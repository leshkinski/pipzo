import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

from .database import initialize_database


@dataclass(frozen=True)
class StoredSetupState:
    playback_test_passed: bool = False
    playback_device_id: Optional[str] = None


class SetupStateStore:
    def __init__(self, db_path: Union[str, Path]) -> None:
        self._db_path = Path(db_path)

    def get_state(self) -> StoredSetupState:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            row = connection.execute(
                "select playback_test_passed, playback_device_id from setup_state where id = 1"
            ).fetchone()

        if row is None:
            return StoredSetupState()
        return StoredSetupState(playback_test_passed=bool(row[0]), playback_device_id=row[1])

    def mark_playback_test_passed(self, device_id: str) -> StoredSetupState:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            connection.execute(
                """
                insert into setup_state (id, playback_test_passed, playback_device_id)
                values (1, 1, ?)
                on conflict(id) do update set
                    playback_test_passed = 1,
                    playback_device_id = excluded.playback_device_id,
                    updated_at = current_timestamp
                """,
                (device_id,),
            )
            connection.commit()
        return StoredSetupState(playback_test_passed=True, playback_device_id=device_id)

    def clear_playback_test(self) -> None:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            connection.execute("delete from setup_state where id = 1")
            connection.commit()
