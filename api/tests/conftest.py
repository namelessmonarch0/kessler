import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

from app.db import connect

API_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"

ALL_TABLES = (
    "gp_elements, yearly_stats, ingest_runs, objects, breakup_events, launch_sites, owners"
)


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
