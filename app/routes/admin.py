import csv
import io
import uuid
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.db.database import get_db
from app.db.models import User, Apartment, FloorPlan, Room
from app.middleware.auth import hash_password, get_current_admin
from app.services.monitoring_service import get_system_metrics, format_weekly_report
from app.services.telegram import send_alert

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------- Pydantic schemas ----------

class UserResponse(BaseModel):
    id: str
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool
    created_at: datetime
    last_login: Optional[datetime]

    class Config:
        from_attributes = True


class CreateUserRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    role: str = "agent"


class UpdateUserRequest(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None


class AdminResetPasswordRequest(BaseModel):
    new_password: str


class MessageResponse(BaseModel):
    message: str


class AdminStatsResponse(BaseModel):
    total_users: int
    total_apartments: int
    total_floor_plans: int
    active_users: int
    floor_plans_this_month: int


class AIMetricsResponse(BaseModel):
    avg_confidence_score: Optional[float] = None
    total_floor_plans: int = 0
    edited_count: int = 0
    unedited_count: int = 0
    edit_rate_percent: float = 0.0
    flagged_count: int = 0
    avg_internal_m2: Optional[float] = None
    avg_balcony_m2: Optional[float] = None


class AgentProductivityItem(BaseModel):
    user_id: str
    email: str
    full_name: Optional[str] = None
    role: str
    is_active: bool
    floor_plans_uploaded: int = 0
    floor_plans_edited: int = 0
    last_login: Optional[datetime] = None


class RecentActivityItem(BaseModel):
    floor_plan_id: str
    apartment_id: str
    apartment_name: str
    version: int
    uploaded_at: datetime
    uploaded_by_email: Optional[str] = None
    uploaded_by_name: Optional[str] = None
    total_internal_m2: Optional[float] = None
    total_balcony_m2: Optional[float] = None
    was_edited: bool = False
    ai_confidence_score: Optional[float] = None


class MonthlyTrendItem(BaseModel):
    month: str
    count: int


class AdminReportsSummaryResponse(BaseModel):
    stats: AdminStatsResponse
    ai_metrics: AIMetricsResponse
    agent_productivity: List[AgentProductivityItem]
    recent_activity: List[RecentActivityItem]
    monthly_trend: List[MonthlyTrendItem]
    total_rooms: int


# ---------- Routes ----------

@router.get("/stats", response_model=AdminStatsResponse)
async def get_stats(
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    total_users = db.execute(select(func.count()).select_from(User)).scalar() or 0
    total_apartments = db.execute(
        select(func.count()).select_from(Apartment).where(Apartment.is_active == True)
    ).scalar() or 0
    total_floor_plans = db.execute(select(func.count()).select_from(FloorPlan)).scalar() or 0
    active_users = db.execute(
        select(func.count()).select_from(User).where(User.is_active == True)
    ).scalar() or 0
    start_of_month = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    floor_plans_this_month = db.execute(
        select(func.count()).select_from(FloorPlan).where(FloorPlan.uploaded_at >= start_of_month)
    ).scalar() or 0
    return AdminStatsResponse(
        total_users=total_users,
        total_apartments=total_apartments,
        total_floor_plans=total_floor_plans,
        active_users=active_users,
        floor_plans_this_month=floor_plans_this_month,
    )

@router.get("/users", response_model=List[UserResponse])
async def list_users(
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    users = db.execute(select(User).order_by(User.created_at.desc())).scalars().all()
    return [
        UserResponse(
            id=str(u.id),
            email=u.email,
            full_name=u.full_name,
            role=u.role,
            is_active=u.is_active,
            created_at=u.created_at,
            last_login=u.last_login,
        )
        for u in users
    ]


@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: CreateUserRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    if db.execute(select(User).where(User.email == body.email.lower().strip())).scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")

    if body.role not in ("admin", "agent"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be 'admin' or 'agent'")

    if len(body.password) < 6:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 6 characters")

    user = User(
        id=uuid.uuid4(),
        email=body.email.lower().strip(),
        password_hash=hash_password(body.password),
        full_name=body.full_name,
        role=body.role,
        is_active=True,
        created_at=datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    print(f"[Admin] Created user: {user.email} (role={user.role})")

    return UserResponse(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
        last_login=user.last_login,
    )


@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    body: UpdateUserRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if body.full_name is not None:
        user.full_name = body.full_name
    if body.role is not None:
        if body.role not in ("admin", "agent"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be 'admin' or 'agent'")
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active

    db.commit()
    db.refresh(user)

    print(f"[Admin] Updated user: {user.email}")
    return UserResponse(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
        last_login=user.last_login,
    )


@router.delete("/users/{user_id}", response_model=MessageResponse)
async def deactivate_user(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if str(user.id) == str(admin.id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot deactivate yourself")

    user.is_active = False
    db.commit()

    print(f"[Admin] Deactivated user: {user.email}")
    return MessageResponse(message=f"User {user.email} deactivated")


@router.post("/users/{user_id}/reset-password", response_model=MessageResponse)
async def admin_reset_password(
    user_id: str,
    body: AdminResetPasswordRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if len(body.new_password) < 6:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 6 characters")

    user.password_hash = hash_password(body.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()

    print(f"[Admin] Force reset password for: {user.email}")
    return MessageResponse(message=f"Password reset for {user.email}")


@router.get("/server-monitoring/status")
async def get_server_monitoring_status(
    _admin: User = Depends(get_current_admin),
):
    try:
        metrics = await get_system_metrics()
        return metrics
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to gather system metrics: {exc}"
        )


@router.post("/server-monitoring/trigger", response_model=MessageResponse)
async def trigger_server_monitoring_report(
    _admin: User = Depends(get_current_admin),
):
    try:
        metrics = await get_system_metrics()
        report = format_weekly_report(metrics)
        await send_alert(report)
        return MessageResponse(message="Weekly server monitoring report triggered and sent successfully.")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to send weekly report: {exc}"
        )


@router.get("/reports/summary", response_model=AdminReportsSummaryResponse)
async def get_reports_summary(
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    total_users = db.execute(select(func.count()).select_from(User)).scalar() or 0
    total_apartments = db.execute(
        select(func.count()).select_from(Apartment).where(Apartment.is_active == True)
    ).scalar() or 0
    total_floor_plans = db.execute(select(func.count()).select_from(FloorPlan)).scalar() or 0
    active_users = db.execute(
        select(func.count()).select_from(User).where(User.is_active == True)
    ).scalar() or 0
    start_of_month = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    floor_plans_this_month = db.execute(
        select(func.count()).select_from(FloorPlan).where(FloorPlan.uploaded_at >= start_of_month)
    ).scalar() or 0
    total_rooms = db.execute(select(func.count()).select_from(Room)).scalar() or 0

    # AI Metrics
    avg_conf = db.execute(
        select(func.avg(FloorPlan.ai_confidence_score)).where(FloorPlan.ai_confidence_score.isnot(None))
    ).scalar()
    avg_confidence_score = round(float(avg_conf), 4) if avg_conf is not None else None

    edited_count = db.execute(
        select(func.count()).select_from(FloorPlan).where(FloorPlan.was_edited == True)
    ).scalar() or 0
    unedited_count = db.execute(
        select(func.count()).select_from(FloorPlan).where(FloorPlan.was_edited == False)
    ).scalar() or 0
    edit_rate_percent = round((edited_count / total_floor_plans * 100), 1) if total_floor_plans > 0 else 0.0

    flagged_count = db.execute(
        select(func.count()).select_from(FloorPlan).where(FloorPlan.flags_triggered.isnot(None))
    ).scalar() or 0

    avg_internal = db.execute(
        select(func.avg(FloorPlan.total_internal_m2)).where(
            FloorPlan.total_internal_m2.isnot(None), FloorPlan.total_internal_m2 > 0
        )
    ).scalar()
    avg_internal_m2 = round(float(avg_internal), 2) if avg_internal is not None else None

    avg_balc = db.execute(
        select(func.avg(FloorPlan.total_balcony_m2)).where(
            FloorPlan.total_balcony_m2.isnot(None), FloorPlan.total_balcony_m2 > 0
        )
    ).scalar()
    avg_balcony_m2 = round(float(avg_balc), 2) if avg_balc is not None else None

    # Agent Productivity
    users = db.execute(select(User).order_by(User.created_at.asc())).scalars().all()
    agent_productivity = []
    for u in users:
        up_count = db.execute(
            select(func.count()).select_from(FloorPlan).where(FloorPlan.uploaded_by == u.id)
        ).scalar() or 0
        ed_count = db.execute(
            select(func.count()).select_from(FloorPlan).where(FloorPlan.updated_by == u.id)
        ).scalar() or 0
        agent_productivity.append(
            AgentProductivityItem(
                user_id=str(u.id),
                email=u.email,
                full_name=u.full_name,
                role=u.role,
                is_active=u.is_active,
                floor_plans_uploaded=up_count,
                floor_plans_edited=ed_count,
                last_login=u.last_login,
            )
        )
    agent_productivity.sort(key=lambda a: a.floor_plans_uploaded, reverse=True)

    # Recent Activity (Top 10)
    recent_rows = db.execute(
        select(FloorPlan, Apartment, User)
        .join(Apartment, FloorPlan.apartment_id == Apartment.id)
        .outerjoin(User, FloorPlan.uploaded_by == User.id)
        .order_by(FloorPlan.uploaded_at.desc())
        .limit(10)
    ).all()
    recent_activity = [
        RecentActivityItem(
            floor_plan_id=str(fp.id),
            apartment_id=str(apt.id),
            apartment_name=apt.name,
            version=fp.version,
            uploaded_at=fp.uploaded_at,
            uploaded_by_email=usr.email if usr else None,
            uploaded_by_name=usr.full_name if usr else None,
            total_internal_m2=float(fp.total_internal_m2) if fp.total_internal_m2 is not None else None,
            total_balcony_m2=float(fp.total_balcony_m2) if fp.total_balcony_m2 is not None else None,
            was_edited=fp.was_edited,
            ai_confidence_score=float(fp.ai_confidence_score) if fp.ai_confidence_score is not None else None,
        )
        for fp, apt, usr in recent_rows
    ]

    # Monthly Trend (Last 6 Months)
    fps_dates = db.execute(select(FloorPlan.uploaded_at)).scalars().all()
    month_map = {}
    for dt in fps_dates:
        if dt:
            k = dt.strftime("%Y-%m")
            month_map[k] = month_map.get(k, 0) + 1
    sorted_months = sorted(month_map.items())
    monthly_trend = [MonthlyTrendItem(month=k, count=v) for k, v in sorted_months[-6:]] if sorted_months else []

    return AdminReportsSummaryResponse(
        stats=AdminStatsResponse(
            total_users=total_users,
            total_apartments=total_apartments,
            total_floor_plans=total_floor_plans,
            active_users=active_users,
            floor_plans_this_month=floor_plans_this_month,
        ),
        ai_metrics=AIMetricsResponse(
            avg_confidence_score=avg_confidence_score,
            total_floor_plans=total_floor_plans,
            edited_count=edited_count,
            unedited_count=unedited_count,
            edit_rate_percent=edit_rate_percent,
            flagged_count=flagged_count,
            avg_internal_m2=avg_internal_m2,
            avg_balcony_m2=avg_balcony_m2,
        ),
        agent_productivity=agent_productivity,
        recent_activity=recent_activity,
        monthly_trend=monthly_trend,
        total_rooms=total_rooms,
    )


@router.get("/reports/export-csv")
async def export_reports_csv(
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    rows = db.execute(
        select(FloorPlan, Apartment, User)
        .join(Apartment, FloorPlan.apartment_id == Apartment.id)
        .outerjoin(User, FloorPlan.uploaded_by == User.id)
        .order_by(Apartment.name.asc(), FloorPlan.version.asc())
    ).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Apartment Name",
        "Address",
        "Version",
        "Is Latest",
        "Uploaded At",
        "Uploaded By",
        "Internal m2",
        "Balcony m2",
        "Total m2",
        "Was Edited",
        "AI Confidence Score",
        "Flags Triggered"
    ])

    for fp, apt, usr in rows:
        int_m2 = float(fp.total_internal_m2) if fp.total_internal_m2 is not None else 0.0
        balc_m2 = float(fp.total_balcony_m2) if fp.total_balcony_m2 is not None else 0.0
        tot_m2 = round(int_m2 + balc_m2, 2)
        flags = str(fp.flags_triggered) if fp.flags_triggered else "None"

        writer.writerow([
            apt.name,
            apt.address or "",
            fp.version,
            "Yes" if fp.is_latest else "No",
            fp.uploaded_at.strftime("%Y-%m-%d %H:%M:%S") if fp.uploaded_at else "",
            usr.email if usr else "Unknown",
            f"{int_m2:.2f}" if fp.total_internal_m2 is not None else "",
            f"{balc_m2:.2f}" if fp.total_balcony_m2 is not None else "",
            f"{tot_m2:.2f}",
            "Yes" if fp.was_edited else "No",
            f"{float(fp.ai_confidence_score):.4f}" if fp.ai_confidence_score is not None else "",
            flags
        ])

    csv_data = output.getvalue()
    filename = f"apartment_floorplans_report_{datetime.utcnow().strftime('%Y%m%d_%H%M')}.csv"

    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
