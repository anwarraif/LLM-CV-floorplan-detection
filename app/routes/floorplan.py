import logging
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session, selectinload

logger = logging.getLogger(__name__)

from app.db.database import get_db
from app.db.models import Apartment, FloorPlan, Room, User
from app.middleware.auth import get_current_user
from app.routes.upload import _upload_store
from app.services import calculation_service, geometry_service, telegram

router = APIRouter(prefix="/api/floorplan", tags=["floorplan"])
apartment_router = APIRouter(prefix="/api/apartments", tags=["apartments"])


# ---------- Pydantic schemas ----------

class BBoxInput(BaseModel):
    x: float
    y: float
    w: float
    h: float


class ShapeInput(BaseModel):
    mode: str = "rectangle"
    rotated_rect: Optional[dict] = None
    polygon_points: Optional[List[dict]] = None
    sections: Optional[List[dict]] = None
    measurement: Optional[dict] = None  # {recipe, values, area_m2} from the guided checklist
    # Who positioned this room: "ai" | "user_marked" | "user_added". Kept here rather than in the
    # bbox_source column, which is varchar(10) and cannot hold "user_marked" (11 chars).
    # shape_data is JSONB, so this is additive and needs no migration.
    source: Optional[str] = None


class RoomInput(BaseModel):
    room_name: str
    position: Optional[str] = None
    length_m: float
    width_m: float
    area_m2: Optional[float] = None
    is_balcony: bool = False
    sort_order: int = 0
    bbox: Optional[BBoxInput] = None
    shape: Optional[ShapeInput] = None
    shape_type: str = "rectangle"
    polygon_points: Optional[List[dict]] = None
    bbox_source: str = "ai"
    ai_confidence: Optional[float] = None


class SaveFloorPlanRequest(BaseModel):
    upload_id: Optional[str] = None
    apartment_id: Optional[str] = None
    apartment_name: str
    address: Optional[str] = None
    image_url: Optional[str] = None
    original_image_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    floor_plan_boundary: Optional[BBoxInput] = None
    rooms: List[RoomInput]
    was_edited: bool = False
    device_type: Optional[str] = None
    confirmed_flags: List[str] = []


class RoomResponse(BaseModel):
    id: str
    room_name: str
    position: Optional[str]
    length_m: float
    width_m: float
    area_m2: float
    is_balcony: bool
    sort_order: int
    bbox: Optional[dict] = None
    shape: Optional[dict] = None
    source: Optional[str] = None


class SaveFloorPlanResponse(BaseModel):
    floor_plan_id: str
    apartment_id: str
    apartment_name: str
    version: int
    similarity_match: Optional[dict] = None
    name_mismatch: Optional[dict] = None
    rooms: List[RoomResponse]
    total_internal_m2: float
    total_balcony_m2: float
    total_m2: float
    flags: list
    saved_at: datetime


class ApartmentSearchResult(BaseModel):
    apartment_id: str
    name: str
    address: Optional[str]
    latest_floor_plan_id: Optional[str]
    latest_version: Optional[int]
    total_internal_m2: Optional[float]
    room_count: Optional[int]
    uploaded_at: Optional[datetime]


class FloorPlanDetail(BaseModel):
    floor_plan_id: str
    apartment_id: str
    apartment_name: str
    address: Optional[str] = None
    version: int
    is_latest: bool
    image_url: Optional[str]
    original_image_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    total_internal_m2: Optional[float]
    total_balcony_m2: Optional[float]
    ai_confidence_score: Optional[float]
    was_edited: bool
    device_type: Optional[str]
    flags_triggered: Optional[list]
    uploaded_at: datetime
    confirmed_at: Optional[datetime]
    uploaded_by_email: Optional[str] = None
    rooms: List[RoomResponse]


class ApartmentListItem(BaseModel):
    apartment_id: str
    name: str
    address: Optional[str]
    latest_floor_plan_id: Optional[str]
    latest_version: Optional[int]
    total_internal_m2: Optional[float]
    total_balcony_m2: Optional[float]
    room_count: Optional[int]
    uploaded_at: Optional[datetime]
    image_url: Optional[str]
    thumbnail_url: Optional[str]


class VersionListItem(BaseModel):
    floor_plan_id: str
    version: int
    is_latest: bool
    total_internal_m2: Optional[float]
    total_balcony_m2: Optional[float]
    room_count: int
    uploaded_at: datetime
    confirmed_at: Optional[datetime]
    uploaded_by_email: Optional[str]
    image_url: Optional[str]
    original_image_url: Optional[str]
    thumbnail_url: Optional[str]
    flags_triggered: Optional[list]


class FloorPlanHistoryItem(BaseModel):
    floor_plan_id: str
    version: int
    is_latest: bool
    total_internal_m2: Optional[float]
    total_balcony_m2: Optional[float]
    was_edited: bool
    room_count: int
    uploaded_at: datetime
    confirmed_at: Optional[datetime]


def calculate_polygon_centroid(points: list) -> dict:
    """Calculate the mathematical center of mass (centroid) of a 2D polygon."""
    if not points or len(points) < 3:
        return {"x": 0.5, "y": 0.5}
    
    area = 0.0
    cx = 0.0
    cy = 0.0
    n = len(points)
    
    for i in range(n):
        p1 = points[i]
        p2 = points[(i + 1) % n]
        x1 = p1.x if hasattr(p1, "x") else p1.get("x", 0.0)
        y1 = p1.y if hasattr(p1, "y") else p1.get("y", 0.0)
        x2 = p2.x if hasattr(p2, "x") else p2.get("x", 0.0)
        y2 = p2.y if hasattr(p2, "y") else p2.get("y", 0.0)
        
        factor = x1 * y2 - x2 * y1
        area += factor
        cx += (x1 + x2) * factor
        cy += (y1 + y2) * factor
        
    area = area / 2.0
    if abs(area) < 1e-7:
        xs = [p.x if hasattr(p, "x") else p.get("x", 0.0) for p in points]
        ys = [p.y if hasattr(p, "y") else p.get("y", 0.0) for p in points]
        return {
            "x": round(sum(xs) / n, 4),
            "y": round(sum(ys) / n, 4)
        }
        
    cx = cx / (6.0 * area)
    cy = cy / (6.0 * area)
    return {"x": round(cx, 4), "y": round(cy, 4)}


# ---------- Routes ----------

class MeasurementPlanRequest(BaseModel):
    polygon_points: List[dict]
    aspect_ratio: float = 1.0


@router.post("/measurement-plan")
async def measurement_plan(
    body: MeasurementPlanRequest,
    current_user: User = Depends(get_current_user),
):
    """Given a room polygon (fractions) and the image aspect ratio, return the
    classification, the feasible measurement checklist, and the area recipe. The
    frontend evaluates the recipe locally for the live preview; the backend recomputes
    it authoritatively on save. Additive endpoint, does not affect existing routes."""
    return geometry_service.build_plan(body.polygon_points, body.aspect_ratio)


@router.post("/save", response_model=SaveFloorPlanResponse)
async def save_floor_plan(
    body: SaveFloorPlanRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rooms_data = []
    for r in body.rooms:
        # Authoritative area: if the room carries a measurement plan + measured values,
        # recompute the area from those (single source of truth, same engine as the
        # frontend preview). Fall back to the sent area_m2, then to length x width.
        measurement = r.shape.measurement if r.shape else None
        recomputed = None
        if measurement and isinstance(measurement, dict) and measurement.get("recipe"):
            recomputed = geometry_service.compute_area(measurement["recipe"], measurement.get("values") or {})
        if recomputed is not None and recomputed > 0:
            area = round(recomputed, 3)
        elif r.area_m2 is not None and r.area_m2 > 0:
            area = r.area_m2
        else:
            area = calculation_service.calculate_room_area(r.length_m, r.width_m)
            
        shape_mode = r.shape.mode if r.shape else r.shape_type
        shape_data = None
        if r.shape:
            shape_data = r.shape.dict()
        elif r.polygon_points:
            shape_data = {"polygon_points": r.polygon_points, "shape_type": r.shape_type}

        # Calculate centroid if shape_data contains polygon_points
        if shape_data and "polygon_points" in shape_data and shape_data["polygon_points"]:
            pts = shape_data["polygon_points"]
            shape_data["centroid"] = calculate_polygon_centroid(pts)
        elif shape_data and shape_data.get("rotated_rect"):
            rr = shape_data["rotated_rect"]
            if "cx" in rr and "cy" in rr:
                shape_data["centroid"] = {"x": rr["cx"], "y": rr["cy"]}
        elif r.bbox:
            shape_data = shape_data or {"shape_type": "rectangle"}
            shape_data["centroid"] = {
                "x": round(r.bbox.x + r.bbox.w / 2.0, 4),
                "y": round(r.bbox.y + r.bbox.h / 2.0, 4)
            }

        rooms_data.append({
            "room_name": r.room_name,
            "position": r.position,
            "length_m": r.length_m,
            "width_m": r.width_m,
            "area_m2": area,
            "is_balcony": r.is_balcony,
            "sort_order": r.sort_order,
            "bbox_x": r.bbox.x if r.bbox else None,
            "bbox_y": r.bbox.y if r.bbox else None,
            "bbox_w": r.bbox.w if r.bbox else None,
            "bbox_h": r.bbox.h if r.bbox else None,
            "shape_mode": shape_mode,
            "shape_data": shape_data,
            "bbox_source": r.bbox_source,
            "ai_confidence": r.ai_confidence,
        })

    flags = calculation_service.validate_measurements(rooms_data)
    hard_flags = [f for f in flags if f["type"] == "hard"]
    unconfirmed_hard = [f for f in hard_flags if f["code"] not in body.confirmed_flags]
    if unconfirmed_hard:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Hard validation flags must be resolved or confirmed.", "flags": unconfirmed_hard},
        )

    totals = calculation_service.calculate_totals(rooms_data)

    apartment = None
    similarity_match = None
    name_mismatch = None

    # Priority 1: apartment_id explicitly provided
    logger.info(f"[Save] apartment_id={body.apartment_id} apartment_name={body.apartment_name!r}")
    if body.apartment_id:
        logger.info("[Save] Checking name mismatch...")
        try:
            apartment = db.execute(
                select(Apartment).where(
                    Apartment.id == uuid.UUID(body.apartment_id),
                    Apartment.is_active == True,
                )
            ).scalar_one_or_none()
        except (ValueError, AttributeError):
            pass
        if not apartment:
            raise HTTPException(status_code=404, detail="Apartment not found")

        # Verify access to this apartment
        if current_user.role != "admin":
            owned_fp = db.execute(
                select(FloorPlan).where(
                    FloorPlan.apartment_id == apartment.id,
                    FloorPlan.uploaded_by == current_user.id
                ).limit(1)
            ).scalar_one_or_none()
            if not owned_fp:
                raise HTTPException(status_code=403, detail="Access denied to this apartment")

        logger.info(f"[Save] Existing: {apartment.name!r}")
        logger.info(f"[Save] Detected: {body.apartment_name!r}")

        # Check if the detected name differs significantly from the existing apartment name
        if body.apartment_name and len(body.apartment_name.strip()) >= 3:
            row = db.execute(
                text("SELECT similarity(lower(:detected), lower(:existing)) AS sim"),
                {"detected": body.apartment_name.strip(), "existing": apartment.name},
            ).fetchone()
            sim_score = float(row[0]) if row else 0.0
            logger.info(f"[Save] Similarity: {sim_score:.2f}")
            if row and sim_score < 0.70:
                name_mismatch = {
                    "existing_name": apartment.name,
                    "detected_name": body.apartment_name.strip(),
                    "similarity": sim_score,
                }
                logger.info(
                    f"[Apartment] Name mismatch: existing='{apartment.name}' "
                    f"detected='{body.apartment_name.strip()}' sim={sim_score:.2f}"
                )
            else:
                logger.info("[Save] No mismatch (similarity >= 0.70 or no detected name)")

    # Priority 2: match by name
    elif body.apartment_name and len(body.apartment_name.strip()) >= 3:
        name = body.apartment_name.strip()

        # Exact match (case-insensitive)
        exact_query = select(Apartment).where(
            func.lower(Apartment.name) == name.lower(),
            Apartment.is_active == True,
        )
        if current_user.role != "admin":
            exact_query = exact_query.join(FloorPlan).where(FloorPlan.uploaded_by == current_user.id).distinct()
        apartment = db.execute(exact_query).scalars().first()

        if not apartment:
            # Fuzzy similarity match via pg_trgm
            if current_user.role != "admin":
                row = db.execute(
                    text("""
                        SELECT DISTINCT a.id, a.name,
                               similarity(lower(a.name), lower(:name)) AS sim
                        FROM apartments a
                        JOIN floor_plans fp ON fp.apartment_id = a.id
                        WHERE a.is_active = true
                          AND fp.uploaded_by = :user_id
                          AND similarity(lower(a.name), lower(:name)) > 0.7
                        ORDER BY sim DESC
                        LIMIT 1
                    """),
                    {"name": name, "user_id": current_user.id},
                ).fetchone()
            else:
                row = db.execute(
                    text("""
                        SELECT id, name,
                               similarity(lower(name), lower(:name)) AS sim
                        FROM apartments
                        WHERE is_active = true
                          AND similarity(lower(name), lower(:name)) > 0.7
                        ORDER BY sim DESC
                        LIMIT 1
                    """),
                    {"name": name},
                ).fetchone()

            if row:
                sim_score = float(row[2])
                if sim_score >= 0.90:
                    # Very high similarity → auto match
                    apartment = db.execute(
                        select(Apartment).where(Apartment.id == row[0])
                    ).scalar_one_or_none()
                    logger.info(f"[Apartment] Auto-matched '{name}' → '{row[1]}' (sim={sim_score:.2f})")
                else:
                    # 70–89% → flag for user confirmation, save as new for now
                    similarity_match = {
                        "apartment_id": str(row[0]),
                        "apartment_name": row[1],
                        "similarity": sim_score,
                    }
                    logger.info(f"[Apartment] Similarity prompt: '{name}' ~ '{row[1]}' (sim={sim_score:.2f})")

        if not apartment:
            apartment = Apartment(
                id=uuid.uuid4(),
                name=name,
                address=body.address,
                created_at=datetime.utcnow(),
            )
            db.add(apartment)
            db.flush()
            logger.info(f"[Apartment] Created new: '{name}'")

    # Priority 3: empty/short name → placeholder
    else:
        placeholder = f"Floor Plan {datetime.utcnow().strftime('%d %b %Y %H:%M')}"
        apartment = Apartment(
            id=uuid.uuid4(),
            name=placeholder,
            address=body.address,
            created_at=datetime.utcnow(),
        )
        db.add(apartment)
        db.flush()
        logger.info(f"[Apartment] Created placeholder: '{placeholder}'")

    if body.address and not apartment.address:
        apartment.address = body.address

    db.execute(
        update(FloorPlan)
        .where(FloorPlan.apartment_id == apartment.id)
        .values(is_latest=False)
    )

    max_version = db.execute(
        select(func.max(FloorPlan.version)).where(FloorPlan.apartment_id == apartment.id)
    ).scalar()
    new_version = (max_version or 0) + 1

    image_url = None
    ai_confidence_score = None
    original_filename = None
    file_type = None
    thumbnail_url = None
    original_image_url = None

    # Priority 1: in-memory upload store (new file uploads)
    if body.upload_id:
        upload_rec = _upload_store.get(body.upload_id)
        if upload_rec:
            image_url = upload_rec.get("image_url")
            ai_confidence_score = upload_rec.get("confidence")
            original_filename = upload_rec.get("original_filename")
            file_type = upload_rec.get("file_type")
            thumbnail_url = upload_rec.get("thumbnail_url")
            original_image_url = upload_rec.get("original_image_url")

    # Priority 2: image URLs sent directly in the request body (edit flows)
    if not image_url and body.image_url:
        image_url = body.image_url
    if not original_image_url and body.original_image_url:
        original_image_url = body.original_image_url
    if not thumbnail_url and body.thumbnail_url:
        thumbnail_url = body.thumbnail_url

    # Priority 3: fall back to the most recent version that actually has an image
    if not image_url:
        existing = db.execute(
            select(FloorPlan)
            .where(FloorPlan.apartment_id == apartment.id, FloorPlan.image_url.isnot(None))
            .order_by(FloorPlan.version.desc())
            .limit(1)
        ).scalar_one_or_none()
        if existing:
            image_url = existing.image_url
            if not original_image_url:
                original_image_url = existing.original_image_url
            if not thumbnail_url:
                thumbnail_url = existing.thumbnail_url

    floor_plan = FloorPlan(
        id=uuid.uuid4(),
        apartment_id=apartment.id,
        image_url=image_url,
        original_filename=original_filename,
        file_type=file_type,
        total_internal_m2=totals["total_internal_m2"],
        total_balcony_m2=totals["total_balcony_m2"],
        version=new_version,
        is_latest=True,
        uploaded_by=current_user.id,
        uploaded_at=datetime.utcnow(),
        confirmed_at=datetime.utcnow(),
        ai_confidence_score=ai_confidence_score,
        was_edited=body.was_edited,
        flags_triggered=flags if flags else None,
        device_type=body.device_type,
        floor_plan_boundary=body.floor_plan_boundary.dict() if body.floor_plan_boundary else None,
        thumbnail_url=thumbnail_url,
        original_image_url=original_image_url,
    )
    db.add(floor_plan)
    db.flush()

    room_records = []
    for rd in rooms_data:
        room = Room(
            id=uuid.uuid4(),
            floor_plan_id=floor_plan.id,
            room_name=rd["room_name"],
            position=rd["position"],
            length_m=rd["length_m"],
            width_m=rd["width_m"],
            area_m2=rd["area_m2"],
            is_balcony=rd["is_balcony"],
            sort_order=rd["sort_order"],
            bbox_x=rd["bbox_x"],
            bbox_y=rd["bbox_y"],
            bbox_w=rd["bbox_w"],
            bbox_h=rd["bbox_h"],
            shape_mode=rd["shape_mode"],
            shape_data=rd["shape_data"],
            bbox_source=rd["bbox_source"],
            ai_confidence=rd["ai_confidence"],
        )
        db.add(room)
        room_records.append(room)

    db.commit()

    print(
        f"[FloorPlan] Saved: {apartment.name} | v{new_version} | "
        f"{len(rooms_data)} rooms | Internal: {totals['total_internal_m2']}m2 | "
        f"Balcony: {totals['total_balcony_m2']}m2 | By: {current_user.email}"
    )

    room_lines = []
    for rd in rooms_data:
        badge = " (exterior)" if rd["is_balcony"] else ""
        room_lines.append(
            f"  {rd['room_name']}{badge} = {rd['area_m2']}m\u00b2"
        )
    grand_total = round(totals["total_internal_m2"] + totals["total_balcony_m2"], 2)
    telegram_msg = "\n".join([
        "FLOOR PLAN SAVED",
        f"Apartment: {apartment.name}",
        f"Version: {new_version}",
        f"By: {current_user.email}",
        "",
        "ROOMS:",
        *room_lines,
        "",
        "TOTALS:",
        f"  Internal: {totals['total_internal_m2']}m\u00b2",
        f"  Balcony: {totals['total_balcony_m2']}m\u00b2",
        f"  Grand total: {grand_total}m\u00b2",
    ])
    await telegram.send_success_alert(telegram_msg)

    return SaveFloorPlanResponse(
        floor_plan_id=str(floor_plan.id),
        apartment_id=str(apartment.id),
        apartment_name=apartment.name,
        version=new_version,
        similarity_match=similarity_match,
        name_mismatch=name_mismatch,
        rooms=[
            RoomResponse(
                id=str(room_records[i].id),
                room_name=rd["room_name"],
                position=rd["position"],
                length_m=rd["length_m"],
                width_m=rd["width_m"],
                area_m2=rd["area_m2"],
                is_balcony=rd["is_balcony"],
                sort_order=rd["sort_order"],
            )
            for i, rd in enumerate(rooms_data)
        ],
        total_internal_m2=totals["total_internal_m2"],
        total_balcony_m2=totals["total_balcony_m2"],
        total_m2=totals["total_m2"],
        flags=flags,
        saved_at=floor_plan.confirmed_at,
    )


@router.get("/check-similarity")
async def check_apartment_similarity(
    name: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    name = name.strip()

    # Exact match first — no dialog needed
    exact_query = select(Apartment).where(
        func.lower(Apartment.name) == name.lower(),
        Apartment.is_active == True,
    )
    if current_user.role != "admin":
        exact_query = exact_query.join(FloorPlan).where(FloorPlan.uploaded_by == current_user.id).distinct()
    exact = db.execute(exact_query).scalars().first()
    if exact:
        return {"similarity_match": None}

    # Fuzzy match
    if current_user.role != "admin":
        row = db.execute(
            text("""
                SELECT DISTINCT a.id, a.name,
                       similarity(lower(a.name), lower(:name)) AS sim
                FROM apartments a
                JOIN floor_plans fp ON fp.apartment_id = a.id
                WHERE a.is_active = true
                  AND fp.uploaded_by = :user_id
                  AND similarity(lower(a.name), lower(:name)) > 0.7
                ORDER BY sim DESC
                LIMIT 1
            """),
            {"name": name, "user_id": current_user.id},
        ).fetchone()
    else:
        row = db.execute(
            text("""
                SELECT id, name,
                       similarity(lower(name), lower(:name)) AS sim
                FROM apartments
                WHERE is_active = true
                  AND similarity(lower(name), lower(:name)) > 0.7
                ORDER BY sim DESC
                LIMIT 1
            """),
            {"name": name},
        ).fetchone()

    if row:
        sim_score = float(row[2])
        if sim_score >= 0.90:
            # High confidence — auto-match, no dialog
            return {"similarity_match": None, "auto_match_apartment_id": str(row[0])}
        else:
            return {
                "similarity_match": {
                    "apartment_id": str(row[0]),
                    "apartment_name": row[1],
                    "similarity": sim_score,
                }
            }

    return {"similarity_match": None}


@router.post("/{floor_plan_id}/reassign")
async def reassign_floor_plan(
    floor_plan_id: str,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Move a floor plan to a brand-new apartment (used after name-mismatch dialog)."""
    floor_plan = db.execute(
        select(FloorPlan).where(FloorPlan.id == uuid.UUID(floor_plan_id))
    ).scalar_one_or_none()
    if not floor_plan:
        raise HTTPException(status_code=404, detail="Floor plan not found")

    if current_user.role != "admin" and floor_plan.uploaded_by != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    new_name = (body.get("apartment_name") or "").strip()
    if not new_name:
        new_name = f"Floor Plan {datetime.utcnow().strftime('%d %b %Y %H:%M')}"

    new_apartment = Apartment(
        id=uuid.uuid4(),
        name=new_name,
        is_active=True,
        created_at=datetime.utcnow(),
    )
    db.add(new_apartment)
    db.flush()

    old_apartment_id = floor_plan.apartment_id
    floor_plan.apartment_id = new_apartment.id
    floor_plan.version = 1
    floor_plan.is_latest = True

    # Fix is_latest on the old apartment
    db.execute(
        update(FloorPlan)
        .where(FloorPlan.apartment_id == old_apartment_id)
        .values(is_latest=False)
    )
    latest_old = db.execute(
        select(FloorPlan.id)
        .where(FloorPlan.apartment_id == old_apartment_id)
        .order_by(FloorPlan.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    if latest_old:
        db.execute(
            update(FloorPlan).where(FloorPlan.id == latest_old).values(is_latest=True)
        )

    db.commit()
    logger.info(
        f"[FloorPlan] Reassigned {floor_plan_id} → new apartment '{new_name}' "
        f"(old apt {old_apartment_id})"
    )
    return {
        "success": True,
        "new_apartment_id": str(new_apartment.id),
        "new_apartment_name": new_apartment.name,
    }


@router.get("/search", response_model=List[ApartmentSearchResult])
async def search_apartments(
    name: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = select(Apartment).where(func.lower(Apartment.name).contains(name.lower()))
    if current_user.role != "admin":
        query = query.join(FloorPlan).where(FloorPlan.uploaded_by == current_user.id).distinct()

    apartments = db.execute(
        query.order_by(Apartment.name)
    ).scalars().all()

    out = []
    for apt in apartments:
        latest_fp_query = select(FloorPlan).where(FloorPlan.apartment_id == apt.id)
        if current_user.role != "admin":
            latest_fp_query = latest_fp_query.where(FloorPlan.uploaded_by == current_user.id)
        fp = db.execute(
            latest_fp_query.order_by(FloorPlan.version.desc()).limit(1)
        ).scalar_one_or_none()

        room_count = None
        if fp:
            room_count = db.execute(
                select(func.count()).select_from(Room).where(Room.floor_plan_id == fp.id)
            ).scalar()

        out.append(ApartmentSearchResult(
            apartment_id=str(apt.id),
            name=apt.name,
            address=apt.address,
            latest_floor_plan_id=str(fp.id) if fp else None,
            latest_version=fp.version if fp else None,
            total_internal_m2=float(fp.total_internal_m2) if fp and fp.total_internal_m2 else None,
            room_count=room_count,
            uploaded_at=fp.uploaded_at if fp else None,
        ))
    return out


@router.get("/apartment/{apartment_id}/history", response_model=List[FloorPlanHistoryItem])
async def get_apartment_history(
    apartment_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    apartment = db.execute(select(Apartment).where(Apartment.id == apartment_id)).scalar_one_or_none()
    if not apartment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Apartment not found")

    if current_user.role != "admin":
        owned_fp = db.execute(
            select(FloorPlan).where(
                FloorPlan.apartment_id == apartment_id,
                FloorPlan.uploaded_by == current_user.id
            ).limit(1)
        ).scalar_one_or_none()
        if not owned_fp:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    query = select(FloorPlan).where(FloorPlan.apartment_id == apartment_id)
    if current_user.role != "admin":
        query = query.where(FloorPlan.uploaded_by == current_user.id)

    floor_plans = db.execute(
        query.order_by(FloorPlan.version.desc())
    ).scalars().all()

    out = []
    for fp in floor_plans:
        room_count = db.execute(
            select(func.count()).select_from(Room).where(Room.floor_plan_id == fp.id)
        ).scalar() or 0
        out.append(FloorPlanHistoryItem(
            floor_plan_id=str(fp.id),
            version=fp.version,
            is_latest=fp.is_latest,
            total_internal_m2=float(fp.total_internal_m2) if fp.total_internal_m2 else None,
            total_balcony_m2=float(fp.total_balcony_m2) if fp.total_balcony_m2 else None,
            was_edited=fp.was_edited,
            room_count=room_count,
            uploaded_at=fp.uploaded_at,
            confirmed_at=fp.confirmed_at,
        ))
    return out


@router.get("/{floor_plan_id}", response_model=FloorPlanDetail)
async def get_floor_plan(
    floor_plan_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    fp = db.execute(
        select(FloorPlan)
        .options(selectinload(FloorPlan.apartment), selectinload(FloorPlan.rooms))
        .where(FloorPlan.id == floor_plan_id)
    ).scalar_one_or_none()
    if not fp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Floor plan not found")

    if current_user.role != "admin" and fp.uploaded_by != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    rooms_sorted = sorted(fp.rooms, key=lambda r: r.sort_order)

    uploader = None
    if fp.uploaded_by:
        uploader = db.execute(select(User).where(User.id == fp.uploaded_by)).scalar_one_or_none()

    return FloorPlanDetail(
        floor_plan_id=str(fp.id),
        apartment_id=str(fp.apartment_id),
        apartment_name=fp.apartment.name,
        address=fp.apartment.address,
        version=fp.version,
        is_latest=fp.is_latest,
        image_url=fp.image_url,
        original_image_url=fp.original_image_url,
        thumbnail_url=fp.thumbnail_url,
        total_internal_m2=float(fp.total_internal_m2) if fp.total_internal_m2 else None,
        total_balcony_m2=float(fp.total_balcony_m2) if fp.total_balcony_m2 else None,
        ai_confidence_score=float(fp.ai_confidence_score) if fp.ai_confidence_score else None,
        was_edited=fp.was_edited,
        device_type=fp.device_type,
        flags_triggered=fp.flags_triggered,
        uploaded_at=fp.uploaded_at,
        confirmed_at=fp.confirmed_at,
        uploaded_by_email=uploader.email if uploader else None,
        rooms=[
            RoomResponse(
                id=str(r.id),
                room_name=r.room_name,
                position=r.position,
                length_m=float(r.length_m) if r.length_m else 0.0,
                width_m=float(r.width_m) if r.width_m else 0.0,
                area_m2=float(r.area_m2) if r.area_m2 else 0.0,
                is_balcony=r.is_balcony,
                sort_order=r.sort_order,
                bbox={
                    "x": float(r.bbox_x), "y": float(r.bbox_y),
                    "w": float(r.bbox_w), "h": float(r.bbox_h),
                } if r.bbox_x is not None else None,
                shape=r.shape_data,
                source=r.bbox_source,
            )
            for r in rooms_sorted
        ],
    )


# ---------- Apartment-centric routes ----------

@apartment_router.get("", response_model=List[ApartmentListItem])
async def list_apartments(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = select(Apartment).where(Apartment.is_active == True)
    if current_user.role != "admin":
        query = query.join(FloorPlan).where(FloorPlan.uploaded_by == current_user.id).distinct()

    apartments = db.execute(
        query.order_by(Apartment.created_at.desc())
    ).scalars().all()

    out = []
    for apt in apartments:
        latest_fp_query = select(FloorPlan).where(FloorPlan.apartment_id == apt.id)
        if current_user.role != "admin":
            latest_fp_query = latest_fp_query.where(FloorPlan.uploaded_by == current_user.id)
        fp = db.execute(
            latest_fp_query.order_by(FloorPlan.version.desc()).limit(1)
        ).scalar_one_or_none()

        room_count = None
        if fp:
            room_count = db.execute(
                select(func.count()).select_from(Room).where(Room.floor_plan_id == fp.id)
            ).scalar()
        image_url = fp.image_url if fp else None
        thumbnail_url = fp.thumbnail_url if fp else None
        if fp and not image_url:
            fp_img_query = select(FloorPlan).where(FloorPlan.apartment_id == apt.id, FloorPlan.image_url.isnot(None))
            if current_user.role != "admin":
                fp_img_query = fp_img_query.where(FloorPlan.uploaded_by == current_user.id)
            fp_img = db.execute(
                fp_img_query.order_by(FloorPlan.version.desc()).limit(1)
            ).scalar_one_or_none()
            if fp_img:
                image_url = fp_img.image_url
                thumbnail_url = fp_img.thumbnail_url

        out.append(ApartmentListItem(
            apartment_id=str(apt.id),
            name=apt.name,
            address=apt.address,
            latest_floor_plan_id=str(fp.id) if fp else None,
            latest_version=fp.version if fp else None,
            total_internal_m2=float(fp.total_internal_m2) if fp and fp.total_internal_m2 else None,
            total_balcony_m2=float(fp.total_balcony_m2) if fp and fp.total_balcony_m2 else None,
            room_count=room_count,
            uploaded_at=fp.uploaded_at if fp else None,
            image_url=image_url,
            thumbnail_url=thumbnail_url,
        ))
    return out


@apartment_router.get("/{apartment_id}/versions", response_model=List[VersionListItem])
async def list_apartment_versions(
    apartment_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    apartment = db.execute(select(Apartment).where(Apartment.id == apartment_id)).scalar_one_or_none()
    if not apartment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Apartment not found")

    if current_user.role != "admin":
        owned_fp = db.execute(
            select(FloorPlan).where(
                FloorPlan.apartment_id == apartment_id,
                FloorPlan.uploaded_by == current_user.id
            ).limit(1)
        ).scalar_one_or_none()
        if not owned_fp:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    query = select(FloorPlan).where(FloorPlan.apartment_id == apartment_id)
    if current_user.role != "admin":
        query = query.where(FloorPlan.uploaded_by == current_user.id)

    floor_plans = db.execute(
        query.order_by(FloorPlan.version.desc())
    ).scalars().all()

    out = []
    for fp in floor_plans:
        room_count = db.execute(
            select(func.count()).select_from(Room).where(Room.floor_plan_id == fp.id)
        ).scalar() or 0
        uploader = None
        if fp.uploaded_by:
            uploader = db.execute(select(User).where(User.id == fp.uploaded_by)).scalar_one_or_none()
        out.append(VersionListItem(
            floor_plan_id=str(fp.id),
            version=fp.version,
            is_latest=fp.is_latest,
            total_internal_m2=float(fp.total_internal_m2) if fp.total_internal_m2 else None,
            total_balcony_m2=float(fp.total_balcony_m2) if fp.total_balcony_m2 else None,
            room_count=room_count,
            uploaded_at=fp.uploaded_at,
            confirmed_at=fp.confirmed_at,
            uploaded_by_email=uploader.email if uploader else None,
            image_url=fp.image_url,
            original_image_url=fp.original_image_url,
            thumbnail_url=fp.thumbnail_url,
            flags_triggered=fp.flags_triggered,
        ))
    return out


@apartment_router.get("/{apartment_id}/versions/{floor_plan_id}", response_model=FloorPlanDetail)
async def get_apartment_version(
    apartment_id: str,
    floor_plan_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    fp = db.execute(
        select(FloorPlan)
        .options(selectinload(FloorPlan.apartment), selectinload(FloorPlan.rooms))
        .where(FloorPlan.id == floor_plan_id, FloorPlan.apartment_id == apartment_id)
    ).scalar_one_or_none()
    if not fp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Floor plan not found")

    if current_user.role != "admin" and fp.uploaded_by != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    rooms_sorted = sorted(fp.rooms, key=lambda r: r.sort_order)
    uploader = None
    if fp.uploaded_by:
        uploader = db.execute(select(User).where(User.id == fp.uploaded_by)).scalar_one_or_none()

    return FloorPlanDetail(
        floor_plan_id=str(fp.id),
        apartment_id=str(fp.apartment_id),
        apartment_name=fp.apartment.name,
        address=fp.apartment.address,
        version=fp.version,
        is_latest=fp.is_latest,
        image_url=fp.image_url,
        original_image_url=fp.original_image_url,
        thumbnail_url=fp.thumbnail_url,
        total_internal_m2=float(fp.total_internal_m2) if fp.total_internal_m2 else None,
        total_balcony_m2=float(fp.total_balcony_m2) if fp.total_balcony_m2 else None,
        ai_confidence_score=float(fp.ai_confidence_score) if fp.ai_confidence_score else None,
        was_edited=fp.was_edited,
        device_type=fp.device_type,
        flags_triggered=fp.flags_triggered,
        uploaded_at=fp.uploaded_at,
        confirmed_at=fp.confirmed_at,
        uploaded_by_email=uploader.email if uploader else None,
        rooms=[
            RoomResponse(
                id=str(r.id),
                room_name=r.room_name,
                position=r.position,
                length_m=float(r.length_m) if r.length_m else 0.0,
                width_m=float(r.width_m) if r.width_m else 0.0,
                area_m2=float(r.area_m2) if r.area_m2 else 0.0,
                is_balcony=r.is_balcony,
                sort_order=r.sort_order,
                bbox={
                    "x": float(r.bbox_x), "y": float(r.bbox_y),
                    "w": float(r.bbox_w), "h": float(r.bbox_h),
                } if r.bbox_x is not None else None,
                shape=r.shape_data,
                source=r.bbox_source,
            )
            for r in rooms_sorted
        ],
    )
