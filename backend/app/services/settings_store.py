"""Server-side configuration with defaults. Values are validated by the API before being stored."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ConfigEntry

DEFAULTS: dict[str, dict] = {
    # A reading older than sensor_s is stale; a controller silent for heartbeat_s is offline.
    "freshness": {"sensor_s": 30, "heartbeat_s": 20},
    # App-side thresholds. Hazard states (smoke/flame/water) come from the safety controller's firmware;
    # these only drive display lines and the optional temperature/humidity advisories.
    "thresholds": {"mq2_warning": 350, "mq2_critical": 500, "water_wet": 300, "temp_advisory_c": None, "humidity_advisory": None},
    "home": {"name": "My home", "timezone": "Asia/Kolkata"},
    "rooms": {},
}


async def get_config(db: AsyncSession, key: str) -> dict:
    row = await db.get(ConfigEntry, key)
    base = dict(DEFAULTS.get(key, {}))
    if row:
        base.update(row.value or {})
    return base


async def get_config_row(db: AsyncSession, key: str) -> ConfigEntry | None:
    return await db.get(ConfigEntry, key)


async def set_config(db: AsyncSession, key: str, value: dict, by: str) -> ConfigEntry:
    row = await db.get(ConfigEntry, key)
    if row:
        row.value = value
        row.version += 1
        row.updated_by = by
        from ..timeutil import now

        row.updated_at = now()
    else:
        row = ConfigEntry(key=key, value=value, version=1, updated_by=by)
        db.add(row)
    return row
