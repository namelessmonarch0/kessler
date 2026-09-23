from datetime import UTC, datetime

import pytest

from app.domain.orbits import ATTRIBUTION
from app.errors import ApiError
from app.seeds import load_seeds
from app.services.events import list_events
from app.services.meta import get_meta
from app.services.objects import escape_like, get_object, search_objects
from tests.factories import insert_object, seed_stats_world


@pytest.fixture
def world(conn):
    load_seeds(conn)
    seed_stats_world(conn)
    return conn


def test_get_object_includes_joins_and_elements(world):
    world.execute(
        "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
        "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
        "VALUES (1, %s, 15.5, 0.001, 53, 10, 20, 30, 0.0001, 0, 0, 'spacetrack')",
        (datetime(2026, 9, 22, tzinfo=UTC),),
    )
    world.execute("UPDATE objects SET ops_status = '+' WHERE norad_id = 1")
    obj = get_object(world, 1)
    assert obj["name"] == "ALPHA SAT"
    assert obj["inclination"] == 53.0  # SATCAT value survives the GP join
    assert obj["owner_name"] == "United States"
    assert obj["ops_status_label"] == "Operational"
    assert obj["elements"]["mean_motion"] == 15.5
    assert obj["event"] is None
    assert get_object(world, 2)["elements"] is None
    assert get_object(world, 999) is None


def test_get_object_includes_event(world):
    world.execute("UPDATE objects SET event_id = 'fengyun-1c-2007' WHERE norad_id = 2")
    assert get_object(world, 2)["event"]["name"] == "Fengyun-1C anti-satellite test"


def test_search_by_name_cospar_and_number(world):
    assert [o["norad_id"] for o in search_objects(world, "alpha")] == [1, 2]
    assert [o["norad_id"] for o in search_objects(world, "1999-025")] == [2]
    assert [o["norad_id"] for o in search_objects(world, "4")] == [4]


def test_search_treats_wildcards_literally(world):
    assert [o["norad_id"] for o in search_objects(world, "50%_")] == [3]
    assert search_objects(world, "%%") == []
    assert search_objects(world, "a\\b") == []
    assert escape_like("50%_\\") == "50\\%\\_\\\\"


def test_search_rejects_one_letter_queries(world):
    with pytest.raises(ApiError) as e:
        search_objects(world, " a ")
    assert e.value.code == "invalid_query"


def test_search_orders_in_orbit_first(world):
    insert_object(world, 10, name="ALPHA OLD", decay_date=datetime(2001, 1, 1).date())
    ids = [o["norad_id"] for o in search_objects(world, "alpha")]
    assert ids.index(10) == len(ids) - 1


def test_search_rejects_non_ascii_digit_as_number(world):
    with pytest.raises(ApiError) as e:
        search_objects(world, "²")  # single superscript-two char; isdigit() but not ascii
    assert e.value.code == "invalid_query"
    assert search_objects(world, "①①") == []  # circled digit one, twice


def test_search_rejects_oversized_number_without_db_error(world):
    assert search_objects(world, "99999999999") == []


def test_list_events_counts_pieces(world):
    world.execute("UPDATE objects SET event_id = 'fengyun-1c-2007' WHERE norad_id = 2")
    events = {e["id"]: e for e in list_events(world)}
    fy = events["fengyun-1c-2007"]
    assert (fy["pieces_total"], fy["pieces_in_orbit"]) == (1, 0)
    assert events["kosmos-1408-2021"]["pieces_total"] == 0
    assert list(events) == sorted(events, key=lambda k: events[k]["event_date"])


def test_meta(world):
    world.execute(
        "INSERT INTO ingest_runs (job, source, status, finished_at, rows) "
        "VALUES ('ingest_satcat', 'celestrak', 'ok', now(), 4)"
    )
    m = get_meta(world)
    assert m["attribution"] == ATTRIBUTION
    assert m["data_as_of"]["satcat"] is not None and m["data_as_of"]["gp"] is None
    assert m["in_orbit"] == {"PAY": {"LEO": 1, "GEO": 1}}
    assert [o["code"] for o in m["owners"]][:1] == ["US"]
    assert all(o["total"] > 0 for o in m["owners"])
    assert m["types"]["DEB"] == "Debris"
