import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.api.main import create_app
from app.config import Settings
from app.db import Database, connect
from app.ingest.snapshot import LocalSnapshotStore
from app.seeds import load_seeds
from app.stats.rebuild import rebuild_yearly_stats
from tests.factories import seed_stats_world

API_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"

ALL_TABLES = (
    "gp_elements, yearly_stats, ingest_runs, objects, breakup_events, launch_sites, owners"
)


@pytest.fixture(autouse=True)
def _no_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep tests independent of a developer's local api/.env.

    `Settings.model_config` is a plain dict class attribute that pydantic-settings reads
    fresh on every `Settings()` call (it is not baked into the schema at class-definition
    time), so mutating it here — and letting monkeypatch restore it after the test — reliably
    disables dotenv loading without touching real env vars. Verified manually: instantiating
    `Settings()` in a directory containing a `.env` with `ORIGIN_SECRET=leaked` returns
    `"leaked"` normally, and `None` once `env_file` is patched to `None`.
    """
    monkeypatch.setitem(Settings.model_config, "env_file", None)


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    """A throwaway Postgres. Set TEST_DATABASE_URL to reuse an existing empty database."""
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    from testcontainers.community.postgres import PostgresContainer

    with PostgresContainer("pgvector/pgvector:pg16", driver=None) as pg:
        yield pg.get_connection_url()


@pytest.fixture(scope="session")
def migrated(database_url: str) -> str:
    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(cfg, "head")
    return database_url


@pytest.fixture
def conn(migrated: str):
    with connect(migrated) as c:
        yield c
        c.execute(f"TRUNCATE {ALL_TABLES} RESTART IDENTITY CASCADE")


@pytest.fixture
def world(conn):
    load_seeds(conn)
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    return conn


@pytest.fixture
def store(tmp_path):
    return LocalSnapshotStore(tmp_path)


def make_client(migrated, store, **settings):
    db = Database(migrated)
    app = create_app(Settings(database_url=migrated, **settings), store=store, database=db)
    return TestClient(app), db


@pytest.fixture
def client(world, migrated, store):
    c, db = make_client(migrated, store)
    with c:
        yield c
    db.close()
