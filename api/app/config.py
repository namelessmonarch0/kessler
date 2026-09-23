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
