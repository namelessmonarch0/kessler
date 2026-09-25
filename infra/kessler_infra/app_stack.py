from aws_cdk import CfnOutput, Duration, RemovalPolicy, Stack, TimeZone
from aws_cdk import aws_budgets as budgets
from aws_cdk import aws_cloudwatch as cloudwatch
from aws_cdk import aws_cloudwatch_actions as cw_actions
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_scheduler as scheduler
from aws_cdk import aws_scheduler_targets as targets
from aws_cdk import aws_sns as sns
from aws_cdk import aws_sns_subscriptions as subs
from constructs import Construct

SSM_PREFIX = "/kessler/"
REPO_NAME = "kessler-api"


class KesslerAppStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, image_tag: str,
                 alert_email: str, api_reserved_concurrency: int,
                 api_url_auth: str = "NONE", **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        if api_url_auth not in ("NONE", "AWS_IAM"):
            raise ValueError(f"api_url_auth must be NONE or AWS_IAM, not {api_url_auth!r}")
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
            resources=[
                self.format_arn(service="ssm", resource="parameter",
                                resource_name=SSM_PREFIX.strip("/")),
                self.format_arn(service="ssm", resource="parameter",
                                resource_name=f"{SSM_PREFIX.strip('/')}/*"),
            ],
        )
        common_env = {"SSM_PREFIX": SSM_PREFIX, "SNAPSHOT_BUCKET": self.bucket.bucket_name}

        self.api_fn = lambda_.DockerImageFunction(
            self, "ApiFunction",
            function_name="kessler-api",
            code=lambda_.DockerImageCode.from_ecr(repo, tag_or_digest=f"api-{image_tag}"),
            architecture=lambda_.Architecture.X86_64,
            memory_size=1024,
            timeout=Duration.seconds(60),
            reserved_concurrent_executions=api_reserved_concurrency or None,
            environment=common_env,
            log_group=logs.LogGroup(self, "ApiLogs", log_group_name="/aws/lambda/kessler-api",
                                    retention=logs.RetentionDays.TWO_WEEKS,
                                    removal_policy=RemovalPolicy.DESTROY),
        )
        self.bucket.grant_read(self.api_fn)
        self.api_fn.add_to_role_policy(ssm_read)
        url = self.api_fn.add_function_url(
            auth_type=(lambda_.FunctionUrlAuthType.AWS_IAM if api_url_auth == "AWS_IAM"
                       else lambda_.FunctionUrlAuthType.NONE),
            invoke_mode=lambda_.InvokeMode.RESPONSE_STREAM,
        )
        self.api_url = url.url

        # --- origin protection: only Vercel production (via OIDC) and the deploy workflow may
        # call the API URL (spec 2026-09-25-origin-protection). Enforced once api_url_auth is
        # AWS_IAM. ---
        vercel_issuer = "oidc.vercel.com/kudayyurter"
        vercel_oidc = iam.OidcProviderNative(
            self, "VercelOidc", url=f"https://{vercel_issuer}",
            client_ids=["https://vercel.com/kudayyurter"],
        )
        vercel_role = iam.Role(
            self, "VercelApiRole", role_name="kessler-vercel-api",
            assumed_by=iam.WebIdentityPrincipal(vercel_oidc.oidc_provider_arn, conditions={
                "StringEquals": {
                    f"{vercel_issuer}:aud": "https://vercel.com/kudayyurter",
                    f"{vercel_issuer}:sub":
                        "owner:kudayyurter:project:kessler:environment:production",
                },
            }),
            max_session_duration=Duration.hours(1),
        )
        vercel_role.add_to_policy(iam.PolicyStatement(
            actions=["lambda:InvokeFunctionUrl"], resources=[self.api_fn.function_arn],
            conditions={"StringEquals": {"lambda:FunctionUrlAuthType": "AWS_IAM"}},
        ))
        vercel_role.add_to_policy(iam.PolicyStatement(
            actions=["lambda:InvokeFunction"], resources=[self.api_fn.function_arn],
            conditions={"Bool": {"lambda:InvokedViaFunctionUrl": "true"}},
        ))
        deploy_role = iam.ArnPrincipal(f"arn:aws:iam::{self.account}:role/kessler-github-deploy")
        lambda_.CfnPermission(
            self, "DeployRoleInvokeUrl", action="lambda:InvokeFunctionUrl",
            function_name=self.api_fn.function_arn, principal=deploy_role.arn,
            function_url_auth_type="AWS_IAM",
        )
        lambda_.CfnPermission(
            self, "DeployRoleInvokeViaUrl", action="lambda:InvokeFunction",
            function_name=self.api_fn.function_arn, principal=deploy_role.arn,
            invoked_via_function_url=True,
        )

        self.jobs_fn = lambda_.DockerImageFunction(
            self, "JobsFunction",
            function_name="kessler-jobs",
            code=lambda_.DockerImageCode.from_ecr(repo, tag_or_digest=f"jobs-{image_tag}",
                                                  cmd=["app.lambda_jobs.handler"]),
            architecture=lambda_.Architecture.X86_64,
            memory_size=1536,
            timeout=Duration.minutes(10),
            retry_attempts=0,
            environment=common_env,
            log_group=logs.LogGroup(self, "JobsLogs", log_group_name="/aws/lambda/kessler-jobs",
                                    retention=logs.RetentionDays.TWO_WEEKS,
                                    removal_policy=RemovalPolicy.DESTROY),
        )
        self.bucket.grant_read_write(self.jobs_fn)
        self.jobs_fn.add_to_role_policy(ssm_read)

        # --- schedules (spec §3.6) ---
        for name, job, minute, hour in (
            ("kessler-ingest-satcat", "ingest-satcat", "17", "5"),
            ("kessler-ingest-gp", "ingest-gp", "41", "0/6"),
        ):
            scheduler.Schedule(
                self, name,
                schedule_name=name,
                schedule=scheduler.ScheduleExpression.cron(minute=minute, hour=hour,
                                                           time_zone=TimeZone.ETC_UTC),
                target=targets.LambdaInvoke(
                    self.jobs_fn,
                    input=scheduler.ScheduleTargetInput.from_object({"job": job}),
                    retry_attempts=0,
                ),
                time_window=scheduler.TimeWindow.off(),
            )

        # --- a failed job keeps the last good data (spec §3.6); make sure someone hears ---
        topic = sns.Topic(self, "Alerts", topic_name="kessler-alerts")
        topic.add_subscription(subs.EmailSubscription(alert_email))
        alarm = cloudwatch.Alarm(
            self, "JobsErrors",
            alarm_name="kessler-jobs-errors",
            metric=self.jobs_fn.metric_errors(period=Duration.hours(1), statistic="Sum"),
            threshold=1,
            evaluation_periods=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
        )
        alarm.add_alarm_action(cw_actions.SnsAction(topic))

        # --- kessler-agent: a narrow identity for local tooling (Claude Code's checks), so
        # day-to-day reads don't need the owner's 12-hour console sign-in. The owner creates its
        # access key by hand (a key in CloudFormation would leak the secret). It reads Kessler's
        # stacks, snapshot bucket, logs, metrics and Lambda quota requests and can start the jobs
        # Lambda; it cannot write data, change infrastructure, or read SSM secrets. ---
        agent = iam.User(self, "AgentUser", user_name="kessler-agent")
        agent.add_to_policy(iam.PolicyStatement(
            actions=["cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents",
                     "cloudformation:DescribeStackResources"],
            resources=[f"arn:aws:cloudformation:{self.region}:{self.account}:stack/Kessler*/*"],
        ))
        self.bucket.grant_read(agent)
        agent.add_to_policy(iam.PolicyStatement(
            actions=["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams",
                     "logs:StartLiveTail"],
            resources=[
                f"arn:aws:logs:{self.region}:{self.account}:log-group:/aws/lambda/kessler-*",
                f"arn:aws:logs:{self.region}:{self.account}:log-group:/aws/lambda/kessler-*:*",
            ],
        ))
        agent.add_to_policy(iam.PolicyStatement(
            actions=["logs:DescribeLogGroups", "cloudwatch:GetMetricData",
                     "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics",
                     "cloudwatch:DescribeAlarms", "servicequotas:GetServiceQuota",
                     "servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota"],
            resources=["*"],  # these list/read calls don't support resource-level scoping
        ))
        agent.add_to_policy(iam.PolicyStatement(
            actions=["lambda:GetFunction", "lambda:GetFunctionConfiguration"],
            resources=[self.api_fn.function_arn, self.jobs_fn.function_arn],
        ))
        self.jobs_fn.grant_invoke(agent)

        # --- $5/month budget (spec §9) ---
        subscriber = budgets.CfnBudget.SubscriberProperty(subscription_type="EMAIL",
                                                          address=alert_email)
        budgets.CfnBudget(
            self, "MonthlyBudget",
            budget=budgets.CfnBudget.BudgetDataProperty(
                budget_name="kessler-monthly", budget_type="COST", time_unit="MONTHLY",
                budget_limit=budgets.CfnBudget.SpendProperty(amount=5, unit="USD"),
                # the free plan's credits pay the bill, so exclude them: the $5 alert
                # must still fire on real spend, not be masked by unused credit balance.
                cost_types=budgets.CfnBudget.CostTypesProperty(include_credit=False),
            ),
            notifications_with_subscribers=[
                budgets.CfnBudget.NotificationWithSubscribersProperty(
                    notification=budgets.CfnBudget.NotificationProperty(
                        notification_type=kind, comparison_operator="GREATER_THAN",
                        threshold=100, threshold_type="PERCENTAGE"),
                    subscribers=[subscriber])
                for kind in ("ACTUAL", "FORECASTED")
            ],
        )

        CfnOutput(self, "ApiFunctionUrl", value=url.url)
        CfnOutput(self, "SnapshotBucketName", value=self.bucket.bucket_name)
        CfnOutput(self, "VercelApiRoleArn", value=vercel_role.role_arn)
