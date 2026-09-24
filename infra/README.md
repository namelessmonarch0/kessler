# infra

AWS CDK (Python) app for the LEO Debris deployment.

## Stacks

- **LeoApp** (`leo_infra/app_stack.py`) — the `leo-api` and `leo-jobs` container Lambdas
  (built from `api/Dockerfile` targets `api` and `jobs` in the `leo-api` ECR repo), the
  public streaming Function URL for `leo-api`, the private TLS-only snapshot S3 bucket,
  and 14-day CloudWatch log groups for both functions. Only defined when the CDK context
  keys `image_tag` and `alert_email` are both supplied.
- **LeoRegistry**, **LeoCi** — defined elsewhere in this app (Task 6/7); they provision the
  ECR repo and CI role/OIDC ahead of any image existing.

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
