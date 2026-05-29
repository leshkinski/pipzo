import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Union


SCHEMA_VERSION = "1"


@dataclass(frozen=True)
class DatabaseInitializationResult:
    db_path: Path
    schema_version: str


def initialize_database(db_path: Union[str, Path]) -> DatabaseInitializationResult:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(path) as connection:
        connection.execute("pragma foreign_keys = on")
        connection.execute(
            """
            create table if not exists schema_metadata (
                key text primary key,
                value text not null,
                updated_at text not null default current_timestamp
            )
            """
        )
        connection.execute(
            """
            insert into schema_metadata (key, value)
            values ('schema_version', ?)
            on conflict(key) do update set
                value = excluded.value,
                updated_at = current_timestamp
            """,
            (SCHEMA_VERSION,),
        )
        connection.commit()

    return DatabaseInitializationResult(db_path=path, schema_version=SCHEMA_VERSION)
