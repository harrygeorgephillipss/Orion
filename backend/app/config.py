"""ORION backend configuration. Every secret comes from the environment (see /.env.example)."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORION_", env_file=".env", extra="ignore", populate_by_name=True)

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
    gateway_mqtt_port: int = 0  # broker port offered to gateways (0 = 8883 with mqtt_tls, else 1883); cloud: 8883
    lan_host: str = ""  # this server's address on the home network, offered to gateways in the setup code
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_topic_root: str = "orion"
    mqtt_passwd_file: str = ""  # if set, the server maintains broker accounts for gateways (and itself)

    home_id: str = "home-1"
    frontend_dir: str = ""
    monitor_interval_s: float = 2.0
    command_ttl_s: int = 30
    clear_hold_s: float = 10.0
    login_max_failures: int = 5
    login_lock_s: int = 300

    # ---- Aura (Phase 4). The API key itself is read by the Anthropic SDK from ANTHROPIC_API_KEY. ----
    aura_provider: str = Field(default="", alias="AURA_PROVIDER")  # anthropic | mock | "" (off → basic mode)
    aura_model: str = Field(default="", alias="AURA_MODEL")  # Anthropic model ID chosen by the owner
    aura_effort: str = Field(default="", alias="AURA_EFFORT")  # low | medium | high … ("" = model default)
    aura_refusal_fallback: str = Field(default="", alias="AURA_REFUSAL_FALLBACK")  # "default" enables server-side fallback
    aura_max_tool_rounds: int = Field(default=6, alias="AURA_MAX_TOOL_ROUNDS")
    aura_history_turns: int = Field(default=10, alias="AURA_HISTORY_TURNS")
    aura_retention_days: int = Field(default=30, alias="AURA_RETENTION_DAYS")

    # ---- Push notifications (Phase 5) ----
    fcm_project_id: str = Field(default="", alias="FCM_PROJECT_ID")
    fcm_service_account_file: str = Field(default="", alias="FCM_SERVICE_ACCOUNT_FILE")

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
