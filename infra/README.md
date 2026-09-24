# infra

AWS CDK (Python) app for the LEO Debris deployment.

## Stacks

- **LeoApp** (`leo_infra/app_stack.py`) — the `leo-api` and `leo-jobs` container Lambdas
  (built from `api/Dockerfile` targets `api` and `jobs` in the `leo-api` ECR repo), the
  public streaming Function URL for `leo-api`, the private TLS-only snapshot S3 bucket,
  and 14-day CloudWatch log groups for both functions. Only defined when the CDK context
  keys `image_tag` and `alert_email` are both supplied.
- **LeoRegistry** (`leo_infra/registry_stack.py`), **LeoCi** (`leo_infra/ci_stack.py`) — the
  ECR repo and the GitHub OIDC provider/deploy role, provisioned ahead of any image existing.

## Development

```bash
cd infra
uv sync
uv run ruff check .
uv run pytest -q
```

## Deploying

This project never deploys itself and holds no AWS credentials. See
[`../docs/deploy.md`](../docs/deploy.md) for how to synth and deploy the stacks.
