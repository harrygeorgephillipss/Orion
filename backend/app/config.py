"""ORION backend configuration. Every secret comes from the environment (see /.env.example)."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORION_", env_file=".env", extra="ignore")

    env: str = "development"
    secret_key: str = Field(default="", description="JWT signing key; required")
    access_token_ttl_s: int = 900
    refresh_token_ttl_s: int = 14 * 24 * 3600
    cors_origins: str = ""
    database_url: str = "postgresql+asyncpg://orion:orion-dev@localhost:5432/orion"
    bootstrap_owner_email: str = ""
    bootstrap_owner_password: str = ""
    bootstrap_owner_name: str = "Owner"

    mqtt_enabled: bool = True
    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_tls: bool = False
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_topic_root: str = "orion"

    home_id: str = "home-1"
    frontend_dir: str = ""
    monitor_interval_s: float = 2.0
    command_ttl_s: int = 30
    clear_hold_s: float = 10.0
    login_max_failures: int = 5
    login_lock_s: int = 300

    @field_validator("secret_key")
    @classmethod
    def _key_strength(cls, v: str) -> str:
        if v and len(v) < 32:
            raise ValueError("ORION_SECRET_KEY must be at least 32 characters")
        return v

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if not s.secret_key:
        if s.is_production:
            raise RuntimeError("ORION_SECRET_KEY is required in production")
        # Development only: an ephemeral key (all tokens become invalid on restart).
        import secrets

        s.secret_key = secrets.token_hex(32)
    return s
