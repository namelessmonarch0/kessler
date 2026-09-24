"""Entry point of the `leo-jobs` Lambda (image target `jobs`).

EventBridge Scheduler invokes it with {"job": "ingest-satcat"} or {"job": "ingest-gp"}. The
deploy workflow invokes {"job": "migrate"}; the owner can run {"job": "all"} once to load data.
"""
import json
import logging

from app.config import load_settings
from app.jobs import JOBS, run_job
from app.migrate import upgrade_head

LAMBDA_JOBS = ("migrate", *JOBS)
log = logging.getLogger("leo.jobs")


def handler(event: dict | None, context) -> dict:
    job = (event or {}).get("job")
    if job not in LAMBDA_JOBS:
        raise ValueError(f"invalid job {job!r}; expected one of {', '.join(LAMBDA_JOBS)}")
    logging.getLogger().setLevel(logging.INFO)
    settings = load_settings()
    if job == "migrate":
        result = {"migrate": upgrade_head(settings.database_url)}
    else:
        result = run_job(job, settings)
    log.info("job %s finished: %s", job, json.dumps(result))
    return result
