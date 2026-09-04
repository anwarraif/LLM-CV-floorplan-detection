"""
Seed script: creates the first admin user.
Run with: python -m app.db.seed  (from backend/ directory)
"""
import uuid
from datetime import datetime
from sqlalchemy import select
from app.db.database import SessionLocal
from app.db.models import User
from app.middleware.auth import hash_password

ADMIN_EMAIL = "admin@apartmentspecialists.co.nz"
ADMIN_PASSWORD = "Admin2026!"
ADMIN_NAME = "System Admin"
ADMIN_ROLE = "admin"


def seed():
    print("[Seed] Connecting to database...")
    db = SessionLocal()
    try:
        existing = db.execute(select(User).where(User.email == ADMIN_EMAIL)).scalar_one_or_none()

        if existing:
            print(f"[Seed] Admin user already exists: {ADMIN_EMAIL}")
            return

        admin = User(
            id=uuid.uuid4(),
            email=ADMIN_EMAIL,
            password_hash=hash_password(ADMIN_PASSWORD),
            full_name=ADMIN_NAME,
            role=ADMIN_ROLE,
            is_active=True,
            created_at=datetime.utcnow(),
        )
        db.add(admin)
        db.commit()
        print(f"[Seed] Admin user created: {ADMIN_EMAIL}")
        print(f"[Seed] Password: {ADMIN_PASSWORD}")
    finally:
        db.close()


if __name__ == "__main__":
    seed()
