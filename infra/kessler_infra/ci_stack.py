from aws_cdk import ArnFormat, CfnOutput, Stack
from aws_cdk import aws_iam as iam
from constructs import Construct

GITHUB_OIDC = "token.actions.githubusercontent.com"


class KesslerCiStack(Stack):
    """Lets GitHub Actions on `main` deploy without stored AWS keys (spec §9)."""

    def __init__(self, scope: Construct, construct_id: str, *, github_repo: str,
                 github_subject_prefix: str | None = None, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        provider = iam.OidcProviderNative(self, "GitHubOidc", url=f"https://{GITHUB_OIDC}",
                                          client_ids=["sts.amazonaws.com"])
        # GitHub's OIDC `sub` claim uses immutable ids by default for newer repos
        # ("repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:..."), which also survives renames.
        # The name-based form is kept as a fallback.
        prefixes = [p for p in (github_subject_prefix, f"repo:{github_repo}") if p]
        role = iam.Role(
            self, "DeployRole",
            role_name="kessler-github-deploy",
            assumed_by=iam.WebIdentityPrincipal(provider.oidc_provider_arn, conditions={
                "StringEquals": {
                    f"{GITHUB_OIDC}:aud": "sts.amazonaws.com",
                    f"{GITHUB_OIDC}:sub": [f"{p}:ref:refs/heads/main" for p in prefixes],
                }}),
        )
        role.add_to_policy(iam.PolicyStatement(
            actions=["sts:AssumeRole", "sts:TagSession"],
            resources=[f"arn:aws:iam::{self.account}:role/cdk-hnb659fds-*-{self.account}-{self.region}"],
        ))
        role.add_to_policy(iam.PolicyStatement(actions=["ecr:GetAuthorizationToken"],
                                               resources=["*"]))
        role.add_to_policy(iam.PolicyStatement(
            actions=["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage",
                     "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage",
                     "ecr:UploadLayerPart"],
            resources=[self.format_arn(service="ecr", resource="repository",
                                       resource_name="kessler-api")],
        ))
        role.add_to_policy(iam.PolicyStatement(
            actions=["lambda:InvokeFunction"],
            resources=[self.format_arn(service="lambda", resource="function",
                                       resource_name="kessler-jobs",
                                       arn_format=ArnFormat.COLON_RESOURCE_NAME)],
        ))
        role.add_to_policy(iam.PolicyStatement(
            actions=["cloudformation:DescribeStacks"],
            resources=[self.format_arn(service="cloudformation", resource="stack",
                                       resource_name="KesslerApp/*")],
        ))
        CfnOutput(self, "DeployRoleArn", value=role.role_arn)
