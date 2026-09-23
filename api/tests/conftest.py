import os
from collections.abc import Iterator
from pathlib import Path

import pytest

API_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"


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
