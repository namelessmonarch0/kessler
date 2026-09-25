"""The globe lock through PgBouncer in transaction mode, the way production reaches Neon's pooled
endpoint. Needs Docker and the PgBouncer image; skipped, with the reason, when the pooler cannot be
started or cannot reach the test database from its container."""
import time
from collections.abc import Iterator
from contextlib import ExitStack
from datetime import timedelta

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from app.db import connect
from app.ingest import runlog
from app.ingest.runlog import advisory_lock

pytestmark = pytest.mark.pgbouncer

PGBOUNCER_IMAGE = "edoburu/pgbouncer:v1.25.2-p0"
NAME = "kessler.pgbouncer-test"


def pooler_container(postgres_container, database_url: str):
    """PgBouncer in transaction mode in front of the test database. The session's Postgres
    container is reached directly on its Docker network (a published port on the Docker host may
    be firewalled from containers); an external TEST_DATABASE_URL is reached as written."""
    from testcontainers.core.container import DockerContainer

    db = conninfo_to_dict(database_url)
    pooler = DockerContainer(PGBOUNCER_IMAGE).with_exposed_ports(5432).with_envs(
        DB_USER=db["user"], DB_PASSWORD=db["password"], DB_NAME=db["dbname"],
        AUTH_TYPE="scram-sha-256", POOL_MODE="transaction",
    )
    if postgres_container is None:
        return pooler.with_envs(DB_HOST=db.get("host", "localhost"), DB_PORT=db.get("port", "5432"))
    docker = postgres_container.get_docker_client()
    pg_id = postgres_container.get_wrapped_container().id
    return pooler.with_envs(DB_HOST=docker.bridge_ip(pg_id), DB_PORT="5432").with_kwargs(
        network=docker.network_name(pg_id)
    )


@pytest.fixture(scope="module")
def pooled_url(postgres_container, database_url: str) -> Iterator[str]:
    pooler = pooler_container(postgres_container, database_url)
    try:
        pooler.start()
    except Exception as exc:  # no image, no registry, no Docker: nothing to test against
        pytest.skip(f"could not start {PGBOUNCER_IMAGE}: {exc}")
    try:
        url = make_conninfo(
            database_url, host=pooler.get_container_host_ip(),
            port=pooler.get_exposed_port(5432), connect_timeout=5,
        )
        deadline = time.monotonic() + 20
        while True:
            try:
                with connect(url) as c:
                    c.execute("SELECT 1")
                break
            except psycopg.OperationalError as exc:
                if time.monotonic() > deadline:
                    pytest.skip(f"PgBouncer could not reach the test database: {exc}")
                time.sleep(0.5)
        yield url
    finally:
        pooler.stop()


@pytest.fixture
def short_wait(monkeypatch):
    monkeypatch.setattr(runlog, "LOCK_WAIT", timedelta(milliseconds=500))


def try_lock(url: str) -> bool:
    """Takes and at once releases the lock from a fresh pooled connection, if it is free."""
    with connect(url) as c, c.transaction():
        row = c.execute("SELECT pg_try_advisory_xact_lock(hashtext(%s)) AS ok", (NAME,)).fetchone()
        return row["ok"]


def holders(database_url: str) -> int:
    """Sessions holding the lock, counted on the database itself rather than through the pooler
    (a pooled try-lock can land on the very server connection that holds it)."""
    with connect(database_url) as c:
        return c.execute(
            "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted "
            "AND objid::bigint = (hashtext(%s)::bigint & 4294967295)", (NAME,),
        ).fetchone()["n"]


def test_a_second_holder_cannot_take_the_lock_through_the_pooler(
    pooled_url, database_url, short_wait
):
    with advisory_lock(pooled_url, NAME):
        assert holders(database_url) == 1
        assert not try_lock(pooled_url)
        with pytest.raises(psycopg.errors.QueryCanceled):
            with advisory_lock(pooled_url, NAME):
                pass


def test_the_lock_is_free_as_soon_as_the_holder_exits(pooled_url, database_url, short_wait):
    with connect(pooled_url) as other, ExitStack() as busy:
        with advisory_lock(pooled_url, NAME):
            # Another client takes a pooled server connection and keeps it past the block.
            busy.enter_context(other.transaction())
            other.execute("SELECT 1")
        assert holders(database_url) == 0
    assert all(try_lock(pooled_url) for _ in range(3))
    with pytest.raises(ValueError):
        with advisory_lock(pooled_url, NAME):
            raise ValueError("run failed")
    assert holders(database_url) == 0
    with advisory_lock(pooled_url, NAME):  # at once: QueryCanceled after 0.5 s otherwise
        pass


def test_the_wait_limit_stays_inside_the_lock_transaction(pooled_url, short_wait):
    with advisory_lock(pooled_url, NAME):
        pass
    # PgBouncer hands out the server connection released last, i.e. the lock's own.
    with connect(pooled_url) as c:
        assert c.execute("SHOW statement_timeout").fetchone()["statement_timeout"] == "0"
