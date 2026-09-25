"""AWS adapters, used only in production (SSM_PREFIX / SNAPSHOT_BUCKET set)."""
import os

import boto3
from botocore.exceptions import ClientError


def load_ssm_env(prefix: str, client=None) -> list[str]:
    """Copy every parameter under `prefix` into os.environ (decrypted), keyed by the last
    path segment. Variables that are already set win, so local overrides keep working."""
    client = client or boto3.client("ssm")
    set_names: list[str] = []
    pages = client.get_paginator("get_parameters_by_path").paginate(
        Path=prefix, WithDecryption=True, Recursive=False
    )
    for page in pages:
        for param in page["Parameters"]:
            name = param["Name"].rsplit("/", 1)[-1]
            if name not in os.environ:
                os.environ[name] = param["Value"]
                set_names.append(name)
    return set_names


class S3SnapshotStore:
    def __init__(self, bucket: str, client=None):
        self.bucket = bucket
        self.client = client or boto3.client("s3")

    def put(self, key: str, data: bytes) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data,
                               ContentType="application/octet-stream")

    def get(self, key: str) -> bytes | None:
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return None
            raise
        return obj["Body"].read()

    def keys(self, prefix: str) -> list[str]:
        pages = self.client.get_paginator("list_objects_v2").paginate(
            Bucket=self.bucket, Prefix=prefix
        )
        return sorted(obj["Key"] for page in pages for obj in page.get("Contents", []))
