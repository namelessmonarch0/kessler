import gzip
import json
from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from app.config import Settings
from app.domain.orbits import parse_epoch
from app.history.archive import (
    archive_gp,
    archive_key,
    day_prefix,
    decode_records,
    encode_records,
    select_new_records,
)
from app.ingest.satcat import run_ingest_satcat
from tests.test_ingest_satcat import SAMPLE, FakeCelesTrak

SETTINGS = Settings(min_satcat_rows=10)
ISS_EPOCH = datetime(2026, 9, 22, 6, 30, 37, 496448, tzinfo=UTC)


def omm(norad_id: str, epoch: str, **extra) -> dict:
    return {"NORAD_CAT_ID": norad_id, "EPOCH": epoch, "MEAN_MOTION": "15.49", **extra}


@pytest.fixture
def catalog(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=SETTINGS)
    return conn


def store_epoch(conn, norad_id: int, epoch: datetime) -> None:
    conn.execute(
        "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
        "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
        "VALUES (%s, %s, 15, 0, 51.6, 0, 0, 0, 0, 0, 0, 'test')",
        (norad_id, epoch),
    )


def test_parse_epoch_treats_naive_times_as_utc():
    assert parse_epoch("2026-09-22T06:30:37.496448") == ISS_EPOCH
    assert parse_epoch("2026-09-22T06:30:37.496448Z") == ISS_EPOCH
    assert parse_epoch("2026-09-22T08:30:37.496448+02:00") == ISS_EPOCH


def test_archive_key_is_utc_and_unique_per_run():
    run_at = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
    assert archive_key(run_at, "spacetrack", 42) == (
        "history/gp/2026/09/25/064112Z-spacetrack-r42.jsonl.gz"
    )
    local = run_at.astimezone(timezone(timedelta(hours=-5)))  # same instant, UTC-5
    assert archive_key(local, "celestrak", 7) == (
        "history/gp/2026/09/25/064112Z-celestrak-r7.jsonl.gz"
    )
    assert day_prefix(date(2026, 9, 5)) == "history/gp/2026/09/05/"


def test_encode_round_trips_records_exactly_and_is_gzip():
    records = [omm("25544", "2026-09-22T06:30:37.496448", TLE_LINE1="1 25544U 98067A"),
               {"OBJECT_NAME": "NAVSTAR 43 (USA 132)", "NORAD_CAT_ID": "24876"}]
    data = encode_records(records)
    lines = gzip.decompress(data).decode("utf-8").splitlines()
    assert [json.loads(line) for line in lines] == records
    assert list(json.loads(lines[0])) == list(records[0])  # field order kept
    assert decode_records(data) == records
    assert decode_records(encode_records([])) == []


def test_unstored_and_newer_element_sets_are_new(catalog):
    store_epoch(catalog, 25544, ISS_EPOCH)
    items = [
        omm("25544", "2026-09-22T12:00:00.000000"),  # newer than stored
        omm("24876", "2026-09-22T10:11:43.219392"),  # no stored row
        omm("123456", "2026-09-21T00:00:00.000000"),  # unknown to the catalogue
    ]
    assert select_new_records(catalog, items) == items


def test_equal_or_older_element_sets_are_not_new(catalog):
    store_epoch(catalog, 25544, ISS_EPOCH)
    items = [omm("25544", "2026-09-22T06:30:37.496448"), omm("25544", "2026-09-21T00:00:00")]
    assert select_new_records(catalog, items) == []


def test_same_instant_in_another_format_is_not_new(catalog):
    store_epoch(catalog, 25544, ISS_EPOCH)
    items = [omm("25544", "2026-09-22T06:30:37.496448Z"),
             omm("25544", "2026-09-22T06:30:37.496448+00:00")]
    assert select_new_records(catalog, items) == []


def test_malformed_records_are_skipped(catalog):
    good = omm("25544", "2026-09-22T06:30:37.496448")
    items = [{"NORAD_CAT_ID": "25544"}, omm("ISS", "2026-09-22T06:30:37"),
             omm("25544", "not-a-date"), omm("25544", None), good]
    assert select_new_records(catalog, items) == [good]


def test_archive_gp_writes_one_file_for_the_run(catalog, store):
    run_at = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
    items = [omm("25544", "2026-09-22T06:30:37.496448")]
    n = archive_gp(catalog, store, items, source="spacetrack", run_at=run_at, run_id=3)
    assert n == 1
    key = "history/gp/2026/09/25/064112Z-spacetrack-r3.jsonl.gz"
    assert store.keys("history/") == [key]
    assert decode_records(store.get(key)) == items


def test_archive_gp_writes_an_empty_file_when_nothing_is_new(catalog, store):
    store_epoch(catalog, 25544, ISS_EPOCH)
    run_at = datetime(2026, 9, 25, 12, 41, tzinfo=UTC)
    items = [omm("25544", "2026-09-22T06:30:37.496448")]
    assert archive_gp(catalog, store, items, source="spacetrack", run_at=run_at, run_id=4) == 0
    [key] = store.keys("history/")
    assert decode_records(store.get(key)) == []
