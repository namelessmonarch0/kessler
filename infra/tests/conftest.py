import os

import pytest
from aws_cdk import App, Environment
from aws_cdk.assertions import Template

os.environ.setdefault("JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION", "1")
ENV = Environment(account="111111111111", region="us-east-2")


@pytest.fixture
def app_template():
    def build(reserved: int = 10) -> Template:
        from leo_infra.app_stack import LeoAppStack

        app = App()
        stack = LeoAppStack(app, "LeoApp", env=ENV, image_tag="abc123",
                            alert_email="owner@example.com", api_reserved_concurrency=reserved)
        return Template.from_stack(stack)

    return build
