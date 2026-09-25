from datetime import UTC, date, datetime

import psycopg

DEFAULTS = {
    "cospar_id": None, "object_type": "PAY", "ops_status": None, "owner": "US",
    "launch_date": None, "launch_site": None, "decay_date": None, "period": 95.0,
    "inclination": 53.0, "apogee": 500.0, "perigee": 480.0, "rcs_size": None,
    "regime": "LEO", "orbit_center": "EA", "parent_cospar": None, "event_id": None,
    "first_seen_year": 2000,
}


def insert_object(conn: psycopg.Connection, norad_id: int, **overrides) -> None:
    row = {**DEFAULTS, "name": f"OBJECT {norad_id}", **overrides, "norad_id": norad_id}
    conn.execute(
        "INSERT INTO owners (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (row["owner"], row["owner"]),
    )
    cols = ", ".join(row)
    vals = ", ".join(f"%({k})s" for k in row)
    conn.execute(f"INSERT INTO objects ({cols}) VALUES ({vals})", row)


def seed_stats_world(conn: psycopg.Connection) -> None:
    """Four objects with hand-computable yearly counts, used by stats and API tests."""
    insert_object(conn, 1, object_type="PAY", owner="US", first_seen_year=2000,
                  name="ALPHA SAT", cospar_id="2000-001A")
    insert_object(conn, 2, object_type="DEB", owner="PRC", first_seen_year=2007,
                  decay_date=date(2010, 5, 1), name="ALPHA DEB", cospar_id="1999-025AC")
    insert_object(conn, 3, object_type="R/B", owner="CIS", first_seen_year=2015,
                  decay_date=date(2015, 8, 1), name="BETA R/B 50%_OFF", cospar_id="2015-010B")
    insert_object(conn, 4, object_type="PAY", owner="US", regime="GEO", first_seen_year=2005,
                  apogee=35800.0, perigee=35780.0, inclination=0.1, name="GAMMA GEO")


GP_SQL = (
    "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
    "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
    "VALUES (%s, %s, 15.5, 0.001, 53, 10, 20, 30, 0.0001, 0, 0, 'spacetrack')"
)


def add_gp(conn: psycopg.Connection, *norad_ids: int) -> None:
    """A fixed element set (epoch 2026-09-22 UTC) for each object, for snapshot/globe tests."""
    for norad_id in norad_ids:
        conn.execute(GP_SQL, (norad_id, datetime(2026, 9, 22, tzinfo=UTC)))
