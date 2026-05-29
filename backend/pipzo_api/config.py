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

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, value: object) -> object:
        if isinstance(value, str):
            return value.lower()
        return value

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        populate_by_name=True,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
