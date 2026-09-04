"""
One-off migration: widen rooms.bbox_source so it can hold the real provenance value.

varchar(10) -> varchar(20). Non-destructive: widening a varchar never truncates or
rewrites existing rows, and every current value ("ai", at most 2 characters) still fits.

Why it is needed
----------------
bbox_source records who positioned the room: "ai" | "user_marked" | "user_added".
"user_marked" is 11 characters, so writing it into a varchar(10) made Postgres reject
the ENTIRE room INSERT with StringDataRightTruncation — every "Confirm & save" of a
plan containing an adjusted room failed. Until this migration runs, the application
deliberately writes only the short value and keeps the precise one in shape_data.

Idempotent: re-running is a no-op once the column is already varchar(20) or wider.

Run from the backend/ directory:  ../venv/bin/python migrate_bbox_source.py
"""
from sqlalchemy import text

from app.db.database import engine

TABLE = "rooms"
COLUMN = "bbox_source"
TARGET_LEN = 20


def current_length(conn):
    row = conn.execute(text(
        "SELECT character_maximum_length FROM information_schema.columns "
        "WHERE table_name = :t AND column_name = :c"
    ), {"t": TABLE, "c": COLUMN}).fetchone()
    return row[0] if row else None


def run():
    with engine.begin() as conn:
        before = current_length(conn)
        if before is None:
            print(f"[fail] {TABLE}.{COLUMN} not found — nothing changed")
            return
        if before >= TARGET_LEN:
            print(f"[skip] {TABLE}.{COLUMN} already varchar({before})")
            return
        # Widening only. Postgres does this without rewriting the table and cannot
        # lose data, so it is safe on a shared database.
        conn.execute(text(
            f"ALTER TABLE {TABLE} ALTER COLUMN {COLUMN} TYPE varchar({TARGET_LEN})"
        ))
        print(f"[ok]   {TABLE}.{COLUMN}: varchar({before}) -> varchar({current_length(conn)})")
    print("migration complete")


if __name__ == "__main__":
    run()
