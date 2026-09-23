import pytest

from app.errors import ApiError
from app.services.filters import Filters, parse_filters, parse_year_range
from app.services.stats import OTHER_KEY, _fold_top, breakdown, distribution, timeseries
from app.stats.rebuild import rebuild_yearly_stats
from tests.factories import insert_object, seed_stats_world

ALL = Filters(None, None, None)


@pytest.fixture
def world(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    return conn


def series(result):
    return {s["key"]: s["values"] for s in result["series"]}


def test_parse_filters_normalizes_case_and_blanks(world):
    f = parse_filters(world, " us ,,prc", "pay,deb", "leo")
    assert f == Filters(("US", "PRC"), ("PAY", "DEB"), ("LEO",))
    assert parse_filters(world, None, "", None) == ALL


def test_parse_filters_rejects_unknown_owner(world):
    with pytest.raises(ApiError) as e:
        parse_filters(world, "US,XX", None, None)
    assert e.value.status == 422 and e.value.code == "invalid_filter" and "XX" in e.value.message


def test_parse_filters_rejects_unknown_type_and_regime(world):
    with pytest.raises(ApiError, match="object type"):
        parse_filters(world, None, "SAT", None)
    with pytest.raises(ApiError, match="regime"):
        parse_filters(world, None, None, "LUNAR")


def test_parse_year_range():
    assert parse_year_range(None, None, 2026) == (1957, 2026)
    assert parse_year_range(2006, 2011, 2026) == (2006, 2011)
    for bad in [(2011, 2006), (1900, 2000), (2000, 2030)]:
        with pytest.raises(ApiError) as e:
            parse_year_range(*bad, 2026)
        assert e.value.code == "invalid_range"


def test_timeseries_in_orbit_by_type(world):
    r = timeseries(world, metric="in_orbit", group_by="type", filters=ALL,
                   from_year=2006, to_year=2011)
    assert r["years"] == [2006, 2007, 2008, 2009, 2010, 2011]
    assert series(r) == {"PAY": [2] * 6, "DEB": [0, 1, 1, 1, 0, 0]}


def test_timeseries_respects_filters(world):
    leo = Filters(None, None, ("LEO",))
    r = timeseries(world, metric="in_orbit", group_by="none", filters=leo,
                   from_year=2006, to_year=2008)
    assert series(r) == {"all": [1, 2, 2]}


def test_timeseries_added_and_reentered(world):
    added = timeseries(world, metric="added", group_by="none", filters=ALL,
                       from_year=2005, to_year=2008)
    assert series(added) == {"all": [1, 0, 1, 0]}
    gone = timeseries(world, metric="reentered", group_by="type", filters=ALL,
                      from_year=2010, to_year=2015)
    assert series(gone) == {"DEB": [1, 0, 0, 0, 0, 0], "R/B": [0, 0, 0, 0, 0, 1]}


def test_fold_top_keeps_leaders_and_sums_the_rest():
    folded = _fold_top({"US": [1, 2], "PRC": [3, 1], "CIS": [0, 1]}, top=1)
    assert folded == {"US": [1, 2], OTHER_KEY: [3, 2]}


def test_breakdown_by_owner(world):
    r = breakdown(world, at_year=2008, by="owner", filters=ALL)
    assert r["rows"] == [
        {"key": "US", "counts": {"PAY": 2}, "total": 2},
        {"key": "PRC", "counts": {"DEB": 1}, "total": 1},
    ]


def test_distribution_perigee_bins(world):
    r = distribution(world, field="perigee", filters=ALL, bin_width=100)
    assert [(b["key"], b["total"]) for b in r["bins"]] == [("400", 1), ("35700", 1)]
    assert r["bins"][0]["counts"] == {"PAY": 1}


def test_distribution_does_not_merge_bins_whose_labels_collide(conn):
    # Four perigee values 0.0001 apart: `floor(perigee/width)*width` gives 4 distinct
    # `start` floats that all format to the same 6-sig-fig "g" label ("1234.56"). The
    # bins must stay separate (grouped by the exact bin, not by the display string) and
    # each object_type's count must accumulate rather than get clobbered by the next row.
    for i, perigee in enumerate([1234.5600, 1234.5601, 1234.5602, 1234.5603], start=1):
        insert_object(conn, i, perigee=perigee, object_type="PAY", owner="US", regime="LEO")
    r = distribution(conn, field="perigee", filters=ALL, bin_width=0.0001)
    assert {b["key"] for b in r["bins"]} == {"1234.56"}
    assert len(r["bins"]) == 4
    assert all(b["counts"] == {"PAY": 1} and b["total"] == 1 for b in r["bins"])


def test_distribution_rcs_categories(world):
    world.execute("UPDATE objects SET rcs_size = 'LARGE' WHERE norad_id = 1")
    r = distribution(world, field="rcs_size", filters=ALL)
    assert r["bin_width"] is None
    assert {b["key"]: b["total"] for b in r["bins"]} == {"LARGE": 1, "UNKNOWN": 1}
