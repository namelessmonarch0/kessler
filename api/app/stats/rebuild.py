import psycopg

from app.ingest.runlog import run_log

REBUILD_SQL = """
INSERT INTO yearly_stats (year, owner, object_type, regime, in_orbit, added, reentered)
SELECT y.year, o.owner, o.object_type, o.regime,
       count(*) FILTER (WHERE o.dy IS NULL OR o.dy > y.year),
       count(*) FILTER (WHERE o.first_seen_year = y.year),
       count(*) FILTER (WHERE o.dy = y.year)
FROM generate_series(1957, extract(year FROM now())::int) AS y(year)
JOIN (
  SELECT owner, object_type, regime, first_seen_year,
         extract(year FROM decay_date)::int AS dy
  FROM objects
) o ON o.first_seen_year <= y.year AND (o.dy IS NULL OR o.dy >= y.year)
GROUP BY y.year, o.owner, o.object_type, o.regime
"""


def rebuild_yearly_stats(conn: psycopg.Connection) -> int:
    with conn.transaction():
        # Serializes concurrent rebuilds: without this, two overlapping rebuilds can both
        # pass the DELETE and then race on the yearly_stats primary key, one hitting a
        # unique violation. The lock is transaction-scoped and released automatically.
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('rebuild_stats'))")
        conn.execute("DELETE FROM yearly_stats")
        return conn.execute(REBUILD_SQL).rowcount


def run_rebuild_stats(conn: psycopg.Connection) -> int:
    with run_log(conn, "rebuild_stats", source="db") as run:
        run.rows = rebuild_yearly_stats(conn)
    return run.rows
