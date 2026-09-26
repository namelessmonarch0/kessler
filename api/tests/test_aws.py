import os

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.api.main import create_app
from app.aws import S3SnapshotStore, load_ssm_env
from app.config import LocalSnapshotStore, Settings, load_settings, make_store
from app.db import Database
from app.ingest.snapshot import snapshot_key

REGION = "us-east-2"


@pytest.fixture
def aws(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    with mock_aws():
        yield


def clear_env(monkeypatch, *names: str) -> None:
    """Unset names so load_ssm_env sets them, and have monkeypatch remove them afterwards.
    (monkeypatch.delenv alone records nothing for an absent var, so values load_ssm_env
    writes to os.environ would leak into later tests.)"""
    for name in names:
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)


def put_params(values: dict[str, str]) -> None:
    ssm = boto3.client("ssm", region_name=REGION)
    for name, value in values.items():
        ssm.put_parameter(Name=f"/kessler/{name}", Value=value, Type="SecureString")


def test_load_ssm_env_sets_missing_vars_only(aws, monkeypatch):
    clear_env(monkeypatch, "DATABASE_URL", "ORIGIN_SECRET")
    monkeypatch.setenv("SPACETRACK_USER", "from-env")
    put_params({"DATABASE_URL": "postgresql://neon/db", "SPACETRACK_USER": "from-ssm",
                "ORIGIN_SECRET": "s3cret"})
    names = load_ssm_env("/kessler/")
    assert sorted(names) == ["DATABASE_URL", "ORIGIN_SECRET"]
    assert os.environ["DATABASE_URL"] == "postgresql://neon/db"
    assert os.environ["SPACETRACK_USER"] == "from-env"  # explicit env wins


def test_load_ssm_env_pages_through_many_parameters(aws, monkeypatch):
    values = {f"P{i:02d}": str(i) for i in range(23)}  # > 10 = more than one page
    clear_env(monkeypatch, *values)
    put_params(values)
    assert len(load_ssm_env("/kessler/")) == 23


def test_load_settings_requires_production_parameters(aws, monkeypatch):
    monkeypatch.setenv("SSM_PREFIX", "/kessler/")
    clear_env(monkeypatch, "DATABASE_URL")
    with pytest.raises(RuntimeError, match="/kessler/DATABASE_URL"):
        load_settings()


def test_load_settings_reads_ssm_when_prefix_set(aws, monkeypatch):
    monkeypatch.setenv("SSM_PREFIX", "/kessler/")
    clear_env(monkeypatch, "DATABASE_URL")
    put_params({"DATABASE_URL": "postgresql://neon/db"})
    settings = load_settings()
    assert settings.database_url == "postgresql://neon/db"


def test_load_settings_without_prefix_touches_no_aws(monkeypatch):
    monkeypatch.delenv("SSM_PREFIX", raising=False)
    monkeypatch.setattr("app.aws.load_ssm_env", lambda *a, **k: pytest.fail("called SSM"))
    assert isinstance(load_settings(), Settings)


def test_s3_store_round_trip_and_missing_key(aws):
    boto3.client("s3", region_name=REGION).create_bucket(
        Bucket="snaps", CreateBucketConfiguration={"LocationConstraint": REGION}
    )
    store = S3SnapshotStore("snaps")
    assert store.get(snapshot_key("LEO")) is None
    store.put(snapshot_key("LEO"), b"LEO1-bytes")
    assert store.get(snapshot_key("LEO")) == b"LEO1-bytes"


def test_make_store_picks_s3_only_when_bucket_set(aws, tmp_path):
    assert isinstance(make_store(Settings(snapshot_dir=str(tmp_path))), LocalSnapshotStore)
    assert isinstance(make_store(Settings(snapshot_bucket="snaps")), S3SnapshotStore)


def test_snapshot_endpoint_404_when_s3_object_missing(aws, migrated):
    boto3.client("s3", region_name=REGION).create_bucket(
        Bucket="snaps", CreateBucketConfiguration={"LocationConstraint": REGION}
    )
    db = Database(migrated)
    app = create_app(Settings(database_url=migrated), store=S3SnapshotStore("snaps"),
                     database=db)
    with TestClient(app) as client:
        response = client.get("/api/globe/snapshot?group=LEO")
    db.close()
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_s3_store_keys_lists_sorted_keys_under_a_prefix(aws):
    boto3.client("s3", region_name=REGION).create_bucket(
        Bucket="snaps", CreateBucketConfiguration={"LocationConstraint": REGION}
    )
    store = S3SnapshotStore("snaps")
    for key in ("history/gp/2026/09/25/b", "history/gp/2026/09/25/a", "globe/LEO.bin.gz"):
        store.put(key, b"x")
    assert store.keys("history/gp/2026/09/25/") == [
        "history/gp/2026/09/25/a", "history/gp/2026/09/25/b",
    ]
    assert store.keys("history/gp/2026/09/26/") == []


def test_s3_store_delete_removes_a_key_and_ignores_missing_ones(aws):
    boto3.client("s3", region_name=REGION).create_bucket(
        Bucket="snaps", CreateBucketConfiguration={"LocationConstraint": REGION}
    )
    store = S3SnapshotStore("snaps")
    store.put("globe/gen/a/LEO.bin.gz", b"x")
    store.delete("globe/gen/a/LEO.bin.gz")
    store.delete("globe/gen/a/LEO.bin.gz")
    assert store.keys("globe/") == []
