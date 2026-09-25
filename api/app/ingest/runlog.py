import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime

import psycopg

log = logging.getLogger(__name__)

GLOBE_LOCK = "kessler.globe"


@contextmanager
def advisory_lock(conn: psycopg.Connection, name: str) -> Iterator[None]:
    """Holds a session-level Postgres advisory lock for the block: runs that take the same lock
    wait for each other (a manual run overlapping the schedule). The lock also ends with the
    connection, so a crashed run cannot leave it held."""
    conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (name,))
    try:
        yield
    finally:
        # Never let a failed unlock mask the original exception: the session lock also ends
        # when the connection closes, so a failed unlock here just leaves it held a bit longer.
        try:
            conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (name,))
        except Exception:
            log.warning("could not release advisory lock %s", name, exc_info=True)


@dataclass
class RunState:
    source: str
    rows: int | None = None
    id: int | None = None


@contextmanager
def run_log(conn: psycopg.Connection, job: str, source: str = "pending") -> Iterator[RunState]:
    """Records a job run in ingest_runs. The body owns its own transactions, so a failed
    write is rolled back before the failure is recorded here."""
    run_id = conn.execute(
        "INSERT INTO ingest_runs (job, source, status) VALUES (%s, %s, 'running') RETURNING id",
        (job, source),
    ).fetchone()["id"]
    state = RunState(source=source, id=run_id)
    try:
        yield state
    except Exception as exc:
        conn.execute(
            "UPDATE ingest_runs SET finished_at = now(), status = 'failed', source = %s, "
            "error = %s WHERE id = %s",
            (state.source, f"{type(exc).__name__}: {exc}"[:2000], run_id),
        )
        raise
    conn.execute(
        "UPDATE ingest_runs SET finished_at = now(), status = 'ok', source = %s, rows = %s "
        "WHERE id = %s",
        (state.source, state.rows, run_id),
    )


def last_success(conn: psycopg.Connection, job: str, source: str | None = None) -> datetime | None:
    row = conn.execute(
        "SELECT max(finished_at) AS at FROM ingest_runs "
        "WHERE job = %s AND status = 'ok' AND (%s::text IS NULL OR source = %s)",
        (job, source, source),
    ).fetchone()
    return row["at"]
