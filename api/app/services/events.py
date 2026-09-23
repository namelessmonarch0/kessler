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
