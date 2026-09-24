import os

from aws_cdk import App, Environment

from leo_infra.app_stack import LeoAppStack

os.environ.setdefault("JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION", "1")

app = App()
env = Environment(account=os.environ.get("CDK_DEFAULT_ACCOUNT"), region="us-east-2")


def ctx(name: str) -> str | None:
    value = app.node.try_get_context(name)
    return str(value) if value not in (None, "") else None


image_tag, alert_email = ctx("image_tag"), ctx("alert_email")
if image_tag and alert_email:
    LeoAppStack(app, "LeoApp", env=env, image_tag=image_tag, alert_email=alert_email,
                api_reserved_concurrency=int(ctx("api_reserved_concurrency") or 10))

app.synth()
