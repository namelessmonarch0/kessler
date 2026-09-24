# syntax=docker/dockerfile:1
# Two Lambda images from shared layers. Build with:
#   docker buildx build --platform linux/amd64 --provenance=false --target api|jobs .
FROM public.ecr.aws/docker/library/python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

# HTTP API: uvicorn behind the AWS Lambda Web Adapter (response streaming for SSE).
FROM base AS api
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080 \
    AWS_LWA_INVOKE_MODE=response_stream
EXPOSE 8080
CMD ["uvicorn", "app.api.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]

# Scheduled jobs + migrations: a plain Lambda handler. No web adapter here, because an adapter
# extension in this image would compete with the runtime client for invocations.
FROM base AS jobs
RUN uv pip install --python /opt/venv/bin/python --no-cache awslambdaric==4.0.4
ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["app.lambda_jobs.handler"]
