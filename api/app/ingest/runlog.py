import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg
from psycopg import sql

from app.db import connect

log = logging.getLogger(__name__)

GLOBE_LOCK = "kessler.globe"
LOCK_WAIT = timedelta(minutes=8)  # the jobs Lambda times out at 10


@contextmanager
def advisory_lock(database_url: str, name: str) -> Iterator[None]:
    """Holds a Postgres advisory lock for the block: runs that take the same lock wait for each
    other (a manual run overlapping the schedule). Production connects through Neon's pooler
    (PgBouncer, transaction mode), where a session-level lock can land on a server connection other
    clients share, so the lock is transaction-scoped instead, on a dedicated connection whose one
    transaction stays open, pinned to one server connection, for the whole block. Ending that
    transaction releases the lock on success and on error, and so does the connection dropping when
    a run crashes. A run that cannot get the lock within LOCK_WAIT fails with
    psycopg.errors.QueryCanceled instead of waiting until the Lambda times out."""
    wait_ms = int(LOCK_WAIT.total_seconds() * 1000)
    with connect(database_url) as lock_conn, lock_conn.transaction():
        # SET LOCAL: the limit ends with this transaction and never reaches a pooled connection.
        lock_conn.execute(sql.SQL("SET LOCAL statement_timeout = {}").format(wait_ms))
        # This transaction idles for the whole run; Neon ends idle transactions after 5 minutes.
        lock_conn.execute("SET LOCAL idle_in_transaction_session_timeout = 0")
        log.info("waiting for globe lock (%s)", name)
        lock_conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (name,))
        log.info("acquired globe lock (%s)", name)
        yield


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
