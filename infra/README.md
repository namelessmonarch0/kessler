# infra

AWS CDK (Python) app for the Kessler deployment.

## Stacks

- **KesslerApp** (`kessler_infra/app_stack.py`) — the `kessler-api` and `kessler-jobs` container Lambdas
  (built from `api/Dockerfile` targets `api` and `jobs` in the `kessler-api` ECR repo), the
  public streaming Function URL for `kessler-api`, the private TLS-only snapshot S3 bucket,
  and 14-day CloudWatch log groups for both functions. Only defined when the CDK context
  keys `image_tag` and `alert_email` are both supplied.
- **KesslerRegistry** (`kessler_infra/registry_stack.py`), **KesslerCi** (`kessler_infra/ci_stack.py`) — the
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
