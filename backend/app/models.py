"""ORION database schema.

Times are stored as timezone-aware UTC timestamps. The API exposes epoch milliseconds (what the web app uses).
Every row that originates from a simulated device carries simulated=True so it can never be mistaken for hardware data.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


TS = DateTime(timezone=True)


class Role(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    member = "member"
    viewer = "viewer"


ROLE_RANK = {Role.viewer: 0, Role.member: 1, Role.admin: 2, Role.owner: 3}


class DeviceKind(str, enum.Enum):
    gateway = "gateway"  # ESP32: talks to the server, owns the GSM module
    controller = "controller"  # Arduino UNO: reads sensors, drives actuators, reports via its gateway


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("usr"))
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role, name="user_role"), default=Role.viewer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)  # jti
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    family_id: Mapped[str] = mapped_column(String(40), index=True)
    token_hash: Mapped[str] = mapped_column(String(128))
    expires_at: Mapped[datetime] = mapped_column(TS)
    revoked_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    user_agent: Mapped[str] = mapped_column(String(200), default="")


class Device(Base):
    """A registered board. Gateways authenticate to the MQTT broker; controllers report through a gateway."""

    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    home_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[DeviceKind] = mapped_column(Enum(DeviceKind, name="device_kind"))
    name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(160), default="")
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    secret_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    firmware_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    boot_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    online_since: Mapped[datetime | None] = mapped_column(TS, nullable=True)  # start of the current online period
    last_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    seq_gaps: Mapped[int] = mapped_column(Integer, default=0)
    info: Mapped[dict] = mapped_column(JSON, default=dict)  # rssi, uptime, link details…
    actuators: Mapped[dict] = mapped_column(JSON, default=dict)  # last actuator report (commanded states)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Sensor(Base):
    __tablename__ = "sensors"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(16))  # mq2 | flame | water | dht22
    label: Mapped[str] = mapped_column(String(80))
    room: Mapped[str] = mapped_column(String(60), default="")
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    # latest reading (as reported by the controller)
    fields: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String(16), default="unknown")  # normal | warning | critical | unknown
    quality: Mapped[str] = mapped_column(String(16), default="no_data")  # valid | warming_up | fault | disconnected | no_data
    fault: Mapped[str | None] = mapped_column(String(120), nullable=True)
    fw_threshold: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    warmup_remaining_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recorded_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    received_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    sequence: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class Telemetry(Base):
    __tablename__ = "telemetry"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sensor_id: Mapped[str] = mapped_column(ForeignKey("sensors.id", ondelete="CASCADE"))
    metric: Mapped[str] = mapped_column(String(16))
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    quality: Mapped[str] = mapped_column(String(16))
    recorded_at: Mapped[datetime] = mapped_column(TS)
    received_at: Mapped[datetime] = mapped_column(TS)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (
        Index("ix_telemetry_series_time", "sensor_id", "metric", "recorded_at"),
        Index("ix_telemetry_recorded_brin", "recorded_at", postgresql_using="brin"),
    )


class GsmModule(Base):
    __tablename__ = "gsm_modules"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    gateway_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    module: Mapped[str] = mapped_column(String(32), default="SIM800C")
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    network_registered: Mapped[bool] = mapped_column(Boolean, default=False)
    csq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    operator: Mapped[str | None] = mapped_column(String(60), nullable=True)
    sim_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_report_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)


class GsmAttempt(Base):
    """An SMS or call attempt as reported by the gateway. 'sent' = modem accepted (+CMGS); never 'delivered' without a delivery report."""

    __tablename__ = "gsm_attempts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    module_id: Mapped[str] = mapped_column(ForeignKey("gsm_modules.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(8))  # sms | call
    destination: Mapped[str] = mapped_column(String(60))  # masked
    status: Mapped[str] = mapped_column(String(16))  # queued | sending | sent | delivered | failed | timeout | answered
    note: Mapped[str] = mapped_column(String(200), default="")
    error_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    incident_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    incident_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Incident(Base):
    __tablename__ = "incidents"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("inc"))
    key: Mapped[str] = mapped_column(String(120), index=True)
    type: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[str] = mapped_column(String(64), index=True)
    source_label: Mapped[str] = mapped_column(String(120))
    severity: Mapped[str] = mapped_column(String(16))  # critical | warning | degraded | info
    state: Mapped[str] = mapped_column(String(16), default="active", index=True)  # active | cleared
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    opened_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    cleared_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    acknowledged_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    normal_since: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    held_stale: Mapped[bool] = mapped_column(Boolean, default=False)

    events: Mapped[list[IncidentEvent]] = relationship(order_by="IncidentEvent.at", cascade="all, delete-orphan", lazy="selectin")
    actions: Mapped[list[IncidentAction]] = relationship(order_by="IncidentAction.at", cascade="all, delete-orphan", lazy="selectin")


class IncidentEvent(Base):
    __tablename__ = "incident_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True)
    at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    text: Mapped[str] = mapped_column(Text)


class IncidentAction(Base):
    __tablename__ = "incident_actions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True)
    at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    actor: Mapped[str] = mapped_column(String(16))  # firmware | backend | user
    action: Mapped[str] = mapped_column(Text)
    outcome: Mapped[str] = mapped_column(Text, default="")
    gsm_attempt_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Command(Base):
    __tablename__ = "commands"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("cmd"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)  # controller that executes it
    actuator: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(32))
    requested_by: Mapped[str] = mapped_column(String(80))
    origin: Mapped[str] = mapped_column(String(16), default="user")  # user | aura_proposal
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(TS)
    status: Mapped[str] = mapped_column(String(16), default="requested", index=True)
    completed_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    result: Mapped[str | None] = mapped_column(String(40), nullable=True)
    history: Mapped[list[CommandStep]] = relationship(order_by="CommandStep.id", cascade="all, delete-orphan", lazy="selectin")


class CommandStep(Base):
    __tablename__ = "command_history"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    command_id: Mapped[str] = mapped_column(ForeignKey("commands.id", ondelete="CASCADE"), index=True)
    at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    status: Mapped[str] = mapped_column(String(16))
    note: Mapped[str] = mapped_column(Text, default="")


class ActivityEvent(Base):
    """Human-readable activity feed (what the app shows as recent events)."""

    __tablename__ = "activity_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(TS, default=utcnow, index=True)
    severity: Mapped[str] = mapped_column(String(16))
    source: Mapped[str] = mapped_column(String(120))
    text: Mapped[str] = mapped_column(Text)
    incident_id: Mapped[str | None] = mapped_column(String(40), nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(TS, default=utcnow, index=True)
    actor_type: Mapped[str] = mapped_column(String(16))  # user | device | system | aura
    actor_id: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(64), index=True)
    target: Mapped[str] = mapped_column(String(120), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    ip: Mapped[str] = mapped_column(String(64), default="")


class ConfigEntry(Base):
    """Versioned server-side configuration (one row per key)."""

    __tablename__ = "config"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(80), default="system")
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class NotificationContact(Base):
    __tablename__ = "notification_contacts"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ct"))
    name: Mapped[str] = mapped_column(String(80))
    phone: Mapped[str] = mapped_column(String(20))  # E.164; never returned unmasked except to owner/admin
    sms: Mapped[bool] = mapped_column(Boolean, default=True)
    call: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


# ---------------- Aura (Phase 4) ----------------
class AuraConversation(Base):
    """One chat thread. Conversation memory is per user and pruned after a retention period."""

    __tablename__ = "aura_conversations"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("conv"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, index=True)


class AuraMessage(Base):
    __tablename__ = "aura_messages"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("aura_conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    text: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)  # tool steps, mode (ai/basic), language
    at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class AuraProposal(Base):
    """A device command Aura suggested. Nothing runs until the same user confirms it in the app."""

    __tablename__ = "aura_proposals"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("prop"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    actuator: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(String(300), default="")
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | confirmed | declined | expired
    command_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(TS)


class UserPreference(Base):
    """Settings the user chooses (language, voice). Aura can read them but has no tool to change them."""

    __tablename__ = "user_preferences"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class PushToken(Base):
    """A phone registered for push notifications (Phase 5)."""

    __tablename__ = "push_tokens"
    token: Mapped[str] = mapped_column(String(300), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    platform: Mapped[str] = mapped_column(String(16), default="android")
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_error: Mapped[str | None] = mapped_column(String(200), nullable=True)
