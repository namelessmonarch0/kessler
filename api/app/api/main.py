from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.auth import install_origin_auth
from app.api.errors import install_error_handlers
from app.api.routes import router
from app.config import Settings, load_settings, make_store
from app.db import Database
from app.ingest.snapshot import SnapshotStore


def create_app(
    settings: Settings | None = None,
    *,
    store: SnapshotStore | None = None,
    database: Database | None = None,
) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = database or Database(settings.database_url)
        app.state.db = db
        app.state.store = store or make_store(settings)
        app.state.settings = settings
        yield
        if database is None:
            db.close()

    app = FastAPI(title="Kessler API", version="0.1.0", lifespan=lifespan)
    install_error_handlers(app)
    install_origin_auth(app, settings.origin_secret)
    app.include_router(router)
    return app
