from datetime import UTC, datetime

from app.services.globe import globe_names

GP_SQL = (
    "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
    "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
    "VALUES (%s, %s, 15.5, 0.001, 53, 10, 20, 30, 0.0001, 0, 0, 'spacetrack')"
)


def add_gp(conn, *ids):
    for i in ids:
        conn.execute(GP_SQL, (i, datetime(2026, 9, 22, tzinfo=UTC)))


def test_names_follow_snapshot_groups(world):
    add_gp(world, 1, 2, 3, 4)  # 2 and 3 are decayed in seed_stats_world
    assert globe_names(world, "LEO") == {"1": "ALPHA SAT"}
    assert globe_names(world, "HIGH") == {"4": "GAMMA GEO"}


def test_names_endpoint_shape_and_cache_headers(client, world):
    add_gp(world, 1, 4)
    r = client.get("/api/globe/names?group=LEO")
    assert r.status_code == 200
    body = r.json()
    assert body["names"] == {"1": "ALPHA SAT"}
    assert "generated_at" in body
    assert r.headers["cache-control"] == "public, max-age=300, s-maxage=21600"
    etag = r.headers["etag"]
    again = client.get("/api/globe/names?group=LEO", headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_names_endpoint_rejects_unknown_group(client):
    r = client.get("/api/globe/names?group=MARS")
    assert r.status_code == 422
    assert r.json()["error"]["code"]
