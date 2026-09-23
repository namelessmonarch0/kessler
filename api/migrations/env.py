import os

from alembic import context
from sqlalchemy import create_engine


def _url() -> str:
    url = context.config.get_main_option("sqlalchemy.url") or os.environ["DATABASE_URL"]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def run_migrations_online() -> None:
    engine = create_engine(_url())
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


run_migrations_online()
