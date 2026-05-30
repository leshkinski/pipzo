import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Union


SCHEMA_VERSION = "5"


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
            create table if not exists spotify_auth (
                id integer primary key check (id = 1),
                access_token text not null,
                refresh_token text not null,
                token_type text not null,
                scope text not null,
                expires_at text not null,
                issued_at text not null,
                account_id text not null,
                account_display_name text,
                account_product text,
                account_country text,
                account_is_premium integer not null default 0,
                connected_at text not null,
                updated_at text not null,
                last_refresh_at text,
                last_refresh_error_code text,
                revoked_at text
            )
            """
        )
        connection.execute(
            """
            create table if not exists app_settings (
                id integer primary key check (id = 1),
                settings_json text not null,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            )
            """
        )
        connection.execute(
            """
            create table if not exists bluetooth_speaker (
                id integer primary key check (id = 1),
                address text not null,
                display_name text not null,
                alias text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            )
            """
        )
        connection.execute(
            """
            create table if not exists setup_state (
                id integer primary key check (id = 1),
                playback_test_passed integer not null default 0,
                playback_device_id text,
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
