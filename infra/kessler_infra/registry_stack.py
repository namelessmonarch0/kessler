from aws_cdk import RemovalPolicy, Stack
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_iam as iam
from constructs import Construct


class KesslerRegistryStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        self.repo = ecr.Repository(
            self, "Repo",
            repository_name="kessler-api",
            image_scan_on_push=True,
            removal_policy=RemovalPolicy.RETAIN,
            lifecycle_rules=[ecr.LifecycleRule(max_image_count=10,
                                               description="keep the newest 10 images")],
        )
        # KesslerAppStack imports this repo by name, so CDK cannot attach the Lambda
        # image-pull grant to it there. Grant it here instead.
        self.repo.add_to_resource_policy(iam.PolicyStatement(
            principals=[iam.ServicePrincipal("lambda.amazonaws.com")],
            actions=["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
            conditions={"StringLike": {"aws:sourceArn":
                f"arn:aws:lambda:{self.region}:{self.account}:function:*"}},
        ))
