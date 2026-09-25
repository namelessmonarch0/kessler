import gzip
import json
import logging
from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.ingest.snapshot import (
    POINTER_KEY,
    LocalSnapshotStore,
    generation_id,
    generation_key,
    publish_generation,
    read_pointer,
    snapshot_key,
    unpack_snapshot,
)
from tests.factories import add_gp

T0 = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
FILES = ("LEO.bin.gz", "HIGH.bin.gz", "names-LEO.json.gz", "names-HIGH.json.gz")


def names(store, gen, group):
    return json.loads(gzip.decompress(store.get(generation_key(gen, f"names-{group}.json.gz"))))


class FailingStore(LocalSnapshotStore):
    def __init__(self, root, fail_suffix):
        super().__init__(root)
        self.fail_suffix = fail_suffix

    def put(self, key, data):
        if key.endswith(self.fail_suffix):
            raise OSError("S3 unavailable")
        super().put(key, data)


def test_generation_id_is_utc_time_and_run():
    assert generation_id(T0, 42) == "20260925T064112Z-r42"
    assert generation_id(T0.astimezone(timezone(timedelta(hours=-5))), 7) == "20260925T064112Z-r7"


def test_publish_writes_both_groups_names_and_then_the_pointer(world, store):
    add_gp(world, 1, 2, 3, 4)  # 2 and 3 are decayed in seed_stats_world
    counts = publish_generation(world, store, T0, 42)
    gen = "20260925T064112Z-r42"
    assert counts == {"LEO": 1, "HIGH": 1}
    assert sorted(store.keys(f"globe/gen/{gen}/")) == sorted(generation_key(gen, f) for f in FILES)
    assert read_pointer(store) == {
        "generation": gen, "generated_at": "2026-09-25T06:41:12+00:00",
        "groups": {"LEO": {"count": 1}, "HIGH": {"count": 1}},
    }
    _, leo = unpack_snapshot(store.get(generation_key(gen, "LEO.bin.gz")))
    assert [r[0] for r in leo] == [1]
    assert names(store, gen, "LEO") == {"generated_at": T0.isoformat(), "names": {"1": "ALPHA SAT"}}
    assert names(store, gen, "HIGH")["names"] == {"4": "GAMMA GEO"}


@pytest.mark.parametrize("failing", FILES)
def test_a_failed_file_leaves_the_previous_generation_live(world, tmp_path, failing):
    add_gp(world, 1, 4)
    good = LocalSnapshotStore(tmp_path)
    publish_generation(world, good, T0, 1)
    with pytest.raises(OSError, match="S3 unavailable"):
        publish_generation(world, FailingStore(tmp_path, f"/{failing}"), T0 + timedelta(hours=6), 2)
    assert read_pointer(good)["generation"] == "20260925T064112Z-r1"
    assert len(good.keys("globe/gen/20260925T064112Z-r1/")) == 4  # previous generation intact


def test_a_partial_orphan_generation_is_deleted_by_a_later_publication(world, tmp_path):
    add_gp(world, 1, 4)
    good = LocalSnapshotStore(tmp_path)
    publish_generation(world, good, T0, 1)
    a = "20260925T064112Z-r1"
    with pytest.raises(OSError, match="S3 unavailable"):
        publish_generation(
            world, FailingStore(tmp_path, "/HIGH.bin.gz"), T0 + timedelta(hours=6), 2
        )
    b = "20260925T124112Z-r2"  # orphan: never named by the pointer
    assert sorted(good.keys(f"globe/gen/{b}/")) == [
        generation_key(b, "LEO.bin.gz"), generation_key(b, "names-LEO.json.gz"),
    ]
    publish_generation(world, good, T0 + timedelta(hours=12), 3)
    c = "20260925T184112Z-r3"
    gens = {k.split("/")[2] for k in good.keys("globe/gen/")}
    assert gens == {a, c}  # a kept as the previously live one, orphan b removed
    assert read_pointer(good)["generation"] == c


def test_a_stray_key_under_globe_gen_that_is_not_a_generation_survives_cleanup(world, store):
    add_gp(world, 1, 4)
    store.put("globe/gen/not-a-generation/x", b"stray")
    publish_generation(world, store, T0, 1)
    assert store.get("globe/gen/not-a-generation/x") == b"stray"


def test_cleanup_keeps_current_previous_and_newer_and_drops_legacy_files(world, store):
    add_gp(world, 1, 4)
    store.put(snapshot_key("LEO"), b"legacy")
    store.put(snapshot_key("HIGH"), b"legacy")
    store.put(generation_key("20990101T000000Z-r999", "LEO.bin.gz"), b"from the future")
    for hours, run in ((0, 1), (6, 2), (12, 3)):
        publish_generation(world, store, T0 + timedelta(hours=hours), run)
    gens = {k.split("/")[2] for k in store.keys("globe/gen/")}
    assert gens == {"20260925T184112Z-r3", "20260925T124112Z-r2", "20990101T000000Z-r999"}
    assert store.get(snapshot_key("LEO")) is None and store.get(snapshot_key("HIGH")) is None


def test_cleanup_failure_does_not_fail_the_publication(world, tmp_path, caplog, monkeypatch):
    add_gp(world, 1, 4)
    store = LocalSnapshotStore(tmp_path)
    publish_generation(world, store, T0, 1)

    def broken_delete(key):
        raise OSError("delete denied")

    monkeypatch.setattr(store, "delete", broken_delete)
    with caplog.at_level(logging.WARNING):
        publish_generation(world, store, T0 + timedelta(hours=6), 2)
    assert read_pointer(store)["generation"] == "20260925T124112Z-r2"
    assert "could not remove old globe generations" in caplog.text


def test_read_pointer_is_none_before_the_first_publication(store):
    assert read_pointer(store) is None
    assert store.get(POINTER_KEY) is None
