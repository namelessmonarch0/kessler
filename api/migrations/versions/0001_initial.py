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
