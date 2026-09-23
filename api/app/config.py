from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://leo:leo@localhost:5432/leo"
    spacetrack_user: str | None = None
    spacetrack_pass: str | None = None
    origin_secret: str | None = None
    snapshot_dir: str = "./.snapshots"
    # Sanity floors: a payload smaller than this is treated as a broken upstream response.
    min_satcat_rows: int = 50_000
    min_gp_rows_spacetrack: int = 20_000
    min_gp_rows_celestrak: int = 5_000

    @field_validator("spacetrack_user", "spacetrack_pass", "origin_secret", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> object:
        # .env.example ships these blank (e.g. `SPACETRACK_USER=`); pydantic-settings
        # otherwise reads that as "", not None, which silently changes behavior
        # (a falsy-but-truthy secret, an "empty credentials" Space-Track client, ...).
        if isinstance(value, str) and value.strip() == "":
            return None
        return value
