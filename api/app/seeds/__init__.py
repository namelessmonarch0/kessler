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
