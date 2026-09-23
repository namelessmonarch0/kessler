from datetime import date

import pytest

from app.domain.catalog import (
    CatalogYearIndex,
    EventRef,
    first_seen_year,
    link_event,
    parent_cospar,
)
from app.domain.orbits import classify_regime, rcs_size


@pytest.mark.parametrize(
    ("apogee", "perigee", "center", "expected"),
    [
        (422, 416, "EA", "LEO"),          # ISS
        (1999.9, 300, "EA", "LEO"),
        (20464, 19900, "EA", "MEO"),      # GPS
        (36129, 36102, "EA", "GEO"),
        (3818, 652, "EA", "HEO"),         # Vanguard 1
        (None, None, "EA", "OTHER"),
        (500, 400, "MO", "OTHER"),        # lunar orbit
        (500, 400, None, "LEO"),          # missing center is treated as Earth
        (500, 400, "", "LEO"),
    ],
)
def test_classify_regime(apogee, perigee, center, expected):
    assert classify_regime(apogee, perigee, center) == expected


@pytest.mark.parametrize(
    ("rcs", "expected"),
    [(None, None), (0.05, "SMALL"), (0.1, "MEDIUM"), (1.0, "MEDIUM"), (20.42, "LARGE")],
)
def test_rcs_size(rcs, expected):
    assert rcs_size(rcs) == expected


def test_catalog_year_index_uses_running_max():
    idx = CatalogYearIndex(
        [
            (2, date(1957, 10, 4)),
            (5, date(1958, 3, 17)),
            (25730, date(1999, 5, 10)),
            (27000, date(1990, 1, 1)),  # late-cataloged old payload must not pull years back
            (29228, date(2006, 6, 15)),
        ]
    )
    assert idx.year_for(1) is None
    assert idx.year_for(3) == 1957
    assert idx.year_for(26000) == 1999
    assert idx.year_for(28000) == 1999
    assert idx.year_for(30000) == 2006


@pytest.mark.parametrize(
    ("cospar", "expected"),
    [("1999-025AC", "1999-025"), ("1998-067A", "1998-067"), (None, None), ("", None), ("BAD", None)],
)
def test_parent_cospar(cospar, expected):
    assert parent_cospar(cospar) == expected


EVENTS = {"1999-025": EventRef("fengyun-1c-2007", 2007)}


def test_link_event_matches_debris_cataloged_after_event():
    assert link_event("DEB", "1999-025", 2008, EVENTS) == EventRef("fengyun-1c-2007", 2007)


def test_link_event_allows_one_year_catalog_lag():
    assert link_event("DEB", "1999-025", 2006, EVENTS) == EventRef("fengyun-1c-2007", 2007)


def test_link_event_rejects_earlier_pieces_payloads_and_unknown_parents():
    assert link_event("DEB", "1999-025", 2005, EVENTS) is None
    assert link_event("PAY", "1999-025", 2008, EVENTS) is None
    assert link_event("DEB", "2000-001", 2008, EVENTS) is None
    assert link_event("DEB", None, 2008, EVENTS) is None
    assert link_event("DEB", "1999-025", None, EVENTS) is None


def test_first_seen_uses_later_of_launch_and_catalog_year():
    assert first_seen_year(1999, 2007, None, None) == 2007
    assert first_seen_year(2020, 2019, None, None) == 2020


def test_first_seen_prefers_event_year():
    assert first_seen_year(1999, 2010, 2007, None) == 2007


def test_first_seen_clamped_to_decay_year():
    assert first_seen_year(1998, 2026, None, 2010) == 2010
    assert first_seen_year(1999, 2006, 2007, 2007) == 2007


def test_first_seen_falls_back_to_1957():
    assert first_seen_year(None, None, None, None) == 1957
