from app.stats.rebuild import rebuild_yearly_stats, run_rebuild_stats
from tests.factories import seed_stats_world


def stat(conn, year, owner, object_type, regime="LEO"):
    return conn.execute(
        "SELECT in_orbit, added, reentered FROM yearly_stats "
        "WHERE year = %s AND owner = %s AND object_type = %s AND regime = %s",
        (year, owner, object_type, regime),
    ).fetchone()


def test_in_orbit_added_and_reentered(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    assert stat(conn, 2007, "PRC", "DEB") == {"in_orbit": 1, "added": 1, "reentered": 0}
    assert stat(conn, 2009, "PRC", "DEB") == {"in_orbit": 1, "added": 0, "reentered": 0}
    assert stat(conn, 2010, "PRC", "DEB") == {"in_orbit": 0, "added": 0, "reentered": 1}
    assert stat(conn, 2011, "PRC", "DEB") is None
    assert stat(conn, 2020, "US", "PAY", "GEO") == {"in_orbit": 1, "added": 0, "reentered": 0}


def test_same_year_add_and_decay(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    assert stat(conn, 2015, "CIS", "R/B") == {"in_orbit": 0, "added": 1, "reentered": 1}


def test_totals_per_year(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    rows = conn.execute(
        "SELECT year, sum(in_orbit)::int AS n FROM yearly_stats "
        "WHERE year IN (1999, 2000, 2008, 2012) GROUP BY year ORDER BY year"
    ).fetchall()
    assert [(r["year"], r["n"]) for r in rows] == [(2000, 1), (2008, 3), (2012, 2)]


def test_rebuild_takes_advisory_lock_before_writing(conn, monkeypatch):
    # Deterministic (no real concurrency): a spy on conn.execute confirms the advisory
    # lock is acquired as the transaction's first statement, before the DELETE — this is
    # what serializes concurrent rebuilds and avoids the yearly_stats unique violation.
    seed_stats_world(conn)
    calls: list[str] = []
    original_execute = conn.execute

    def spy(query, *args, **kwargs):
        calls.append(str(query))
        return original_execute(query, *args, **kwargs)

    monkeypatch.setattr(conn, "execute", spy)
    rebuild_yearly_stats(conn)
    assert "pg_advisory_xact_lock" in calls[0]


def test_rebuild_replaces_previous_rows_and_logs(conn):
    seed_stats_world(conn)
    first = run_rebuild_stats(conn)
    second = run_rebuild_stats(conn)
    assert first == second > 0
    count = conn.execute("SELECT count(*) AS n FROM yearly_stats").fetchone()["n"]
    assert count == first
    run = conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert (run["job"], run["status"]) == ("rebuild_stats", "ok")
