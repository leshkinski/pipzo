import sqlite3
from pathlib import Path
from typing import Optional, Union

from .contract import SpeakerSummary
from .database import initialize_database


class BluetoothSpeakerStore:
    def __init__(self, db_path: Union[str, Path]) -> None:
        self._db_path = Path(db_path)

    def get_primary(self) -> Optional[SpeakerSummary]:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            row = connection.execute(
                "select address, display_name, alias from bluetooth_speaker where id = 1",
            ).fetchone()
        if row is None:
            return None
        return SpeakerSummary(address=row[0], display_name=row[1], alias=row[2], connected=False)

    def save_primary(self, speaker: SpeakerSummary) -> SpeakerSummary:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            connection.execute(
                """
                insert into bluetooth_speaker (id, address, display_name, alias)
                values (1, ?, ?, ?)
                on conflict(id) do update set
                    address = excluded.address,
                    display_name = excluded.display_name,
                    alias = excluded.alias,
                    updated_at = current_timestamp
                """,
                (speaker.address, speaker.display_name, speaker.alias),
            )
            connection.commit()
        return speaker

    def delete_primary(self) -> None:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            connection.execute("delete from bluetooth_speaker where id = 1")
            connection.commit()
