import psycopg
import pytest

EXPECTED = {
    "owners", "launch_sites", "breakup_events", "objects",
    "gp_elements", "yearly_stats", "ingest_runs",
}


def test_all_tables_exist(conn):
    rows = conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    ).fetchall()
    assert EXPECTED <= {r["table_name"] for r in rows}


def test_objects_rejects_unknown_regime(conn):
    conn.execute("INSERT INTO owners (code, name) VALUES ('US', 'United States')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO objects (norad_id, name, object_type, owner, regime, first_seen_year) "
            "VALUES (1, 'X', 'PAY', 'US', 'LUNAR', 2000)"
        )
