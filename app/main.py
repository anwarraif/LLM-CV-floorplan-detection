import os
import traceback
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.db.database import engine, SessionLocal
from app.routes import auth, admin, upload, floorplan
from app.routes.floorplan import apartment_router
from app.services.telegram import send_error_alert

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3003")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
PORT = int(os.getenv("PORT", "8001"))
DEBUG = os.getenv("DEBUG", "false").lower() == "true"


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    print(f"[Startup] Upload directory ready: {UPLOAD_DIR}")
    print(f"[Startup] FloorPlanTool API starting on port {PORT}")
    
    # Start background weekly server resource monitoring scheduler
    import asyncio
    from app.services.monitoring_service import run_monitoring_scheduler
    scheduler_task = asyncio.create_task(run_monitoring_scheduler())
    
    yield
    
    # Cancel scheduler on shutdown
    scheduler_task.cancel()
    try:
        await scheduler_task
    except asyncio.CancelledError:
        pass
        
    engine.dispose()
    print("[Shutdown] Database connections closed")


app = FastAPI(
    title="Floor Plan Measurement Tool",
    version="1.0.0",
    lifespan=lifespan,
)

# Parse FRONTEND_URL as comma-separated origins
FRONTEND_URL_ENV = os.getenv("FRONTEND_URL", "http://localhost:3003")
allow_origins = [url.strip() for url in FRONTEND_URL_ENV.split(",") if url.strip()]
if "http://localhost:3003" not in allow_origins:
    allow_origins.append("http://localhost:3003")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_origin_regex=r"https://.*\.ngrok-free\.app|https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.\d+\.\d+\.\d+)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(upload.router)
app.include_router(floorplan.router)
app.include_router(apartment_router)


# ---------- Global exception handler ----------

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    context = f"{request.method} {request.url.path}"
    if DEBUG:
        tb = traceback.format_exc()
        print(f"[500] Unhandled error on {context}:\n{tb}")
    else:
        print(f"[500] Unhandled error on {context}: {type(exc).__name__}: {exc}")
    try:
        await send_error_alert(error=str(exc), context=context)
    except Exception:
        pass
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


# ---------- Health check ----------

@app.get("/health", tags=["health"])
async def health_check():
    status = {"api": "ok", "database": "unknown", "redis": "unknown"}

    # Check DB (sync)
    try:
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
        status["database"] = "ok"
    except Exception as exc:
        status["database"] = f"error: {exc}"

    # Check Redis
    try:
        redis = aioredis.from_url(REDIS_URL, socket_connect_timeout=2)
        await redis.ping()
        await redis.aclose()
        status["redis"] = "ok"
    except Exception as exc:
        status["redis"] = f"error: {exc}"

    all_ok = all(v == "ok" for v in status.values())
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content=status,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, reload=True)
