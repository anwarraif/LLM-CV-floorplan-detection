import os
from datetime import datetime, timedelta
from typing import Optional

DEBUG = os.getenv("DEBUG", "false").lower() == "true"

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.db.database import get_db
from app.db.models import User
from app.middleware.auth import (
    hash_password,
    verify_password,
    create_access_token,
    generate_otp,
    get_current_user,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

OTP_EXPIRE_MINUTES = 10


# ---------- Pydantic schemas ----------

class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str
    full_name: Optional[str]
    role: str


class ForgotPasswordRequest(BaseModel):
    email: str


class VerifyOTPRequest(BaseModel):
    email: str
    otp: str


class ResetPasswordRequest(BaseModel):
    email: str
    otp: str
    new_password: str


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


class MessageResponse(BaseModel):
    message: str


# ---------- Routes ----------

@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.email == body.email.lower().strip())).scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is inactive")

    user.last_login = datetime.utcnow()
    db.commit()

    token = create_access_token({"sub": str(user.id), "role": user.role})
    print(f"[Auth] Login: {user.email}")

    return TokenResponse(
        access_token=token,
        user_id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        role=user.role,
    )


@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(body: ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.email == body.email.lower().strip())).scalar_one_or_none()

    if not user or not user.is_active:
        return MessageResponse(message="If your email is registered, you will receive an OTP.")

    otp = generate_otp()
    user.reset_token = otp
    user.reset_token_expires = datetime.utcnow() + timedelta(minutes=OTP_EXPIRE_MINUTES)
    db.commit()

    if DEBUG:
        print(f"[Auth] OTP for {user.email}: {otp}")
    else:
        print(f"[Auth] OTP generated for {user.email}")

    return MessageResponse(message="If your email is registered, you will receive an OTP.")


@router.post("/verify-otp", response_model=MessageResponse)
async def verify_otp(body: VerifyOTPRequest, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.email == body.email.lower().strip())).scalar_one_or_none()

    if not user or not user.reset_token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired OTP")

    if user.reset_token_expires and datetime.utcnow() > user.reset_token_expires:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OTP has expired")

    if user.reset_token != body.otp:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OTP")

    return MessageResponse(message="OTP verified successfully")


@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.email == body.email.lower().strip())).scalar_one_or_none()

    if not user or not user.reset_token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired OTP")

    if user.reset_token_expires and datetime.utcnow() > user.reset_token_expires:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OTP has expired")

    if user.reset_token != body.otp:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OTP")

    if len(body.new_password) < 6:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 6 characters")

    user.password_hash = hash_password(body.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()

    print(f"[Auth] Password reset: {user.email}")
    return MessageResponse(message="Password reset successfully")


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    return UserResponse(
        id=str(current_user.id),
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        is_active=current_user.is_active,
        created_at=current_user.created_at,
        last_login=current_user.last_login,
    )
