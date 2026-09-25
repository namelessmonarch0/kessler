from app.ingest.snapshot import LocalSnapshotStore


def test_local_keys_lists_sorted_keys_under_a_prefix(tmp_path):
    store = LocalSnapshotStore(tmp_path)
    for key in ("a/b/2", "a/b/1", "a/c/1", "top"):
        store.put(key, b"x")
    (tmp_path / "a" / "b" / "3.tmp").write_bytes(b"partial write")  # never a key
    assert store.keys("a/b/") == ["a/b/1", "a/b/2"]
    assert store.keys("a/") == ["a/b/1", "a/b/2", "a/c/1"]
    assert store.keys("") == ["a/b/1", "a/b/2", "a/c/1", "top"]


def test_local_keys_for_a_missing_prefix_is_empty(tmp_path):
    assert LocalSnapshotStore(tmp_path).keys("history/gp/2026/09/25/") == []
    assert LocalSnapshotStore(tmp_path / "not-created").keys("") == []
