import asyncio
import base64
import json
import os
import re
from typing import Optional, Union
from openai import AsyncOpenAI

AI_PROVIDER = os.getenv("AI_PROVIDER", "openai").lower()
DEBUG = os.getenv("DEBUG", "false").lower() == "true"

if AI_PROVIDER == "gemini":
    gemini_key = os.getenv("GEMINI_API_KEY")
    gemini_base = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/")
    client = AsyncOpenAI(
        api_key=gemini_key if gemini_key else "missing_key",
        base_url=gemini_base
    )
    _PRIMARY_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
    _FALLBACK_SEQUENCE = [_PRIMARY_MODEL, _PRIMARY_MODEL]
else:
    client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    _PRIMARY_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
    _FALLBACK_SEQUENCE = [_PRIMARY_MODEL, _PRIMARY_MODEL]

_active_model: Optional[str] = None


async def _create_completion(messages: list, max_tokens: int) -> str:
    """Retry primary model twice before falling back. Cache first successful model."""
    global _active_model

    # If a non-primary model is cached (from a previous fallback), always start fresh
    # with the primary model so a transient error doesn't permanently degrade quality.
    if _active_model and _active_model == _PRIMARY_MODEL:
        sequence = [_active_model] + [m for m in _FALLBACK_SEQUENCE if m != _active_model]
    else:
        sequence = list(_FALLBACK_SEQUENCE)

    last_exc: Exception = RuntimeError(f"No models available for provider {AI_PROVIDER}")
    permanent_failures = set()
    
    for model in sequence:
        if model in permanent_failures:
            continue
            
        try:
            print(f"[{AI_PROVIDER.upper()}] Trying model: {model}")
            
            # Gemini OpenAI-compatibility layer has a bug where passing max_completion_tokens
            # caps the response to a tiny size (length finish reason). Omit it for Gemini.
            kwargs = {
                "model": model,
                "messages": messages,
            }
            if AI_PROVIDER != "gemini":
                kwargs["max_completion_tokens"] = max_tokens
                
            response = await client.chat.completions.create(**kwargs)
            _active_model = model
            if model != _PRIMARY_MODEL:
                print(f"[{AI_PROVIDER.upper()}] Used fallback model: {model}")
            else:
                print(f"[{AI_PROVIDER.upper()}] Model succeeded: {model}")
            return response.choices[0].message.content
        except Exception as e:
            print(f"[{AI_PROVIDER.upper()}] Model {model} failed: {e}, trying next...")
            last_exc = e
            
            # If it is a quota limit (429) or authentication error (401), do not try this model again in the sequence
            err_str = str(e).lower()
            status_code = getattr(e, 'status_code', None)
            if status_code in (401, 429) or "quota" in err_str or "limit" in err_str or "exhausted" in err_str:
                print(f"[{AI_PROVIDER.upper()}] Model {model} has permanent failure/quota limit. Skipping future attempts.")
                permanent_failures.add(model)
                
            await asyncio.sleep(1)
    raise last_exc


# ── Pass 1: structural analysis ──────────────────────────────────────────────

PASS_1_PROMPT = """You are analyzing a floor plan image.

STEP 1 - UNDERSTAND THE FLOOR PLAN:
Look at the overall image and answer:

1. Is this actually a floor plan? (architectural drawing showing room layout)

2. Floor plan orientation:
   - "axis-aligned": walls are horizontal and vertical
   - "diagonal": floor plan is rotated, walls are at angles
   - "mixed": some rooms axis-aligned, some diagonal

3. Count all visible rooms/spaces

4. List all text labels visible (room names, dimensions, address, compass)

5. Identify furniture/fixtures:
   - Toilet, bathtub, shower = bathroom area
   - Bed outline = bedroom
   - Stove, countertop lines, sink = kitchen
   - Sofa = living room
   - Railings, open exterior area = balcony

Return ONLY valid JSON:
{
  "is_floor_plan": true,
  "orientation": "axis-aligned",
  "apartment_name": "extracted address/name or empty string",
  "estimated_room_count": 5,
  "visible_labels": ["BATH", "BEDROOM", "LIVING ROOM", "KITCHEN", "BALCONY"],
  "visible_fixtures": {
    "bathroom": "toilet and bathtub visible top-left area",
    "bedroom": "bed outline visible right side",
    "kitchen": "stove visible center-left",
    "living_room": "sofa outline visible center",
    "balcony": "open area bottom-right with railings"
  },
  "floor_plan_notes": "diamond-shaped floor plan rotated ~45 degrees"
}"""


# ── Pass 2: room location with CoT context ───────────────────────────────────

PASS_2_PROMPT = """You are locating rooms in a floor plan image.

CONTEXT FROM ANALYSIS:
- Floor plan orientation: {orientation}
- Apartment: {apartment_name}
- Visible labels: {visible_labels}
- Visible fixtures: {visible_fixtures}
- Notes: {floor_plan_notes}

YOUR TASK:
Using the context above, locate EACH room and return its exact polygon shape.

COORDINATE GRID SYSTEM:
We have overlaid a coordinate grid on the image. The grid lines represent percentages from 0 to 100, which correspond directly to decimal coordinates from 0.0 to 1.0 (e.g., line 10 is 0.10, line 50 is 0.50, line 90 is 0.90).
Use these grid lines to visually read and trace the coordinates of the wall corners and intersections extremely accurately!

CHAIN OF THOUGHT — for each room:
1. "Where is [room_name]? I can see [label/fixture] at approximately [location]"
2. "The walls of this room are at [angles] because the floor plan is [orientation]"
3. "Using the overlaid grid lines, the corners are at: corner1 (x1, y1), corner2 (x2, y2)..."
4. "Traced clockwise, this forms a [shape_type] shape with vertices: ..."

SHAPE RULES:
- If a room is a simple box/rectangle, use "rectangle" (or "rotated" if diagonal/miring).
- If a room has alcoves, recesses, L-shape, or is many-sided/non-rectangular, use "polygon" and trace all of its corners clockwise (yielding 5 to 16 points), even if the walls are horizontal and vertical.

POLYGON ACCURACY:
- Trace actual wall intersections/corners using the grid coordinate lines
- For diagonal rooms: follow actual wall angles (not horizontal/vertical)
- Points in clockwise order starting from top-left corner
- All values 0.0 to 1.0 (fraction of full image width/height)
- 4–16 points per room

Return ONLY valid JSON array, no markdown:
[
  {{
    "room_name": "Bathroom",
    "reasoning": "BATH label visible top-left, surrounded by 4 diagonal walls",
    "is_balcony": false,
    "shape_type": "rotated",
    "polygon_points": [
      {{"x": 0.12, "y": 0.08}},
      {{"x": 0.28, "y": 0.06}},
      {{"x": 0.29, "y": 0.22}},
      {{"x": 0.13, "y": 0.24}}
    ],
    "bbox": {{"x": 0.12, "y": 0.06, "w": 0.17, "h": 0.18}},
    "confidence": 0.92,
    "actual_label": "BATH"
  }}
]"""


# ── Locate-rooms prompt with CoT ─────────────────────────────────────────────

LOCATE_PROMPT_TEMPLATE = """You are finding specific rooms in a floor plan.

CONTEXT:
- Floor plan orientation: {orientation}
- Rooms to find: {rooms_to_find}
- Already located (do NOT re-locate): {known_rooms_text}
{cv_context}

COORDINATE GRID SYSTEM:
We have overlaid a coordinate grid on the image. The grid lines represent percentages from 0 to 100, which correspond directly to decimal coordinates from 0.0 to 1.0 (e.g., line 10 is 0.10, line 50 is 0.50, line 90 is 0.90).
Use these grid lines to visually read and trace the coordinates of the wall corners and intersections extremely accurately!

CHAIN OF THOUGHT APPROACH:
For each room in rooms_to_find, think step by step:

Step 1: "Where would [room_name] typically be in this floor plan?"
Step 2: "I can see [label/fixture] that confirms this is [room_name]"
Step 3: "Using the overlaid grid lines, the corners of the walls are at: ..."
Step 4: "This room's shape is [rectangle/rotated/polygon] because [reason]"
Step 5: "Tracing walls clockwise: [list of polygon points]"

SHAPE RULES:
- If a room is a simple box/rectangle, use "rectangle" (or "rotated" if diagonal/miring).
- If a room has alcoves, recesses, L-shape, or is many-sided/non-rectangular, use "polygon" and trace all of its corners clockwise (yielding 5 to 16 points), even if the walls are horizontal and vertical.

RETURN for each room in rooms_to_find:
[
  {{
    "room_name": "Bathroom",
    "reasoning": "BATH label at top-left, diagonal walls at ~45 degrees",
    "shape_type": "rotated",
    "polygon_points": [{{"x": 0.12, "y": 0.08}}, ...],
    "bbox": {{"x": 0.12, "y": 0.06, "w": 0.17, "h": 0.18}},
    "confidence": 0.92,
    "is_balcony": false
  }}
]

RULES:
- Return EVERY room in rooms_to_find (no skipping)
- Use chain of thought reasoning for accuracy
- For diagonal floor plans: polygon_points MUST follow diagonal wall angles
- confidence >= 0.75 for visually confirmed, 0.4-0.74 for inferred
"""


# ── Image helpers ─────────────────────────────────────────────────────────────

def _load_image_base64(image_path: str) -> tuple[str, str]:
    """Return (base64_data, media_type)."""
    ext = os.path.splitext(image_path)[1].lower()
    media_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
    media_type = media_map.get(ext, "image/jpeg")
    with open(image_path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return data, media_type


def _create_grid_image(image_path: str) -> str:
    """Create a temporary grid-overlaid image for vision models to read coordinates accurately."""
    try:
        import cv2
        import numpy as np

        img = cv2.imread(image_path)
        if img is None:
            return image_path

        h, w, c = img.shape
        overlay = img.copy()

        # Draw vertical lines
        for x_pct in range(5, 100, 5):
            x = int(x_pct * w / 100)
            is_major = (x_pct % 10 == 0)
            color = (220, 200, 200) if not is_major else (180, 120, 120)  # Light blue/grey lines in BGR
            thickness = 1 if not is_major else 2
            cv2.line(overlay, (x, 0), (x, h), color, thickness)

        # Draw horizontal lines
        for y_pct in range(5, 100, 5):
            y = int(y_pct * h / 100)
            is_major = (y_pct % 10 == 0)
            color = (220, 200, 200) if not is_major else (180, 120, 120)
            thickness = 1 if not is_major else 2
            cv2.line(overlay, (0, y), (w, y), color, thickness)

        # Apply overlay with transparency (alpha=0.5)
        grid_img = img.copy()
        cv2.addWeighted(overlay, 0.5, grid_img, 0.5, 0, grid_img)

        # Add labels
        for x_pct in range(10, 100, 10):
            x = int(x_pct * w / 100)
            cv2.putText(grid_img, str(x_pct), (x - 8, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (80, 50, 50), 1, cv2.LINE_AA)
            cv2.putText(grid_img, str(x_pct), (x - 8, h - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (80, 50, 50), 1, cv2.LINE_AA)

        for y_pct in range(10, 100, 10):
            y = int(y_pct * h / 100)
            cv2.putText(grid_img, str(y_pct), (5, y + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (80, 50, 50), 1, cv2.LINE_AA)
            cv2.putText(grid_img, str(y_pct), (w - 25, y + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (80, 50, 50), 1, cv2.LINE_AA)

        dir_name = os.path.dirname(image_path)
        base_name = os.path.basename(image_path)
        name, ext = os.path.splitext(base_name)
        grid_path = os.path.join(dir_name, f"{name}_grid{ext}")
        cv2.imwrite(grid_path, grid_img)
        return grid_path
    except Exception as e:
        print(f"[Grid] Failed to generate grid image: {e} — using original")
        return image_path


def detect_floor_plan_boundary(image_path: str) -> dict:
    """Detect the bounding box of the actual floor plan within the full image."""
    from PIL import Image
    import numpy as np
    img = Image.open(image_path).convert("RGB")
    data = np.array(img, dtype=np.float32)
    h, w = data.shape[:2]
    gray = np.mean(data, axis=2)
    dy = np.abs(np.diff(gray, axis=0, prepend=gray[:1]))
    dx = np.abs(np.diff(gray, axis=1, prepend=gray[:, :1]))
    gradient = dy + dx
    adaptive_threshold = np.percentile(gradient, 85)
    content = gradient > max(adaptive_threshold * 0.3, 5)
    row_density = np.mean(content, axis=1)
    col_density = np.mean(content, axis=0)
    content_rows = np.where(row_density > 0.005)[0]
    content_cols = np.where(col_density > 0.005)[0]
    if len(content_rows) < 5 or len(content_cols) < 5:
        return {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    rmin = int(np.percentile(content_rows, 2))
    rmax = int(np.percentile(content_rows, 98))
    cmin = int(np.percentile(content_cols, 2))
    cmax = int(np.percentile(content_cols, 98))
    pad = 0.01
    return {
        "x": max(0.0, float(cmin) / w - pad),
        "y": max(0.0, float(rmin) / h - pad),
        "w": min(1.0, float(cmax - cmin) / w + pad * 2),
        "h": min(1.0, float(rmax - rmin) / h + pad * 2),
    }


def normalize_bbox_to_boundary(bbox: dict, boundary: dict) -> dict:
    """Re-express a full-image bbox as coordinates relative to the floor plan boundary."""
    bx, by, bw, bh = boundary["x"], boundary["y"], boundary["w"], boundary["h"]
    if bw <= 0 or bh <= 0:
        return bbox
    rel_x = max(0.02, min(0.95, (bbox["x"] - bx) / bw))
    rel_y = max(0.02, min(0.95, (bbox["y"] - by) / bh))
    rel_w = max(0.05, min(1.0 - rel_x - 0.02, bbox["w"] / bw))
    rel_h = max(0.05, min(1.0 - rel_y - 0.02, bbox["h"] / bh))
    return {"x": rel_x, "y": rel_y, "w": rel_w, "h": rel_h}


def bbox_to_polygon(bbox: dict) -> list:
    x, y, w, h = bbox["x"], bbox["y"], bbox["w"], bbox["h"]
    return [
        {"x": x,     "y": y},
        {"x": x + w, "y": y},
        {"x": x + w, "y": y + h},
        {"x": x,     "y": y + h},
    ]


def _parse_json_response(text: str) -> Union[dict, list]:
    """Extract JSON from response, handling markdown code blocks."""
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"(\[[\s\S]+?\]|\{[\s\S]+\})", text)
        if match:
            return json.loads(match.group(0))
        raise


# ── Room normalisation + CV enhancement ──────────────────────────────────────

def _process_rooms(rooms_raw: list, image_path: str, orientation: str = "axis-aligned") -> list:
    """Normalise raw room list from AI and apply CV polygon enhancement.

    CV is only applied for axis-aligned floor plans. For diagonal/mixed plans,
    Pass 2 chain-of-thought polygons follow actual wall angles and are more
    accurate than CV contours which are derived from orthogonal edge detection.
    """
    normalised = []
    for r in rooms_raw:
        bbox = r.get("bbox") or {}
        polygon_points = r.get("polygon_points") or []
        
        # Auto-calculate bbox from polygon_points if missing or empty
        if (not bbox or float(bbox.get("w", 0)) == 0) and polygon_points:
            xs = [pt["x"] for pt in polygon_points if "x" in pt]
            ys = [pt["y"] for pt in polygon_points if "y" in pt]
            if xs and ys:
                min_x, max_x = min(xs), max(xs)
                min_y, max_y = min(ys), max(ys)
                bbox = {
                    "x": min_x,
                    "y": min_y,
                    "w": max_x - min_x,
                    "h": max_y - min_y,
                }
                
        room_bbox = {
            "x": float(bbox.get("x", 0.0)),
            "y": float(bbox.get("y", 0.0)),
            "w": float(bbox.get("w", 0.0)),
            "h": float(bbox.get("h", 0.0)),
        }
        if not polygon_points and room_bbox.get("w", 0) > 0:
            polygon_points = bbox_to_polygon(room_bbox)
        normalised.append({
            "room_name": r.get("room_name", "Unknown"),
            "is_balcony": bool(r.get("is_balcony", False)),
            "confidence": float(r.get("confidence", 0.5)),
            "bbox": room_bbox,
            "shape_type": r.get("shape_type", "rectangle"),
            "polygon_points": polygon_points,
            "reasoning": r.get("reasoning", ""),
        })


    if orientation != "axis-aligned":
        print(f"[Watershed] Skipped because orientation is '{orientation}'. Keeping AI-detected polygons.")
        return normalised

    # Build seed centroids from GPT rooms for watershed
    seed_centroids = []
    for room in normalised:
        bbox = room.get("bbox") or {}
        existing_pts = room.get("polygon_points") or []
        if bbox and bbox.get("w", 0) > 0:
            cx = bbox["x"] + bbox["w"] / 2
            cy = bbox["y"] + bbox["h"] / 2
        elif existing_pts:
            cx = sum(p["x"] for p in existing_pts) / len(existing_pts)
            cy = sum(p["y"] for p in existing_pts) / len(existing_pts)
        else:
            continue
        seed_centroids.append({
            "room_name": room.get("room_name", ""),
            "x": cx,
            "y": cy,
            "confidence": room.get("confidence", 0.9),
            "bbox": bbox,
            "polygon_points": existing_pts,
            "shape_type": room.get("shape_type", "rectangle"),
            "is_balcony": room.get("is_balcony", False),
        })

    try:
        from app.services.wall_detection_service import detect_rooms_watershed
        watershed_results = detect_rooms_watershed(image_path, seed_centroids)

        if watershed_results:
            name_to_ws = {r["room_name"]: r for r in watershed_results}
            enhanced = []
            ws_count = 0
            for room in normalised:
                name = room.get("room_name", "")
                ws = name_to_ws.get(name)
                # If AI detected a complex many-sided polygon (len > 4 or shape_type is polygon),
                # keep the AI's detailed tracing instead of overriding with watershed.
                is_complex_ai_polygon = room.get("shape_type") == "polygon" or len(room.get("polygon_points", [])) > 4
                
                if ws and not is_complex_ai_polygon:
                    r = dict(room)
                    r["polygon_points"] = ws["polygon_points"]
                    r["bbox"] = ws["bbox"]
                    r["shape_type"] = ws["shape_type"]
                    if ws.get("source") != "ai_fallback":
                        ws_count += 1
                    enhanced.append(r)
                else:
                    enhanced.append(room)
            normalised = enhanced
            print(f"[Watershed] {ws_count} rooms improved by watershed, "
                  f"{len(watershed_results) - ws_count} kept AI polygon")
    except Exception as e:
        print(f"[Watershed] failed: {e} — keeping AI polygons")

    return normalised


class ImageRotator:
    def __init__(self, image_path: str):
        self.original_path = image_path
        self.temp_path = None
        self.angle = 0.0
        self.M_inv = None
        self.orig_w = 0
        self.orig_h = 0
        self.new_w = 0
        self.new_h = 0
        
        # Disabled rotation to prevent coordinate mapping shift and mixed-orientation issues
        return

    @property
    def active_path(self) -> str:
        return self.temp_path if self.temp_path else self.original_path

    @property
    def is_rotated(self) -> bool:
        return self.temp_path is not None

    def inverse_transform_point(self, fx: float, fy: float) -> tuple[float, float]:
        if not self.is_rotated:
            return fx, fy
        # Convert from fraction to pixel coordinates on rotated image
        rx, ry = fx * self.new_w, fy * self.new_h
        # Apply inverse rotation matrix
        ox = self.M_inv[0, 0] * rx + self.M_inv[0, 1] * ry + self.M_inv[0, 2]
        oy = self.M_inv[1, 0] * rx + self.M_inv[1, 1] * ry + self.M_inv[1, 2]
        # Convert back to fraction on original image size
        return round(max(0.0, min(1.0, ox / self.orig_w)), 4), round(max(0.0, min(1.0, oy / self.orig_h)), 4)

    def inverse_transform_polygon(self, points: list) -> list:
        if not self.is_rotated or not points:
            return points
        transformed = []
        for pt in points:
            x, y = self.inverse_transform_point(pt["x"], pt["y"])
            transformed.append({"x": x, "y": y})
        return transformed

    def inverse_transform_bbox(self, bbox: dict) -> dict:
        if not self.is_rotated or not bbox:
            return bbox
        # Map four corners of bbox
        x, y, w, h = bbox["x"], bbox["y"], bbox["w"], bbox["h"]
        corners = [
            (x, y), (x + w, y),
            (x + w, y + h), (x, y + h)
        ]
        tpts = [self.inverse_transform_point(cx, cy) for cx, cy in corners]
        xs = [p[0] for p in tpts]
        ys = [p[1] for p in tpts]
        return {
            "x": round(min(xs), 4),
            "y": round(min(ys), 4),
            "w": round(max(xs) - min(xs), 4),
            "h": round(max(ys) - min(ys), 4),
        }

    def cleanup(self):
        if self.temp_path and os.path.exists(self.temp_path):
            try:
                os.remove(self.temp_path)
                print(f"[Rotator] Cleaned up temporary rotated image at {self.temp_path}")
            except Exception as e:
                print(f"[Rotator] Cleanup error: {e}")


# ── Main detection functions ──────────────────────────────────────────────────

async def detect_floor_plan(image_path: str) -> dict:
    """
    Two-pass floor plan detection.
    Pass 1: structural analysis (orientation, labels, fixtures).
    Pass 2: room location with chain-of-thought context from Pass 1.
    """
    print(f"[OpenAI] Analysing image: {os.path.basename(image_path)}")
    
    rotator = ImageRotator(image_path)
    grid_path = None
    try:
        active_path = rotator.active_path
        b64_data, media_type = _load_image_base64(active_path)

        def _image_message(b64: str, mt: str) -> dict:
            return {
                "type": "image_url",
                "image_url": {"url": f"data:{mt};base64,{b64}", "detail": "high"},
            }

        # ── Pass 1: understand structure ─────────────────────────────────────────
        print("[OpenAI] Pass 1: Analyzing floor plan structure...")
        pass1_text = await _create_completion(
            messages=[{"role": "user", "content": [
                _image_message(b64_data, media_type),
                {"type": "text", "text": PASS_1_PROMPT},
            ]}],
            max_tokens=800,
        )
        if DEBUG:
            print(f"[OpenAI] Pass 1 raw: {pass1_text[:400]}")

        pass1: dict = {}
        try:
            pass1 = _parse_json_response(pass1_text)
        except Exception as e:
            print(f"[OpenAI] Pass 1 parse failed: {e} - using defaults")
            pass1 = {
                "is_floor_plan": True, "orientation": "axis-aligned",
                "apartment_name": "", "visible_labels": [],
                "visible_fixtures": {}, "floor_plan_notes": "",
            }

        print(
            f"[OpenAI] Pass 1: is_fp={pass1.get('is_floor_plan')} "
            f"orientation={pass1.get('orientation')} "
            f"rooms~{pass1.get('estimated_room_count')}"
        )

        # Reject non-floor-plans without running Pass 2
        if not pass1.get("is_floor_plan", True):
            return {
                "is_floor_plan": False, "confidence": 0.0, "apartment_name": None,
                "rooms": [], "floor_plan_boundary": detect_floor_plan_boundary(image_path),
                "floor_plan_orientation": "unknown",
            }

        # ── Pass 2: locate rooms with context ────────────────────────────────────
        print("[OpenAI] Pass 2: Locating rooms with context...")
        pass2_prompt = PASS_2_PROMPT.format(
            orientation=pass1.get("orientation", "axis-aligned"),
            apartment_name=pass1.get("apartment_name", ""),
            visible_labels=pass1.get("visible_labels", []),
            visible_fixtures=pass1.get("visible_fixtures", {}),
            floor_plan_notes=pass1.get("floor_plan_notes", ""),
        )

        # Generate temporary grid image for Pass 2 to improve coordinate precision
        grid_path = _create_grid_image(active_path)
        b64_grid_data, grid_media_type = _load_image_base64(grid_path)

        pass2_text = await _create_completion(
            messages=[{"role": "user", "content": [
                _image_message(b64_grid_data, grid_media_type),
                {"type": "text", "text": pass2_prompt},
            ]}],
            max_tokens=3000,
        )
        if DEBUG:
            print(f"[OpenAI] Pass 2 raw: {pass2_text[:600]}")

        rooms_raw = _parse_json_response(pass2_text)
        if isinstance(rooms_raw, dict):
            rooms_raw = rooms_raw.get("rooms", [])
        if not isinstance(rooms_raw, list):
            rooms_raw = []

        orientation_for_cv = "axis-aligned" if rotator.is_rotated else pass1.get("orientation", "axis-aligned")
        rooms = _process_rooms(rooms_raw, active_path, orientation=orientation_for_cv)
        
        if rotator.is_rotated:
            print(f"[Rotator] Mapping {len(rooms)} rooms back to original diagonal coordinates...")
            for room in rooms:
                room["polygon_points"] = rotator.inverse_transform_polygon(room.get("polygon_points"))
                if room.get("bbox"):
                    room["bbox"] = rotator.inverse_transform_bbox(room["bbox"])
        
        confidence = round(sum(r["confidence"] for r in rooms) / len(rooms), 4) if rooms else 0.0

        return {
            "is_floor_plan": True,
            "confidence": confidence,
            "apartment_name": pass1.get("apartment_name") or None,
            "rooms": rooms,
            "floor_plan_boundary": detect_floor_plan_boundary(image_path),
            "floor_plan_orientation": "diagonal" if rotator.is_rotated else pass1.get("orientation", "axis-aligned"),
        }
    finally:
        rotator.cleanup()
        if grid_path and os.path.exists(grid_path) and grid_path != image_path:
            try:
                os.remove(grid_path)
                print(f"[Grid] Cleaned up temporary grid image at {grid_path}")
            except Exception as e:
                print(f"[Grid] Cleanup error: {e}")


async def locate_rooms(
    image_path: str,
    rooms: list,
    known_rooms: Optional[list] = None,
    orientation: str = "axis-aligned",
) -> list:
    """
    Given an image path and a list of rooms, ask the model to find each room's
    bounding box and polygon using chain-of-thought reasoning.
    """
    if known_rooms is None:
        known_rooms = []

    print(f"[OpenAI] Locating {len(rooms)} rooms in: {os.path.basename(image_path)}")

    rotator = ImageRotator(image_path)
    grid_path = None
    try:
        active_path = rotator.active_path

        rooms_str = ", ".join(r["room_name"] for r in rooms)
        known_str = ", ".join(r["room_name"] for r in known_rooms) if known_rooms else "none"

        # CV spatial hints
        cv_context = ""
        try:
            from app.services.wall_detection_service import detect_closed_areas
            # Run closed area detection on the active (possibly rotated/straightened) image
            cv_result = detect_closed_areas(active_path)
            if cv_result.get("regions"):
                hints = [
                    f"  Region {i+1}: centroid ({r['centroid']['x']:.2f},{r['centroid']['y']:.2f}) "
                    f"area={r['area_fraction']*100:.1f}%"
                    for i, r in enumerate(cv_result["regions"][:12])
                ]
                cv_context = "CV-detected room regions (use to verify positions):\n" + "\n".join(hints)
        except Exception:
            pass

        orientation_for_ai = "axis-aligned" if rotator.is_rotated else orientation
        prompt = LOCATE_PROMPT_TEMPLATE.format(
            orientation=orientation_for_ai,
            rooms_to_find=rooms_str,
            known_rooms_text=known_str,
            cv_context=cv_context,
        )

        # Generate temporary grid image to improve coordinate precision
        grid_path = _create_grid_image(active_path)
        b64_grid_data, grid_media_type = _load_image_base64(grid_path)

        raw = await _create_completion(
            messages=[{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:{grid_media_type};base64,{b64_grid_data}", "detail": "high"}},
                {"type": "text", "text": prompt},
            ]}],
            max_tokens=2500,
        )
        if DEBUG:
            print(f"[OpenAI] locate_rooms raw: {raw[:500]}")

        result = _parse_json_response(raw)
        if isinstance(result, list):
            raw_rooms = result
        elif isinstance(result, dict):
            raw_rooms = result.get("rooms") or []
        else:
            raw_rooms = []

        room_map = {r["room_name"]: r for r in rooms}
        normalised = []
        for r in raw_rooms:
            bbox = r.get("bbox") or {}
            polygon_points = r.get("polygon_points") or []
            
            # Auto-calculate bbox from polygon_points if missing or empty
            if (not bbox or float(bbox.get("w", 0)) == 0) and polygon_points:
                xs = [pt["x"] for pt in polygon_points if "x" in pt]
                ys = [pt["y"] for pt in polygon_points if "y" in pt]
                if xs and ys:
                    min_x, max_x = min(xs), max(xs)
                    min_y, max_y = min(ys), max(ys)
                    bbox = {
                        "x": min_x,
                        "y": min_y,
                        "w": max_x - min_x,
                        "h": max_y - min_y,
                    }
                    
            original = room_map.get(r.get("room_name", ""), {})
            conf = float(r.get("confidence", 0.0))
            has_good_bbox = conf >= 0.6 and float(bbox.get("w", 0)) >= 0.02
            room_bbox = {
                "x": float(bbox.get("x", 0.0)),
                "y": float(bbox.get("y", 0.0)),
                "w": float(bbox.get("w", 0.0)),
                "h": float(bbox.get("h", 0.0)),
            } if has_good_bbox else None
            if not polygon_points and room_bbox:
                polygon_points = bbox_to_polygon(room_bbox)
            normalised.append({
                "room_name": r.get("room_name", "Unknown"),
                "is_balcony": bool(original.get("is_balcony", False)),
                "found": has_good_bbox,
                "confidence": conf,
                "bbox": room_bbox,
                "shape_type": r.get("shape_type", "rectangle"),
                "polygon_points": polygon_points,
                "reasoning": r.get("reasoning", ""),
            })

        if rotator.is_rotated:
            print(f"[Rotator] Mapping {len(normalised)} rooms back to original diagonal coordinates...")
            for room in normalised:
                room["polygon_points"] = rotator.inverse_transform_polygon(room.get("polygon_points"))
                if room.get("bbox"):
                    room["bbox"] = rotator.inverse_transform_bbox(room["bbox"])

        return normalised
    finally:
        rotator.cleanup()
        if grid_path and os.path.exists(grid_path) and grid_path != image_path:
            try:
                os.remove(grid_path)
                print(f"[Grid] Cleaned up temporary grid image at {grid_path}")
            except Exception as e:
                print(f"[Grid] Cleanup error: {e}")
