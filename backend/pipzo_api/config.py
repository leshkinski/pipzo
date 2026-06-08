from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = Field(default="development", validation_alias="PIPZO_ENV")
    app_mode: Literal["mock", "hardware"] = Field(default="mock", validation_alias="PIPZO_MODE")
    db_path: str = Field(default="./data/pipzo.sqlite3", validation_alias="PIPZO_DB_PATH")
    log_level: Literal["debug", "info", "warning", "error", "critical"] = Field(
        default="info",
        validation_alias="PIPZO_LOG_LEVEL",
    )
    spotify_client_id: str = Field(default="", validation_alias="SPOTIFY_CLIENT_ID")
    spotify_redirect_uri: str = Field(
        default="http://127.0.0.1:8000/api/v1/spotify/auth/callback",
        validation_alias="SPOTIFY_REDIRECT_URI",
    )
    spotify_auth_url: str = Field(
        default="https://accounts.spotify.com/authorize",
        validation_alias="SPOTIFY_AUTH_URL",
    )
    spotify_token_url: str = Field(
        default="https://accounts.spotify.com/api/token",
        validation_alias="SPOTIFY_TOKEN_URL",
    )
    spotify_api_base_url: str = Field(
        default="https://api.spotify.com",
        validation_alias="SPOTIFY_API_BASE_URL",
    )
    spotify_scopes: str = Field(
        default=(
            "streaming user-read-playback-state user-modify-playback-state "
            "user-read-currently-playing playlist-read-private playlist-read-collaborative "
            "user-library-read user-library-modify user-read-recently-played user-read-private"
        ),
        validation_alias="SPOTIFY_SCOPES",
    )
    pipzo_public_base_url: str = Field(
        default="http://127.0.0.1:8000",
        validation_alias="PIPZO_PUBLIC_BASE_URL",
    )
    pipzo_frontend_dist: str = Field(default="", validation_alias="PIPZO_FRONTEND_DIST")
    pipzo_internet_probe_url: str = Field(
        default="https://www.google.com/generate_204",
        validation_alias="PIPZO_INTERNET_PROBE_URL",
    )
    pipzo_audio_user: str = Field(default="", validation_alias="PIPZO_AUDIO_USER")
    pipzo_kiosk_browser_session_reset_command: str = Field(
        default="/usr/local/bin/pipzo-reset-kiosk-browser-session",
        validation_alias="PIPZO_KIOSK_BROWSER_SESSION_RESET_COMMAND",
    )
    spotify_auth_session_ttl_seconds: int = Field(
        default=600,
        ge=1,
        le=3600,
        validation_alias="SPOTIFY_AUTH_SESSION_TTL_SECONDS",
    )
    spotify_token_storage_protection: Literal["local_key_encrypted"] = Field(
        default="local_key_encrypted",
        validation_alias="SPOTIFY_TOKEN_STORAGE_PROTECTION",
    )
    pipzo_token_key_path: str = Field(
        default="./data/spotify-token.key",
        validation_alias="PIPZO_TOKEN_KEY_PATH",
    )
    pipzo_token_key_auto_create: bool = Field(
        default=True,
        validation_alias="PIPZO_TOKEN_KEY_AUTO_CREATE",
    )

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, value: object) -> object:
        if isinstance(value, str):
            return value.lower()
        return value

    @field_validator(
        "spotify_client_id",
        "spotify_redirect_uri",
        "spotify_auth_url",
        "spotify_token_url",
        "spotify_api_base_url",
        "spotify_scopes",
        "pipzo_public_base_url",
        "pipzo_frontend_dist",
        "pipzo_internet_probe_url",
        "pipzo_audio_user",
        "pipzo_kiosk_browser_session_reset_command",
        "spotify_token_storage_protection",
        "pipzo_token_key_path",
        mode="before",
    )
    @classmethod
    def strip_config_string(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        populate_by_name=True,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
