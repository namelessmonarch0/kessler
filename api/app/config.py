import os

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.ingest.snapshot import LocalSnapshotStore, SnapshotStore


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://leo:leo@localhost:5432/leo"
    spacetrack_user: str | None = None
    spacetrack_pass: str | None = None
    origin_secret: str | None = None
    snapshot_dir: str = "./.snapshots"
    snapshot_bucket: str | None = None
    ssm_prefix: str | None = None
    # Sanity floors: a payload smaller than this is treated as a broken upstream response.
    min_satcat_rows: int = 50_000
    min_gp_rows_spacetrack: int = 20_000
    min_gp_rows_celestrak: int = 5_000

    @field_validator(
        "spacetrack_user", "spacetrack_pass", "origin_secret",
        "snapshot_bucket", "ssm_prefix", mode="before",
    )
    @classmethod
    def _blank_to_none(cls, value: object) -> object:
        # .env.example ships these blank (e.g. `SPACETRACK_USER=`); pydantic-settings
        # otherwise reads that as "", not None, which silently changes behavior
        # (a falsy-but-truthy secret, an "empty credentials" Space-Track client, ...).
        if isinstance(value, str) and value.strip() == "":
            return None
        return value


# Parameters production cannot run without. A missing ORIGIN_SECRET would turn the public
# Function URL into an unauthenticated back door (spec §4), so it is fatal too.
PRODUCTION_PARAMETERS = ("DATABASE_URL", "ORIGIN_SECRET")


def load_settings() -> Settings:
    """Settings for a real process. When SSM_PREFIX is set (Lambda), secrets are loaded
    from SSM Parameter Store first and the production parameters become mandatory."""
    prefix = os.environ.get("SSM_PREFIX", "").strip()
    if prefix:
        from app import aws

        aws.load_ssm_env(prefix)
        missing = [n for n in PRODUCTION_PARAMETERS if not os.environ.get(n, "").strip()]
        if missing:
            names = ", ".join(prefix.rstrip("/") + "/" + n for n in missing)
            raise RuntimeError(f"missing required SSM parameters: {names}")
    return Settings()


def make_store(settings: Settings) -> SnapshotStore:
    if settings.snapshot_bucket:
        from app.aws import S3SnapshotStore

        return S3SnapshotStore(settings.snapshot_bucket)
    return LocalSnapshotStore(settings.snapshot_dir)
