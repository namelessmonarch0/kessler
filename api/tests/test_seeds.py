from app.seeds import load_seeds


def test_load_seeds_is_idempotent_and_complete(conn):
    load_seeds(conn)
    load_seeds(conn)
    owners = conn.execute("SELECT count(*) AS n FROM owners").fetchone()["n"]
    sites = conn.execute("SELECT count(*) AS n FROM launch_sites").fetchone()["n"]
    events = conn.execute("SELECT count(*) AS n FROM breakup_events").fetchone()["n"]
    assert owners >= 40
    assert sites >= 30
    assert events == 10


def test_seed_values(conn):
    load_seeds(conn)
    us = conn.execute("SELECT * FROM owners WHERE code = 'US'").fetchone()
    assert us["name"] == "United States"
    assert us["flag_emoji"] == "\U0001F1FA\U0001F1F8"
    esa = conn.execute("SELECT * FROM owners WHERE code = 'ESA'").fetchone()
    assert esa["flag_emoji"] is None
    taiyuan = conn.execute("SELECT name FROM launch_sites WHERE code = 'TAISC'").fetchone()
    assert taiyuan["name"] == "Taiyuan"
    fy = conn.execute("SELECT * FROM breakup_events WHERE parent_cospar = '1999-025'").fetchone()
    assert fy["id"] == "fengyun-1c-2007"
    assert fy["event_date"].isoformat() == "2007-01-11"
    assert fy["kind"] == "ASAT"
