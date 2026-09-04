import os
import uuid
import shutil
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.db.models import User
from app.middleware.auth import get_current_user
from app.services import openai_service, pdf_service, telegram
from app.services.monitoring_service import ResourceTracker

router = APIRouter(prefix="/api/upload", tags=["upload"])

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "10"))
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

ALLOWED_EXTENSIONS = {"pdf", "png", "jpg", "jpeg"}

# In-memory store for upload results (keyed by upload_id)
_upload_store: dict = {}


# ---------- Pydantic schemas ----------

class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


class RoomResult(BaseModel):
    room_name: str
    is_balcony: bool = False
    confidence: float = 0.0
    bbox: Optional[BBox] = None
    shape_type: str = "rectangle"
    polygon_points: Optional[List[dict]] = None


class ResourceUsage(BaseModel):
    duration_seconds: float
    cpu_percent_process: float
    cpu_percent_process_normalized: float
    cpu_percent_system: float
    memory_process_mb: float
    memory_delta_process_mb: float
    system_ram_percent: float
    disk_delta_mb: float


class UploadResponse(BaseModel):
    upload_id: str
    image_url: str
    original_image_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    apartment_name: Optional[str]
    confidence: float
    rooms: List[RoomResult]
    original_filename: str
    file_type: str
    floor_plan_boundary: Optional[BBox] = None
    floor_plan_orientation: Optional[str] = None
    resource_usage: Optional[ResourceUsage] = None


class LocateRoomsRequest(BaseModel):
    image_url: str
    rooms: List[RoomResult]
    known_rooms: List[RoomResult] = []
    orientation: str = "axis-aligned"


class LocateRoomsResponse(BaseModel):
    rooms: List[RoomResult]


# ---------- Helpers ----------

def _extension(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _safe_delete(path: Optional[str]):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


def _safe_rmdir(path: Optional[str]):
    try:
        if path and os.path.exists(path):
            shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


def _generate_thumbnail(image_path: str, thumb_path: str) -> bool:
    try:
        from PIL import Image as PILImage
        img = PILImage.open(image_path).convert("RGB")
        img.thumbnail((300, 300), PILImage.LANCZOS)
        img.save(thumb_path, "JPEG", quality=85)
        return True
    except Exception as e:
        print(f"[Upload] Thumbnail generation failed: {e}")
        return False


def _resolve_image_path(image_url: str) -> str:
    """Resolve /uploads/... URL to filesystem path."""
    prefix = "/uploads/"
    if image_url.startswith(prefix):
        sub_path = image_url[len(prefix):]
    else:
        sub_path = os.path.basename(image_url)
    return os.path.join(UPLOAD_DIR, sub_path)


# ---------- Routes ----------

@router.post("", response_model=UploadResponse, status_code=status.HTTP_200_OK)
async def upload_floor_plan(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    original_filename = file.filename or "unknown"
    tracker = ResourceTracker(filename=original_filename)
    tracker.__enter__()
    
    upload_id = "failed_init"
    upload_subdir = None
    
    try:
        ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        ext = _extension(original_filename)

        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid file type '.{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
            )

        content = await file.read()
        if len(content) > MAX_FILE_SIZE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"File too large. Maximum size is {MAX_FILE_SIZE_MB}MB.",
            )

        # Create per-upload subfolder
        upload_id = str(uuid.uuid4())
        upload_subdir = os.path.join(UPLOAD_DIR, upload_id)
        os.makedirs(upload_subdir, exist_ok=True)

        saved_path = os.path.join(upload_subdir, f"original.{ext}")
        with open(saved_path, "wb") as f:
            f.write(content)

        original_image_url = f"/uploads/{upload_id}/original.{ext}"
        print(f"[Upload] {ts} | {original_filename} | saved to {upload_id}/ | user: {current_user.email}")

        image_path = saved_path
        converted_path: Optional[str] = None
        image_url: str = original_image_url

        # Convert PDF → image
        if ext == "pdf":
            try:
                tmp_converted = pdf_service.convert_pdf_to_image(saved_path)
                converted_path = os.path.join(upload_subdir, "processed.jpg")
                shutil.move(tmp_converted, converted_path)
                image_path = converted_path
                image_url = f"/uploads/{upload_id}/processed.jpg"
            except RuntimeError as exc:
                _safe_rmdir(upload_subdir)
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

        # Generate thumbnail
        thumb_path = os.path.join(upload_subdir, "thumb.jpg")
        thumbnail_url: Optional[str] = None
        if _generate_thumbnail(image_path, thumb_path):
            thumbnail_url = f"/uploads/{upload_id}/thumb.jpg"

        # AI detection
        try:
            detection = await openai_service.detect_floor_plan(image_path)
        except Exception as exc:
            await telegram.send_error_alert(
                error=str(exc),
                context=f"OpenAI detect_floor_plan — file: {original_filename}",
            )
            _safe_rmdir(upload_subdir)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="AI analysis failed. Please try again.",
            )

        # Reject non-floor-plans
        if not detection["is_floor_plan"]:
            _safe_rmdir(upload_subdir)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This does not appear to be a floor plan. Please upload a floor plan image.",
            )

        rooms = []
        for r in detection["rooms"]:
            bbox_data = r.get("bbox")
            rooms.append(RoomResult(
                room_name=r["room_name"],
                is_balcony=r.get("is_balcony", False),
                confidence=r.get("confidence", 0.0),
                bbox=BBox(**bbox_data) if bbox_data else None,
                shape_type=r.get("shape_type", "rectangle"),
                polygon_points=r.get("polygon_points") or None,
            ))

        boundary_data = detection.get("floor_plan_boundary")
        
        # End resource tracking
        tracker.__exit__(None, None, None)
        res_usage = ResourceUsage(**tracker.get_report_dict())
        
        result = UploadResponse(
            upload_id=upload_id,
            image_url=image_url,
            original_image_url=original_image_url,
            thumbnail_url=thumbnail_url,
            apartment_name=detection["apartment_name"],
            confidence=detection["confidence"],
            rooms=rooms,
            original_filename=original_filename,
            file_type=ext,
            floor_plan_boundary=BBox(**boundary_data) if boundary_data else None,
            floor_plan_orientation=detection.get("floor_plan_orientation"),
            resource_usage=res_usage
        )

        _upload_store[upload_id] = result.model_dump()

        # Send Telegram report
        await tracker.send_telegram_report(upload_id=upload_id, success=True)

        print(
            f"[Upload] {ts} | {original_filename} | "
            f"rooms detected: {len(rooms)} | confidence: {detection['confidence']:.2f} | "
            f"apartment: {detection['apartment_name']} | thumb: {thumbnail_url is not None}"
        )

        return result

    except HTTPException as exc:
        tracker.__exit__(type(exc), exc, None)
        if upload_subdir:
            await tracker.send_telegram_report(upload_id=upload_id, success=False, error_msg=exc.detail)
        raise exc
    except Exception as exc:
        tracker.__exit__(type(exc), exc, None)
        await tracker.send_telegram_report(upload_id=upload_id, success=False, error_msg=str(exc))
        await telegram.send_error_alert(
            error=str(exc),
            context=f"Unexpected upload processing error — file: {original_filename}",
        )
        if upload_subdir:
            _safe_rmdir(upload_subdir)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Upload processing failed.")


@router.get("/{upload_id}", response_model=UploadResponse)
async def get_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
):
    result = _upload_store.get(upload_id)
    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
    return result


def canonical_room_name(name: str) -> str:
    import re
    name = name.lower().strip()
    name = re.sub(r'\s*\d+\s*$', '', name)  # remove trailing numbers e.g. "bedroom 1" -> "bedroom"
    
    if "living" in name:
        return "living"
    if "dining" in name:
        return "dining"
    if "kitchen" in name:
        return "kitchen"
    if "bath" in name or "toilet" in name or "l'dry" in name or "laundry" in name:
        if "l'dry" in name or "laundry" in name:
            if "bath" in name:
                return "bathroom"
            return "laundry"
        return "bathroom"
    if "entry" in name or "foyer" in name:
        return "entry"
    if "wardrobe" in name or "robe" in name:
        return "robe"
    if "study" in name or "flexi" in name:
        return "study"
    if "deck" in name or "terrace" in name:
        return "deck"
    if "balcony" in name:
        return "balcony"
    if "garage" in name:
        return "garage"
    if "storage" in name:
        return "storage"
    return name


@router.post("/locate-rooms", response_model=LocateRoomsResponse)
async def locate_rooms(
    body: LocateRoomsRequest,
    current_user: User = Depends(get_current_user),
):
    image_path = _resolve_image_path(body.image_url)

    if not os.path.exists(image_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image file not found")

    # Align known_rooms names to requested rooms names where possible to resolve naming differences (e.g. "Living" vs "Living Room")
    for kr in body.known_rooms:
        kr_canonical = canonical_room_name(kr.room_name)
        for r in body.rooms:
            if canonical_room_name(r.room_name) == kr_canonical:
                kr.room_name = r.room_name
                break

    rooms_input = [{"room_name": r.room_name, "is_balcony": r.is_balcony} for r in body.rooms]
    known_input = [{"room_name": r.room_name, "is_balcony": r.is_balcony} for r in body.known_rooms]

    try:
        located = await openai_service.locate_rooms(
            image_path, rooms_input, known_rooms=known_input,
            orientation=body.orientation,
        )
    except Exception as exc:
        await telegram.send_error_alert(
            error=str(exc),
            context=f"locate_rooms — image: {body.image_url}",
        )
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="AI room location failed. Please try again.")

    known_map = {kr.room_name.lower().strip(): kr for kr in body.known_rooms}
    located_map = {r["room_name"].lower().strip(): r for r in located}

    result_rooms = []
    for r in body.rooms:
        key = r.room_name.lower().strip()
        matched = located_map.get(key)
        known = known_map.get(key)

        if matched and matched.get("found"):
            bbox_data = matched.get("bbox")
            result_rooms.append(RoomResult(
                room_name=r.room_name,
                is_balcony=r.is_balcony,
                confidence=matched.get("confidence", 0.0),
                bbox=BBox(**bbox_data) if bbox_data else None,
                shape_type=matched.get("shape_type", "rectangle"),
                polygon_points=matched.get("polygon_points") or None,
            ))
        elif known and known.bbox:
            result_rooms.append(known)
        elif matched:
            bbox_data = matched.get("bbox")
            result_rooms.append(RoomResult(
                room_name=r.room_name,
                is_balcony=r.is_balcony,
                confidence=matched.get("confidence", 0.0),
                bbox=BBox(**bbox_data) if bbox_data else None,
                shape_type=matched.get("shape_type", "rectangle"),
                polygon_points=matched.get("polygon_points") or None,
            ))
        else:
            result_rooms.append(RoomResult(
                room_name=r.room_name,
                is_balcony=r.is_balcony,
                confidence=0.0,
                bbox=None,
            ))

    return LocateRoomsResponse(rooms=result_rooms)
