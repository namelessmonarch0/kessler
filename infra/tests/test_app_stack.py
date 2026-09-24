import json

from aws_cdk.assertions import Match


def fn_props(template, name):
    fns = template.find_resources("AWS::Lambda::Function",
                                  {"Properties": {"FunctionName": name}})
    assert len(fns) == 1, f"expected exactly one {name}"
    return next(iter(fns.values()))["Properties"]


def test_api_function_shape(app_template):
    p = fn_props(app_template(), "leo-api")
    assert p["MemorySize"] == 1024
    assert p["Timeout"] == 60
    assert p["Architectures"] == ["x86_64"]
    assert p["PackageType"] == "Image"
    assert p["ReservedConcurrentExecutions"] == 10
    env = p["Environment"]["Variables"]
    assert env["SSM_PREFIX"] == "/leo/"
    assert "SNAPSHOT_BUCKET" in env
    assert "DATABASE_URL" not in env and "ORIGIN_SECRET" not in env  # secrets stay in SSM


def test_reserved_concurrency_zero_omits_property(app_template):
    assert "ReservedConcurrentExecutions" not in fn_props(app_template(0), "leo-api")


def test_jobs_function_shape(app_template):
    p = fn_props(app_template(), "leo-jobs")
    assert p["MemorySize"] == 1536
    assert p["Timeout"] == 600
    assert p["ImageConfig"]["Command"] == ["app.lambda_jobs.handler"]


def test_images_come_from_leo_api_repo_by_tag(app_template):
    t = app_template()
    api_uri = str(fn_props(t, "leo-api")["Code"]["ImageUri"])
    jobs_uri = str(fn_props(t, "leo-jobs")["Code"]["ImageUri"])
    assert "leo-api" in api_uri and "api-abc123" in api_uri
    assert "jobs-abc123" in jobs_uri


def test_only_api_has_public_streaming_url(app_template):
    t = app_template()
    t.resource_count_is("AWS::Lambda::Url", 1)
    t.has_resource_properties("AWS::Lambda::Url", {"AuthType": "NONE",
                                                   "InvokeMode": "RESPONSE_STREAM"})
    t.has_resource_properties("AWS::Lambda::Permission", {
        "Action": "lambda:InvokeFunction", "Principal": "*", "InvokedViaFunctionUrl": True})
    t.has_output("ApiFunctionUrl", {})


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
    # GetParametersByPath(Path="/leo/") needs both the bare prefix ARN and the
    # wildcard-under-it ARN granted, or the call is denied.
    t = app_template()
    role_prefixes = ("ApiFunctionServiceRoleDefaultPolicy", "JobsFunctionServiceRoleDefaultPolicy")
    for role_prefix in role_prefixes:
        dumped = json.dumps(_ssm_resources(t, role_prefix))
        assert "parameter/leo\"" in dumped
        assert "parameter/leo/*\"" in dumped


def _schedules(template):
    return {r["Properties"]["Name"]: r["Properties"]
            for r in template.find_resources("AWS::Scheduler::Schedule").values()}


def test_job_schedules(app_template):
    s = _schedules(app_template())
    assert set(s) == {"leo-ingest-satcat", "leo-ingest-gp"}
    assert s["leo-ingest-satcat"]["ScheduleExpression"] == "cron(17 5 * * ? *)"
    assert s["leo-ingest-gp"]["ScheduleExpression"] == "cron(41 0/6 * * ? *)"
    for name, job in (("leo-ingest-satcat", "ingest-satcat"), ("leo-ingest-gp", "ingest-gp")):
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
        "AlarmName": "leo-jobs-errors", "MetricName": "Errors", "Namespace": "AWS/Lambda",
        "Threshold": 1, "ComparisonOperator": "GreaterThanOrEqualToThreshold",
        "TreatMissingData": "notBreaching"})


def test_budget_alerts_at_five_dollars(app_template):
    t = app_template()
    # include_credit=False: the free plan's credits pay the bill, so credits must not
    # mask real spend from the $5 alert.
    t.has_resource_properties("AWS::Budgets::Budget", {"Budget": {
        "BudgetName": "leo-monthly", "BudgetType": "COST", "TimeUnit": "MONTHLY",
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
