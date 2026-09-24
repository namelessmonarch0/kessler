from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

from app import lambda_jobs
from app.migrate import upgrade_head

API_ROOT = Path(__file__).resolve().parents[1]


def head_revision() -> str:
    return ScriptDirectory.from_config(Config(str(API_ROOT / "alembic.ini"))).get_current_head()


def test_upgrade_head_is_idempotent_and_returns_head(migrated):
    assert upgrade_head(migrated) == head_revision()
    assert upgrade_head(migrated) == head_revision()


@pytest.mark.parametrize("event", [None, {}, {"job": ""}, {"job": "drop-tables"}, {"jobs": "all"}])
def test_handler_rejects_missing_or_unknown_job(event, monkeypatch):
    monkeypatch.setattr(lambda_jobs, "load_settings",
                        lambda: pytest.fail("settings loaded for an invalid event"))
    with pytest.raises(ValueError, match="expected one of"):
        lambda_jobs.handler(event, None)


def test_handler_runs_migrate(migrated, monkeypatch):
    monkeypatch.delenv("SSM_PREFIX", raising=False)
    monkeypatch.setenv("DATABASE_URL", migrated)
    assert lambda_jobs.handler({"job": "migrate"}, None) == {"migrate": head_revision()}


def test_handler_dispatches_data_jobs(monkeypatch):
    monkeypatch.delenv("SSM_PREFIX", raising=False)
    calls = []
    monkeypatch.setattr(lambda_jobs, "run_job",
                        lambda name, settings: calls.append(name) or {"ingest_gp": 7})
    assert lambda_jobs.handler({"job": "ingest-gp"}, None) == {"ingest_gp": 7}
    assert calls == ["ingest-gp"]
