"""
One-off migration: widen measurement columns to millimetre precision.

numeric(10,2) -> numeric(11,3). This is non-destructive: total digit capacity for
the integer part stays at 8, only the decimal scale increases from 2 to 3. Existing
rows are re-cast losslessly.

Run from the backend/ directory:  ../venv/bin/python migrate_precision.py
"""
from sqlalchemy import text

from app.db.database import engine

TARGETS = [
    ("rooms", "length_m"),
    ("rooms", "width_m"),
    ("rooms", "area_m2"),
    ("floor_plans", "total_internal_m2"),
    ("floor_plans", "total_balcony_m2"),
]


def current_scale(conn, table, column):
    row = conn.execute(text(
        "SELECT numeric_precision, numeric_scale FROM information_schema.columns "
        "WHERE table_name = :t AND column_name = :c"
    ), {"t": table, "c": column}).fetchone()
    return (row[0], row[1]) if row else None


def run():
    with engine.begin() as conn:
        for table, column in TARGETS:
            before = current_scale(conn, table, column)
            if before == (11, 3):
                print(f"[skip] {table}.{column} already numeric(11,3)")
                continue
            conn.execute(text(
                f'ALTER TABLE {table} ALTER COLUMN {column} TYPE numeric(11,3)'
            ))
            after = current_scale(conn, table, column)
            print(f"[ok]   {table}.{column}: {before} -> {after}")
    print("migration complete")


if __name__ == "__main__":
    run()
