import json
import sqlite3
from pathlib import Path
from typing import Union

from .contract import AppSettings, AppSettingsPatch
from .database import initialize_database


class AppSettingsStore:
    def __init__(self, db_path: Union[str, Path]) -> None:
        self._db_path = Path(db_path)

    def get_settings(self) -> AppSettings:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            row = connection.execute("select settings_json from app_settings where id = 1").fetchone()

        if row is None:
            return AppSettings()
        try:
            return AppSettings.model_validate_json(row[0])
        except (ValueError, TypeError):
            return AppSettings()

    def patch_settings(self, patch: AppSettingsPatch) -> AppSettings:
        current = self.get_settings().model_dump()
        current.update(patch.model_dump(exclude_unset=True))
        updated = AppSettings.model_validate(current)
        self.save_settings(updated)
        return updated

    def save_settings(self, settings: AppSettings) -> None:
        initialize_database(self._db_path)
        settings_json = json.dumps(settings.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        with sqlite3.connect(self._db_path) as connection:
            connection.execute(
                """
                insert into app_settings (id, settings_json)
                values (1, ?)
                on conflict(id) do update set
                    settings_json = excluded.settings_json,
                    updated_at = current_timestamp
                """,
                (settings_json,),
            )
            connection.commit()
