import json
from pathlib import Path

import pytest
from aws_cdk.assertions import Match


def fn_props(template, name):
    fns = template.find_resources("AWS::Lambda::Function",
                                  {"Properties": {"FunctionName": name}})
    assert len(fns) == 1, f"expected exactly one {name}"
    return next(iter(fns.values()))["Properties"]


def test_api_function_shape(app_template):
    p = fn_props(app_template(), "kessler-api")
    assert p["MemorySize"] == 1024
    assert p["Timeout"] == 60
    assert p["Architectures"] == ["x86_64"]
    assert p["PackageType"] == "Image"
    assert p["ReservedConcurrentExecutions"] == 10
    env = p["Environment"]["Variables"]
    assert env["SSM_PREFIX"] == "/kessler/"
    assert "SNAPSHOT_BUCKET" in env
    assert "DATABASE_URL" not in env and "ORIGIN_SECRET" not in env  # secrets stay in SSM


def test_reserved_concurrency_zero_omits_property(app_template):
    assert "ReservedConcurrentExecutions" not in fn_props(app_template(0), "kessler-api")


def test_jobs_function_shape(app_template):
    p = fn_props(app_template(), "kessler-jobs")
    assert p["MemorySize"] == 1536
    assert p["Timeout"] == 600
    assert p["ImageConfig"]["Command"] == ["app.lambda_jobs.handler"]


def test_images_come_from_leo_api_repo_by_tag(app_template):
    t = app_template()
    api_uri = str(fn_props(t, "kessler-api")["Code"]["ImageUri"])
    jobs_uri = str(fn_props(t, "kessler-jobs")["Code"]["ImageUri"])
    assert "kessler-api" in api_uri and "api-abc123" in api_uri
    assert "jobs-abc123" in jobs_uri


def test_only_api_has_a_streaming_url_public_until_iam_is_enabled(app_template):
    t = app_template()
    t.resource_count_is("AWS::Lambda::Url", 1)
    t.has_resource_properties("AWS::Lambda::Url", {"AuthType": "NONE",
                                                   "InvokeMode": "RESPONSE_STREAM"})
    t.has_resource_properties("AWS::Lambda::Permission", {
        "Action": "lambda:InvokeFunction", "Principal": "*", "InvokedViaFunctionUrl": True})
    t.has_output("ApiFunctionUrl", {})


def test_iam_url_has_no_public_permission(app_template):
    t = app_template(url_auth="AWS_IAM")
    t.has_resource_properties("AWS::Lambda::Url", {"AuthType": "AWS_IAM",
                                                   "InvokeMode": "RESPONSE_STREAM"})
    public = t.find_resources("AWS::Lambda::Permission", {"Properties": {"Principal": "*"}})
    assert public == {}


def test_unknown_url_auth_is_rejected(app_template):
    with pytest.raises(ValueError, match="api_url_auth"):
        app_template(url_auth="OPEN")


def test_log_groups_keep_14_days(app_template):
    t = app_template()
    t.resource_count_is("AWS::Logs::LogGroup", 2)
    t.all_resources_properties("AWS::Logs::LogGroup", {"RetentionInDays": 14})


def test_bucket_is_private_and_tls_only(app_template):
    t = app_template()
    t.has_resource_properties("AWS::S3::Bucket", {"PublicAccessBlockConfiguration": {
        "BlockPublicAcls": True, "BlockPublicPolicy": True,
        "IgnorePublicAcls": True, "RestrictPublicBuckets": True}})
    t.has_resource_properties("AWS::S3::BucketPolicy", {"PolicyDocument": {"Statement":
        Match.array_with([Match.object_like({"Effect": "Deny", "Condition": {
            "Bool": {"aws:SecureTransport": "false"}}})])}})


def _policy_statements(template, role_logical_prefix):
    statements = []
    for lid, res in template.find_resources("AWS::IAM::Policy").items():
        if not lid.startswith(role_logical_prefix):
            continue
        statements += res["Properties"]["PolicyDocument"]["Statement"]
    return statements


def _policy_actions(template, role_logical_prefix):
    actions = []
    for st in _policy_statements(template, role_logical_prefix):
        a = st["Action"]
        actions += a if isinstance(a, list) else [a]
    return actions


def _ssm_resources(template, role_logical_prefix):
    for st in _policy_statements(template, role_logical_prefix):
        actions = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
        if "ssm:GetParametersByPath" in actions:
            res = st["Resource"]
            return res if isinstance(res, list) else [res]
    raise AssertionError("no ssm:GetParametersByPath statement found")


def test_api_can_read_but_not_write_snapshots(app_template):
    actions = _policy_actions(app_template(), "ApiFunctionServiceRoleDefaultPolicy")
    assert any(a.startswith("s3:GetObject") for a in actions)
    assert not any(a.startswith("s3:PutObject") or a.startswith("s3:DeleteObject")
                   for a in actions)
    assert "ssm:GetParametersByPath" in actions


def test_jobs_can_write_snapshots(app_template):
    actions = _policy_actions(app_template(), "JobsFunctionServiceRoleDefaultPolicy")
    assert any(a.startswith("s3:PutObject") for a in actions)
    assert "ssm:GetParametersByPath" in actions


def test_ssm_read_covers_prefix_and_path(app_template):
    # GetParametersByPath(Path="/kessler/") needs both the bare prefix ARN and the
    # wildcard-under-it ARN granted, or the call is denied.
    t = app_template()
    role_prefixes = ("ApiFunctionServiceRoleDefaultPolicy", "JobsFunctionServiceRoleDefaultPolicy")
    for role_prefix in role_prefixes:
        dumped = json.dumps(_ssm_resources(t, role_prefix))
        assert "parameter/kessler\"" in dumped
        assert "parameter/kessler/*\"" in dumped


def _schedules(template):
    return {r["Properties"]["Name"]: r["Properties"]
            for r in template.find_resources("AWS::Scheduler::Schedule").values()}


def test_job_schedules(app_template):
    s = _schedules(app_template())
    assert set(s) == {"kessler-ingest-satcat", "kessler-ingest-gp"}
    assert s["kessler-ingest-satcat"]["ScheduleExpression"] == "cron(17 5 * * ? *)"
    assert s["kessler-ingest-gp"]["ScheduleExpression"] == "cron(41 0/6 * * ? *)"
    for name, job in (("kessler-ingest-satcat", "ingest-satcat"),
                      ("kessler-ingest-gp", "ingest-gp")):
        props = s[name]
        assert props["ScheduleExpressionTimezone"] == "Etc/UTC"
        assert props["FlexibleTimeWindow"] == {"Mode": "OFF"}
        assert json.loads(props["Target"]["Input"]) == {"job": job}
        assert props["Target"]["RetryPolicy"]["MaximumRetryAttempts"] == 0


def test_job_errors_alarm_emails_owner(app_template):
    t = app_template()
    t.has_resource_properties("AWS::SNS::Subscription", {
        "Protocol": "email", "Endpoint": "owner@example.com"})
    t.has_resource_properties("AWS::CloudWatch::Alarm", {
        "AlarmName": "kessler-jobs-errors", "MetricName": "Errors", "Namespace": "AWS/Lambda",
        "Threshold": 1, "ComparisonOperator": "GreaterThanOrEqualToThreshold",
        "TreatMissingData": "notBreaching"})


def test_budget_alerts_at_five_dollars(app_template):
    t = app_template()
    # include_credit=False: the free plan's credits pay the bill, so credits must not
    # mask real spend from the $5 alert.
    t.has_resource_properties("AWS::Budgets::Budget", {"Budget": {
        "BudgetName": "kessler-monthly", "BudgetType": "COST", "TimeUnit": "MONTHLY",
        "BudgetLimit": {"Amount": 5, "Unit": "USD"},
        "CostTypes": {"IncludeCredit": False}}})
    budget = next(iter(t.find_resources("AWS::Budgets::Budget").values()))["Properties"]
    kinds = {n["Notification"]["NotificationType"] for n in budget["NotificationsWithSubscribers"]}
    assert kinds == {"ACTUAL", "FORECASTED"}
    for n in budget["NotificationsWithSubscribers"]:
        assert n["Subscribers"] == [{"SubscriptionType": "EMAIL", "Address": "owner@example.com"}]
        notification = n["Notification"]
        assert notification["ComparisonOperator"] == "GREATER_THAN"
        assert notification["Threshold"] == 100
        assert notification["ThresholdType"] == "PERCENTAGE"


def _agent_statements(template):
    return _policy_statements(template, "AgentUserDefaultPolicy")


def test_agent_user_can_read_kessler_and_start_jobs(app_template):
    t = app_template()
    t.has_resource_properties("AWS::IAM::User", {"UserName": "kessler-agent"})
    actions = set(_policy_actions(t, "AgentUserDefaultPolicy"))
    assert "cloudformation:DescribeStacks" in actions
    assert any(a.startswith("s3:GetObject") for a in actions)
    assert any(a.startswith("s3:List") for a in actions)
    assert {"logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogGroups"} <= actions
    assert {"cloudwatch:GetMetricData", "cloudwatch:DescribeAlarms"} <= actions
    assert {"lambda:GetFunction", "lambda:InvokeFunction"} <= actions


def test_agent_user_cannot_write_or_touch_secrets(app_template):
    actions = _policy_actions(app_template(), "AgentUserDefaultPolicy")
    forbidden = ("s3:Put", "s3:Delete", "iam:", "ssm:", "kms:", "lambda:Update", "lambda:Delete",
                 "lambda:Create", "lambda:Add", "cloudformation:Create", "cloudformation:Update",
                 "cloudformation:Delete", "logs:Delete", "logs:Put", "logs:Create")
    assert not [a for a in actions if a.startswith(forbidden) or a == "*"]


def test_agent_user_scopes_invoke_and_logs_to_kessler(app_template):
    for st in _agent_statements(app_template()):
        actions = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
        resources = json.dumps(st["Resource"])
        if "lambda:InvokeFunction" in actions:
            assert "JobsFunction" in resources and "ApiFunction" not in resources
        if "logs:FilterLogEvents" in actions:
            assert "/aws/lambda/kessler-*" in resources and '"*"' not in resources
        if "cloudformation:DescribeStacks" in actions:
            assert "stack/Kessler*/*" in resources


def test_agent_user_has_no_access_key_in_the_template(app_template):
    # The owner creates the key by hand; a key in CloudFormation would leak the secret.
    app_template().resource_count_is("AWS::IAM::AccessKey", 0)


VERCEL = "oidc.vercel.com/kudayyurter"


def _role_by_name(template, name):
    roles = template.find_resources("AWS::IAM::Role", {"Properties": {"RoleName": name}})
    assert len(roles) == 1, f"expected exactly one role {name}"
    return next(iter(roles.items()))


def test_vercel_oidc_provider(app_template):
    app_template().has_resource_properties("AWS::IAM::OIDCProvider", {
        "Url": f"https://{VERCEL}", "ClientIdList": ["https://vercel.com/kudayyurter"]})


def test_vercel_role_trusts_only_production_of_this_project(app_template):
    _, role = _role_by_name(app_template(), "kessler-vercel-api")
    (statement,) = role["Properties"]["AssumeRolePolicyDocument"]["Statement"]
    assert statement["Action"] == "sts:AssumeRoleWithWebIdentity"
    assert statement["Condition"] == {"StringEquals": {
        f"{VERCEL}:aud": "https://vercel.com/kudayyurter",
        f"{VERCEL}:sub": "owner:kudayyurter:project:kessler:environment:production",
    }}


def test_vercel_role_may_only_invoke_the_api_through_its_url(app_template):
    t = app_template()
    logical_id, _ = _role_by_name(t, "kessler-vercel-api")
    policies = [p for p in t.find_resources("AWS::IAM::Policy").values()
                if {"Ref": logical_id} in p["Properties"].get("Roles", [])]
    (policy,) = policies
    statements = policy["Properties"]["PolicyDocument"]["Statement"]
    by_action = {s["Action"]: s for s in statements}
    assert set(by_action) == {"lambda:InvokeFunctionUrl", "lambda:InvokeFunction"}
    assert by_action["lambda:InvokeFunctionUrl"]["Condition"] == {
        "StringEquals": {"lambda:FunctionUrlAuthType": "AWS_IAM"}}
    assert by_action["lambda:InvokeFunction"]["Condition"] == {
        "Bool": {"lambda:InvokedViaFunctionUrl": "true"}}
    for s in statements:
        resource = json.dumps(s["Resource"])
        assert "ApiFunction" in resource and "JobsFunction" not in resource
    t.has_output("VercelApiRoleArn", {})


def test_deploy_role_may_call_the_api_url_for_smoke_tests(app_template):
    t = app_template()
    grants = [p["Properties"] for p in t.find_resources("AWS::Lambda::Permission").values()
              if "kessler-github-deploy" in json.dumps(p["Properties"]["Principal"])]
    assert {g["Action"] for g in grants} == {"lambda:InvokeFunctionUrl", "lambda:InvokeFunction"}
    url_grant = next(g for g in grants if g["Action"] == "lambda:InvokeFunctionUrl")
    via_grant = next(g for g in grants if g["Action"] == "lambda:InvokeFunction")
    assert url_grant["FunctionUrlAuthType"] == "AWS_IAM"
    assert via_grant["InvokedViaFunctionUrl"] is True
    for g in grants:
        assert "ApiFunction" in json.dumps(g["FunctionName"])


def test_cdk_json_caps_api_concurrency_and_starts_with_an_open_url():
    context = json.loads((Path(__file__).parents[1] / "cdk.json").read_text())["context"]
    assert context["api_reserved_concurrency"] == 10
    assert context["api_url_auth"] == "NONE"
