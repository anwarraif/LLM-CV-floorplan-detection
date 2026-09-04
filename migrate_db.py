import os
import sys
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Setup system path to import app modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.db.database import Base, DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME
from app.db.models import User, Apartment, FloorPlan, Room

# Connection URLs
old_url = f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
new_url = "postgresql+psycopg2://postgres:Adminas2026!@192.168.1.223:5432/floor-plan-Tool"

def copy_table_data(old_session, new_session, model_class):
    records = old_session.query(model_class).all()
    print(f"Migrating {len(records)} records for table '{model_class.__tablename__}' ({model_class.__name__})...")
    for rec in records:
        # Extract column attributes only to avoid loading relationships
        data = {c.key: getattr(rec, c.key) for c in rec.__table__.columns}
        new_rec = model_class(**data)
        new_session.add(new_rec)
    new_session.commit()
    print(f"Successfully migrated '{model_class.__tablename__}'.")

def main():
    print("Connecting to databases...")
    old_engine = create_engine(old_url)
    new_engine = create_engine(new_url)

    # Create tables in the new database
    print("Creating tables in the new database (if not exists)...")
    Base.metadata.create_all(bind=new_engine)
    print("Tables created successfully.")

    # Create sessions
    OldSession = sessionmaker(bind=old_engine)
    NewSession = sessionmaker(bind=new_engine)

    old_session = OldSession()
    new_session = NewSession()

    try:
        # Clear new database tables first to prevent duplicate key errors if run multiple times
        print("Clearing existing data in the new database tables (in correct order)...")
        new_session.query(Room).delete()
        new_session.query(FloorPlan).delete()
        new_session.query(Apartment).delete()
        new_session.query(User).delete()
        new_session.commit()
        print("New database tables cleared.")

        # Migrate data in correct order of foreign key dependencies
        copy_table_data(old_session, new_session, User)
        copy_table_data(old_session, new_session, Apartment)
        copy_table_data(old_session, new_session, FloorPlan)
        copy_table_data(old_session, new_session, Room)

        print("\nMigration completed successfully!")
    except Exception as e:
        new_session.rollback()
        print(f"\nMigration failed: {e}")
        raise e
    finally:
        old_session.close()
        new_session.close()

if __name__ == "__main__":
    main()
