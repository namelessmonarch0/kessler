from datetime import UTC, datetime

import pytest

from app.ingest.snapshot import generation_key, publish_generation, snapshot_key
from tests.factories import add_gp

T0 = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
GEN = "20260925T064112Z-r42"
IMMUTABLE = "public, max-age=31536000, immutable"
CURRENT = "public, max-age=60, s-maxage=300"


@pytest.fixture
def published(world, store):
    add_gp(world, 1, 2, 3, 4)
    publish_generation(world, store, T0, 42)
    return store


def test_current_is_404_until_a_generation_exists(client):
    r = client.get("/api/globe/current")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_current_returns_the_pointer(client, published):
    r = client.get("/api/globe/current")
    assert r.status_code == 200
    assert r.json()["generation"] == GEN
    assert r.headers["cache-control"] == "public, max-age=60, s-maxage=60"


def test_versioned_snapshot_is_immutable(client, published):
    r = client.get(f"/api/globe/snapshot?group=LEO&gen={GEN}")
    assert r.status_code == 200
    assert r.content == published.get(generation_key(GEN, "LEO.bin.gz"))
    assert r.headers["cache-control"] == IMMUTABLE
    again = client.get(f"/api/globe/snapshot?group=LEO&gen={GEN}",
                       headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304


def test_versioned_names_come_from_the_generation_not_the_database(client, published, world):
    world.execute("UPDATE objects SET name = 'RENAMED' WHERE norad_id = 1")
    r = client.get(f"/api/globe/names?group=LEO&gen={GEN}")
    assert r.status_code == 200
    assert r.json() == {"generated_at": T0.isoformat(), "names": {"1": "ALPHA SAT"}}
    assert r.headers["cache-control"] == IMMUTABLE


def test_unknown_generation_is_404(client, published):
    other = "20200101T000000Z-r1"
    assert client.get(f"/api/globe/snapshot?group=LEO&gen={other}").status_code == 404
    assert client.get(f"/api/globe/names?group=LEO&gen={other}").status_code == 404


@pytest.mark.parametrize("bad", ["../current.json", "20260925T064112Z-r42/../x", "latest", ""])
def test_versioned_endpoints_reject_malformed_generations(client, published, bad):
    for path in ("snapshot", "names"):
        r = client.get(f"/api/globe/{path}", params={"group": "LEO", "gen": bad})
        assert r.status_code == 422, (path, bad)


def test_unversioned_endpoints_serve_the_current_generation(client, published):
    r = client.get("/api/globe/snapshot?group=HIGH")
    assert r.status_code == 200
    assert r.content == published.get(generation_key(GEN, "HIGH.bin.gz"))
    assert r.headers["cache-control"] == CURRENT
    names = client.get("/api/globe/names?group=HIGH")
    assert names.json()["names"] == {"4": "GAMMA GEO"}
    assert names.headers["cache-control"] == CURRENT


def test_unversioned_snapshot_falls_back_to_the_legacy_file_before_any_generation(client, store):
    store.put(snapshot_key("LEO"), b"\x1f\x8bdata")
    r = client.get("/api/globe/snapshot?group=LEO")
    assert r.status_code == 200 and r.content == b"\x1f\x8bdata"
    assert r.headers["content-type"] == "application/octet-stream"
    assert client.get("/api/globe/snapshot?group=HIGH").status_code == 404
    assert client.get("/api/globe/names?group=LEO").status_code == 404


def test_names_reject_unknown_group(client):
    r = client.get("/api/globe/names?group=MARS")
    assert r.status_code == 422
    assert r.json()["error"]["code"]
