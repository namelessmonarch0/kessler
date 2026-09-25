import json
from datetime import UTC, date, datetime

from app.config import Settings
from app.history import __main__ as cli
from app.history.archive import archive_key, encode_records
from app.history.read import read_history


def omm(norad_id: str, epoch: str, **extra) -> dict:
    return {"NORAD_CAT_ID": norad_id, "EPOCH": epoch, **extra}


def put_run(store, run_at: datetime, run_id: int, records: list[dict],
            source="spacetrack"):
    store.put(archive_key(run_at, source, run_id), encode_records(records))


def test_round_trips_every_field(store):
    record = omm("25544", "2026-09-22T06:30:37.496448", TLE_LINE1="1 25544U",
                 GP_ID="284716723")
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1, [record])
    assert list(read_history(store, date(2026, 9, 25), date(2026, 9, 25))) == [
        record]


def test_repeats_and_older_epochs_are_dropped(store):
    first = omm("25544", "2026-09-25T00:10:00")
    unknown = omm("999999", "2026-09-24T00:00:00")
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1,
            [first, unknown])
    # A retried run re-archives `first`; the unknown object repeats until SATCAT
    # knows it.
    put_run(store, datetime(2026, 9, 25, 6, 41, tzinfo=UTC), 2,
            [first, unknown])
    newer = omm("25544", "2026-09-25T06:00:00")
    put_run(store, datetime(2026, 9, 25, 12, 41, tzinfo=UTC), 3,
            [newer, omm("25544", "2026-09-24T00:00:00")])
    out = list(read_history(store, date(2026, 9, 25), date(2026, 9, 25)))
    assert out == [first, unknown, newer]


def test_date_range_is_inclusive_utc_days(store):
    for day in (24, 25, 26, 27):
        put_run(store, datetime(2026, 9, day, 0, 41, tzinfo=UTC), day,
                [omm(str(day), f"2026-09-{day}T00:00:00")])
    out = list(read_history(store, date(2026, 9, 25), date(2026, 9, 26)))
    assert [r["NORAD_CAT_ID"] for r in out] == ["25", "26"]


def test_missing_days_and_empty_files_read_as_nothing(store):
    assert list(read_history(store, date(2026, 9, 1), date(2026, 9, 30))) == []
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1, [])
    assert list(read_history(store, date(2026, 9, 25), date(2026, 9, 25))) == []
    # end < start
    assert list(read_history(store, date(2026, 9, 26), date(2026, 9, 25))) == []


def test_dump_prints_json_lines(store, monkeypatch, capsys):
    record = omm("25544", "2026-09-22T06:30:37.496448")
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1, [record])
    monkeypatch.setattr(cli, "load_settings", lambda: Settings())
    monkeypatch.setattr(cli, "make_store", lambda settings: store)
    cli.main(["dump", "--from", "2026-09-25", "--to", "2026-09-25"])
    lines = capsys.readouterr().out.splitlines()
    assert [json.loads(line) for line in lines] == [record]
