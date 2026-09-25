import pytest
from fastapi.testclient import TestClient

from app.api.main import create_app
from app.config import Settings
from app.db import Database
from tests.conftest import make_client  # noqa: F401  (re-export for this module)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_timeseries(client):
    r = client.get("/api/stats/timeseries?group_by=type&from=2006&to=2011")
    assert r.status_code == 200
    body = r.json()
    assert body["years"][0] == 2006
    assert {s["key"] for s in body["series"]} == {"PAY", "DEB"}
    assert "s-maxage=3600" in r.headers["cache-control"]


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("/api/stats/timeseries?owners=XX", "invalid_filter"),
        ("/api/stats/timeseries?from=2011&to=2006", "invalid_range"),
        ("/api/stats/timeseries?metric=bogus", "invalid_request"),
        ("/api/stats/distribution?field=perigee&bin_width=-5", "invalid_request"),
        ("/api/objects/search?q=a", "invalid_query"),
        ("/api/objects/notanumber", "invalid_request"),
        ("/api/objects/99999999999", "invalid_request"),
        # Regression: these used to hit Postgres with malformed input and 500 as text/plain.
        ("/api/stats/distribution?field=perigee&bin_width=1e-310", "invalid_request"),
        ("/api/objects/search?q=ab%00cd", "invalid_query"),
        ("/api/stats/timeseries?owners=US%00", "invalid_filter"),
    ],
)
def test_bad_params_return_422_json(client, url, code):
    r = client.get(url)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == code
    assert r.json()["error"]["message"]


def test_unhandled_exception_returns_json_500(world, migrated, store):
    from app.api.routes import get_conn

    def boom():
        raise RuntimeError("boom: something leaked")
        yield  # pragma: no cover - makes this a generator function

    db = Database(migrated)
    app = create_app(Settings(database_url=migrated), store=store, database=db)
    app.dependency_overrides[get_conn] = boom
    # raise_server_exceptions=False: a real ASGI server (uvicorn) never re-raises past a
    # registered exception handler; the TestClient default does, purely for debugging.
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/meta")
    db.close()
    assert r.status_code == 500
    assert r.json() == {"error": {"code": "internal", "message": "internal server error"}}
    assert "boom" not in r.text


def test_health_returns_503_json_when_db_unavailable(migrated, store):
    db = Database(migrated)
    app = create_app(Settings(database_url=migrated), store=store, database=db)
    with TestClient(app) as c:
        db.close()
        r = c.get("/api/health")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "unavailable"


def test_breakdown_and_distribution(client):
    b = client.get("/api/stats/breakdown?at=2008&by=owner").json()
    assert b["rows"][0]["key"] == "US"
    d = client.get("/api/stats/distribution?field=perigee&bin_width=100&regimes=LEO").json()
    assert [x["key"] for x in d["bins"]] == ["400"]


def test_objects_and_search(client):
    assert client.get("/api/objects/1").json()["name"] == "ALPHA SAT"
    missing = client.get("/api/objects/999")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"
    assert client.get("/api/objects/search?q=50%25_").json()[0]["norad_id"] == 3


def test_events_and_meta(client):
    events = client.get("/api/events").json()
    assert len(events) == 10
    meta = client.get("/api/meta").json()
    assert meta["attribution"].startswith("Data: USSPACECOM")


def test_origin_secret_required_except_health(world, migrated, store):
    c, db = make_client(migrated, store, origin_secret="s3cret")
    with c:
        assert c.get("/api/meta").status_code == 403
        assert c.get("/api/meta").json()["error"]["code"] == "forbidden"
        assert c.get("/api/meta", headers={"X-Origin-Auth": "wrong"}).status_code == 403
        assert c.get("/api/meta", headers={"X-Origin-Auth": "s3cret"}).status_code == 200
        assert c.get("/api/health").status_code == 200
    db.close()
