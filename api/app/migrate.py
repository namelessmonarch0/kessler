from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine

API_ROOT = Path(__file__).resolve().parents[1]


def _sqlalchemy_url(url: str) -> str:
    return "postgresql+psycopg://" + url[len("postgresql://"):] if url.startswith(
        "postgresql://") else url


def upgrade_head(database_url: str) -> str:
    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(cfg, "head")
    engine = create_engine(_sqlalchemy_url(database_url))
    try:
        with engine.connect() as conn:
            return MigrationContext.configure(conn).get_current_revision()
    finally:
        engine.dispose()
