import os
import sys
import time
import shutil
import asyncio
import traceback
from datetime import datetime
import psutil
import redis.asyncio as aioredis
from sqlalchemy import text, select, func

from app.db.database import SessionLocal
from app.db.models import User, Apartment, FloorPlan
from app.services.telegram import send_alert


def format_size(bytes_size: float) -> str:
    """Format bytes to human-readable string (e.g. GB, MB)."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"


async def get_system_metrics() -> dict:
    """Collect server resource metrics (CPU, RAM, Disk, DB, Redis)."""
    # CPU usage (non-blocking)
    cpu_percent = psutil.cpu_percent(interval=None)
    
    # RAM usage
    virtual_mem = psutil.virtual_memory()
    ram_total = virtual_mem.total
    ram_used = virtual_mem.used
    ram_free = virtual_mem.available
    ram_percent = virtual_mem.percent
    
    # Disk usage for the upload directory
    upload_dir = os.getenv("UPLOAD_DIR", "./uploads")
    abs_upload_dir = os.path.abspath(upload_dir)
    target_path = abs_upload_dir
    while not os.path.exists(target_path) and target_path != os.path.dirname(target_path):
        target_path = os.path.dirname(target_path)
    
    try:
        disk = shutil.disk_usage(target_path)
        disk_total = disk.total
        disk_used = disk.used
        disk_free = disk.free
        disk_percent = (disk.used / disk.total) * 100
    except Exception:
        # Fallback to root directory
        disk = shutil.disk_usage("/")
        disk_total = disk.total
        disk_used = disk.used
        disk_free = disk.free
        disk_percent = (disk.used / disk.total) * 100

    # DB Connection & Stats
    db_ok = False
    total_users = 0
    total_apartments = 0
    total_floor_plans = 0
    try:
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db_ok = True
        
        # Query total records
        total_users = db.execute(select(func.count()).select_from(User)).scalar() or 0
        total_apartments = db.execute(select(func.count()).select_from(Apartment).where(Apartment.is_active == True)).scalar() or 0
        total_floor_plans = db.execute(select(func.count()).select_from(FloorPlan)).scalar() or 0
        db.close()
    except Exception as e:
        print(f"[Monitoring] DB healthcheck failed: {e}")

    # Redis Connection
    redis_ok = False
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
    # Inside docker-compose we connect via redis://redis:6379. Let's make sure it handles both.
    try:
        redis = aioredis.from_url(redis_url, socket_connect_timeout=2)
        await redis.ping()
        redis_ok = True
        await redis.aclose()
    except Exception as e:
        print(f"[Monitoring] Redis healthcheck failed on {redis_url}: {e}")

    return {
        "cpu_percent": cpu_percent,
        "ram_total": ram_total,
        "ram_used": ram_used,
        "ram_free": ram_free,
        "ram_percent": ram_percent,
        "disk_total": disk_total,
        "disk_used": disk_used,
        "disk_free": disk_free,
        "disk_percent": disk_percent,
        "db_ok": db_ok,
        "redis_ok": redis_ok,
        "total_users": total_users,
        "total_apartments": total_apartments,
        "total_floor_plans": total_floor_plans
    }


def format_weekly_report(metrics: dict) -> str:
    """Format metrics dict into an HTML message for Telegram."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report = (
        f"📊 <b>Weekly Server Monitoring Report</b>\n"
        f"📅 Date: {ts}\n\n"
        f"🖥️ <b>System Resources:</b>\n"
        f"• CPU Usage: {metrics['cpu_percent']:.1f}%\n"
        f"• RAM Used: {format_size(metrics['ram_used'])} / {format_size(metrics['ram_total'])} ({metrics['ram_percent']:.1f}%)\n"
        f"• RAM Free: {format_size(metrics['ram_free'])}\n"
        f"• Disk Space: {format_size(metrics['disk_used'])} / {format_size(metrics['disk_total'])} ({metrics['disk_percent']:.1f}%)\n"
        f"• Disk Free: {format_size(metrics['disk_free'])}\n\n"
        f"🔌 <b>Service Status:</b>\n"
        f"• Database Connection: {'🟢 OK' if metrics['db_ok'] else '🔴 ERROR'}\n"
        f"• Redis Connection: {'🟢 OK' if metrics['redis_ok'] else '🔴 ERROR'}\n\n"
        f"📈 <b>Application Stats:</b>\n"
        f"• Total Users: {metrics['total_users']}\n"
        f"• Total Active Apartments: {metrics['total_apartments']}\n"
        f"• Total Floor Plans: {metrics['total_floor_plans']}"
    )
    return report


_last_sent_week = None


async def run_monitoring_scheduler():
    """Background loop that schedules and executes weekly monitoring reports."""
    global _last_sent_week
    print("[Monitoring] Background weekly scheduler task started.")
    
    # Prime CPU percent measurement
    psutil.cpu_percent(interval=None)
    
    # Check interval loop
    while True:
        try:
            now = datetime.now()
            
            # Runs weekly on Sunday at 9:00 AM (local server time)
            if now.weekday() == 6 and now.hour == 9:
                year, week, day = now.isocalendar()
                week_key = f"monitoring_weekly:{year}-{week}"
                
                redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
                already_run = False
                redis = None
                try:
                    redis = aioredis.from_url(redis_url, socket_connect_timeout=2)
                    already_run = await redis.get(week_key)
                except Exception as e:
                    print(f"[Monitoring] Redis connection failed in scheduler: {e}")
                    already_run = (_last_sent_week == week_key)
                
                if not already_run:
                    # Mark weekly run complete
                    try:
                        if redis:
                            await redis.setex(week_key, 86400, "sent")
                    except Exception:
                        pass
                    _last_sent_week = week_key
                    print(f"[Monitoring] Triggering weekly monitoring report for week {year}-{week}...")
                    
                    # Gather metrics & send Telegram message
                    metrics = await get_system_metrics()
                    report = format_weekly_report(metrics)
                    await send_alert(report)
                
                if redis:
                    await redis.aclose()
        except Exception as e:
            print(f"[Monitoring] Error in scheduler loop: {e}")
            traceback.print_exc()
            
        # Sleep for 15 minutes before checking again
        await asyncio.sleep(900)


class ResourceTracker:
    """Context manager for measuring execution resource usage."""
    def __init__(self, filename: str = "unknown"):
        self.filename = filename
        self.process = psutil.Process(os.getpid())
        self.duration = 0.0
        self.cpu_percent_process = 0.0
        self.cpu_percent_process_normalized = 0.0
        self.cpu_percent_system = 0.0
        self.mem_process_mb = 0.0
        self.mem_delta_process_mb = 0.0
        self.sys_mem_percent = 0.0
        self.sys_mem_used_gb = 0.0
        self.sys_mem_total_gb = 0.0
        self.disk_delta_mb = 0.0
        
    def __enter__(self):
        self.start_time = time.time()
        self.process.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None)
        
        self.start_mem_process = self.process.memory_info().rss
        self.start_mem_system = psutil.virtual_memory().used
        
        try:
            self.start_disk = shutil.disk_usage("/")
        except Exception:
            self.start_disk = None
            
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.end_time = time.time()
        self.duration = self.end_time - self.start_time
        
        # Read final CPU usage
        self.cpu_percent_process = self.process.cpu_percent(interval=None)
        self.cpu_percent_system = psutil.cpu_percent(interval=None)
        
        try:
            cores = psutil.cpu_count() or 1
            self.cpu_percent_process_normalized = self.cpu_percent_process / cores
        except Exception:
            self.cpu_percent_process_normalized = self.cpu_percent_process
            
        # Read final RAM usage
        self.end_mem_process = self.process.memory_info().rss
        self.end_mem_system = psutil.virtual_memory().used
        
        self.mem_delta_process_mb = (self.end_mem_process - self.start_mem_process) / (1024 * 1024)
        self.mem_process_mb = self.end_mem_process / (1024 * 1024)
        
        # System RAM info
        sys_mem = psutil.virtual_memory()
        self.sys_mem_percent = sys_mem.percent
        self.sys_mem_used_gb = sys_mem.used / (1024**3)
        self.sys_mem_total_gb = sys_mem.total / (1024**3)
        
        # Storage delta info
        if self.start_disk:
            try:
                end_disk = shutil.disk_usage("/")
                self.disk_delta_mb = (self.start_disk.free - end_disk.free) / (1024 * 1024)
            except Exception:
                self.disk_delta_mb = 0.0
        else:
            self.disk_delta_mb = 0.0

    def get_report_dict(self) -> dict:
        return {
            "duration_seconds": round(self.duration, 2),
            "cpu_percent_process": round(self.cpu_percent_process, 1),
            "cpu_percent_process_normalized": round(self.cpu_percent_process_normalized, 1),
            "cpu_percent_system": round(self.cpu_percent_system, 1),
            "memory_process_mb": round(self.mem_process_mb, 2),
            "memory_delta_process_mb": round(self.mem_delta_process_mb, 2),
            "system_ram_percent": round(self.sys_mem_percent, 1),
            "disk_delta_mb": round(max(0.0, self.disk_delta_mb), 2),
        }

    async def send_telegram_report(self, upload_id: str, success: bool = True, error_msg: str = ""):
        """Construct and send a beautiful, highly detailed resource utilization report to Telegram."""
        status_emoji = "✅ SUCCESS" if success else "❌ FAILED"
        err_section = f"\n⚠️ <b>Error:</b> {error_msg}" if error_msg else ""
        
        report = (
            f"⚡ <b>Upload Resource Usage Report</b>\n"
            f"📁 File: <code>{self.filename}</code>\n"
            f"🆔 ID: <code>{upload_id}</code>\n"
            f"🚦 Status: {status_emoji}{err_section}\n\n"
            f"⚙️ <b>Resource Consumption:</b>\n"
            f"• Processing Time: <b>{self.duration:.2f}s</b>\n"
            f"• CPU (Process): <b>{self.cpu_percent_process_normalized:.1f}%</b> (System: {self.cpu_percent_system:.1f}%)\n"
            f"• RAM (Process): <b>{self.mem_process_mb:.1f} MB</b> (Delta: {self.mem_delta_process_mb:+.1f} MB)\n"
            f"• System RAM: <b>{self.sys_mem_percent:.1f}%</b> ({self.sys_mem_used_gb:.1f}GB / {self.sys_mem_total_gb:.1f}GB)\n"
            f"• Storage Delta: <b>{max(0.0, self.disk_delta_mb):.2f} MB</b> write"
        )
        try:
            await send_alert(report)
        except Exception as e:
            print(f"[Monitoring] Failed to send upload resource report: {e}")
