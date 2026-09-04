import uuid
from datetime import datetime
from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer,
    Numeric, String, Text, JSON
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from app.db.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    role = Column(String, default="agent", nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_login = Column(DateTime, nullable=True)
    reset_token = Column(String, nullable=True)
    reset_token_expires = Column(DateTime, nullable=True)


class Apartment(Base):
    __tablename__ = "apartments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    address = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    deleted_at = Column(DateTime, nullable=True)

    floor_plans = relationship("FloorPlan", back_populates="apartment", cascade="all, delete-orphan")


class FloorPlan(Base):
    __tablename__ = "floor_plans"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    apartment_id = Column(UUID(as_uuid=True), ForeignKey("apartments.id", ondelete="CASCADE"), nullable=False)
    image_url = Column(String, nullable=True)
    original_filename = Column(String, nullable=True)
    file_type = Column(String, nullable=True)
    total_internal_m2 = Column(Numeric(11, 3), nullable=True)
    total_balcony_m2 = Column(Numeric(11, 3), nullable=True)
    version = Column(Integer, default=1, nullable=False)
    is_latest = Column(Boolean, default=True, nullable=False)
    uploaded_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    uploaded_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    confirmed_at = Column(DateTime, nullable=True)
    ai_confidence_score = Column(Numeric(5, 4), nullable=True)
    was_edited = Column(Boolean, default=False, nullable=False)
    flags_triggered = Column(JSONB, nullable=True)
    device_type = Column(String, nullable=True)
    floor_plan_boundary = Column(JSONB, nullable=True)
    updated_at = Column(DateTime, nullable=True)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    thumbnail_url = Column(String, nullable=True)
    original_image_url = Column(String, nullable=True)

    apartment = relationship("Apartment", back_populates="floor_plans")
    rooms = relationship("Room", back_populates="floor_plan", cascade="all, delete-orphan")


class Room(Base):
    __tablename__ = "rooms"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    floor_plan_id = Column(UUID(as_uuid=True), ForeignKey("floor_plans.id", ondelete="CASCADE"), nullable=False)
    room_name = Column(String, nullable=True)
    position = Column(String, nullable=True)
    length_m = Column(Numeric(11, 3), nullable=True)
    width_m = Column(Numeric(11, 3), nullable=True)
    area_m2 = Column(Numeric(11, 3), nullable=True)
    is_balcony = Column(Boolean, default=False, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    bbox_x = Column(Numeric(8, 6), nullable=True)
    bbox_y = Column(Numeric(8, 6), nullable=True)
    bbox_w = Column(Numeric(8, 6), nullable=True)
    bbox_h = Column(Numeric(8, 6), nullable=True)
    shape_mode = Column(String(20), default="rectangle", nullable=True)
    shape_data = Column(JSONB, nullable=True)
    # "ai" | "user_marked" | "user_added". Widened from String(10) — "user_marked" is 11
    # characters and overflowed, which made Postgres reject the whole room INSERT.
    # See backend/migrate_bbox_source.py; the DB must be migrated before this is written.
    bbox_source = Column(String(20), default="ai", nullable=True)
    ai_confidence = Column(Numeric(5, 2), nullable=True)

    floor_plan = relationship("FloorPlan", back_populates="rooms")
