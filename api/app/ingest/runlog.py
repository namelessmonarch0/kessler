from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime

import psycopg


@dataclass
class RunState:
    source: str
    rows: int | None = None


@contextmanager
def run_log(conn: psycopg.Connection, job: str, source: str = "pending") -> Iterator[RunState]:
    """Records a job run in ingest_runs. The body owns its own transactions, so a failed
    write is rolled back before the failure is recorded here."""
    run_id = conn.execute(
        "INSERT INTO ingest_runs (job, source, status) VALUES (%s, %s, 'running') RETURNING id",
        (job, source),
    ).fetchone()["id"]
    state = RunState(source=source)
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
