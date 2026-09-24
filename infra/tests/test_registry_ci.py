from aws_cdk import App
from aws_cdk.assertions import Match, Template

from tests.conftest import ENV


def build():
    from leo_infra.ci_stack import LeoCiStack
    from leo_infra.registry_stack import LeoRegistryStack

    app = App()
    reg = LeoRegistryStack(app, "LeoRegistry", env=ENV)
    ci = LeoCiStack(app, "LeoCi", env=ENV, github_repo="owner/repo")
    return Template.from_stack(reg), Template.from_stack(ci)


def test_registry_keeps_last_ten_images():
    reg, _ = build()
    reg.has_resource_properties("AWS::ECR::Repository", {
        "RepositoryName": "leo-api",
        "LifecyclePolicy": {"LifecyclePolicyText": Match.string_like_regexp('"countNumber":10')}})


def test_registry_allows_lambda_image_pull():
    reg, _ = build()
    reg.has_resource_properties("AWS::ECR::Repository", {
        "RepositoryName": "leo-api",
        "RepositoryPolicyText": {"Statement": Match.array_with([Match.object_like({
            "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": Match.array_with(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]),
            "Condition": {"StringLike": {"aws:sourceArn":
                f"arn:aws:lambda:{ENV.region}:{ENV.account}:function:*"}},
        })])}})


def test_ci_role_trusts_only_main_of_the_repo():
    _, ci = build()
    ci.has_resource_properties("AWS::IAM::OIDCProvider", {
        "Url": "https://token.actions.githubusercontent.com",
        "ClientIdList": ["sts.amazonaws.com"]})
    ci.has_resource_properties("AWS::IAM::Role", {
        "RoleName": "leo-github-deploy",
        "AssumeRolePolicyDocument": {"Statement": [Match.object_like({
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {
                "StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                                 "token.actions.githubusercontent.com:sub":
                                     "repo:owner/repo:ref:refs/heads/main"}}})]}})
    ci.has_output("DeployRoleArn", {})


def test_ci_role_permissions_are_scoped():
    _, ci = build()
    statements = []
    for res in ci.find_resources("AWS::IAM::Policy").values():
        statements += res["Properties"]["PolicyDocument"]["Statement"]
    flat = str(statements)
    assert "cdk-hnb659fds-" in flat            # may assume the CDK bootstrap roles
    assert "sts:AssumeRole" in flat
    assert "sts:TagSession" in flat            # cdk deploy passes session tags
    assert "ecr:PutImage" in flat              # may push images
    assert "lambda:InvokeFunction" in flat     # may run the migrate job
    assert "cloudformation:DescribeStacks" in flat  # may read the smoke-test output
    assert "'*'" not in flat.replace("'Resource': '*'", "")  # no wildcard actions
    assert "iam:" not in flat.replace("iam::", "")  # no direct IAM powers
