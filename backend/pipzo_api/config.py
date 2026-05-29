from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = Field(default="development", validation_alias="PIPZO_ENV")
    app_mode: Literal["mock", "hardware"] = Field(default="mock", validation_alias="PIPZO_MODE")
    db_path: str = Field(default="./data/pipzo.sqlite3", validation_alias="PIPZO_DB_PATH")

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
