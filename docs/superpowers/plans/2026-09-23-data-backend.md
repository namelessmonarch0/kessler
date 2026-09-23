# LEO Debris: Data Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Python data backend for leo.kudayyurter.dev. It ingests the full space-object catalog (CelesTrak SATCAT) and current orbital elements (Space-Track GP, CelesTrak fallback) into Postgres, precomputes yearly statistics for every year 1957–today, writes globe snapshot files, and serves it all through a FastAPI REST API. It runs and is tested locally.

**Architecture:** This is a single Python package `api/app`. Pure domain rules (`app/domain`) sit apart from I/O. Ingest jobs (`app/ingest`, `app/stats`) write to Postgres through psycopg 3 with explicit transactions, and every run is logged in `ingest_runs`. Read-side service functions (`app/services`) are shared by the REST routes (`app/api`) and, in a later plan, the AI agent's tools. The schema is managed by Alembic using raw SQL migrations. AWS deployment (Lambda, S3, EventBridge) is **out of scope** here and is covered by the deploy plan. This plan leaves clean seams for it (`SnapshotStore` protocol, `run_job()` entry point, `create_app()` factory).

**Tech Stack:** Python 3.12, uv, FastAPI, psycopg 3 + psycopg-pool, Alembic (+SQLAlchemy only as Alembic's engine), httpx, pydantic-settings, pytest, testcontainers (Postgres `pgvector/pgvector:pg16`), respx, ruff.

**Spec:** `docs/superpowers/specs/2026-09-22-leo-debris-design.md` (read §3 Data and §4 API before starting).

## Global Constraints

- Python `>=3.12`; dependencies managed with **uv** (`uv sync`, `uv run ...`); all backend code lives under `api/`.
- Database: Postgres 16 (Neon in production). Connections use `autocommit=True`, `row_factory=dict_row`, `prepare_threshold=None` (required for Neon's pooled connection string), and every multi-statement write uses an explicit `with conn.transaction():`.
- SATCAT source: CelesTrak `https://celestrak.org/pub/satcat.csv` (primary). GP source: Space-Track (primary, bulk query only), CelesTrak `GROUP=active` (fallback, **upsert only, never a full replace**).
- Space-Track rate limits: under 30 requests/min and under 300/hr. One login plus one bulk GP query per run. Never loop per object.
- No catalog-number exclusion (the catalog runs 1–69,999 and then 100,000+).
- Regimes: LEO = apogee < 2,000 km; GEO = perigee 35,000–36,500 km; MEO = perigee ≥ 2,000 km and not GEO; HEO = perigee < 2,000 km and apogee ≥ 2,000 km; OTHER = orbit center not Earth, or missing apogee/perigee.
- `first_seen_year` = event year if linked to a breakup event, else `max(launch_year, catalog_year)`, then clamped to ≤ decay year. Link rule: DEB, matching `parent_cospar`, and `catalog_year ≥ event_year − 1`.
- In orbit at the end of year Y means `first_seen_year ≤ Y AND (decay_date IS NULL OR year(decay_date) > Y)`.
- Attribution string, verbatim: `Data: USSPACECOM via Space-Track.org; CelesTrak.`
- API errors always use the shape `{"error": {"code": str, "message": str}}`. There are no 500s for bad user input.
- Every git commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` after a blank line.
- `ruff check api` must pass before each commit.

## Review Focus

1. **Upstream returns garbage** (Space-Track login failure, an HTML error page, a truncated or empty CSV/JSON). The job must fail loudly, log `status='failed'` in `ingest_runs`, and leave the previous data untouched. *(Tests: Task 6 `test_bad_payload_keeps_previous_data`, `test_too_few_rows_is_rejected`; Task 7 `test_spacetrack_failure_within_24h_keeps_data`.)*
2. **Objects cataloged after they decayed, or added and decayed in the same year.** Counts must stay consistent: never negative, never dropped. *(Tests: Task 4 `test_first_seen_clamped_to_decay_year`; Task 8 `test_same_year_add_and_decay`.)*
3. **Sloppy query parameters** (lowercase owner codes, `US,,PRC`, unknown codes, `from > to`, unknown enum values). These must be normalized or rejected with 422 JSON, never a 500. *(Tests: Task 9 `test_parse_filters_*`; Task 11 `test_bad_params_return_422_json`.)*
4. **Search text containing `%`, `_` or `\`, or very short queries.** It must be matched literally and never error. *(Test: Task 10 `test_search_treats_wildcards_literally`.)*
5. **Space-Track down for a long time.** The CelesTrak fallback must refresh active satellites **without deleting** debris elements. *(Test: Task 7 `test_celestrak_fallback_upserts_without_deleting`.)*

---

## File Structure

```
api/
  pyproject.toml                 # deps, pytest + ruff config
  compose.yaml                   # local Postgres (pgvector image)
  alembic.ini
  README.md                      # local dev + job commands
  migrations/
    env.py
    script.py.mako
    versions/0001_initial.py     # all v1 tables
  app/
    __init__.py
    config.py                    # Settings (env vars)
    db.py                        # connect(), Database pool, CONN_KWARGS
    errors.py                    # ApiError
    domain/
      __init__.py
      orbits.py                  # classify_regime, rcs_size, label maps, ATTRIBUTION
      catalog.py                 # CatalogYearIndex, EventRef, parent_cospar, link_event, first_seen_year
    seeds/
      __init__.py                # load_seeds(conn)
      owners.csv
      launch_sites.csv
      breakup_events.csv
    ingest/
      __init__.py
      sources.py                 # SourceError, CelesTrakClient, SpaceTrackClient
      runlog.py                  # run_log(), RunState, last_success()
      satcat.py                  # parse_satcat_csv, derive_objects, upsert_objects, run_ingest_satcat
      gp.py                      # parse_gp_*, write_gp, fetch_gp, run_ingest_gp
      snapshot.py                # pack/unpack, SnapshotStore, LocalSnapshotStore, write_snapshots
    stats/
      __init__.py
      rebuild.py                 # rebuild_yearly_stats, run_rebuild_stats
    services/
      __init__.py
      filters.py                 # Filters, parse_filters, parse_year_range
      stats.py                   # timeseries, breakdown, distribution
      objects.py                 # get_object, search_objects
      events.py                  # list_events
      meta.py                    # get_meta
    api/
      __init__.py
      main.py                    # create_app()
      errors.py                  # exception handlers
      auth.py                    # X-Origin-Auth middleware
      routes.py                  # all /api routes
    jobs.py                      # run_job(), CLI (python -m app.jobs)
  tests/
    conftest.py
    factories.py
    fixtures/
      satcat_sample.csv
      gp_spacetrack_sample.json
      gp_celestrak_sample.csv
    test_config_db.py
    test_migrations.py
    test_seeds.py
    test_domain.py
    test_sources.py
    test_ingest_satcat.py
    test_ingest_gp.py
    test_stats_rebuild.py
    test_services_stats.py
    test_services_objects.py
    test_api.py
    test_jobs.py
.github/workflows/api.yml
```

---

### Task 1: Scaffold the API package, settings, DB access and test harness

**Files:**
- Create: `api/pyproject.toml`, `api/app/__init__.py`, `api/app/config.py`, `api/app/db.py`, `api/app/errors.py`, `api/tests/conftest.py`, `api/tests/test_config_db.py`, `api/compose.yaml`
- Modify: `.gitignore` (add `api/.snapshots/`, `api/.env`)

**Interfaces:**
- Produces: `Settings` (fields: `database_url: str`, `spacetrack_user: str | None`, `spacetrack_pass: str | None`, `origin_secret: str | None`, `snapshot_dir: str`, `min_satcat_rows: int`, `min_gp_rows_spacetrack: int`, `min_gp_rows_celestrak: int`); `connect(url: str) -> psycopg.Connection`; `Database(url)` with `.conn() -> Iterator[psycopg.Connection]` and `.close()`; `ApiError(status: int, code: str, message: str)`; pytest fixture `database_url: str` (session).

- [ ] **Step 1: Create the project files**

`api/pyproject.toml`:
```toml
[project]
name = "leo-api"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "psycopg[binary]>=3.2",
  "psycopg-pool>=3.2",
  "alembic>=1.13",
  "sqlalchemy>=2.0",
  "httpx>=0.27",
  "pydantic-settings>=2.4",
]

[dependency-groups]
dev = [
  "pytest>=8.3",
  "testcontainers[postgres]>=4.8",
  "respx>=0.21",
  "ruff>=0.6",
]

[tool.uv]
package = false

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]
ignore = ["E501"]  # long SQL/test lines; run `uv run ruff format` for layout

[tool.ruff.lint.flake8-bugbear]
# FastAPI's dependency-injection defaults are intentional.
extend-immutable-calls = ["fastapi.Depends", "fastapi.Query"]
```

`api/app/__init__.py`: empty file.

`api/app/config.py`:
```python
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
```

`api/app/db.py`:
```python
from collections.abc import Iterator
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# prepare_threshold=None: Neon's pooled endpoint (PgBouncer, transaction mode) breaks
# server-side prepared statements. autocommit=True: every write uses conn.transaction().
CONN_KWARGS: dict[str, Any] = {
    "row_factory": dict_row,
    "autocommit": True,
    "prepare_threshold": None,
}


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, **CONN_KWARGS)


class Database:
    def __init__(self, url: str, max_size: int = 4):
        self.pool = ConnectionPool(url, min_size=0, max_size=max_size, kwargs=CONN_KWARGS, open=True)

    def conn(self) -> Iterator[psycopg.Connection]:
        with self.pool.connection() as c:
            yield c

    def close(self) -> None:
        self.pool.close()
```

`api/app/errors.py`:
```python
class ApiError(Exception):
    """An error that maps directly to an HTTP response {"error": {"code", "message"}}."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
```

`api/compose.yaml`:
```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: leo
      POSTGRES_PASSWORD: leo
      POSTGRES_DB: leo
    ports:
      - "5432:5432"
    volumes:
      - leo-db:/var/lib/postgresql/data
volumes:
  leo-db:
```

`api/tests/conftest.py`:
```python
import os
from collections.abc import Iterator
from pathlib import Path

import pytest

API_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    """A throwaway Postgres. Set TEST_DATABASE_URL to reuse an existing empty database."""
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("pgvector/pgvector:pg16", driver=None) as pg:
        yield pg.get_connection_url()
```

Append to the repo root `.gitignore`:
```
api/.snapshots/
api/.env
.venv/
```

- [ ] **Step 2: Write the failing test**

`api/tests/test_config_db.py`:
```python
from app.config import Settings
from app.db import Database, connect


def test_settings_read_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x:y@db:5432/z")
    monkeypatch.setenv("MIN_SATCAT_ROWS", "10")
    s = Settings()
    assert s.database_url == "postgresql://x:y@db:5432/z"
    assert s.min_satcat_rows == 10
    assert s.spacetrack_user is None


def test_connect_returns_dict_rows_in_autocommit(database_url):
    with connect(database_url) as conn:
        row = conn.execute("SELECT 1 AS one").fetchone()
        assert row == {"one": 1}
        assert conn.autocommit is True


def test_database_pool_yields_connections(database_url):
    db = Database(database_url)
    try:
        conn = next(db.conn())
        assert conn.execute("SELECT 2 AS two").fetchone() == {"two": 2}
    finally:
        db.close()
```

- [ ] **Step 3: Run the tests and watch them fail, then pass**

Run: `cd api && uv sync && uv run pytest tests/test_config_db.py -v`
Expected before Step 1 files exist: `ModuleNotFoundError: No module named 'app.config'`. After Step 1: 3 passed. Docker must be running for testcontainers; if it isn't, start `docker compose up -d db` in `api/` and run with `TEST_DATABASE_URL=postgresql://leo:leo@localhost:5432/leo`.

- [ ] **Step 4: Lint and commit**

```bash
cd api && uv run ruff check . && cd ..
git add .gitignore api/pyproject.toml api/uv.lock api/compose.yaml api/app api/tests
git commit -m "feat(api): scaffold package, settings, db access and test harness"
```

---

### Task 2: Schema migration

**Files:**
- Create: `api/alembic.ini`, `api/migrations/env.py`, `api/migrations/script.py.mako`, `api/migrations/versions/0001_initial.py`, `api/tests/test_migrations.py`
- Modify: `api/tests/conftest.py` (add `migrated` and `conn` fixtures)

**Interfaces:**
- Consumes: `database_url` fixture, `connect()` from Task 1.
- Produces: tables `owners`, `launch_sites`, `breakup_events`, `objects`, `gp_elements`, `yearly_stats`, `ingest_runs` (exact columns below). Fixtures `migrated: str` (session, URL of a migrated DB) and `conn` (function-scoped `psycopg.Connection`; truncates all tables afterwards).

- [ ] **Step 1: Write the failing test**

`api/tests/test_migrations.py`:
```python
import psycopg
import pytest

EXPECTED = {
    "owners", "launch_sites", "breakup_events", "objects",
    "gp_elements", "yearly_stats", "ingest_runs",
}


def test_all_tables_exist(conn):
    rows = conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    ).fetchall()
    assert EXPECTED <= {r["table_name"] for r in rows}


def test_objects_rejects_unknown_regime(conn):
    conn.execute("INSERT INTO owners (code, name) VALUES ('US', 'United States')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO objects (norad_id, name, object_type, owner, regime, first_seen_year) "
            "VALUES (1, 'X', 'PAY', 'US', 'LUNAR', 2000)"
        )
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_migrations.py -v`
Expected: FAIL with `fixture 'conn' not found`.

- [ ] **Step 3: Write the migration and fixtures**

`api/alembic.ini`:
```ini
[alembic]
script_location = %(here)s/migrations
```

`api/migrations/env.py`:
```python
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
```

`api/migrations/script.py.mako`:
```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
"""
from alembic import op

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = None
depends_on = None


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

`api/migrations/versions/0001_initial.py`:
```python
"""initial schema

Revision ID: 0001
Revises:
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

UP = """
CREATE TABLE owners (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  country_iso text,
  flag_emoji  text
);

CREATE TABLE launch_sites (
  code    text PRIMARY KEY,
  name    text NOT NULL,
  country text,
  lat     double precision,
  lon     double precision
);

CREATE TABLE breakup_events (
  id            text PRIMARY KEY,
  parent_cospar text NOT NULL UNIQUE,
  name          text NOT NULL,
  event_date    date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('ASAT', 'COLLISION', 'EXPLOSION', 'UNKNOWN')),
  description   text NOT NULL,
  source_url    text NOT NULL
);

CREATE TABLE objects (
  norad_id        integer PRIMARY KEY,
  cospar_id       text,
  name            text NOT NULL,
  object_type     text NOT NULL CHECK (object_type IN ('PAY', 'R/B', 'DEB', 'UNK')),
  ops_status      text,
  owner           text NOT NULL REFERENCES owners (code),
  launch_date     date,
  launch_site     text REFERENCES launch_sites (code),
  decay_date      date,
  period          double precision,
  inclination     double precision,
  apogee          double precision,
  perigee         double precision,
  rcs_size        text CHECK (rcs_size IN ('SMALL', 'MEDIUM', 'LARGE')),
  regime          text NOT NULL CHECK (regime IN ('LEO', 'MEO', 'GEO', 'HEO', 'OTHER')),
  orbit_center    text,
  parent_cospar   text,
  event_id        text REFERENCES breakup_events (id),
  first_seen_year integer NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX objects_owner_idx ON objects (owner);
CREATE INDEX objects_type_idx ON objects (object_type);
CREATE INDEX objects_regime_idx ON objects (regime);
CREATE INDEX objects_parent_idx ON objects (parent_cospar);
CREATE INDEX objects_event_idx ON objects (event_id);
CREATE INDEX objects_in_orbit_idx ON objects (regime) WHERE decay_date IS NULL;

CREATE TABLE gp_elements (
  norad_id         integer PRIMARY KEY REFERENCES objects (norad_id) ON DELETE CASCADE,
  epoch            timestamptz NOT NULL,
  mean_motion      double precision NOT NULL,
  eccentricity     double precision NOT NULL,
  inclination      double precision NOT NULL,
  raan             double precision NOT NULL,
  arg_pericenter   double precision NOT NULL,
  mean_anomaly     double precision NOT NULL,
  bstar            double precision NOT NULL,
  mean_motion_dot  double precision NOT NULL,
  mean_motion_ddot double precision NOT NULL,
  source           text NOT NULL,
  fetched_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE yearly_stats (
  year        integer NOT NULL,
  owner       text NOT NULL,
  object_type text NOT NULL,
  regime      text NOT NULL,
  in_orbit    integer NOT NULL,
  added       integer NOT NULL,
  reentered   integer NOT NULL,
  PRIMARY KEY (year, owner, object_type, regime)
);

CREATE TABLE ingest_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  source      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows        integer,
  status      text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  error       text
);
CREATE INDEX ingest_runs_lookup_idx ON ingest_runs (job, status, finished_at DESC);
"""

DOWN = """
DROP TABLE IF EXISTS ingest_runs, yearly_stats, gp_elements, objects,
  breakup_events, launch_sites, owners CASCADE;
"""


def upgrade() -> None:
    op.execute(UP)


def downgrade() -> None:
    op.execute(DOWN)
```

Append to `api/tests/conftest.py`:
```python
from alembic import command
from alembic.config import Config

from app.db import connect

ALL_TABLES = (
    "gp_elements, yearly_stats, ingest_runs, objects, breakup_events, launch_sites, owners"
)


@pytest.fixture(scope="session")
def migrated(database_url: str) -> str:
    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(cfg, "head")
    return database_url


@pytest.fixture
def conn(migrated: str):
    with connect(migrated) as c:
        yield c
        c.execute(f"TRUNCATE {ALL_TABLES} RESTART IDENTITY CASCADE")
```
Move the `from alembic ...` and `from app.db ...` imports to the top of the file with the other imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_migrations.py tests/test_config_db.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/alembic.ini api/migrations api/tests
git commit -m "feat(api): initial schema migration"
```

---

### Task 3: Seed reference data (owners, launch sites, breakup events)

**Files:**
- Create: `api/app/seeds/__init__.py`, `api/app/seeds/owners.csv`, `api/app/seeds/launch_sites.csv`, `api/app/seeds/breakup_events.csv`, `api/tests/test_seeds.py`

**Interfaces:**
- Consumes: tables from Task 2.
- Produces: `load_seeds(conn) -> None` (idempotent upsert of all three CSVs; sets `owners.flag_emoji` from a two-letter `country_iso`).

- [ ] **Step 1: Write the failing test**

`api/tests/test_seeds.py`:
```python
from app.seeds import load_seeds


def test_load_seeds_is_idempotent_and_complete(conn):
    load_seeds(conn)
    load_seeds(conn)
    owners = conn.execute("SELECT count(*) AS n FROM owners").fetchone()["n"]
    sites = conn.execute("SELECT count(*) AS n FROM launch_sites").fetchone()["n"]
    events = conn.execute("SELECT count(*) AS n FROM breakup_events").fetchone()["n"]
    assert owners >= 40
    assert sites >= 30
    assert events == 10


def test_seed_values(conn):
    load_seeds(conn)
    us = conn.execute("SELECT * FROM owners WHERE code = 'US'").fetchone()
    assert us["name"] == "United States"
    assert us["flag_emoji"] == "\U0001F1FA\U0001F1F8"
    esa = conn.execute("SELECT * FROM owners WHERE code = 'ESA'").fetchone()
    assert esa["flag_emoji"] is None
    taiyuan = conn.execute("SELECT name FROM launch_sites WHERE code = 'TAISC'").fetchone()
    assert taiyuan["name"] == "Taiyuan"
    fy = conn.execute("SELECT * FROM breakup_events WHERE parent_cospar = '1999-025'").fetchone()
    assert fy["id"] == "fengyun-1c-2007"
    assert fy["event_date"].isoformat() == "2007-01-11"
    assert fy["kind"] == "ASAT"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_seeds.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.seeds'`.

- [ ] **Step 3: Write the seeds and loader**

`api/app/seeds/owners.csv` (curated names for the ~45 most common owner codes in the catalog. Any other code is inserted at ingest time with `name = code`):
```csv
code,name,country_iso
US,United States,US
CIS,Russia / former USSR,RU
PRC,China,CN
FR,France,FR
JPN,Japan,JP
IND,India,IN
UK,United Kingdom,GB
TBD,To be determined,
ESA,European Space Agency,
GER,Germany,DE
ITSO,Intelsat,
IT,Italy,IT
ISS,International Space Station partners,
CA,Canada,CA
SPN,Spain,ES
ORB,ORBCOMM,
CHBZ,China / Brazil (CBERS),
GLOB,Globalstar,
SKOR,South Korea,KR
AUS,Australia,AU
ARGN,Argentina,AR
SES,SES,
ISRA,Israel,IL
EUTE,Eutelsat,
TURK,Turkey,TR
ROC,Taiwan,TW
FIN,Finland,FI
SEAL,Sea Launch,
IRAN,Iran,IR
UAE,United Arab Emirates,AE
O3B,O3b Networks,
BRAZ,Brazil,BR
NOR,Norway,NO
POL,Poland,PL
SING,Singapore,SG
LUXE,Luxembourg,LU
NZ,New Zealand,NZ
INDO,Indonesia,ID
SWTZ,Switzerland,CH
GREC,Greece,GR
IM,Inmarsat,
EUME,EUMETSAT,
NETH,Netherlands,NL
SAUD,Saudi Arabia,SA
AB,Arabsat,
NKOR,North Korea,KP
UNK,Unknown,
```

`api/app/seeds/launch_sites.csv`:
```csv
code,name,country
AFETR,Cape Canaveral / Kennedy Space Center,US
AFWTR,Vandenberg,US
WLPIS,Wallops Island,US
KODAK,Kodiak (Pacific Spaceport Complex),US
KWAJ,Kwajalein Atoll,US
ERAS,Eastern Range airspace (air launch),US
WRAS,Western Range airspace (air launch),US
PLMSC,Plesetsk,RU
TYMSC,Baikonur (Tyuratam),KZ
KYMSC,Kapustin Yar,RU
VOSTO,Vostochny,RU
DLS,Dombarovsky,RU
SVOBO,Svobodny,RU
TAISC,Taiyuan,CN
JSC,Jiuquan,CN
XICLF,Xichang,CN
WSC,Wenchang,CN
YSLA,Yellow Sea launch area (sea launch),CN
SCSLA,South China Sea launch area (sea launch),CN
FRGUI,Guiana Space Centre (Kourou),GF
SRILR,Satish Dhawan Space Centre (Sriharikota),IN
TANSC,Tanegashima,JP
KSCUT,Uchinoura,JP
RLLB,Rocket Lab Launch Complex 1 (Mahia),NZ
NSC,Naro Space Center,KR
YAVNE,Palmachim,IL
SEMLS,Semnan,IR
SMTS,Shahroud,IR
YUN,Sohae (Yunsong),KP
SEAL,Sea Launch (Pacific Ocean),
HGSTR,Hammaguir,DZ
SNMLP,San Marco platform,KE
WOMRA,Woomera,AU
ANDSP,Andøya Spaceport,NO
SUBL,Submarine launch,
CAS,Canary Islands airspace (air launch),ES
```

`api/app/seeds/breakup_events.csv`:
```csv
id,parent_cospar,name,event_date,kind,description,source_url
transit-4a-ablestar-1961,1961-015,Transit 4A Ablestar upper stage explosion,1961-06-29,EXPLOSION,"The first known on-orbit breakup: the Ablestar upper stage exploded hours after launch.",https://en.wikipedia.org/wiki/Transit_(satellite)
pegasus-haps-1996,1994-029,Pegasus HAPS upper stage explosion,1996-06-03,EXPLOSION,"The Pegasus HAPS stage from the STEP-2 launch exploded about two years after launch.",https://en.wikipedia.org/wiki/Pegasus_(rocket)
fengyun-1c-2007,1999-025,Fengyun-1C anti-satellite test,2007-01-11,ASAT,"China destroyed its Fengyun-1C weather satellite with a ground-launched missile at about 865 km, creating the largest debris cloud on record.",https://en.wikipedia.org/wiki/2007_Chinese_anti-satellite_missile_test
usa-193-2008,2006-057,USA-193 intercept (Operation Burnt Frost),2008-02-21,ASAT,"The US destroyed the failed USA-193 satellite at about 247 km; its debris re-entered within weeks.",https://en.wikipedia.org/wiki/Operation_Burnt_Frost
cosmos-2251-2009,1993-036,Iridium 33 / Cosmos 2251 collision (Cosmos 2251 fragments),2009-02-10,COLLISION,"The first accidental hypervelocity collision between two intact satellites, at about 789 km over Siberia.",https://en.wikipedia.org/wiki/2009_satellite_collision
iridium-33-2009,1997-051,Iridium 33 / Cosmos 2251 collision (Iridium 33 fragments),2009-02-10,COLLISION,"The first accidental hypervelocity collision between two intact satellites, at about 789 km over Siberia.",https://en.wikipedia.org/wiki/2009_satellite_collision
microsat-r-2019,2019-006,Mission Shakti anti-satellite test,2019-03-27,ASAT,"India destroyed its Microsat-R satellite at about 283 km; most fragments re-entered within a few years.",https://en.wikipedia.org/wiki/Mission_Shakti
kosmos-1408-2021,1982-092,Kosmos 1408 anti-satellite test,2021-11-15,ASAT,"Russia destroyed the defunct Kosmos 1408 satellite with a direct-ascent missile at about 480 km.",https://en.wikipedia.org/wiki/2021_Russian_anti-satellite_missile_test
long-march-6a-2022,2022-151,Long March 6A upper stage breakup,2022-11-12,EXPLOSION,"The upper stage from a Yunhai-3 launch broke up in orbit shortly after launch.",https://en.wikipedia.org/wiki/Long_March_6A
long-march-6a-2024,2024-140,Long March 6A upper stage breakup,2024-08-06,EXPLOSION,"The upper stage that launched the first Qianfan (Thousand Sails) satellites broke up in orbit.",https://en.wikipedia.org/wiki/Long_March_6A
```

`api/app/seeds/__init__.py`:
```python
import csv
from pathlib import Path

import psycopg

SEED_DIR = Path(__file__).parent


def _rows(name: str) -> list[dict[str, str]]:
    with open(SEED_DIR / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def flag_emoji(country_iso: str) -> str | None:
    iso = (country_iso or "").strip().upper()
    if len(iso) != 2 or not iso.isalpha():
        return None
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in iso)


def load_seeds(conn: psycopg.Connection) -> None:
    with conn.transaction():
        for r in _rows("owners.csv"):
            conn.execute(
                """
                INSERT INTO owners (code, name, country_iso, flag_emoji)
                VALUES (%(code)s, %(name)s, NULLIF(%(country_iso)s, ''), %(flag)s)
                ON CONFLICT (code) DO UPDATE
                  SET name = EXCLUDED.name,
                      country_iso = EXCLUDED.country_iso,
                      flag_emoji = EXCLUDED.flag_emoji
                """,
                {**r, "flag": flag_emoji(r["country_iso"])},
            )
        for r in _rows("launch_sites.csv"):
            conn.execute(
                """
                INSERT INTO launch_sites (code, name, country)
                VALUES (%(code)s, %(name)s, NULLIF(%(country)s, ''))
                ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country
                """,
                r,
            )
        for r in _rows("breakup_events.csv"):
            conn.execute(
                """
                INSERT INTO breakup_events
                  (id, parent_cospar, name, event_date, kind, description, source_url)
                VALUES (%(id)s, %(parent_cospar)s, %(name)s, %(event_date)s, %(kind)s,
                        %(description)s, %(source_url)s)
                ON CONFLICT (id) DO UPDATE
                  SET parent_cospar = EXCLUDED.parent_cospar, name = EXCLUDED.name,
                      event_date = EXCLUDED.event_date, kind = EXCLUDED.kind,
                      description = EXCLUDED.description, source_url = EXCLUDED.source_url
                """,
                r,
            )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_seeds.py -v`
Expected: 2 passed.

- [ ] **Step 5: Verify the event rows against their sources**

Open each `source_url` in `breakup_events.csv` and confirm the COSPAR launch designator (first 8 characters, e.g. `1999-025`) and the event date. If one differs, fix the CSV and note the correction in the commit message. This data drives the "debris jumps" on the chart, so it must be right.

- [ ] **Step 6: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/seeds api/tests/test_seeds.py
git commit -m "feat(api): seed owners, launch sites and breakup events"
```

---

### Task 4: Domain rules (regime, RCS size, catalog year, event linking, first-seen year)

**Files:**
- Create: `api/app/domain/__init__.py` (empty), `api/app/domain/orbits.py`, `api/app/domain/catalog.py`, `api/tests/test_domain.py`

**Interfaces:**
- Produces:
  - `classify_regime(apogee: float | None, perigee: float | None, orbit_center: str | None) -> str`
  - `rcs_size(rcs: float | None) -> str | None`
  - constants `OBJECT_TYPES`, `REGIMES`, `TYPE_LABELS`, `REGIME_LABELS`, `OPS_STATUS_LABELS`, `ATTRIBUTION`
  - `CatalogYearIndex(payloads: Iterable[tuple[int, date]])` with `.year_for(norad_id: int) -> int | None`
  - `EventRef(id: str, year: int)` (frozen dataclass)
  - `parent_cospar(cospar_id: str | None) -> str | None`
  - `link_event(object_type: str, parent: str | None, catalog_year: int | None, events: Mapping[str, EventRef]) -> EventRef | None`
  - `first_seen_year(launch_year: int | None, catalog_year: int | None, event_year: int | None, decay_year: int | None) -> int`

- [ ] **Step 1: Write the failing tests**

`api/tests/test_domain.py`:
```python
from datetime import date

import pytest

from app.domain.catalog import (
    CatalogYearIndex,
    EventRef,
    first_seen_year,
    link_event,
    parent_cospar,
)
from app.domain.orbits import classify_regime, rcs_size


@pytest.mark.parametrize(
    ("apogee", "perigee", "center", "expected"),
    [
        (422, 416, "EA", "LEO"),          # ISS
        (1999.9, 300, "EA", "LEO"),
        (20464, 19900, "EA", "MEO"),      # GPS
        (36129, 36102, "EA", "GEO"),
        (3818, 652, "EA", "HEO"),         # Vanguard 1
        (None, None, "EA", "OTHER"),
        (500, 400, "MO", "OTHER"),        # lunar orbit
        (500, 400, None, "LEO"),          # missing center is treated as Earth
        (500, 400, "", "LEO"),
    ],
)
def test_classify_regime(apogee, perigee, center, expected):
    assert classify_regime(apogee, perigee, center) == expected


@pytest.mark.parametrize(
    ("rcs", "expected"),
    [(None, None), (0.05, "SMALL"), (0.1, "MEDIUM"), (1.0, "MEDIUM"), (20.42, "LARGE")],
)
def test_rcs_size(rcs, expected):
    assert rcs_size(rcs) == expected


def test_catalog_year_index_uses_running_max():
    idx = CatalogYearIndex(
        [
            (2, date(1957, 10, 4)),
            (5, date(1958, 3, 17)),
            (25730, date(1999, 5, 10)),
            (27000, date(1990, 1, 1)),  # late-cataloged old payload must not pull years back
            (29228, date(2006, 6, 15)),
        ]
    )
    assert idx.year_for(1) is None
    assert idx.year_for(3) == 1957
    assert idx.year_for(26000) == 1999
    assert idx.year_for(28000) == 1999
    assert idx.year_for(30000) == 2006


@pytest.mark.parametrize(
    ("cospar", "expected"),
    [("1999-025AC", "1999-025"), ("1998-067A", "1998-067"), (None, None), ("", None), ("BAD", None)],
)
def test_parent_cospar(cospar, expected):
    assert parent_cospar(cospar) == expected


EVENTS = {"1999-025": EventRef("fengyun-1c-2007", 2007)}


def test_link_event_matches_debris_cataloged_after_event():
    assert link_event("DEB", "1999-025", 2008, EVENTS) == EventRef("fengyun-1c-2007", 2007)


def test_link_event_allows_one_year_catalog_lag():
    assert link_event("DEB", "1999-025", 2006, EVENTS) == EventRef("fengyun-1c-2007", 2007)


def test_link_event_rejects_earlier_pieces_payloads_and_unknown_parents():
    assert link_event("DEB", "1999-025", 2005, EVENTS) is None
    assert link_event("PAY", "1999-025", 2008, EVENTS) is None
    assert link_event("DEB", "2000-001", 2008, EVENTS) is None
    assert link_event("DEB", None, 2008, EVENTS) is None
    assert link_event("DEB", "1999-025", None, EVENTS) is None


def test_first_seen_uses_later_of_launch_and_catalog_year():
    assert first_seen_year(1999, 2007, None, None) == 2007
    assert first_seen_year(2020, 2019, None, None) == 2020


def test_first_seen_prefers_event_year():
    assert first_seen_year(1999, 2010, 2007, None) == 2007


def test_first_seen_clamped_to_decay_year():
    assert first_seen_year(1998, 2026, None, 2010) == 2010
    assert first_seen_year(1999, 2006, 2007, 2007) == 2007


def test_first_seen_falls_back_to_1957():
    assert first_seen_year(None, None, None, None) == 1957
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_domain.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.domain'`.

- [ ] **Step 3: Implement**

`api/app/domain/orbits.py`:
```python
OBJECT_TYPES = ("PAY", "R/B", "DEB", "UNK")
REGIMES = ("LEO", "MEO", "GEO", "HEO", "OTHER")

TYPE_LABELS = {"PAY": "Payload", "R/B": "Rocket body", "DEB": "Debris", "UNK": "Unknown"}
REGIME_LABELS = {
    "LEO": "Low Earth orbit (apogee under 2,000 km)",
    "MEO": "Medium Earth orbit",
    "GEO": "Geostationary orbit",
    "HEO": "Highly elliptical orbit",
    "OTHER": "Beyond Earth orbit or unknown",
}
OPS_STATUS_LABELS = {
    "+": "Operational",
    "-": "Nonoperational",
    "P": "Partially operational",
    "B": "Backup",
    "S": "Spare",
    "X": "Extended mission",
    "D": "Decayed",
}
ATTRIBUTION = "Data: USSPACECOM via Space-Track.org; CelesTrak."

LEO_MAX_APOGEE_KM = 2000.0
GEO_PERIGEE_KM = (35000.0, 36500.0)


def classify_regime(apogee: float | None, perigee: float | None, orbit_center: str | None) -> str:
    if orbit_center not in (None, "", "EA") or apogee is None or perigee is None:
        return "OTHER"
    if apogee < LEO_MAX_APOGEE_KM:
        return "LEO"
    if GEO_PERIGEE_KM[0] <= perigee <= GEO_PERIGEE_KM[1]:
        return "GEO"
    if perigee >= LEO_MAX_APOGEE_KM:
        return "MEO"
    return "HEO"


def rcs_size(rcs: float | None) -> str | None:
    """Space-Track's radar cross-section classes (m²): small < 0.1 ≤ medium ≤ 1 < large."""
    if rcs is None:
        return None
    if rcs < 0.1:
        return "SMALL"
    if rcs <= 1.0:
        return "MEDIUM"
    return "LARGE"
```

`api/app/domain/catalog.py`:
```python
from bisect import bisect_right
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date

FIRST_YEAR = 1957


class CatalogYearIndex:
    """Estimates when a catalog number was assigned.

    Catalog numbers are handed out in order, so the latest payload launch year among all
    payloads with a number <= n approximates the year object n entered the catalog.
    """

    def __init__(self, payloads: Iterable[tuple[int, date]]):
        pairs = sorted(payloads)
        self._ids: list[int] = []
        self._years: list[int] = []
        running = 0
        for norad_id, launched in pairs:
            running = max(running, launched.year)
            self._ids.append(norad_id)
            self._years.append(running)

    def year_for(self, norad_id: int) -> int | None:
        i = bisect_right(self._ids, norad_id) - 1
        return self._years[i] if i >= 0 else None


@dataclass(frozen=True)
class EventRef:
    id: str
    year: int


def parent_cospar(cospar_id: str | None) -> str | None:
    """'1999-025AC' -> '1999-025' (the launch the piece came from)."""
    if not cospar_id or len(cospar_id) < 8 or cospar_id[4] != "-":
        return None
    return cospar_id[:8]


def link_event(
    object_type: str,
    parent: str | None,
    catalog_year: int | None,
    events: Mapping[str, EventRef],
) -> EventRef | None:
    if object_type != "DEB" or parent is None or catalog_year is None:
        return None
    event = events.get(parent)
    # Catalog numbers lag launches by up to a year, so allow event_year - 1.
    if event is None or catalog_year < event.year - 1:
        return None
    return event


def first_seen_year(
    launch_year: int | None,
    catalog_year: int | None,
    event_year: int | None,
    decay_year: int | None,
) -> int:
    if event_year is not None:
        year = event_year
    else:
        candidates = [y for y in (launch_year, catalog_year) if y is not None]
        year = max(candidates) if candidates else FIRST_YEAR
    if decay_year is not None:
        year = min(year, decay_year)
    return year
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_domain.py -v`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/domain api/tests/test_domain.py
git commit -m "feat(api): domain rules for regimes, catalog year and breakup linking"
```

---

### Task 5: Source clients (CelesTrak, Space-Track)

**Files:**
- Create: `api/app/ingest/__init__.py` (empty), `api/app/ingest/sources.py`, `api/tests/test_sources.py`

**Interfaces:**
- Produces:
  - `SourceError(RuntimeError)`
  - `USER_AGENT: str`
  - `CelesTrakClient(http: httpx.Client, sleep=time.sleep)` with `.satcat_csv() -> str` and `.gp_active_csv() -> str`
  - `SpaceTrackClient(http: httpx.Client, user: str, password: str, sleep=time.sleep)` with `.gp_all_on_orbit() -> list[dict]`
  - URL constants `CELESTRAK_SATCAT_URL`, `CELESTRAK_GP_ACTIVE_URL`, `SPACETRACK_LOGIN_URL`, `SPACETRACK_GP_URL`

- [ ] **Step 1: Write the failing tests**

`api/tests/test_sources.py`:
```python
import httpx
import pytest
import respx

from app.ingest.sources import (
    CELESTRAK_GP_ACTIVE_URL,
    CELESTRAK_SATCAT_URL,
    SPACETRACK_GP_URL,
    SPACETRACK_LOGIN_URL,
    CelesTrakClient,
    SourceError,
    SpaceTrackClient,
)

NO_SLEEP = lambda _s: None  # noqa: E731
SATCAT_HEAD = "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID\nISS (ZARYA),1998-067A,25544\n"


@respx.mock
def test_celestrak_satcat_ok():
    respx.get(CELESTRAK_SATCAT_URL).mock(return_value=httpx.Response(200, text=SATCAT_HEAD))
    with httpx.Client() as http:
        assert CelesTrakClient(http, sleep=NO_SLEEP).satcat_csv() == SATCAT_HEAD


@respx.mock
def test_celestrak_rejects_html_error_page():
    respx.get(CELESTRAK_SATCAT_URL).mock(
        return_value=httpx.Response(200, text="<html>Service unavailable</html>")
    )
    with httpx.Client() as http, pytest.raises(SourceError, match="unexpected"):
        CelesTrakClient(http, sleep=NO_SLEEP).satcat_csv()


@respx.mock
def test_celestrak_retries_server_errors_then_succeeds():
    route = respx.get(CELESTRAK_GP_ACTIVE_URL)
    route.side_effect = [
        httpx.Response(503),
        httpx.Response(200, text="OBJECT_NAME,OBJECT_ID,EPOCH\n"),
    ]
    with httpx.Client() as http:
        assert CelesTrakClient(http, sleep=NO_SLEEP).gp_active_csv().startswith("OBJECT_NAME")
    assert route.call_count == 2


@respx.mock
def test_celestrak_gives_up_after_three_attempts():
    respx.get(CELESTRAK_SATCAT_URL).mock(return_value=httpx.Response(500))
    with httpx.Client() as http, pytest.raises(SourceError, match="HTTP 500"):
        CelesTrakClient(http, sleep=NO_SLEEP).satcat_csv()


@respx.mock
def test_spacetrack_logs_in_then_fetches_gp():
    login = respx.post(SPACETRACK_LOGIN_URL).mock(return_value=httpx.Response(200, text='""'))
    respx.get(SPACETRACK_GP_URL).mock(
        return_value=httpx.Response(200, json=[{"NORAD_CAT_ID": "25544"}])
    )
    with httpx.Client() as http:
        data = SpaceTrackClient(http, "me@example.com", "pw", sleep=NO_SLEEP).gp_all_on_orbit()
    assert data == [{"NORAD_CAT_ID": "25544"}]
    assert b"identity=me%40example.com" in login.calls[0].request.content


@respx.mock
def test_spacetrack_login_failure_raises():
    respx.post(SPACETRACK_LOGIN_URL).mock(
        return_value=httpx.Response(200, json={"Login": "Failed"})
    )
    with httpx.Client() as http, pytest.raises(SourceError, match="login failed"):
        SpaceTrackClient(http, "me", "bad", sleep=NO_SLEEP).gp_all_on_orbit()


@respx.mock
def test_spacetrack_non_list_payload_raises():
    respx.post(SPACETRACK_LOGIN_URL).mock(return_value=httpx.Response(200, text='""'))
    respx.get(SPACETRACK_GP_URL).mock(
        return_value=httpx.Response(200, json={"error": "query limit"})
    )
    with httpx.Client() as http, pytest.raises(SourceError, match="unexpected"):
        SpaceTrackClient(http, "me", "pw", sleep=NO_SLEEP).gp_all_on_orbit()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_sources.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.ingest'`.

- [ ] **Step 3: Implement**

`api/app/ingest/sources.py`:
```python
import time
from collections.abc import Callable

import httpx

USER_AGENT = "leo-debris/0.1 (+https://leo.kudayyurter.dev)"

CELESTRAK_SATCAT_URL = "https://celestrak.org/pub/satcat.csv"
CELESTRAK_GP_ACTIVE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv"
SPACETRACK_LOGIN_URL = "https://www.space-track.org/ajaxauth/login"
# All on-orbit objects with an element set newer than 30 days: Space-Track's recommended
# bulk query. One request; never query per object.
SPACETRACK_GP_URL = (
    "https://www.space-track.org/basicspacedata/query/class/gp/decay_date/null-val"
    "/epoch/%3Enow-30/orderby/norad_cat_id/format/json"
)

CSV_HEADER_PREFIX = "OBJECT_NAME,"
ATTEMPTS = 3


class SourceError(RuntimeError):
    """An upstream data source failed or returned something we refuse to ingest."""


def _request(
    send: Callable[[], httpx.Response], what: str, sleep: Callable[[float], None]
) -> httpx.Response:
    last = ""
    for attempt in range(ATTEMPTS):
        try:
            response = send()
        except httpx.TransportError as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code < 500:
                if response.status_code >= 400:
                    raise SourceError(f"{what}: HTTP {response.status_code}")
                return response
            last = f"HTTP {response.status_code}"
        if attempt < ATTEMPTS - 1:
            sleep(2.0 * (attempt + 1))
    raise SourceError(f"{what}: {last} after {ATTEMPTS} attempts")


class CelesTrakClient:
    def __init__(self, http: httpx.Client, sleep: Callable[[float], None] = time.sleep):
        self.http = http
        self.sleep = sleep

    def _csv(self, url: str, what: str) -> str:
        text = _request(lambda: self.http.get(url), what, self.sleep).text
        if not text.startswith(CSV_HEADER_PREFIX):
            raise SourceError(f"{what}: unexpected response starting {text[:80]!r}")
        return text

    def satcat_csv(self) -> str:
        return self._csv(CELESTRAK_SATCAT_URL, "CelesTrak SATCAT")

    def gp_active_csv(self) -> str:
        return self._csv(CELESTRAK_GP_ACTIVE_URL, "CelesTrak GP active")


class SpaceTrackClient:
    def __init__(
        self,
        http: httpx.Client,
        user: str,
        password: str,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.http = http
        self.user = user
        self.password = password
        self.sleep = sleep

    def gp_all_on_orbit(self) -> list[dict]:
        login = _request(
            lambda: self.http.post(
                SPACETRACK_LOGIN_URL, data={"identity": self.user, "password": self.password}
            ),
            "Space-Track login",
            self.sleep,
        )
        if "Failed" in login.text:
            raise SourceError("Space-Track login failed (check SPACETRACK_USER/SPACETRACK_PASS)")
        response = _request(lambda: self.http.get(SPACETRACK_GP_URL), "Space-Track GP", self.sleep)
        try:
            data = response.json()
        except ValueError as exc:
            raise SourceError("Space-Track GP: response was not JSON") from exc
        if not isinstance(data, list):
            raise SourceError(f"Space-Track GP: unexpected payload {str(data)[:200]}")
        return data
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_sources.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/ingest api/tests/test_sources.py
git commit -m "feat(api): CelesTrak and Space-Track clients with retries and payload checks"
```

---

### Task 6: SATCAT ingest job

**Files:**
- Create: `api/app/ingest/runlog.py`, `api/app/ingest/satcat.py`, `api/tests/fixtures/satcat_sample.csv`, `api/tests/test_ingest_satcat.py`

**Interfaces:**
- Consumes: `load_seeds` (Task 3); domain functions (Task 4); `CelesTrakClient`, `SourceError` (Task 5); `Settings` (Task 1).
- Produces:
  - `RunState(source: str, rows: int | None = None)`; `run_log(conn, job: str, source: str = "pending") -> ContextManager[RunState]`; `last_success(conn, job: str, source: str | None = None) -> datetime | None`
  - `SatcatRow` and `ObjectRecord` dataclasses; `OBJECT_COLUMNS: tuple[str, ...]`
  - `parse_satcat_csv(text: str) -> list[SatcatRow]`
  - `load_event_index(conn) -> dict[str, EventRef]`
  - `derive_objects(rows: list[SatcatRow], events: Mapping[str, EventRef]) -> list[ObjectRecord]`
  - `upsert_objects(conn, records: list[ObjectRecord]) -> None`
  - `run_ingest_satcat(conn, *, celestrak, settings: Settings) -> int` (rows written)

- [ ] **Step 1: Add the fixture (real SATCAT rows, CelesTrak format)**

`api/tests/fixtures/satcat_sample.csv`:
```csv
OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE
SL-1 R/B,1957-001A,1,R/B,D,CIS,1957-10-04,TYMSC,1957-12-01,96.19,65.10,938,214,20.4200,,EA,IMP
SPUTNIK 1,1957-001B,2,PAY,D,CIS,1957-10-04,TYMSC,1958-01-03,96.10,65.00,1080,64,,,EA,IMP
VANGUARD 1,1958-002B,5,PAY,,US,1958-03-17,AFETR,,132.59,34.26,3818,652,0.1220,,EA,ORB
LUNA 2,1959-014A,114,PAY,D,CIS,1959-09-12,TYMSC,1959-09-13,,,,,,NIE,MO,IMP
COSMOS 1066,1978-121A,11165,PAY,,CIS,1978-12-23,PLMSC,,101.97,81.24,888,816,4.2500,,EA,ORB
ERS-1,1991-050A,21574,PAY,-,ESA,1991-07-17,FRGUI,,100.03,98.78,782,737,10.3234,,EA,ORB
NAVSTAR 43 (USA 132),1997-035A,24876,PAY,+,US,1997-07-23,AFETR,,717.97,56.05,20464,19900,3.1622,,EA,ORB
ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.95,51.63,422,416,399.0524,,EA,ORB
FENGYUN 1C,1999-025A,25730,PAY,-,PRC,1999-05-10,TAISC,,100.89,98.86,810,792,0.2267,,EA,ORB
RESURS-DK 1,2006-021A,29228,PAY,P,CIS,2006-06-15,TYMSC,,95.14,69.93,529,522,8.7657,,EA,ORB
NAVSTAR 59 (USA 192),2006-052A,29601,PAY,+,US,2006-11-17,AFETR,,717.98,54.92,20410,19955,4.8064,,EA,ORB
FENGYUN 1C DEB,1999-025E,29716,DEB,D,PRC,1999-05-10,TAISC,2007-02-06,88.75,99.43,286,139,0.0110,,EA,IMP
FENGYUN 1C DEB,1999-025X,29733,DEB,,PRC,1999-05-10,TAISC,,111.03,99.21,1706,843,0.0391,,EA,ORB
LUCH (OLYMP-K 1),2014-058A,40258,PAY,-,CIS,2014-09-27,TYMSC,,1452.93,2.14,36129,36102,45.0715,,EA,ORB
COSMOS 1408 DEB,1982-092C,42060,DEB,D,CIS,1982-09-16,PLMSC,2017-02-23,89.72,82.54,269,252,0.0132,,EA,IMP
STARLINK-1007,2019-074A,44713,PAY,D,US,2019-11-11,AFETR,2024-10-02,88.35,53.04,198,187,,,EA,IMP
CSS (TIANHE),2021-035A,48274,PAY,+,PRC,2021-04-29,WSC,,92.30,41.47,389,385,,,EA,ORB
HIBARI,2021-102F,49400,PAY,+,JPN,2021-11-09,KSCUT,,93.90,97.32,473,458,,,EA,ORB
COSMOS 1408 DEB,1982-092D,49516,DEB,D,CIS,1982-09-16,PLMSC,2022-07-04,87.96,82.58,183,164,,,EA,IMP
SARAMAGO,2026-067CY,100000,PAY,+,POR,2026-03-30,AFWTR,,94.65,97.47,508,495,,,EA,ORB
```

- [ ] **Step 2: Write the failing tests**

`api/tests/test_ingest_satcat.py`:
```python
import pytest

from app.config import Settings
from app.domain.catalog import EventRef
from app.ingest.satcat import derive_objects, parse_satcat_csv, run_ingest_satcat
from app.ingest.sources import SourceError
from tests.conftest import FIXTURES

SAMPLE = (FIXTURES / "satcat_sample.csv").read_text()


class FakeCelesTrak:
    def __init__(self, satcat: str):
        self._satcat = satcat

    def satcat_csv(self) -> str:
        if self._satcat.startswith("<html"):
            raise SourceError("CelesTrak SATCAT: unexpected response starting '<html'")
        return self._satcat


def settings(**kw) -> Settings:
    return Settings(min_satcat_rows=kw.pop("min_satcat_rows", 10), **kw)


def test_parse_satcat_csv_types_and_nulls():
    rows = {r.norad_id: r for r in parse_satcat_csv(SAMPLE)}
    assert len(rows) == 20
    luna = rows[114]
    assert luna.orbit_center == "MO"
    assert luna.apogee is None and luna.rcs is None
    iss = rows[25544]
    assert iss.object_type == "PAY" and iss.owner == "ISS"
    assert iss.launch_date.isoformat() == "1998-11-20"
    assert iss.decay_date is None
    assert iss.rcs == pytest.approx(399.0524)


def test_parse_satcat_rejects_missing_columns():
    with pytest.raises(SourceError, match="missing columns"):
        parse_satcat_csv("OBJECT_NAME,NORAD_CAT_ID\nX,1\n")


def test_derive_objects_rules():
    events = {
        "1999-025": EventRef("fengyun-1c-2007", 2007),
        "1982-092": EventRef("kosmos-1408-2021", 2021),
    }
    objs = {o.norad_id: o for o in derive_objects(parse_satcat_csv(SAMPLE), events)}
    assert objs[25544].regime == "LEO"
    assert objs[24876].regime == "MEO"
    assert objs[40258].regime == "GEO"
    assert objs[5].regime == "HEO"
    assert objs[114].regime == "OTHER"
    assert objs[1].first_seen_year == 1957
    assert objs[25544].rcs_size == "LARGE"
    # Fengyun-1C fragments: catalog numbers read 2006, but they are linked to the 2007 test.
    assert objs[29716].event_id == "fengyun-1c-2007"
    assert objs[29716].first_seen_year == 2007
    assert objs[29733].event_id == "fengyun-1c-2007"
    assert objs[29733].first_seen_year == 2007
    # An earlier Kosmos 1408 piece (cataloged ~2014) is not part of the 2021 test.
    assert objs[42060].event_id is None
    assert objs[42060].first_seen_year == 2014
    assert objs[49516].event_id == "kosmos-1408-2021"
    assert objs[49516].first_seen_year == 2021
    # Six-digit catalog numbers are real objects.
    assert objs[100000].first_seen_year == 2026
    assert objs[29716].parent_cospar == "1999-025"


def test_run_ingest_satcat_writes_objects_and_logs(conn):
    n = run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    assert n == 20
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 20
    fy = conn.execute("SELECT * FROM objects WHERE norad_id = 29733").fetchone()
    assert fy["event_id"] == "fengyun-1c-2007"
    # Unknown owner codes are created on the fly with name = code.
    por = conn.execute("SELECT name FROM owners WHERE code = 'POR'").fetchone()
    assert por["name"] == "POR"
    run = conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert (run["job"], run["source"], run["status"], run["rows"]) == (
        "ingest_satcat", "celestrak", "ok", 20,
    )


def test_rerun_is_idempotent(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 20


def test_bad_payload_keeps_previous_data(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    with pytest.raises(SourceError):
        run_ingest_satcat(conn, celestrak=FakeCelesTrak("<html>oops</html>"), settings=settings())
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 20
    run = conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert run["status"] == "failed" and "unexpected" in run["error"]


def test_too_few_rows_is_rejected(conn):
    with pytest.raises(SourceError, match="expected at least 25"):
        run_ingest_satcat(
            conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings(min_satcat_rows=25)
        )
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 0
```

Also create `api/tests/__init__.py` (empty) so `from tests.conftest import FIXTURES` works.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_ingest_satcat.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.ingest.satcat'`.

- [ ] **Step 4: Implement the run log**

`api/app/ingest/runlog.py`:
```python
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime

import psycopg


@dataclass
class RunState:
    source: str
    rows: int | None = None


@contextmanager
def run_log(conn: psycopg.Connection, job: str, source: str = "pending") -> Iterator[RunState]:
    """Records a job run in ingest_runs. The body owns its own transactions, so a failed
    write is rolled back before the failure is recorded here."""
    run_id = conn.execute(
        "INSERT INTO ingest_runs (job, source, status) VALUES (%s, %s, 'running') RETURNING id",
        (job, source),
    ).fetchone()["id"]
    state = RunState(source=source)
    try:
        yield state
    except Exception as exc:
        conn.execute(
            "UPDATE ingest_runs SET finished_at = now(), status = 'failed', source = %s, "
            "error = %s WHERE id = %s",
            (state.source, f"{type(exc).__name__}: {exc}"[:2000], run_id),
        )
        raise
    conn.execute(
        "UPDATE ingest_runs SET finished_at = now(), status = 'ok', source = %s, rows = %s "
        "WHERE id = %s",
        (state.source, state.rows, run_id),
    )


def last_success(conn: psycopg.Connection, job: str, source: str | None = None) -> datetime | None:
    row = conn.execute(
        "SELECT max(finished_at) AS at FROM ingest_runs "
        "WHERE job = %s AND status = 'ok' AND (%s::text IS NULL OR source = %s)",
        (job, source, source),
    ).fetchone()
    return row["at"]
```

- [ ] **Step 5: Implement the SATCAT ingest**

`api/app/ingest/satcat.py`:
```python
import csv
import io
from collections.abc import Mapping
from dataclasses import astuple, dataclass, fields
from datetime import date

import psycopg

from app.config import Settings
from app.domain.catalog import (
    CatalogYearIndex,
    EventRef,
    first_seen_year,
    link_event,
    parent_cospar,
)
from app.domain.orbits import OBJECT_TYPES, classify_regime, rcs_size
from app.ingest.runlog import run_log
from app.ingest.sources import SourceError
from app.seeds import load_seeds

REQUIRED_COLUMNS = {
    "OBJECT_NAME", "OBJECT_ID", "NORAD_CAT_ID", "OBJECT_TYPE", "OPS_STATUS_CODE", "OWNER",
    "LAUNCH_DATE", "LAUNCH_SITE", "DECAY_DATE", "PERIOD", "INCLINATION", "APOGEE", "PERIGEE",
    "RCS", "ORBIT_CENTER",
}


@dataclass(frozen=True)
class SatcatRow:
    norad_id: int
    cospar_id: str | None
    name: str
    object_type: str
    ops_status: str | None
    owner: str
    launch_date: date | None
    launch_site: str | None
    decay_date: date | None
    period: float | None
    inclination: float | None
    apogee: float | None
    perigee: float | None
    rcs: float | None
    orbit_center: str | None


@dataclass(frozen=True)
class ObjectRecord:
    norad_id: int
    cospar_id: str | None
    name: str
    object_type: str
    ops_status: str | None
    owner: str
    launch_date: date | None
    launch_site: str | None
    decay_date: date | None
    period: float | None
    inclination: float | None
    apogee: float | None
    perigee: float | None
    rcs_size: str | None
    regime: str
    orbit_center: str | None
    parent_cospar: str | None
    event_id: str | None
    first_seen_year: int


OBJECT_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(ObjectRecord))


def _s(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def _f(value: str | None) -> float | None:
    value = _s(value)
    return float(value) if value is not None else None


def _d(value: str | None) -> date | None:
    value = _s(value)
    return date.fromisoformat(value) if value is not None else None


def parse_satcat_csv(text: str) -> list[SatcatRow]:
    reader = csv.DictReader(io.StringIO(text))
    missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
    if missing:
        raise SourceError(f"SATCAT: missing columns {sorted(missing)}")
    rows: list[SatcatRow] = []
    for r in reader:
        norad_id = int(r["NORAD_CAT_ID"])
        object_type = _s(r["OBJECT_TYPE"]) or "UNK"
        rows.append(
            SatcatRow(
                norad_id=norad_id,
                cospar_id=_s(r["OBJECT_ID"]),
                name=_s(r["OBJECT_NAME"]) or f"NORAD {norad_id}",
                object_type=object_type if object_type in OBJECT_TYPES else "UNK",
                ops_status=_s(r["OPS_STATUS_CODE"]),
                owner=_s(r["OWNER"]) or "UNK",
                launch_date=_d(r["LAUNCH_DATE"]),
                launch_site=_s(r["LAUNCH_SITE"]),
                decay_date=_d(r["DECAY_DATE"]),
                period=_f(r["PERIOD"]),
                inclination=_f(r["INCLINATION"]),
                apogee=_f(r["APOGEE"]),
                perigee=_f(r["PERIGEE"]),
                rcs=_f(r["RCS"]),
                orbit_center=_s(r["ORBIT_CENTER"]),
            )
        )
    return rows


def load_event_index(conn: psycopg.Connection) -> dict[str, EventRef]:
    rows = conn.execute(
        "SELECT id, parent_cospar, extract(year FROM event_date)::int AS year FROM breakup_events"
    ).fetchall()
    return {r["parent_cospar"]: EventRef(r["id"], r["year"]) for r in rows}


def derive_objects(rows: list[SatcatRow], events: Mapping[str, EventRef]) -> list[ObjectRecord]:
    index = CatalogYearIndex(
        (r.norad_id, r.launch_date) for r in rows if r.object_type == "PAY" and r.launch_date
    )
    out: list[ObjectRecord] = []
    for r in rows:
        catalog_year = index.year_for(r.norad_id)
        parent = parent_cospar(r.cospar_id)
        event = link_event(r.object_type, parent, catalog_year, events)
        out.append(
            ObjectRecord(
                norad_id=r.norad_id,
                cospar_id=r.cospar_id,
                name=r.name,
                object_type=r.object_type,
                ops_status=r.ops_status,
                owner=r.owner,
                launch_date=r.launch_date,
                launch_site=r.launch_site,
                decay_date=r.decay_date,
                period=r.period,
                inclination=r.inclination,
                apogee=r.apogee,
                perigee=r.perigee,
                rcs_size=rcs_size(r.rcs),
                regime=classify_regime(r.apogee, r.perigee, r.orbit_center),
                orbit_center=r.orbit_center,
                parent_cospar=parent,
                event_id=event.id if event else None,
                first_seen_year=first_seen_year(
                    launch_year=r.launch_date.year if r.launch_date else None,
                    catalog_year=catalog_year,
                    event_year=event.year if event else None,
                    decay_year=r.decay_date.year if r.decay_date else None,
                ),
            )
        )
    return out


def upsert_objects(conn: psycopg.Connection, records: list[ObjectRecord]) -> None:
    """Must be called inside a transaction."""
    owners = sorted({r.owner for r in records})
    sites = sorted({r.launch_site for r in records if r.launch_site})
    conn.execute(
        "INSERT INTO owners (code, name) SELECT c, c FROM unnest(%s::text[]) AS c "
        "ON CONFLICT (code) DO NOTHING",
        (owners,),
    )
    conn.execute(
        "INSERT INTO launch_sites (code, name) SELECT c, c FROM unnest(%s::text[]) AS c "
        "ON CONFLICT (code) DO NOTHING",
        (sites,),
    )
    cols = ", ".join(OBJECT_COLUMNS)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in OBJECT_COLUMNS if c != "norad_id")
    conn.execute("CREATE TEMP TABLE objects_in (LIKE objects INCLUDING DEFAULTS) ON COMMIT DROP")
    with conn.cursor() as cur, cur.copy(f"COPY objects_in ({cols}) FROM STDIN") as copy:
        for r in records:
            copy.write_row(astuple(r))
    conn.execute(
        f"INSERT INTO objects ({cols}) SELECT {cols} FROM objects_in "
        f"ON CONFLICT (norad_id) DO UPDATE SET {updates}, updated_at = now()"
    )


def run_ingest_satcat(conn: psycopg.Connection, *, celestrak, settings: Settings) -> int:
    with run_log(conn, "ingest_satcat", source="celestrak") as run:
        rows = parse_satcat_csv(celestrak.satcat_csv())
        if len(rows) < settings.min_satcat_rows:
            raise SourceError(
                f"SATCAT returned {len(rows)} rows, expected at least "
                f"{settings.min_satcat_rows}; keeping previous data"
            )
        with conn.transaction():
            load_seeds(conn)
            records = derive_objects(rows, load_event_index(conn))
            upsert_objects(conn, records)
        run.rows = len(records)
    return run.rows
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_ingest_satcat.py -v`
Expected: 7 passed.

- [ ] **Step 7: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/ingest api/tests
git commit -m "feat(api): SATCAT ingest with derived regimes, first-seen years and run log"
```

---

### Task 7: GP ingest job, CelesTrak fallback and globe snapshots

**Files:**
- Create: `api/app/ingest/gp.py`, `api/app/ingest/snapshot.py`, `api/tests/fixtures/gp_spacetrack_sample.json`, `api/tests/fixtures/gp_celestrak_sample.csv`, `api/tests/test_ingest_gp.py`

**Interfaces:**
- Consumes: `run_log`, `last_success`, `RunState` (Task 6); `SourceError` (Task 5); `run_ingest_satcat` (Task 6, in tests); `Settings`.
- Produces:
  - `GpRecord` dataclass (`norad_id, epoch: datetime, mean_motion, eccentricity, inclination, raan, arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot`)
  - `parse_gp_records(items: Iterable[Mapping[str, str | None]]) -> list[GpRecord]`, `parse_gp_csv(text: str) -> list[GpRecord]`
  - `write_gp(conn, records, source: str, *, replace: bool) -> int`
  - `fetch_gp(conn, spacetrack, celestrak, now: datetime) -> tuple[str, list[GpRecord]]`
  - `run_ingest_gp(conn, *, spacetrack, celestrak, store: SnapshotStore, settings: Settings, now: datetime | None = None) -> int`
  - In `snapshot.py`: `SnapshotStore` (Protocol with `put(key: str, data: bytes) -> None`, `get(key: str) -> bytes | None`), `LocalSnapshotStore(root)`, `SNAPSHOT_GROUPS = {"LEO": ("LEO",), "HIGH": ("MEO", "GEO", "HEO")}`, `snapshot_key(group: str) -> str`, `RECORD` (`struct.Struct("<IHBx10d")`), `pack_snapshot(rows: list[dict], generated_at: datetime) -> bytes`, `unpack_snapshot(data: bytes) -> tuple[dict, list[tuple]]`, `write_snapshots(conn, store, generated_at: datetime) -> dict[str, int]`

**Snapshot binary format (the web plan decodes this):** `gzip( b"LEO1" + uint32_le(header_len) + header_json_utf8 + records )`. Header JSON: `{"version": 1, "generated_at": ISO-8601, "count": N, "owners": [codes...], "types": ["PAY","R/B","DEB","UNK"], "record_size": 88, "fields": [...]}`. Each record is little-endian `uint32 norad_id, uint16 owner_index, uint8 type_index, 1 pad byte, float64 × 10: epoch_unix_seconds, mean_motion_rev_per_day, eccentricity, inclination_deg, raan_deg, arg_pericenter_deg, mean_anomaly_deg, bstar, mean_motion_dot, mean_motion_ddot`.

- [ ] **Step 1: Add fixtures**

`api/tests/fixtures/gp_spacetrack_sample.json` (Space-Track OMM JSON: values are strings. 29733's elements are synthetic but consistent with its 111-minute period. 123456 is deliberately not in the catalog):
```json
[
  {"NORAD_CAT_ID": "25544", "OBJECT_TYPE": "PAYLOAD", "EPOCH": "2026-09-22T06:30:37.496448",
   "MEAN_MOTION": "15.49224498", "ECCENTRICITY": "0.00047657", "INCLINATION": "51.6312",
   "RA_OF_ASC_NODE": "179.6046", "ARG_OF_PERICENTER": "167.6102", "MEAN_ANOMALY": "192.5004",
   "BSTAR": "0.0001364276", "MEAN_MOTION_DOT": "0.00007132", "MEAN_MOTION_DDOT": "0"},
  {"NORAD_CAT_ID": "24876", "OBJECT_TYPE": "PAYLOAD", "EPOCH": "2026-09-22T10:11:43.219392",
   "MEAN_MOTION": "2.00564517", "ECCENTRICITY": "0.01060881", "INCLINATION": "56.0511",
   "RA_OF_ASC_NODE": "94.7725", "ARG_OF_PERICENTER": "59.0192", "MEAN_ANOMALY": "302.0940",
   "BSTAR": "0", "MEAN_MOTION_DOT": "0.00000052", "MEAN_MOTION_DDOT": "0"},
  {"NORAD_CAT_ID": "29733", "OBJECT_TYPE": "DEBRIS", "EPOCH": "2026-09-21T18:02:11.000000",
   "MEAN_MOTION": "12.96920000", "ECCENTRICITY": "0.05800000", "INCLINATION": "99.2100",
   "RA_OF_ASC_NODE": "210.1000", "ARG_OF_PERICENTER": "120.5000", "MEAN_ANOMALY": "240.2000",
   "BSTAR": "0.000021", "MEAN_MOTION_DOT": "0.0000003", "MEAN_MOTION_DDOT": "0"},
  {"NORAD_CAT_ID": "123456", "OBJECT_TYPE": "UNKNOWN", "EPOCH": "2026-09-21T00:00:00.000000",
   "MEAN_MOTION": "15.0", "ECCENTRICITY": "0.001", "INCLINATION": "50.0",
   "RA_OF_ASC_NODE": "0", "ARG_OF_PERICENTER": "0", "MEAN_ANOMALY": "0",
   "BSTAR": "0", "MEAN_MOTION_DOT": "0", "MEAN_MOTION_DDOT": "0"}
]
```

`api/tests/fixtures/gp_celestrak_sample.csv` (real CelesTrak rows. ISS has a newer epoch than the Space-Track sample):
```csv
OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT
NAVSTAR 43 (USA 132),1997-035A,2026-09-22T10:11:43.219392,2.00564517,.01060881,56.0511,94.7725,59.0192,302.0940,0,U,24876,999,21390,0,.52E-6,0
ISS (ZARYA),1998-067A,2026-09-23T06:30:37.496448,15.49224498,.00047657,51.6312,179.6046,167.6102,192.5004,0,U,25544,999,58680,.1364276E-3,.7132E-4,0
```

- [ ] **Step 2: Write the failing tests**

`api/tests/test_ingest_gp.py`:
```python
import json
from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.ingest.gp import parse_gp_csv, parse_gp_records, run_ingest_gp
from app.ingest.satcat import run_ingest_satcat
from app.ingest.snapshot import (
    LocalSnapshotStore,
    snapshot_key,
    unpack_snapshot,
)
from app.ingest.sources import SourceError
from tests.conftest import FIXTURES
from tests.test_ingest_satcat import SAMPLE, FakeCelesTrak

ST_SAMPLE = json.loads((FIXTURES / "gp_spacetrack_sample.json").read_text())
CT_SAMPLE = (FIXTURES / "gp_celestrak_sample.csv").read_text()
NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)
SETTINGS = Settings(min_satcat_rows=10, min_gp_rows_spacetrack=3, min_gp_rows_celestrak=1)


class FakeSpaceTrack:
    def __init__(self, data=None, error: Exception | None = None):
        self.data, self.error = data, error

    def gp_all_on_orbit(self):
        if self.error:
            raise self.error
        return self.data


class FakeCelesTrakGp(FakeCelesTrak):
    def gp_active_csv(self) -> str:
        return CT_SAMPLE


@pytest.fixture
def catalog(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=SETTINGS)
    return conn


@pytest.fixture
def store(tmp_path):
    return LocalSnapshotStore(tmp_path)


def gp_rows(conn):
    return {r["norad_id"]: r for r in conn.execute("SELECT * FROM gp_elements").fetchall()}


def test_parse_gp_records_and_csv():
    recs = {r.norad_id: r for r in parse_gp_records(ST_SAMPLE)}
    assert recs[25544].mean_motion == pytest.approx(15.49224498)
    assert recs[25544].epoch == datetime(2026, 9, 22, 6, 30, 37, 496448, tzinfo=UTC)
    csv_recs = {r.norad_id: r for r in parse_gp_csv(CT_SAMPLE)}
    assert csv_recs[24876].mean_motion_dot == pytest.approx(0.52e-6)


def test_parse_gp_skips_malformed_rows():
    bad = [{"NORAD_CAT_ID": "1", "EPOCH": "not-a-date"}, ST_SAMPLE[0]]
    assert [r.norad_id for r in parse_gp_records(bad)] == [25544]


def test_spacetrack_ingest_replaces_and_skips_unknown_objects(catalog, store):
    n = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    assert n == 3
    rows = gp_rows(catalog)
    assert set(rows) == {25544, 24876, 29733}
    assert rows[25544]["source"] == "spacetrack"


def test_snapshots_are_written_per_group(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    header, records = unpack_snapshot(store.get(snapshot_key("LEO")))
    assert header["version"] == 1 and header["count"] == 2
    by_id = {r[0]: r for r in records}
    assert set(by_id) == {25544, 29733}
    iss = by_id[25544]
    assert header["owners"][iss[1]] == "ISS"
    assert header["types"][iss[2]] == "PAY"
    assert iss[4] == pytest.approx(15.49224498)
    high_header, high_records = unpack_snapshot(store.get(snapshot_key("HIGH")))
    assert [r[0] for r in high_records] == [24876]


def test_too_few_spacetrack_rows_keeps_data(catalog, store):
    s = Settings(min_satcat_rows=10, min_gp_rows_spacetrack=100, min_gp_rows_celestrak=1)
    with pytest.raises(SourceError, match="expected at least 100"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
            store=store, settings=s, now=NOW,
        )
    assert gp_rows(catalog) == {}


def test_spacetrack_failure_within_24h_keeps_data(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    before = gp_rows(catalog)
    with pytest.raises(SourceError, match="login failed"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(error=SourceError("Space-Track login failed")),
            celestrak=FakeCelesTrakGp(SAMPLE), store=store, settings=SETTINGS,
            now=datetime.now(UTC),
        )
    assert gp_rows(catalog) == before


def test_celestrak_fallback_upserts_without_deleting(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    # Pretend the last Space-Track success was 2 days ago.
    catalog.execute(
        "UPDATE ingest_runs SET finished_at = %s WHERE job = 'ingest_gp'",
        (datetime.now(UTC) - timedelta(days=2),),
    )
    n = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(error=SourceError("Space-Track GP: HTTP 500")),
        celestrak=FakeCelesTrakGp(SAMPLE), store=store, settings=SETTINGS,
        now=datetime.now(UTC),
    )
    assert n == 2
    rows = gp_rows(catalog)
    assert set(rows) == {25544, 24876, 29733}          # debris 29733 kept
    assert rows[25544]["source"] == "celestrak"          # refreshed
    assert rows[29733]["source"] == "spacetrack"
    run = catalog.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert run["source"] == "celestrak" and run["status"] == "ok"


def test_no_spacetrack_credentials_uses_celestrak(catalog, store):
    n = run_ingest_gp(
        catalog, spacetrack=None, celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    assert n == 2
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_ingest_gp.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.ingest.gp'`.

- [ ] **Step 4: Implement snapshots**

`api/app/ingest/snapshot.py`:
```python
import gzip
import json
import struct
from datetime import datetime
from pathlib import Path
from typing import Protocol

import psycopg

from app.domain.orbits import OBJECT_TYPES

MAGIC = b"LEO1"
RECORD = struct.Struct("<IHBx10d")  # 88 bytes
FIELDS = [
    "norad_id", "owner_index", "type_index", "epoch_unix", "mean_motion", "eccentricity",
    "inclination", "raan", "arg_pericenter", "mean_anomaly", "bstar", "mean_motion_dot",
    "mean_motion_ddot",
]
SNAPSHOT_GROUPS: dict[str, tuple[str, ...]] = {"LEO": ("LEO",), "HIGH": ("MEO", "GEO", "HEO")}


class SnapshotStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes | None: ...


class LocalSnapshotStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)

    def put(self, key: str, data: bytes) -> None:
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)

    def get(self, key: str) -> bytes | None:
        path = self.root / key
        return path.read_bytes() if path.exists() else None


def snapshot_key(group: str) -> str:
    return f"globe/{group}.bin.gz"


def pack_snapshot(rows: list[dict], generated_at: datetime) -> bytes:
    owners = sorted({r["owner"] for r in rows})
    owner_index = {code: i for i, code in enumerate(owners)}
    header = json.dumps(
        {
            "version": 1,
            "generated_at": generated_at.isoformat(),
            "count": len(rows),
            "owners": owners,
            "types": list(OBJECT_TYPES),
            "record_size": RECORD.size,
            "fields": FIELDS,
        }
    ).encode()
    body = bytearray(MAGIC + struct.pack("<I", len(header)) + header)
    for r in rows:
        body += RECORD.pack(
            r["norad_id"], owner_index[r["owner"]], OBJECT_TYPES.index(r["object_type"]),
            r["epoch"].timestamp(), r["mean_motion"], r["eccentricity"], r["inclination"],
            r["raan"], r["arg_pericenter"], r["mean_anomaly"], r["bstar"],
            r["mean_motion_dot"], r["mean_motion_ddot"],
        )
    return gzip.compress(bytes(body), compresslevel=6)


def unpack_snapshot(data: bytes) -> tuple[dict, list[tuple]]:
    raw = gzip.decompress(data)
    if raw[:4] != MAGIC:
        raise ValueError("not a LEO1 snapshot")
    (header_len,) = struct.unpack_from("<I", raw, 4)
    header = json.loads(raw[8 : 8 + header_len])
    offset = 8 + header_len
    records = [RECORD.unpack_from(raw, offset + i * RECORD.size) for i in range(header["count"])]
    return header, records


def write_snapshots(
    conn: psycopg.Connection, store: SnapshotStore, generated_at: datetime
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for group, regimes in SNAPSHOT_GROUPS.items():
        rows = conn.execute(
            """
            SELECT o.norad_id, o.owner, o.object_type, g.epoch, g.mean_motion, g.eccentricity,
                   g.inclination, g.raan, g.arg_pericenter, g.mean_anomaly, g.bstar,
                   g.mean_motion_dot, g.mean_motion_ddot
            FROM gp_elements g JOIN objects o USING (norad_id)
            WHERE o.decay_date IS NULL AND o.regime = ANY(%s)
            ORDER BY o.norad_id
            """,
            (list(regimes),),
        ).fetchall()
        store.put(snapshot_key(group), pack_snapshot(rows, generated_at))
        counts[group] = len(rows)
    return counts
```

- [ ] **Step 5: Implement the GP ingest**

`api/app/ingest/gp.py`:
```python
import csv
import io
import logging
from collections.abc import Iterable, Mapping
from dataclasses import astuple, dataclass, fields
from datetime import UTC, datetime, timedelta

import psycopg

from app.config import Settings
from app.ingest.runlog import last_success, run_log
from app.ingest.snapshot import SnapshotStore, write_snapshots
from app.ingest.sources import SourceError

log = logging.getLogger(__name__)
FALLBACK_AFTER = timedelta(hours=24)


@dataclass(frozen=True)
class GpRecord:
    norad_id: int
    epoch: datetime
    mean_motion: float
    eccentricity: float
    inclination: float
    raan: float
    arg_pericenter: float
    mean_anomaly: float
    bstar: float
    mean_motion_dot: float
    mean_motion_ddot: float


GP_COLUMNS = tuple(f.name for f in fields(GpRecord))


def _epoch(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def parse_gp_records(items: Iterable[Mapping[str, str | None]]) -> list[GpRecord]:
    """Parses OMM mappings (Space-Track JSON objects or CelesTrak CSV rows share field names)."""
    out: list[GpRecord] = []
    skipped = 0
    for d in items:
        try:
            out.append(
                GpRecord(
                    norad_id=int(d["NORAD_CAT_ID"]),
                    epoch=_epoch(d["EPOCH"]),
                    mean_motion=float(d["MEAN_MOTION"]),
                    eccentricity=float(d["ECCENTRICITY"]),
                    inclination=float(d["INCLINATION"]),
                    raan=float(d["RA_OF_ASC_NODE"]),
                    arg_pericenter=float(d["ARG_OF_PERICENTER"]),
                    mean_anomaly=float(d["MEAN_ANOMALY"]),
                    bstar=float(d["BSTAR"]),
                    mean_motion_dot=float(d["MEAN_MOTION_DOT"]),
                    mean_motion_ddot=float(d["MEAN_MOTION_DDOT"]),
                )
            )
        except (KeyError, TypeError, ValueError):
            skipped += 1
    if skipped:
        log.warning("skipped %d malformed GP rows", skipped)
    return out


def parse_gp_csv(text: str) -> list[GpRecord]:
    return parse_gp_records(csv.DictReader(io.StringIO(text)))


def write_gp(
    conn: psycopg.Connection, records: list[GpRecord], source: str, *, replace: bool
) -> int:
    cols = ", ".join(GP_COLUMNS)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in (*GP_COLUMNS[1:], "source", "fetched_at"))
    with conn.transaction():
        conn.execute(
            "CREATE TEMP TABLE gp_in (LIKE gp_elements INCLUDING DEFAULTS) ON COMMIT DROP"
        )
        with conn.cursor() as cur, cur.copy(f"COPY gp_in ({cols}, source) FROM STDIN") as copy:
            for r in records:
                copy.write_row((*astuple(r), source))
        if replace:
            conn.execute("DELETE FROM gp_elements")
        cur = conn.execute(
            f"""
            INSERT INTO gp_elements ({cols}, source, fetched_at)
            SELECT DISTINCT ON (norad_id) {cols}, source, now() FROM gp_in
            WHERE norad_id IN (SELECT norad_id FROM objects)
            ORDER BY norad_id, epoch DESC
            ON CONFLICT (norad_id) DO UPDATE SET {updates}
            """
        )
        return cur.rowcount


def fetch_gp(
    conn: psycopg.Connection, spacetrack, celestrak, now: datetime
) -> tuple[str, list[GpRecord]]:
    if spacetrack is not None:
        try:
            return "spacetrack", parse_gp_records(spacetrack.gp_all_on_orbit())
        except SourceError:
            last_ok = last_success(conn, "ingest_gp", "spacetrack")
            if last_ok is not None and now - last_ok < FALLBACK_AFTER:
                raise
            log.warning("Space-Track unavailable for over 24 h; falling back to CelesTrak")
    return "celestrak", parse_gp_csv(celestrak.gp_active_csv())


def run_ingest_gp(
    conn: psycopg.Connection,
    *,
    spacetrack,
    celestrak,
    store: SnapshotStore,
    settings: Settings,
    now: datetime | None = None,
) -> int:
    now = now or datetime.now(UTC)
    with run_log(conn, "ingest_gp") as run:
        source, records = fetch_gp(conn, spacetrack, celestrak, now)
        run.source = source
        minimum = (
            settings.min_gp_rows_spacetrack
            if source == "spacetrack"
            else settings.min_gp_rows_celestrak
        )
        if len(records) < minimum:
            raise SourceError(
                f"{source} returned {len(records)} GP records, expected at least {minimum}; "
                "keeping previous data"
            )
        # Space-Track is the full catalog: replace. CelesTrak is partial: upsert only.
        run.rows = write_gp(conn, records, source, replace=(source == "spacetrack"))
        write_snapshots(conn, store, now)
    return run.rows
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_ingest_gp.py -v`
Expected: 8 passed.

- [ ] **Step 7: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/ingest api/tests
git commit -m "feat(api): GP ingest with CelesTrak fallback and packed globe snapshots"
```

---

### Task 8: Yearly statistics rebuild

**Files:**
- Create: `api/app/stats/__init__.py` (empty), `api/app/stats/rebuild.py`, `api/tests/factories.py`, `api/tests/test_stats_rebuild.py`

**Interfaces:**
- Consumes: `objects` table; `run_log` (Task 6).
- Produces: `rebuild_yearly_stats(conn) -> int` (rows written; runs in its own transaction); `run_rebuild_stats(conn) -> int` (wrapped in `run_log(job="rebuild_stats", source="db")`); test helper `insert_object(conn, norad_id, **overrides) -> None`.

- [ ] **Step 1: Write the factory and failing tests**

`api/tests/factories.py`:
```python
from datetime import date

import psycopg

DEFAULTS = {
    "cospar_id": None, "object_type": "PAY", "ops_status": None, "owner": "US",
    "launch_date": None, "launch_site": None, "decay_date": None, "period": 95.0,
    "inclination": 53.0, "apogee": 500.0, "perigee": 480.0, "rcs_size": None,
    "regime": "LEO", "orbit_center": "EA", "parent_cospar": None, "event_id": None,
    "first_seen_year": 2000,
}


def insert_object(conn: psycopg.Connection, norad_id: int, **overrides) -> None:
    row = {**DEFAULTS, "name": f"OBJECT {norad_id}", **overrides, "norad_id": norad_id}
    conn.execute(
        "INSERT INTO owners (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (row["owner"], row["owner"]),
    )
    cols = ", ".join(row)
    vals = ", ".join(f"%({k})s" for k in row)
    conn.execute(f"INSERT INTO objects ({cols}) VALUES ({vals})", row)


def seed_stats_world(conn: psycopg.Connection) -> None:
    """Four objects with hand-computable yearly counts, used by stats and API tests."""
    insert_object(conn, 1, object_type="PAY", owner="US", first_seen_year=2000,
                  name="ALPHA SAT", cospar_id="2000-001A")
    insert_object(conn, 2, object_type="DEB", owner="PRC", first_seen_year=2007,
                  decay_date=date(2010, 5, 1), name="ALPHA DEB", cospar_id="1999-025AC")
    insert_object(conn, 3, object_type="R/B", owner="CIS", first_seen_year=2015,
                  decay_date=date(2015, 8, 1), name="BETA R/B 50%_OFF", cospar_id="2015-010B")
    insert_object(conn, 4, object_type="PAY", owner="US", regime="GEO", first_seen_year=2005,
                  apogee=35800.0, perigee=35780.0, inclination=0.1, name="GAMMA GEO")
```

`api/tests/test_stats_rebuild.py`:
```python
from app.stats.rebuild import rebuild_yearly_stats, run_rebuild_stats
from tests.factories import seed_stats_world


def stat(conn, year, owner, object_type, regime="LEO"):
    return conn.execute(
        "SELECT in_orbit, added, reentered FROM yearly_stats "
        "WHERE year = %s AND owner = %s AND object_type = %s AND regime = %s",
        (year, owner, object_type, regime),
    ).fetchone()


def test_in_orbit_added_and_reentered(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    assert stat(conn, 2007, "PRC", "DEB") == {"in_orbit": 1, "added": 1, "reentered": 0}
    assert stat(conn, 2009, "PRC", "DEB") == {"in_orbit": 1, "added": 0, "reentered": 0}
    assert stat(conn, 2010, "PRC", "DEB") == {"in_orbit": 0, "added": 0, "reentered": 1}
    assert stat(conn, 2011, "PRC", "DEB") is None
    assert stat(conn, 2020, "US", "PAY", "GEO") == {"in_orbit": 1, "added": 0, "reentered": 0}


def test_same_year_add_and_decay(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    assert stat(conn, 2015, "CIS", "R/B") == {"in_orbit": 0, "added": 1, "reentered": 1}


def test_totals_per_year(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    rows = conn.execute(
        "SELECT year, sum(in_orbit)::int AS n FROM yearly_stats "
        "WHERE year IN (1999, 2000, 2008, 2012) GROUP BY year ORDER BY year"
    ).fetchall()
    assert [(r["year"], r["n"]) for r in rows] == [(2000, 1), (2008, 3), (2012, 2)]


def test_rebuild_replaces_previous_rows_and_logs(conn):
    seed_stats_world(conn)
    first = run_rebuild_stats(conn)
    second = run_rebuild_stats(conn)
    assert first == second > 0
    count = conn.execute("SELECT count(*) AS n FROM yearly_stats").fetchone()["n"]
    assert count == first
    run = conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert (run["job"], run["status"]) == ("rebuild_stats", "ok")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_stats_rebuild.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.stats'`.

- [ ] **Step 3: Implement**

`api/app/stats/rebuild.py`:
```python
import psycopg

from app.ingest.runlog import run_log

REBUILD_SQL = """
INSERT INTO yearly_stats (year, owner, object_type, regime, in_orbit, added, reentered)
SELECT y.year, o.owner, o.object_type, o.regime,
       count(*) FILTER (WHERE o.dy IS NULL OR o.dy > y.year),
       count(*) FILTER (WHERE o.first_seen_year = y.year),
       count(*) FILTER (WHERE o.dy = y.year)
FROM generate_series(1957, extract(year FROM now())::int) AS y(year)
JOIN (
  SELECT owner, object_type, regime, first_seen_year,
         extract(year FROM decay_date)::int AS dy
  FROM objects
) o ON o.first_seen_year <= y.year AND (o.dy IS NULL OR o.dy >= y.year)
GROUP BY y.year, o.owner, o.object_type, o.regime
"""


def rebuild_yearly_stats(conn: psycopg.Connection) -> int:
    with conn.transaction():
        conn.execute("DELETE FROM yearly_stats")
        return conn.execute(REBUILD_SQL).rowcount


def run_rebuild_stats(conn: psycopg.Connection) -> int:
    with run_log(conn, "rebuild_stats", source="db") as run:
        run.rows = rebuild_yearly_stats(conn)
    return run.rows
```

The join keeps only (year, object) pairs where the object existed at some point during that year. `in_orbit` then drops objects that decayed during the year. `first_seen_year` is already clamped to ≤ decay year (Task 4), so no object is skipped.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_stats_rebuild.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/stats api/tests
git commit -m "feat(api): precomputed yearly stats (in orbit, added, re-entered)"
```

---

### Task 9: Filters and stats services

**Files:**
- Create: `api/app/services/__init__.py` (empty), `api/app/services/filters.py`, `api/app/services/stats.py`, `api/tests/test_services_stats.py`

**Interfaces:**
- Consumes: `yearly_stats`, `objects`, `owners`; `ApiError` (Task 1); `OBJECT_TYPES`, `REGIMES` (Task 4); `rebuild_yearly_stats`, `seed_stats_world` (Task 8, tests).
- Produces:
  - `Filters(owners: tuple[str, ...] | None, types: tuple[str, ...] | None, regimes: tuple[str, ...] | None)` with `.where() -> tuple[sql.Composable, dict]`
  - `parse_filters(conn, owners: str | None, types: str | None, regimes: str | None) -> Filters` (raises `ApiError(422, "invalid_filter", ...)`)
  - `parse_year_range(from_year: int | None, to_year: int | None, current_year: int) -> tuple[int, int]` (raises `ApiError(422, "invalid_range", ...)`)
  - `OTHER_KEY = "_other"`
  - `timeseries(conn, *, metric: str, group_by: str, filters: Filters, from_year: int, to_year: int, top: int = 8) -> dict` returning `{"metric", "group_by", "years": [int], "series": [{"key": str, "values": [int]}]}`
  - `breakdown(conn, *, at_year: int, by: str, filters: Filters, top: int = 8) -> dict` returning `{"at", "by", "rows": [{"key", "counts": {type: int}, "total": int}]}`
  - `distribution(conn, *, field: str, filters: Filters, bin_width: float | None = None) -> dict` returning `{"field", "bin_width", "bins": [{"key": str, "start": float | None, "counts": {type: int}, "total": int}]}`

- [ ] **Step 1: Write the failing tests**

`api/tests/test_services_stats.py`:
```python
import pytest

from app.errors import ApiError
from app.services.filters import Filters, parse_filters, parse_year_range
from app.services.stats import OTHER_KEY, _fold_top, breakdown, distribution, timeseries
from app.stats.rebuild import rebuild_yearly_stats
from tests.factories import seed_stats_world

ALL = Filters(None, None, None)


@pytest.fixture
def world(conn):
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    return conn


def series(result):
    return {s["key"]: s["values"] for s in result["series"]}


def test_parse_filters_normalizes_case_and_blanks(world):
    f = parse_filters(world, " us ,,prc", "pay,deb", "leo")
    assert f == Filters(("US", "PRC"), ("PAY", "DEB"), ("LEO",))
    assert parse_filters(world, None, "", None) == ALL


def test_parse_filters_rejects_unknown_owner(world):
    with pytest.raises(ApiError) as e:
        parse_filters(world, "US,XX", None, None)
    assert e.value.status == 422 and e.value.code == "invalid_filter" and "XX" in e.value.message


def test_parse_filters_rejects_unknown_type_and_regime(world):
    with pytest.raises(ApiError, match="object type"):
        parse_filters(world, None, "SAT", None)
    with pytest.raises(ApiError, match="regime"):
        parse_filters(world, None, None, "LUNAR")


def test_parse_year_range():
    assert parse_year_range(None, None, 2026) == (1957, 2026)
    assert parse_year_range(2006, 2011, 2026) == (2006, 2011)
    for bad in [(2011, 2006), (1900, 2000), (2000, 2030)]:
        with pytest.raises(ApiError) as e:
            parse_year_range(*bad, 2026)
        assert e.value.code == "invalid_range"


def test_timeseries_in_orbit_by_type(world):
    r = timeseries(world, metric="in_orbit", group_by="type", filters=ALL,
                   from_year=2006, to_year=2011)
    assert r["years"] == [2006, 2007, 2008, 2009, 2010, 2011]
    assert series(r) == {"PAY": [2] * 6, "DEB": [0, 1, 1, 1, 0, 0]}


def test_timeseries_respects_filters(world):
    leo = Filters(None, None, ("LEO",))
    r = timeseries(world, metric="in_orbit", group_by="none", filters=leo,
                   from_year=2006, to_year=2008)
    assert series(r) == {"all": [1, 2, 2]}


def test_timeseries_added_and_reentered(world):
    added = timeseries(world, metric="added", group_by="none", filters=ALL,
                       from_year=2005, to_year=2008)
    assert series(added) == {"all": [1, 0, 1, 0]}
    gone = timeseries(world, metric="reentered", group_by="type", filters=ALL,
                      from_year=2010, to_year=2015)
    assert series(gone) == {"DEB": [1, 0, 0, 0, 0, 0], "R/B": [0, 0, 0, 0, 0, 1]}


def test_fold_top_keeps_leaders_and_sums_the_rest():
    folded = _fold_top({"US": [1, 2], "PRC": [3, 1], "CIS": [0, 1]}, top=1)
    assert folded == {"US": [1, 2], OTHER_KEY: [3, 2]}


def test_breakdown_by_owner(world):
    r = breakdown(world, at_year=2008, by="owner", filters=ALL)
    assert r["rows"] == [
        {"key": "US", "counts": {"PAY": 2}, "total": 2},
        {"key": "PRC", "counts": {"DEB": 1}, "total": 1},
    ]


def test_distribution_perigee_bins(world):
    r = distribution(world, field="perigee", filters=ALL, bin_width=100)
    assert [(b["key"], b["total"]) for b in r["bins"]] == [("400", 1), ("35700", 1)]
    assert r["bins"][0]["counts"] == {"PAY": 1}


def test_distribution_rcs_categories(world):
    world.execute("UPDATE objects SET rcs_size = 'LARGE' WHERE norad_id = 1")
    r = distribution(world, field="rcs_size", filters=ALL)
    assert r["bin_width"] is None
    assert {b["key"]: b["total"] for b in r["bins"]} == {"LARGE": 1, "UNKNOWN": 1}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_services_stats.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services'`.

- [ ] **Step 3: Implement filters**

`api/app/services/filters.py`:
```python
from dataclasses import dataclass

import psycopg
from psycopg import sql

from app.domain.orbits import OBJECT_TYPES, REGIMES
from app.errors import ApiError

FIRST_YEAR = 1957


@dataclass(frozen=True)
class Filters:
    owners: tuple[str, ...] | None
    types: tuple[str, ...] | None
    regimes: tuple[str, ...] | None

    def where(self) -> tuple[sql.Composable, dict]:
        """SQL condition over columns owner / object_type / regime (valid for both
        yearly_stats and objects)."""
        parts: list[sql.Composable] = [sql.SQL("TRUE")]
        params: dict = {}
        if self.owners:
            parts.append(sql.SQL("owner = ANY(%(f_owners)s)"))
            params["f_owners"] = list(self.owners)
        if self.types:
            parts.append(sql.SQL("object_type = ANY(%(f_types)s)"))
            params["f_types"] = list(self.types)
        if self.regimes:
            parts.append(sql.SQL("regime = ANY(%(f_regimes)s)"))
            params["f_regimes"] = list(self.regimes)
        return sql.SQL(" AND ").join(parts), params


def _split(value: str | None) -> tuple[str, ...] | None:
    items = tuple(dict.fromkeys(s.strip().upper() for s in (value or "").split(",") if s.strip()))
    return items or None


def parse_filters(
    conn: psycopg.Connection, owners: str | None, types: str | None, regimes: str | None
) -> Filters:
    f = Filters(_split(owners), _split(types), _split(regimes))
    for t in f.types or ():
        if t not in OBJECT_TYPES:
            raise ApiError(422, "invalid_filter",
                           f"unknown object type '{t}' (expected one of {', '.join(OBJECT_TYPES)})")
    for r in f.regimes or ():
        if r not in REGIMES:
            raise ApiError(422, "invalid_filter",
                           f"unknown regime '{r}' (expected one of {', '.join(REGIMES)})")
    if f.owners:
        known = {
            row["code"]
            for row in conn.execute(
                "SELECT code FROM owners WHERE code = ANY(%s)", (list(f.owners),)
            ).fetchall()
        }
        unknown = [o for o in f.owners if o not in known]
        if unknown:
            raise ApiError(422, "invalid_filter", f"unknown owner code '{unknown[0]}'")
    return f


def parse_year_range(
    from_year: int | None, to_year: int | None, current_year: int
) -> tuple[int, int]:
    start = FIRST_YEAR if from_year is None else from_year
    end = current_year if to_year is None else to_year
    if not (FIRST_YEAR <= start <= current_year and FIRST_YEAR <= end <= current_year):
        raise ApiError(422, "invalid_range",
                       f"years must be between {FIRST_YEAR} and {current_year}")
    if start > end:
        raise ApiError(422, "invalid_range", f"'from' ({start}) is after 'to' ({end})")
    return start, end
```

- [ ] **Step 4: Implement stats queries**

`api/app/services/stats.py`:
```python
from collections import defaultdict

import psycopg
from psycopg import sql

from app.services.filters import Filters

OTHER_KEY = "_other"
METRICS = ("in_orbit", "added", "reentered")
GROUP_COLUMNS = {"type": "object_type", "owner": "owner", "regime": "regime"}
NUMERIC_FIELDS = {"perigee": 50.0, "apogee": 50.0, "inclination": 2.0}


def _fold_top(values: dict[str, list[int]], top: int) -> dict[str, list[int]]:
    ranked = sorted(values, key=lambda k: (values[k][-1], sum(values[k])), reverse=True)
    keep, rest = ranked[:top], ranked[top:]
    out = {k: values[k] for k in keep}
    if rest:
        out[OTHER_KEY] = [sum(col) for col in zip(*(values[k] for k in rest), strict=True)]
    return out


def timeseries(
    conn: psycopg.Connection, *, metric: str, group_by: str, filters: Filters,
    from_year: int, to_year: int, top: int = 8,
) -> dict:
    where, params = filters.where()
    key = (
        sql.Identifier(GROUP_COLUMNS[group_by]) if group_by in GROUP_COLUMNS
        else sql.Literal("all")
    )
    query = sql.SQL(
        "SELECT year, {key} AS key, sum({metric})::bigint AS value FROM yearly_stats "
        "WHERE {where} AND year BETWEEN %(y0)s AND %(y1)s GROUP BY year, 2"
    ).format(key=key, metric=sql.Identifier(metric), where=where)
    rows = conn.execute(query, {**params, "y0": from_year, "y1": to_year}).fetchall()
    years = list(range(from_year, to_year + 1))
    values: dict[str, list[int]] = {}
    for r in rows:
        values.setdefault(r["key"], [0] * len(years))[r["year"] - from_year] = int(r["value"])
    values = {k: v for k, v in values.items() if any(v)}
    if group_by == "owner":
        values = _fold_top(values, top)
    order = sorted(values, key=lambda k: (k == OTHER_KEY, -values[k][-1], -sum(values[k])))
    return {
        "metric": metric,
        "group_by": group_by,
        "years": years,
        "series": [{"key": k, "values": values[k]} for k in order],
    }


def breakdown(
    conn: psycopg.Connection, *, at_year: int, by: str, filters: Filters, top: int = 8
) -> dict:
    where, params = filters.where()
    query = sql.SQL(
        "SELECT {key} AS key, object_type, sum(in_orbit)::bigint AS n FROM yearly_stats "
        "WHERE {where} AND year = %(at)s GROUP BY 1, 2 HAVING sum(in_orbit) > 0"
    ).format(key=sql.Identifier(GROUP_COLUMNS[by]), where=where)
    counts: dict[str, dict[str, int]] = defaultdict(dict)
    for r in conn.execute(query, {**params, "at": at_year}).fetchall():
        counts[r["key"]][r["object_type"]] = int(r["n"])
    rows = sorted(
        ({"key": k, "counts": c, "total": sum(c.values())} for k, c in counts.items()),
        key=lambda row: -row["total"],
    )
    if by == "owner" and len(rows) > top:
        other: dict[str, int] = defaultdict(int)
        for row in rows[top:]:
            for t, n in row["counts"].items():
                other[t] += n
        rows = rows[:top] + [{"key": OTHER_KEY, "counts": dict(other),
                              "total": sum(other.values())}]
    return {"at": at_year, "by": by, "rows": rows}


def distribution(
    conn: psycopg.Connection, *, field: str, filters: Filters, bin_width: float | None = None
) -> dict:
    where, params = filters.where()
    if field == "rcs_size":
        query = sql.SQL(
            "SELECT coalesce(rcs_size, 'UNKNOWN') AS key, NULL::float AS start, object_type, "
            "count(*) AS n FROM objects WHERE decay_date IS NULL AND {where} "
            "GROUP BY 1, 2, 3 ORDER BY 1"
        ).format(where=where)
        width = None
    else:
        width = float(bin_width or NUMERIC_FIELDS[field])
        query = sql.SQL(
            "SELECT floor({f} / %(w)s) * %(w)s AS start, object_type, count(*) AS n "
            "FROM objects WHERE decay_date IS NULL AND {f} IS NOT NULL AND {where} "
            "GROUP BY 1, 2 ORDER BY 1"
        ).format(f=sql.Identifier(field), where=where)
        params = {**params, "w": width}
    bins: dict[str, dict] = {}
    for r in conn.execute(query, params).fetchall():
        key = r["key"] if field == "rcs_size" else f"{r['start']:g}"
        b = bins.setdefault(key, {"key": key, "start": r["start"], "counts": {}, "total": 0})
        b["counts"][r["object_type"]] = int(r["n"])
        b["total"] += int(r["n"])
    return {"field": field, "bin_width": width, "bins": list(bins.values())}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_services_stats.py -v`
Expected: all passed.

- [ ] **Step 6: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/services api/tests/test_services_stats.py
git commit -m "feat(api): filter parsing and stats services (timeseries, breakdown, distribution)"
```

---

### Task 10: Object, event and meta services

**Files:**
- Create: `api/app/services/objects.py`, `api/app/services/events.py`, `api/app/services/meta.py`, `api/tests/test_services_objects.py`

**Interfaces:**
- Consumes: tables; `ApiError`; label constants and `ATTRIBUTION` (Task 4); `load_seeds` (Task 3); `seed_stats_world` (Task 8).
- Produces:
  - `get_object(conn, norad_id: int) -> dict | None`: object columns plus `owner_name`, `flag_emoji`, `launch_site_name`, `ops_status_label`, `event` (`{"id","name","event_date"}` or None) and `elements` (GP dict or None)
  - `search_objects(conn, q: str, limit: int = 20) -> list[dict]` (raises `ApiError(422, "invalid_query", ...)` if the query is under 2 characters and not a number)
  - `escape_like(s: str) -> str`
  - `list_events(conn) -> list[dict]` (each event + `pieces_total`, `pieces_in_orbit`)
  - `get_meta(conn) -> dict` with keys `data_as_of`, `in_orbit`, `owners`, `types`, `regimes`, `ops_status`, `attribution`

- [ ] **Step 1: Write the failing tests**

`api/tests/test_services_objects.py`:
```python
from datetime import UTC, datetime

import pytest

from app.domain.orbits import ATTRIBUTION
from app.errors import ApiError
from app.seeds import load_seeds
from app.services.events import list_events
from app.services.meta import get_meta
from app.services.objects import escape_like, get_object, search_objects
from tests.factories import insert_object, seed_stats_world


@pytest.fixture
def world(conn):
    load_seeds(conn)
    seed_stats_world(conn)
    return conn


def test_get_object_includes_joins_and_elements(world):
    world.execute(
        "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
        "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
        "VALUES (1, %s, 15.5, 0.001, 53, 10, 20, 30, 0.0001, 0, 0, 'spacetrack')",
        (datetime(2026, 9, 22, tzinfo=UTC),),
    )
    world.execute("UPDATE objects SET ops_status = '+' WHERE norad_id = 1")
    obj = get_object(world, 1)
    assert obj["name"] == "ALPHA SAT"
    assert obj["inclination"] == 53.0  # SATCAT value survives the GP join
    assert obj["owner_name"] == "United States"
    assert obj["ops_status_label"] == "Operational"
    assert obj["elements"]["mean_motion"] == 15.5
    assert obj["event"] is None
    assert get_object(world, 2)["elements"] is None
    assert get_object(world, 999) is None


def test_get_object_includes_event(world):
    world.execute("UPDATE objects SET event_id = 'fengyun-1c-2007' WHERE norad_id = 2")
    assert get_object(world, 2)["event"]["name"] == "Fengyun-1C anti-satellite test"


def test_search_by_name_cospar_and_number(world):
    assert [o["norad_id"] for o in search_objects(world, "alpha")] == [1, 2]
    assert [o["norad_id"] for o in search_objects(world, "1999-025")] == [2]
    assert [o["norad_id"] for o in search_objects(world, "4")] == [4]


def test_search_treats_wildcards_literally(world):
    assert [o["norad_id"] for o in search_objects(world, "50%_")] == [3]
    assert search_objects(world, "%%") == []
    assert search_objects(world, "a\\b") == []
    assert escape_like("50%_\\") == "50\\%\\_\\\\"


def test_search_rejects_one_letter_queries(world):
    with pytest.raises(ApiError) as e:
        search_objects(world, " a ")
    assert e.value.code == "invalid_query"


def test_search_orders_in_orbit_first(world):
    insert_object(world, 10, name="ALPHA OLD", decay_date=datetime(2001, 1, 1).date())
    ids = [o["norad_id"] for o in search_objects(world, "alpha")]
    assert ids.index(10) == len(ids) - 1


def test_list_events_counts_pieces(world):
    world.execute("UPDATE objects SET event_id = 'fengyun-1c-2007' WHERE norad_id = 2")
    events = {e["id"]: e for e in list_events(world)}
    fy = events["fengyun-1c-2007"]
    assert (fy["pieces_total"], fy["pieces_in_orbit"]) == (1, 0)
    assert events["kosmos-1408-2021"]["pieces_total"] == 0
    assert list(events) == sorted(events, key=lambda k: events[k]["event_date"])


def test_meta(world):
    world.execute(
        "INSERT INTO ingest_runs (job, source, status, finished_at, rows) "
        "VALUES ('ingest_satcat', 'celestrak', 'ok', now(), 4)"
    )
    m = get_meta(world)
    assert m["attribution"] == ATTRIBUTION
    assert m["data_as_of"]["satcat"] is not None and m["data_as_of"]["gp"] is None
    assert m["in_orbit"] == {"PAY": {"LEO": 1, "GEO": 1}}
    assert [o["code"] for o in m["owners"]][:1] == ["US"]
    assert all(o["total"] > 0 for o in m["owners"])
    assert m["types"]["DEB"] == "Debris"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_services_objects.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.objects'`.

- [ ] **Step 3: Implement**

`api/app/services/objects.py`:
```python
import psycopg

from app.domain.orbits import OPS_STATUS_LABELS
from app.errors import ApiError

# GP columns selected under their own names. The element set's inclination is aliased
# g_inclination because objects.inclination (from SATCAT) has the same name.
ELEMENT_KEYS = (
    "epoch", "mean_motion", "eccentricity", "raan", "arg_pericenter",
    "mean_anomaly", "bstar", "mean_motion_dot", "mean_motion_ddot", "source",
)
INTERNAL_KEYS = {"g_inclination", "g_norad", "event_name", "event_date", *ELEMENT_KEYS}


def escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def get_object(conn: psycopg.Connection, norad_id: int) -> dict | None:
    row = conn.execute(
        """
        SELECT o.*, ow.name AS owner_name, ow.flag_emoji, ls.name AS launch_site_name,
               e.name AS event_name, e.event_date AS event_date,
               g.epoch, g.mean_motion, g.eccentricity, g.inclination AS g_inclination, g.raan,
               g.arg_pericenter, g.mean_anomaly, g.bstar, g.mean_motion_dot, g.mean_motion_ddot,
               g.source, g.norad_id AS g_norad
        FROM objects o
        JOIN owners ow ON ow.code = o.owner
        LEFT JOIN launch_sites ls ON ls.code = o.launch_site
        LEFT JOIN breakup_events e ON e.id = o.event_id
        LEFT JOIN gp_elements g ON g.norad_id = o.norad_id
        WHERE o.norad_id = %s
        """,
        (norad_id,),
    ).fetchone()
    if row is None:
        return None
    elements = None
    if row["g_norad"] is not None:
        elements = {c: row[c] for c in ELEMENT_KEYS}
        elements["inclination"] = row["g_inclination"]
    obj = {k: v for k, v in row.items() if k not in INTERNAL_KEYS}
    obj["ops_status_label"] = OPS_STATUS_LABELS.get(row["ops_status"] or "")
    obj["event"] = (
        {"id": row["event_id"], "name": row["event_name"], "event_date": row["event_date"]}
        if row["event_id"] else None
    )
    obj["elements"] = elements
    return obj


def search_objects(conn: psycopg.Connection, q: str, limit: int = 20) -> list[dict]:
    q = q.strip()
    base = (
        "SELECT norad_id, name, cospar_id, object_type, owner, regime, "
        "(decay_date IS NOT NULL) AS decayed FROM objects "
    )
    if q.isdigit():
        return conn.execute(base + "WHERE norad_id = %s", (int(q),)).fetchall()
    if len(q) < 2:
        raise ApiError(422, "invalid_query", "search text must be at least 2 characters")
    return conn.execute(
        base
        + "WHERE name ILIKE %(p)s ESCAPE '\\' OR cospar_id ILIKE %(c)s ESCAPE '\\' "
        "ORDER BY (decay_date IS NULL) DESC, norad_id LIMIT %(limit)s",
        {"p": f"%{escape_like(q)}%", "c": f"{escape_like(q.upper())}%", "limit": limit},
    ).fetchall()
```

`api/app/services/events.py`:
```python
import psycopg


def list_events(conn: psycopg.Connection) -> list[dict]:
    return conn.execute(
        """
        SELECT e.*, count(o.norad_id)::int AS pieces_total,
               count(o.norad_id) FILTER (WHERE o.decay_date IS NULL)::int AS pieces_in_orbit
        FROM breakup_events e
        LEFT JOIN objects o ON o.event_id = e.id
        GROUP BY e.id
        ORDER BY e.event_date
        """
    ).fetchall()
```

`api/app/services/meta.py`:
```python
from collections import defaultdict

import psycopg

from app.domain.orbits import ATTRIBUTION, OPS_STATUS_LABELS, REGIME_LABELS, TYPE_LABELS

JOB_KEYS = {"ingest_satcat": "satcat", "ingest_gp": "gp", "rebuild_stats": "stats"}


def get_meta(conn: psycopg.Connection) -> dict:
    runs = {
        r["job"]: r["at"]
        for r in conn.execute(
            "SELECT job, max(finished_at) AS at FROM ingest_runs WHERE status = 'ok' GROUP BY job"
        ).fetchall()
    }
    in_orbit: dict[str, dict[str, int]] = defaultdict(dict)
    for r in conn.execute(
        "SELECT object_type, regime, count(*)::int AS n FROM objects "
        "WHERE decay_date IS NULL GROUP BY 1, 2"
    ).fetchall():
        in_orbit[r["object_type"]][r["regime"]] = r["n"]
    owners = conn.execute(
        """
        SELECT ow.code, ow.name, ow.flag_emoji,
               count(o.norad_id) FILTER (WHERE o.decay_date IS NULL)::int AS in_orbit,
               count(o.norad_id)::int AS total
        FROM owners ow JOIN objects o ON o.owner = ow.code
        GROUP BY ow.code
        ORDER BY in_orbit DESC, total DESC, ow.code
        """
    ).fetchall()
    return {
        "data_as_of": {key: runs.get(job) for job, key in JOB_KEYS.items()},
        "in_orbit": dict(in_orbit),
        "owners": owners,
        "types": TYPE_LABELS,
        "regimes": REGIME_LABELS,
        "ops_status": OPS_STATUS_LABELS,
        "attribution": ATTRIBUTION,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_services_objects.py -v`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/services api/tests/test_services_objects.py
git commit -m "feat(api): object lookup/search, breakup events and meta services"
```

---

### Task 11: FastAPI app, routes, origin auth and error format

**Files:**
- Create: `api/app/api/__init__.py` (empty), `api/app/api/errors.py`, `api/app/api/auth.py`, `api/app/api/routes.py`, `api/app/api/main.py`, `api/tests/test_api.py`

**Interfaces:**
- Consumes: all services (Tasks 9–10); `Database` (Task 1); `SnapshotStore`, `LocalSnapshotStore`, `snapshot_key`, `SNAPSHOT_GROUPS` (Task 7); `last_success` (Task 6).
- Produces: `create_app(settings: Settings | None = None, *, store: SnapshotStore | None = None, database: Database | None = None) -> FastAPI`. Run locally with `uv run uvicorn app.api.main:create_app --factory --reload`. Endpoints exactly as listed in the spec §4 (except `/chat`, which belongs to the AI plan). Query parameter names: `metric, group_by, owners, types, regimes, from, to, top, at, by, field, bin_width, q, group`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_api.py`:
```python
import pytest
from fastapi.testclient import TestClient

from app.api.main import create_app
from app.config import Settings
from app.db import Database
from app.ingest.snapshot import LocalSnapshotStore, snapshot_key
from app.seeds import load_seeds
from app.stats.rebuild import rebuild_yearly_stats
from tests.factories import seed_stats_world


@pytest.fixture
def world(conn):
    load_seeds(conn)
    seed_stats_world(conn)
    rebuild_yearly_stats(conn)
    return conn


@pytest.fixture
def store(tmp_path):
    return LocalSnapshotStore(tmp_path)


def make_client(migrated, store, **settings):
    db = Database(migrated)
    app = create_app(Settings(database_url=migrated, **settings), store=store, database=db)
    return TestClient(app), db


@pytest.fixture
def client(world, migrated, store):
    c, db = make_client(migrated, store)
    with c:
        yield c
    db.close()


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_timeseries(client):
    r = client.get("/api/stats/timeseries?group_by=type&from=2006&to=2011")
    assert r.status_code == 200
    body = r.json()
    assert body["years"][0] == 2006
    assert {s["key"] for s in body["series"]} == {"PAY", "DEB"}
    assert "s-maxage=3600" in r.headers["cache-control"]


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("/api/stats/timeseries?owners=XX", "invalid_filter"),
        ("/api/stats/timeseries?from=2011&to=2006", "invalid_range"),
        ("/api/stats/timeseries?metric=bogus", "invalid_request"),
        ("/api/stats/distribution?field=perigee&bin_width=-5", "invalid_request"),
        ("/api/objects/search?q=a", "invalid_query"),
        ("/api/objects/notanumber", "invalid_request"),
    ],
)
def test_bad_params_return_422_json(client, url, code):
    r = client.get(url)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == code
    assert r.json()["error"]["message"]


def test_breakdown_and_distribution(client):
    b = client.get("/api/stats/breakdown?at=2008&by=owner").json()
    assert b["rows"][0]["key"] == "US"
    d = client.get("/api/stats/distribution?field=perigee&bin_width=100&regimes=LEO").json()
    assert [x["key"] for x in d["bins"]] == ["400"]


def test_objects_and_search(client):
    assert client.get("/api/objects/1").json()["name"] == "ALPHA SAT"
    missing = client.get("/api/objects/999")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"
    assert client.get("/api/objects/search?q=50%25_").json()[0]["norad_id"] == 3


def test_events_and_meta(client):
    events = client.get("/api/events").json()
    assert len(events) == 10
    meta = client.get("/api/meta").json()
    assert meta["attribution"].startswith("Data: USSPACECOM")


def test_snapshot_etag_and_404(client, store):
    store.put(snapshot_key("LEO"), b"\x1f\x8bdata")
    r = client.get("/api/globe/snapshot?group=LEO")
    assert r.status_code == 200 and r.content == b"\x1f\x8bdata"
    assert r.headers["content-type"] == "application/octet-stream"
    etag = r.headers["etag"]
    again = client.get("/api/globe/snapshot?group=LEO", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert client.get("/api/globe/snapshot?group=HIGH").status_code == 404


def test_origin_secret_required_except_health(world, migrated, store):
    c, db = make_client(migrated, store, origin_secret="s3cret")
    with c:
        assert c.get("/api/meta").status_code == 403
        assert c.get("/api/meta").json()["error"]["code"] == "forbidden"
        assert c.get("/api/meta", headers={"X-Origin-Auth": "wrong"}).status_code == 403
        assert c.get("/api/meta", headers={"X-Origin-Auth": "s3cret"}).status_code == 200
        assert c.get("/api/health").status_code == 200
    db.close()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_api.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api'`.

- [ ] **Step 3: Implement error handlers and auth**

`api/app/api/errors.py`:
```python
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.errors import ApiError


def error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(error_body(exc.code, exc.message), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        message = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'][1:]) or 'request'}: {e['msg']}"
            for e in exc.errors()
        )
        return JSONResponse(error_body("invalid_request", message), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else "http_error"
        return JSONResponse(error_body(code, str(exc.detail)), status_code=exc.status_code)
```

`api/app/api/auth.py`:
```python
import hmac

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.errors import error_body

OPEN_PATHS = {"/api/health"}


def install_origin_auth(app: FastAPI, secret: str | None) -> None:
    """Only the Vercel proxy knows the secret; it keeps the Lambda URL from being a public
    back door. Disabled when no secret is configured (local development)."""
    if not secret:
        return
    expected = secret.encode()

    @app.middleware("http")
    async def check_origin(request: Request, call_next):
        if request.url.path in OPEN_PATHS:
            return await call_next(request)
        supplied = request.headers.get("x-origin-auth", "").encode()
        if not hmac.compare_digest(supplied, expected):
            return JSONResponse(
                error_body("forbidden", "missing or invalid origin credentials"), status_code=403
            )
        return await call_next(request)
```

- [ ] **Step 4: Implement routes and the app factory**

`api/app/api/routes.py`:
```python
import hashlib
from datetime import UTC, datetime
from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, Query, Request, Response

from app.errors import ApiError
from app.ingest.runlog import last_success
from app.ingest.snapshot import SNAPSHOT_GROUPS, snapshot_key
from app.services import stats
from app.services.events import list_events
from app.services.filters import parse_filters, parse_year_range
from app.services.meta import get_meta
from app.services.objects import get_object, search_objects

router = APIRouter(prefix="/api")


def get_conn(request: Request):
    yield from request.app.state.db.conn()


def cache(response: Response, seconds: int) -> None:
    response.headers["Cache-Control"] = f"public, max-age=60, s-maxage={seconds}"


def this_year() -> int:
    return datetime.now(UTC).year


@router.get("/health")
def health(conn: psycopg.Connection = Depends(get_conn)) -> dict:
    conn.execute("SELECT 1")
    last_gp = last_success(conn, "ingest_gp")
    age = (datetime.now(UTC) - last_gp).total_seconds() / 3600 if last_gp else None
    return {"status": "ok", "gp_age_hours": age}


@router.get("/meta")
def meta(response: Response, conn: psycopg.Connection = Depends(get_conn)) -> dict:
    cache(response, 600)
    return get_meta(conn)


@router.get("/stats/timeseries")
def timeseries(
    response: Response,
    metric: Literal["in_orbit", "added", "reentered"] = "in_orbit",
    group_by: Literal["none", "type", "owner", "regime"] = "type",
    owners: str | None = None,
    types: str | None = None,
    regimes: str | None = None,
    from_year: int | None = Query(None, alias="from"),
    to_year: int | None = Query(None, alias="to"),
    top: int = Query(8, ge=1, le=30),
    conn: psycopg.Connection = Depends(get_conn),
) -> dict:
    filters = parse_filters(conn, owners, types, regimes)
    y0, y1 = parse_year_range(from_year, to_year, this_year())
    cache(response, 3600)
    return stats.timeseries(conn, metric=metric, group_by=group_by, filters=filters,
                            from_year=y0, to_year=y1, top=top)


@router.get("/stats/breakdown")
def breakdown(
    response: Response,
    by: Literal["owner", "type", "regime"] = "owner",
    at: int | None = None,
    owners: str | None = None,
    types: str | None = None,
    regimes: str | None = None,
    top: int = Query(8, ge=1, le=30),
    conn: psycopg.Connection = Depends(get_conn),
) -> dict:
    filters = parse_filters(conn, owners, types, regimes)
    year, _ = parse_year_range(at, at, this_year()) if at is not None else (this_year(), None)
    cache(response, 3600)
    return stats.breakdown(conn, at_year=year, by=by, filters=filters, top=top)


@router.get("/stats/distribution")
def distribution(
    response: Response,
    field: Literal["perigee", "apogee", "inclination", "rcs_size"] = "perigee",
    bin_width: float | None = Query(None, gt=0, le=10000),
    owners: str | None = None,
    types: str | None = None,
    regimes: str | None = None,
    conn: psycopg.Connection = Depends(get_conn),
) -> dict:
    filters = parse_filters(conn, owners, types, regimes)
    cache(response, 3600)
    return stats.distribution(conn, field=field, filters=filters, bin_width=bin_width)


@router.get("/events")
def events(response: Response, conn: psycopg.Connection = Depends(get_conn)) -> list[dict]:
    cache(response, 3600)
    return list_events(conn)


@router.get("/objects/search")
def objects_search(
    response: Response,
    q: str = Query(..., max_length=100),
    limit: int = Query(20, ge=1, le=50),
    conn: psycopg.Connection = Depends(get_conn),
) -> list[dict]:
    cache(response, 600)
    return search_objects(conn, q, limit)


@router.get("/objects/{norad_id}")
def object_detail(
    norad_id: int, response: Response, conn: psycopg.Connection = Depends(get_conn)
) -> dict:
    obj = get_object(conn, norad_id)
    if obj is None:
        raise ApiError(404, "not_found", f"no object with NORAD catalog number {norad_id}")
    cache(response, 600)
    return obj


@router.get("/globe/snapshot")
def globe_snapshot(request: Request, group: Literal["LEO", "HIGH"] = "LEO") -> Response:
    assert group in SNAPSHOT_GROUPS
    data = request.app.state.store.get(snapshot_key(group))
    if data is None:
        raise ApiError(404, "not_found", f"no globe snapshot for group {group} yet")
    etag = '"' + hashlib.sha1(data).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=300, s-maxage=21600"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="application/octet-stream", headers=headers)
```

`api/app/api/main.py`:
```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.auth import install_origin_auth
from app.api.errors import install_error_handlers
from app.api.routes import router
from app.config import Settings
from app.db import Database
from app.ingest.snapshot import LocalSnapshotStore, SnapshotStore


def create_app(
    settings: Settings | None = None,
    *,
    store: SnapshotStore | None = None,
    database: Database | None = None,
) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = database or Database(settings.database_url)
        app.state.db = db
        app.state.store = store or LocalSnapshotStore(settings.snapshot_dir)
        app.state.settings = settings
        yield
        if database is None:
            db.close()

    app = FastAPI(title="LEO Debris API", version="0.1.0", lifespan=lifespan)
    install_error_handlers(app)
    install_origin_auth(app, settings.origin_secret)
    app.include_router(router)
    return app
```

- [ ] **Step 5: Run the whole suite**

Run: `cd api && uv run pytest -v`
Expected: all tests pass (Tasks 1–11).

- [ ] **Step 6: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/api api/tests/test_api.py
git commit -m "feat(api): FastAPI routes with JSON errors, origin auth, caching and snapshots"
```

---

### Task 12: Job runner CLI, local dev docs and a live smoke run

**Files:**
- Create: `api/app/jobs.py`, `api/tests/test_jobs.py`, `api/README.md`, `api/.env.example`

**Interfaces:**
- Consumes: `run_ingest_satcat`, `run_ingest_gp`, `run_rebuild_stats`, clients, `LocalSnapshotStore`, `connect`.
- Produces: `JOBS = ("ingest-satcat", "ingest-gp", "rebuild-stats", "all")`; `run_job(name: str, settings: Settings, *, store: SnapshotStore | None = None, http: httpx.Client | None = None) -> dict[str, int]`; CLI `uv run python -m app.jobs <job>`. The deploy plan's Lambda handlers call `run_job`.

- [ ] **Step 1: Write the failing test**

`api/tests/test_jobs.py`:
```python
import httpx
import pytest
import respx

from app.config import Settings
from app.ingest.snapshot import LocalSnapshotStore, snapshot_key
from app.ingest.sources import (
    CELESTRAK_GP_ACTIVE_URL,
    CELESTRAK_SATCAT_URL,
    SPACETRACK_GP_URL,
    SPACETRACK_LOGIN_URL,
)
from app.jobs import run_job
from tests.conftest import FIXTURES


@respx.mock
def test_run_all_end_to_end(conn, migrated, tmp_path):
    respx.get(CELESTRAK_SATCAT_URL).mock(
        return_value=httpx.Response(200, text=(FIXTURES / "satcat_sample.csv").read_text())
    )
    respx.post(SPACETRACK_LOGIN_URL).mock(return_value=httpx.Response(200, text='""'))
    respx.get(SPACETRACK_GP_URL).mock(
        return_value=httpx.Response(200, text=(FIXTURES / "gp_spacetrack_sample.json").read_text())
    )
    respx.get(CELESTRAK_GP_ACTIVE_URL).mock(return_value=httpx.Response(500))
    settings = Settings(
        database_url=migrated, spacetrack_user="u", spacetrack_pass="p",
        min_satcat_rows=10, min_gp_rows_spacetrack=3,
    )
    store = LocalSnapshotStore(tmp_path)
    with httpx.Client() as http:
        result = run_job("all", settings, store=store, http=http)
    assert result == {"ingest_satcat": 20, "rebuild_stats": result["rebuild_stats"],
                      "ingest_gp": 3}
    assert result["rebuild_stats"] > 0
    assert store.get(snapshot_key("LEO")) is not None


def test_unknown_job_is_rejected(migrated):
    with pytest.raises(ValueError, match="unknown job"):
        run_job("bogus", Settings(database_url=migrated))
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_jobs.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.jobs'`.

- [ ] **Step 3: Implement**

`api/app/jobs.py`:
```python
import argparse
import json
import logging
from contextlib import ExitStack

import httpx

from app.config import Settings
from app.db import connect
from app.ingest.gp import run_ingest_gp
from app.ingest.satcat import run_ingest_satcat
from app.ingest.snapshot import LocalSnapshotStore, SnapshotStore
from app.ingest.sources import USER_AGENT, CelesTrakClient, SpaceTrackClient
from app.stats.rebuild import run_rebuild_stats

JOBS = ("ingest-satcat", "ingest-gp", "rebuild-stats", "all")


def run_job(
    name: str,
    settings: Settings,
    *,
    store: SnapshotStore | None = None,
    http: httpx.Client | None = None,
) -> dict[str, int]:
    if name not in JOBS:
        raise ValueError(f"unknown job {name!r}; expected one of {', '.join(JOBS)}")
    store = store or LocalSnapshotStore(settings.snapshot_dir)
    with ExitStack() as stack:
        if http is None:
            http = stack.enter_context(
                httpx.Client(timeout=180, headers={"User-Agent": USER_AGENT},
                             follow_redirects=True)
            )
        conn = stack.enter_context(connect(settings.database_url))
        celestrak = CelesTrakClient(http)
        spacetrack = (
            SpaceTrackClient(http, settings.spacetrack_user, settings.spacetrack_pass)
            if settings.spacetrack_user and settings.spacetrack_pass
            else None
        )
        result: dict[str, int] = {}
        if name in ("ingest-satcat", "all"):
            result["ingest_satcat"] = run_ingest_satcat(conn, celestrak=celestrak,
                                                        settings=settings)
        if name in ("ingest-satcat", "rebuild-stats", "all"):
            result["rebuild_stats"] = run_rebuild_stats(conn)
        if name in ("ingest-gp", "all"):
            result["ingest_gp"] = run_ingest_gp(conn, spacetrack=spacetrack, celestrak=celestrak,
                                                store=store, settings=settings)
        return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run a LEO Debris data job.")
    parser.add_argument("job", choices=JOBS)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(json.dumps(run_job(args.job, Settings())))


if __name__ == "__main__":
    main()
```

`api/.env.example`:
```bash
DATABASE_URL=postgresql://leo:leo@localhost:5432/leo
# Free account at https://www.space-track.org/auth/createAccount. Without these, GP falls
# back to CelesTrak's active satellites only.
SPACETRACK_USER=
SPACETRACK_PASS=
# Leave empty locally; set in production (shared with the Vercel proxy).
ORIGIN_SECRET=
SNAPSHOT_DIR=./.snapshots
```

`api/README.md`:
````markdown
# LEO Debris API

FastAPI + Postgres backend for leo.kudayyurter.dev. Design: `../docs/superpowers/specs/2026-09-22-leo-debris-design.md`.

## Local setup

```bash
cd api
cp .env.example .env            # add Space-Track credentials if you have them
docker compose up -d db         # Postgres 16 with pgvector on localhost:5432
uv sync
uv run alembic upgrade head
uv run python -m app.jobs all   # ~1–2 min: SATCAT, stats, GP + globe snapshots
uv run uvicorn app.api.main:create_app --factory --reload
```

Then open http://localhost:8000/docs.

## Jobs

| Command | What it does | Production schedule |
|---|---|---|
| `python -m app.jobs ingest-satcat` | CelesTrak SATCAT → `objects`, then rebuilds `yearly_stats` | daily |
| `python -m app.jobs ingest-gp` | Space-Track GP (CelesTrak fallback) → `gp_elements` + globe snapshots | every 6 h, random minute |
| `python -m app.jobs rebuild-stats` | Recomputes `yearly_stats` from `objects` | after SATCAT |
| `python -m app.jobs all` | All of the above | — |

Every run is recorded in `ingest_runs`. A failed run never replaces good data.

## Tests

`uv run pytest` (needs Docker for testcontainers, or set `TEST_DATABASE_URL` to an empty database).

Data: USSPACECOM via Space-Track.org; CelesTrak.
````

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest -v`
Expected: all tests pass.

- [ ] **Step 5: Live smoke run against the real sources (manual, not a test)**

```bash
cd api && docker compose up -d db && uv run alembic upgrade head
uv run python -m app.jobs all
uv run python - <<'PY'
from app.db import connect
from app.config import Settings
c = connect(Settings().database_url)
q = lambda s: c.execute(s).fetchall()
print(q("SELECT year, object_type, sum(in_orbit) n FROM yearly_stats WHERE regime='LEO' AND year IN (2006,2007,2009,2024) AND object_type IN ('PAY','DEB') GROUP BY 1,2 ORDER BY 1,2"))
print(q("SELECT id, count(o.*) FROM breakup_events e LEFT JOIN objects o ON o.event_id=e.id GROUP BY id ORDER BY 2 DESC"))
PY
```
Expected, within about ±5% of the spec §3.5 reference (computed before event linking was added): LEO debris ≈ 4.1k (2006), ≈ 6.5k (2007), ≈ 8.7k (2009), and **payloads > debris in 2024**. Fengyun-1C should link about 3.5k pieces, Kosmos 1408 about 1.8k and Cosmos 2251 about 1.7k. If numbers are far off, stop and investigate before continuing (see Review Focus 2). Without Space-Track credentials, `ingest_gp` reports `source=celestrak` with about 16k rows; that is expected.

- [ ] **Step 6: Commit**

```bash
cd api && uv run ruff check . && cd ..
git add api/app/jobs.py api/tests/test_jobs.py api/README.md api/.env.example
git commit -m "feat(api): job runner CLI and local development docs"
```

---

### Task 13: CI for the API

**Files:**
- Create: `.github/workflows/api.yml`

**Interfaces:**
- Consumes: `uv`, `ruff`, `pytest` config from Task 1. GitHub-hosted Ubuntu runners have Docker, so testcontainers works.

- [ ] **Step 1: Write the workflow**

`.github/workflows/api.yml`:
```yaml
name: api
on:
  push:
    branches: [main]
    paths: ["api/**", ".github/workflows/api.yml"]
  pull_request:
    paths: ["api/**", ".github/workflows/api.yml"]
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: api
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"
      - run: uv sync --locked
      - run: uv run ruff check .
      - run: uv run pytest -q
```

- [ ] **Step 2: Validate locally**

Run: `cd api && uv sync --locked && uv run ruff check . && uv run pytest -q`
Expected: lint clean, all tests pass (this is exactly what CI runs).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/api.yml
git commit -m "ci: lint and test the API on push and pull requests"
```

---

## Spec coverage (self-review)

| Spec section | Covered by |
|---|---|
| §3.1 sources and licensing, attribution | Tasks 5, 6, 7; `ATTRIBUTION` in Task 4, served by `/api/meta` |
| §3.2 tiers (v1 = SATCAT + GP) | Tasks 6, 7 |
| §3.3 scope and regimes, no number exclusion | Task 4 (`classify_regime`), Task 6 fixture includes 100000 |
| §3.4 schema | Task 2 (`documents`, `chunks`, `rate_limits` belong to the AI plan) |
| §3.5 first-seen year, event linking, in-orbit rule | Tasks 4, 6, 8; live check in Task 12 |
| §3.6 ingest jobs, all-or-nothing, 24 h fallback | Tasks 6, 7, 8, 12 |
| §3.7 globe snapshot | Task 7 (format), Task 11 (endpoint) |
| §4 API endpoints, errors, caching, origin secret | Tasks 9–11 (`/chat` belongs to the AI plan) |
| §7 error handling | Tasks 5–7 (ingest), 11 (API) |
| §8 testing (api part) | every task; CI in Task 13 |
| §9 deployment | **Deploy plan** (Lambda handlers call `run_job`/`create_app`; S3 implements `SnapshotStore`) |
