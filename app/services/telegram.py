import os
import httpx
from datetime import datetime

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
TELEGRAM_API_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"


async def _send(message: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print(f"[Telegram] Skipped (no token/chat): {message}")
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                TELEGRAM_API_URL,
                json={"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "HTML"},
            )
    except Exception as exc:
        print(f"[Telegram] Failed to send message: {exc}")


async def send_alert(message: str) -> None:
    try:
        ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        await _send(f"[FloorPlanTool] {ts}\n{message}")
    except Exception as exc:
        print(f"[Telegram] send_alert error: {exc}")


async def send_error_alert(error: str, context: str = "") -> None:
    try:
        ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        text = f"ERROR {ts}\nContext: {context}\n{error}"
        await _send(text)
    except Exception as exc:
        print(f"[Telegram] send_error_alert error: {exc}")


async def send_success_alert(message: str) -> None:
    try:
        ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        await _send(f"SUCCESS {ts}\n{message}")
    except Exception as exc:
        print(f"[Telegram] send_success_alert error: {exc}")
