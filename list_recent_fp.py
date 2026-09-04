import sys
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

sys.path.append("c:/YUSUF/My-Job/yup/as-ai-predraw-floorplans/backend")
from app.db.database import DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME
from app.db.models import FloorPlan, Apartment

def main():
    engine = create_engine(
        f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    )
    Session = sessionmaker(bind=engine)
    session = Session()
    
    stmt = select(FloorPlan).order_by(FloorPlan.uploaded_at.desc()).limit(10)
    fps = session.execute(stmt).scalars().all()
    
    print(f"Found {len(fps)} recent floor plans:")
    for fp in fps:
        apt = session.get(Apartment, fp.apartment_id)
        apt_name = apt.name if apt else "Unknown"
        print(f"ID: {fp.id} | Apt: {apt_name} | Uploaded: {fp.uploaded_at} | File: {fp.original_filename} | URL: {fp.image_url}")

if __name__ == "__main__":
    main()
