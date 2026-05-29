import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional, Union

from cryptography.fernet import Fernet, InvalidToken

from .config import Settings
from .database import initialize_database

_TOKEN_PREFIX = "fernet:v1:"


@dataclass(frozen=True)
class StoredSpotifyAccount:
    account_id: str
    display_name: Optional[str]
    product: Optional[str]
    country: Optional[str]
    is_premium: bool


@dataclass(frozen=True)
class StoredSpotifyAuthRecord:
    access_token: str
    refresh_token: str
    token_type: str
    scope: str
    expires_at: datetime
    issued_at: datetime
    connected_at: datetime
    updated_at: datetime
    account: StoredSpotifyAccount
    last_refresh_at: Optional[datetime] = None
    last_refresh_error_code: Optional[str] = None
    revoked_at: Optional[datetime] = None


class SpotifyAuthTokenStorageError(Exception):
    pass


class SpotifyAuthTokenKeyError(SpotifyAuthTokenStorageError):
    pass


class SpotifyAuthTokenDecryptionError(SpotifyAuthTokenStorageError):
    pass


class SpotifyAuthStore:
    def __init__(
        self,
        db_path: Union[str, Path],
        *,
        token_key_path: Optional[Union[str, Path]] = None,
        auto_create_key: bool = True,
    ) -> None:
        self._db_path = Path(db_path)
        self._token_key_path = (
            Path(token_key_path)
            if token_key_path is not None
            else self._db_path.parent / "spotify-token.key"
        )
        self._auto_create_key = auto_create_key
        self._fernet: Optional[Fernet] = None

    @classmethod
    def from_settings(cls, settings: Settings) -> "SpotifyAuthStore":
        return cls(
            settings.db_path,
            token_key_path=settings.pipzo_token_key_path,
            auto_create_key=settings.pipzo_token_key_auto_create,
        )

    def upsert_auth_record(self, record: StoredSpotifyAuthRecord) -> None:
        initialize_database(self._db_path)
        encrypted_access_token = self._encrypt_token(record.access_token)
        encrypted_refresh_token = self._encrypt_token(record.refresh_token)
        with sqlite3.connect(self._db_path) as connection:
            connection.execute(
                """
                insert into spotify_auth (
                    id,
                    access_token,
                    refresh_token,
                    token_type,
                    scope,
                    expires_at,
                    issued_at,
                    account_id,
                    account_display_name,
                    account_product,
                    account_country,
                    account_is_premium,
                    connected_at,
                    updated_at,
                    last_refresh_at,
                    last_refresh_error_code,
                    revoked_at
                )
                values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                    access_token = excluded.access_token,
                    refresh_token = excluded.refresh_token,
                    token_type = excluded.token_type,
                    scope = excluded.scope,
                    expires_at = excluded.expires_at,
                    issued_at = excluded.issued_at,
                    account_id = excluded.account_id,
                    account_display_name = excluded.account_display_name,
                    account_product = excluded.account_product,
                    account_country = excluded.account_country,
                    account_is_premium = excluded.account_is_premium,
                    connected_at = excluded.connected_at,
                    updated_at = excluded.updated_at,
                    last_refresh_at = excluded.last_refresh_at,
                    last_refresh_error_code = excluded.last_refresh_error_code,
                    revoked_at = excluded.revoked_at
                """,
                (
                    encrypted_access_token,
                    encrypted_refresh_token,
                    record.token_type,
                    record.scope,
                    _format_dt(record.expires_at),
                    _format_dt(record.issued_at),
                    record.account.account_id,
                    record.account.display_name,
                    record.account.product,
                    record.account.country,
                    1 if record.account.is_premium else 0,
                    _format_dt(record.connected_at),
                    _format_dt(record.updated_at),
                    _format_optional_dt(record.last_refresh_at),
                    record.last_refresh_error_code,
                    _format_optional_dt(record.revoked_at),
                ),
            )
            connection.commit()

    def get_auth_record(self) -> Optional[StoredSpotifyAuthRecord]:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                select
                    access_token,
                    refresh_token,
                    token_type,
                    scope,
                    expires_at,
                    issued_at,
                    account_id,
                    account_display_name,
                    account_product,
                    account_country,
                    account_is_premium,
                    connected_at,
                    updated_at,
                    last_refresh_at,
                    last_refresh_error_code,
                    revoked_at
                from spotify_auth
                where id = 1
                """
            ).fetchone()

        if row is None:
            return None

        return StoredSpotifyAuthRecord(
            access_token=self._decrypt_token(row["access_token"]),
            refresh_token=self._decrypt_token(row["refresh_token"]),
            token_type=row["token_type"],
            scope=row["scope"],
            expires_at=_parse_dt(row["expires_at"]),
            issued_at=_parse_dt(row["issued_at"]),
            connected_at=_parse_dt(row["connected_at"]),
            updated_at=_parse_dt(row["updated_at"]),
            account=StoredSpotifyAccount(
                account_id=row["account_id"],
                display_name=row["account_display_name"],
                product=row["account_product"],
                country=row["account_country"],
                is_premium=bool(row["account_is_premium"]),
            ),
            last_refresh_at=_parse_optional_dt(row["last_refresh_at"]),
            last_refresh_error_code=row["last_refresh_error_code"],
            revoked_at=_parse_optional_dt(row["revoked_at"]),
        )

    def delete_auth_record(self) -> None:
        initialize_database(self._db_path)
        with sqlite3.connect(self._db_path) as connection:
            connection.execute("delete from spotify_auth where id = 1")
            connection.commit()

    def _encrypt_token(self, value: str) -> str:
        encrypted = self._get_fernet().encrypt(value.encode("utf-8")).decode("ascii")
        return f"{_TOKEN_PREFIX}{encrypted}"

    def _decrypt_token(self, value: str) -> str:
        if not value.startswith(_TOKEN_PREFIX):
            raise SpotifyAuthTokenDecryptionError("spotify_token_encryption_missing")
        encrypted = value.removeprefix(_TOKEN_PREFIX).encode("ascii")
        try:
            return self._get_fernet().decrypt(encrypted).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError) as exc:
            raise SpotifyAuthTokenDecryptionError("spotify_token_decryption_failed") from exc

    def _get_fernet(self) -> Fernet:
        if self._fernet is None:
            self._fernet = Fernet(
                _load_or_create_key(self._token_key_path, auto_create=self._auto_create_key)
            )
        return self._fernet


def _load_or_create_key(path: Path, *, auto_create: bool) -> bytes:
    try:
        key = path.read_bytes().strip()
    except FileNotFoundError:
        if not auto_create:
            raise SpotifyAuthTokenKeyError("spotify_token_key_missing")
        key = Fernet.generate_key()
        parent_existed = path.parent.exists()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not parent_existed:
            _restrict_directory_permissions(path.parent)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as key_file:
                key_file.write(key + b"\n")
        except Exception:
            path.unlink(missing_ok=True)
            raise
    else:
        _restrict_file_permissions(path)

    try:
        Fernet(key)
    except (ValueError, TypeError) as exc:
        raise SpotifyAuthTokenKeyError("spotify_token_key_invalid") from exc
    return key


def _restrict_directory_permissions(path: Path) -> None:
    try:
        mode = path.stat().st_mode & 0o777
        if mode & 0o077:
            path.chmod(mode & 0o700)
    except OSError:
        return


def _restrict_file_permissions(path: Path) -> None:
    try:
        mode = path.stat().st_mode & 0o777
        if mode & 0o077:
            path.chmod(0o600)
    except OSError:
        return


def _format_dt(value: datetime) -> str:
    return value.isoformat()


def _format_optional_dt(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return _format_dt(value)


def _parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _parse_optional_dt(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    return _parse_dt(value)
