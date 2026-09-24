from aws_cdk import CfnOutput, Duration, RemovalPolicy, Stack
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_s3 as s3
from constructs import Construct

SSM_PREFIX = "/leo/"
REPO_NAME = "leo-api"


class LeoAppStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, image_tag: str,
                 alert_email: str, api_reserved_concurrency: int, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        self.alert_email = alert_email
        repo = ecr.Repository.from_repository_name(self, "Repo", REPO_NAME)

        self.bucket = s3.Bucket(
            self, "Snapshots",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.RETAIN,
        )
        ssm_read = iam.PolicyStatement(
            actions=["ssm:GetParametersByPath"],
            resources=[self.format_arn(service="ssm", resource="parameter",
                                       resource_name=SSM_PREFIX.strip("/"))],
        )
        common_env = {"SSM_PREFIX": SSM_PREFIX, "SNAPSHOT_BUCKET": self.bucket.bucket_name}

        self.api_fn = lambda_.DockerImageFunction(
            self, "ApiFunction",
            function_name="leo-api",
            code=lambda_.DockerImageCode.from_ecr(repo, tag_or_digest=f"api-{image_tag}"),
            architecture=lambda_.Architecture.X86_64,
            memory_size=1024,
            timeout=Duration.seconds(60),
            reserved_concurrent_executions=api_reserved_concurrency or None,
            environment=common_env,
            log_group=logs.LogGroup(self, "ApiLogs", log_group_name="/aws/lambda/leo-api",
                                    retention=logs.RetentionDays.TWO_WEEKS,
                                    removal_policy=RemovalPolicy.DESTROY),
        )
        self.bucket.grant_read(self.api_fn)
        self.api_fn.add_to_role_policy(ssm_read)
        url = self.api_fn.add_function_url(
            auth_type=lambda_.FunctionUrlAuthType.NONE,
            invoke_mode=lambda_.InvokeMode.RESPONSE_STREAM,
        )
        self.api_url = url.url

        self.jobs_fn = lambda_.DockerImageFunction(
            self, "JobsFunction",
            function_name="leo-jobs",
            code=lambda_.DockerImageCode.from_ecr(repo, tag_or_digest=f"jobs-{image_tag}",
                                                  cmd=["app.lambda_jobs.handler"]),
            architecture=lambda_.Architecture.X86_64,
            memory_size=1536,
            timeout=Duration.minutes(10),
            retry_attempts=0,
            environment=common_env,
            log_group=logs.LogGroup(self, "JobsLogs", log_group_name="/aws/lambda/leo-jobs",
                                    retention=logs.RetentionDays.TWO_WEEKS,
                                    removal_policy=RemovalPolicy.DESTROY),
        )
        self.bucket.grant_read_write(self.jobs_fn)
        self.jobs_fn.add_to_role_policy(ssm_read)

        CfnOutput(self, "ApiFunctionUrl", value=url.url)
        CfnOutput(self, "SnapshotBucketName", value=self.bucket.bucket_name)
