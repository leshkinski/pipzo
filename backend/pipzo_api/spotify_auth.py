import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Callable, Dict, Optional, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import Settings
from .contract import (
    SpotifyAuthHealth,
    SpotifyAuthReason,
    SpotifyAuthSession,
    SpotifyAuthSessionFailureReason,
    SpotifyAuthSessionStatus,
    SpotifyAuthStatus,
)
from .spotify_store import (
    SpotifyAuthTokenStorageError,
    StoredSpotifyAccount,
    StoredSpotifyAuthRecord,
    SpotifyAuthStore,
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _base64url_sha256(value: str) -> str:
    digest = hashlib.sha256(value.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


@dataclass
class PendingSpotifyAuthSession:
    session_id: str
    code_verifier: Optional[str]
    code_challenge: str
    state: str
    created_at: datetime
    expires_at: datetime
    start_url: str
    redirect_uri: str
    scopes: str
    status: SpotifyAuthSessionStatus = SpotifyAuthSessionStatus.WAITING
    failure_reason: Optional[SpotifyAuthSessionFailureReason] = None
    account_display_name: Optional[str] = None

    def safe_model(self) -> SpotifyAuthSession:
        return SpotifyAuthSession(
            session_id=self.session_id,
            status=self.status,
            created_at=self.created_at,
            expires_at=self.expires_at,
            start_url=self.start_url,
            failure_reason=self.failure_reason,
            account_display_name=self.account_display_name,
        )


@dataclass(frozen=True)
class SpotifyTokenResponse:
    access_token: str
    refresh_token: Optional[str]
    token_type: str
    scope: str
    expires_in: int


@dataclass(frozen=True)
class SpotifyAccountProfile:
    account_id: str
    display_name: Optional[str]
    product: Optional[str]
    country: Optional[str]

    @property
    def is_premium(self) -> bool:
        return self.product == "premium"


@dataclass(frozen=True)
class SpotifyCallbackExchange:
    session_id: str
    code: str
    code_verifier: str
    redirect_uri: str
    scopes: str


class SpotifyClient(Protocol):
    def exchange_authorization_code(
        self,
        *,
        token_url: str,
        client_id: str,
        redirect_uri: str,
        code: str,
        code_verifier: str,
    ) -> SpotifyTokenResponse:
        ...

    def fetch_current_user_profile(self, *, access_token: str) -> SpotifyAccountProfile:
        ...

    def refresh_access_token(
        self,
        *,
        token_url: str,
        client_id: str,
        refresh_token: str,
    ) -> SpotifyTokenResponse:
        ...

    def transfer_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
        device_id: str,
        play: bool,
    ) -> None:
        ...

    def send_playback_control(
        self,
        *,
        api_base_url: str,
        access_token: str,
        action: str,
        device_id: Optional[str],
    ) -> None:
        ...

    def set_playback_volume(
        self,
        *,
        api_base_url: str,
        access_token: str,
        volume_percent: int,
        device_id: Optional[str],
    ) -> None:
        ...

    def fetch_current_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
    ) -> Optional[dict]:
        ...

    def fetch_library_json(
        self,
        *,
        api_base_url: str,
        access_token: str,
        path: str,
        params: Optional[Dict[str, object]] = None,
    ) -> dict:
        ...

    def start_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
        playback_kind: str,
        uri: str,
        device_id: Optional[str],
    ) -> None:
        ...


class SpotifyTokenExchangeError(Exception):
    pass


class SpotifyTokenRefreshFailure(str, Enum):
    NETWORK = "network"
    AUTH = "auth"
    REVOKED = "revoked"
    INVALID_RESPONSE = "invalid_response"


class SpotifyTokenRefreshError(Exception):
    def __init__(self, failure: SpotifyTokenRefreshFailure) -> None:
        super().__init__(failure.value)
        self.failure = failure


class SpotifyPlaybackApiFailure(str, Enum):
    AUTH = "auth"
    PREMIUM_REQUIRED = "premium_required"
    DEVICE_NOT_FOUND = "device_not_found"
    RATE_LIMITED = "rate_limited"
    NETWORK = "network"
    INVALID_RESPONSE = "invalid_response"


class SpotifyPlaybackApiError(Exception):
    def __init__(self, failure: SpotifyPlaybackApiFailure) -> None:
        super().__init__(failure.value)
        self.failure = failure


class SpotifyCatalogApiFailure(str, Enum):
    AUTH = "auth"
    FORBIDDEN = "forbidden"
    RATE_LIMITED = "rate_limited"
    NETWORK = "network"
    INVALID_RESPONSE = "invalid_response"


class SpotifyCatalogApiError(Exception):
    def __init__(self, failure: SpotifyCatalogApiFailure) -> None:
        super().__init__(failure.value)
        self.failure = failure


class UrlLibSpotifyClient:
    profile_url = "https://api.spotify.com/v1/me"

    def exchange_authorization_code(
        self,
        *,
        token_url: str,
        client_id: str,
        redirect_uri: str,
        code: str,
        code_verifier: str,
    ) -> SpotifyTokenResponse:
        form = urlencode(
            {
                "client_id": client_id,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            }
        ).encode("utf-8")
        request = Request(
            token_url,
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        payload = self._send_json_request(request)
        try:
            return SpotifyTokenResponse(
                access_token=str(payload["access_token"]),
                refresh_token=str(payload["refresh_token"]),
                token_type=str(payload.get("token_type", "Bearer")),
                scope=str(payload.get("scope", "")),
                expires_in=int(payload["expires_in"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise SpotifyTokenExchangeError("spotify_token_response_invalid") from exc

    def fetch_current_user_profile(self, *, access_token: str) -> SpotifyAccountProfile:
        request = Request(
            self.profile_url,
            headers={"Authorization": f"Bearer {access_token}"},
            method="GET",
        )
        payload = self._send_json_request(request)
        try:
            account_id = payload.get("account_id") or payload["id"]
            return SpotifyAccountProfile(
                account_id=str(account_id),
                display_name=_optional_str(payload.get("display_name")),
                product=_optional_str(payload.get("product")),
                country=_optional_str(payload.get("country")),
            )
        except (KeyError, TypeError) as exc:
            raise SpotifyTokenExchangeError("spotify_profile_response_invalid") from exc

    def refresh_access_token(
        self,
        *,
        token_url: str,
        client_id: str,
        refresh_token: str,
    ) -> SpotifyTokenResponse:
        form = urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": client_id,
            }
        ).encode("utf-8")
        request = Request(
            token_url,
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        payload = self._send_json_request_for_refresh(request)
        try:
            return SpotifyTokenResponse(
                access_token=str(payload["access_token"]),
                refresh_token=_optional_str(payload.get("refresh_token")),
                token_type=str(payload.get("token_type", "Bearer")),
                scope=str(payload.get("scope", "")),
                expires_in=int(payload["expires_in"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise SpotifyTokenRefreshError(SpotifyTokenRefreshFailure.INVALID_RESPONSE) from exc

    def transfer_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
        device_id: str,
        play: bool,
    ) -> None:
        request = Request(
            f"{api_base_url.rstrip('/')}/v1/me/player",
            data=json.dumps({"device_ids": [device_id], "play": play}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="PUT",
        )
        self._send_empty_spotify_api_request(request)

    def send_playback_control(
        self,
        *,
        api_base_url: str,
        access_token: str,
        action: str,
        device_id: Optional[str],
    ) -> None:
        if action == "next":
            path = "/v1/me/player/next"
            method = "POST"
        elif action == "previous":
            path = "/v1/me/player/previous"
            method = "POST"
        elif action == "seek_start":
            path = "/v1/me/player/seek"
            method = "PUT"
        elif action == "play":
            path = "/v1/me/player/play"
            method = "PUT"
        else:
            path = "/v1/me/player/pause"
            method = "PUT"

        url = f"{api_base_url.rstrip('/')}{path}"
        if action == "seek_start":
            params: dict[str, object] = {"position_ms": 0}
            if device_id:
                params["device_id"] = device_id
            url = f"{url}?{urlencode(params)}"
        elif device_id:
            url = f"{url}?{urlencode({'device_id': device_id})}"
        request = Request(
            url,
            data=b"{}" if method == "PUT" else None,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        self._send_empty_spotify_api_request(request)

    def set_playback_volume(
        self,
        *,
        api_base_url: str,
        access_token: str,
        volume_percent: int,
        device_id: Optional[str],
    ) -> None:
        params: Dict[str, object] = {"volume_percent": volume_percent}
        if device_id:
            params["device_id"] = device_id
        request = Request(
            f"{api_base_url.rstrip('/')}/v1/me/player/volume?{urlencode(params)}",
            headers={"Authorization": f"Bearer {access_token}"},
            method="PUT",
        )
        self._send_empty_spotify_api_request(request)

    def fetch_current_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
    ) -> Optional[dict]:
        request = Request(
            f"{api_base_url.rstrip('/')}/v1/me/player",
            headers={"Authorization": f"Bearer {access_token}"},
            method="GET",
        )
        return self._send_optional_json_spotify_playback_request(request)

    def fetch_library_json(
        self,
        *,
        api_base_url: str,
        access_token: str,
        path: str,
        params: Optional[Dict[str, object]] = None,
    ) -> dict:
        query = f"?{urlencode(params)}" if params else ""
        request = Request(
            f"{api_base_url.rstrip('/')}{path}{query}",
            headers={"Authorization": f"Bearer {access_token}"},
            method="GET",
        )
        return self._send_json_spotify_api_request(request)

    def start_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
        playback_kind: str,
        uri: str,
        device_id: Optional[str],
    ) -> None:
        payload = {"uris": [uri]} if playback_kind == "track" else {"context_uri": uri}
        url = f"{api_base_url.rstrip('/')}/v1/me/player/play"
        if device_id:
            url = f"{url}?{urlencode({'device_id': device_id})}"
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="PUT",
        )
        self._send_empty_spotify_api_request(request)

    def _send_json_request(self, request: Request) -> dict:
        try:
            with urlopen(request, timeout=10) as response:
                body = response.read()
        except (HTTPError, URLError, TimeoutError) as exc:
            raise SpotifyTokenExchangeError("spotify_request_failed") from exc

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SpotifyTokenExchangeError("spotify_response_invalid") from exc

        if not isinstance(payload, dict):
            raise SpotifyTokenExchangeError("spotify_response_invalid")
        return payload

    def _send_json_request_for_refresh(self, request: Request) -> dict:
        try:
            with urlopen(request, timeout=10) as response:
                body = response.read()
        except HTTPError as exc:
            failure = SpotifyTokenRefreshFailure.REVOKED if exc.code == 400 else SpotifyTokenRefreshFailure.AUTH
            raise SpotifyTokenRefreshError(failure) from exc
        except (URLError, TimeoutError) as exc:
            raise SpotifyTokenRefreshError(SpotifyTokenRefreshFailure.NETWORK) from exc

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SpotifyTokenRefreshError(SpotifyTokenRefreshFailure.INVALID_RESPONSE) from exc

        if not isinstance(payload, dict):
            raise SpotifyTokenRefreshError(SpotifyTokenRefreshFailure.INVALID_RESPONSE)
        return payload

    def _send_empty_spotify_api_request(self, request: Request) -> None:
        try:
            with urlopen(request, timeout=10) as response:
                response.read()
        except HTTPError as exc:
            if exc.code == 401:
                failure = SpotifyPlaybackApiFailure.AUTH
            elif exc.code == 403:
                failure = SpotifyPlaybackApiFailure.PREMIUM_REQUIRED
            elif exc.code == 404:
                failure = SpotifyPlaybackApiFailure.DEVICE_NOT_FOUND
            elif exc.code == 429:
                failure = SpotifyPlaybackApiFailure.RATE_LIMITED
            else:
                failure = SpotifyPlaybackApiFailure.INVALID_RESPONSE
            raise SpotifyPlaybackApiError(failure) from exc
        except (URLError, TimeoutError) as exc:
            raise SpotifyPlaybackApiError(SpotifyPlaybackApiFailure.NETWORK) from exc

    def _send_json_spotify_api_request(self, request: Request) -> dict:
        try:
            with urlopen(request, timeout=10) as response:
                body = response.read()
        except HTTPError as exc:
            if exc.code == 401:
                failure = SpotifyCatalogApiFailure.AUTH
            elif exc.code == 403:
                failure = SpotifyCatalogApiFailure.FORBIDDEN
            elif exc.code == 429:
                failure = SpotifyCatalogApiFailure.RATE_LIMITED
            else:
                failure = SpotifyCatalogApiFailure.INVALID_RESPONSE
            raise SpotifyCatalogApiError(failure) from exc
        except (URLError, TimeoutError) as exc:
            raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.NETWORK) from exc

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.INVALID_RESPONSE) from exc

        if not isinstance(payload, dict):
            raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.INVALID_RESPONSE)
        return payload

    def _send_optional_json_spotify_playback_request(self, request: Request) -> Optional[dict]:
        try:
            with urlopen(request, timeout=10) as response:
                if response.status == 204:
                    return None
                body = response.read()
        except HTTPError as exc:
            if exc.code == 401:
                failure = SpotifyPlaybackApiFailure.AUTH
            elif exc.code == 403:
                failure = SpotifyPlaybackApiFailure.PREMIUM_REQUIRED
            elif exc.code == 404:
                failure = SpotifyPlaybackApiFailure.DEVICE_NOT_FOUND
            elif exc.code == 429:
                failure = SpotifyPlaybackApiFailure.RATE_LIMITED
            else:
                failure = SpotifyPlaybackApiFailure.INVALID_RESPONSE
            raise SpotifyPlaybackApiError(failure) from exc
        except (URLError, TimeoutError) as exc:
            raise SpotifyPlaybackApiError(SpotifyPlaybackApiFailure.NETWORK) from exc

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SpotifyPlaybackApiError(SpotifyPlaybackApiFailure.INVALID_RESPONSE) from exc

        if not isinstance(payload, dict):
            raise SpotifyPlaybackApiError(SpotifyPlaybackApiFailure.INVALID_RESPONSE)
        return payload


class SpotifyAuthSessionService:
    def __init__(self, now: Callable[[], datetime] = _utc_now) -> None:
        self._now = now
        self._sessions: Dict[str, PendingSpotifyAuthSession] = {}

    def create_session(self, settings: Settings) -> SpotifyAuthSession:
        self._expire_stale_sessions()
        session_id = secrets.token_urlsafe(24)
        state_secret = secrets.token_urlsafe(32)
        state = f"{session_id}.{state_secret}"
        code_verifier = secrets.token_urlsafe(96)[:128]
        code_challenge = _base64url_sha256(code_verifier)
        created_at = self._now()
        expires_at = created_at + timedelta(seconds=settings.spotify_auth_session_ttl_seconds)
        start_url = (
            f"{settings.pipzo_public_base_url.rstrip('/')}/api/v1/spotify/auth/start/{session_id}"
        )

        session = PendingSpotifyAuthSession(
            session_id=session_id,
            code_verifier=code_verifier,
            code_challenge=code_challenge,
            state=state,
            created_at=created_at,
            expires_at=expires_at,
            start_url=start_url,
            redirect_uri=settings.spotify_redirect_uri,
            scopes=settings.spotify_scopes,
        )
        self._sessions[session_id] = session
        return session.safe_model()

    def get_session(self, session_id: str) -> Optional[SpotifyAuthSession]:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        self._expire_session_if_needed(session)
        return session.safe_model()

    def cancel_session(self, session_id: str) -> Optional[SpotifyAuthSession]:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        self._expire_session_if_needed(session)
        if session.status == SpotifyAuthSessionStatus.WAITING:
            session.status = SpotifyAuthSessionStatus.CANCELLED
            session.failure_reason = SpotifyAuthSessionFailureReason.CANCELLED
            session.code_verifier = None
        return session.safe_model()

    def clear_sessions(self) -> None:
        for session in self._sessions.values():
            if session.status in {SpotifyAuthSessionStatus.WAITING, SpotifyAuthSessionStatus.CALLBACK_RECEIVED}:
                session.status = SpotifyAuthSessionStatus.CANCELLED
                session.failure_reason = SpotifyAuthSessionFailureReason.CANCELLED
            session.code_verifier = None
        self._sessions.clear()

    def build_authorize_url(self, session_id: str, settings: Settings) -> Optional[str]:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        self._expire_session_if_needed(session)
        if session.status != SpotifyAuthSessionStatus.WAITING:
            return None

        params = {
            "client_id": settings.spotify_client_id,
            "response_type": "code",
            "redirect_uri": session.redirect_uri,
            "scope": session.scopes,
            "state": session.state,
            "code_challenge_method": "S256",
            "code_challenge": session.code_challenge,
        }
        return f"{settings.spotify_auth_url}?{urlencode(params)}"

    def consume_callback_for_exchange(
        self,
        *,
        state: Optional[str],
        code: Optional[str],
        error: Optional[str],
    ) -> SpotifyCallbackExchange:
        if not state:
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.MISSING_STATE)

        session = self._find_session_by_state(state)
        if session is None:
            session_id = state.split(".", 1)[0]
            known_session = self._sessions.get(session_id)
            if known_session is None:
                raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.UNKNOWN_STATE)
            self._expire_session_if_needed(known_session)
            if known_session.status == SpotifyAuthSessionStatus.EXPIRED:
                raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.EXPIRED_STATE)
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.STATE_MISMATCH)

        self._expire_session_if_needed(session)
        if session.status == SpotifyAuthSessionStatus.EXPIRED:
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.EXPIRED_STATE)
        if session.status == SpotifyAuthSessionStatus.CANCELLED:
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.CANCELLED)
        if session.status != SpotifyAuthSessionStatus.WAITING:
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.UNKNOWN_STATE)

        code_verifier = session.code_verifier
        session.code_verifier = None
        if error is not None:
            session.status = SpotifyAuthSessionStatus.FAILED
            session.failure_reason = SpotifyAuthSessionFailureReason.SPOTIFY_ERROR
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.SPOTIFY_ERROR)
        elif not code:
            session.status = SpotifyAuthSessionStatus.FAILED
            session.failure_reason = SpotifyAuthSessionFailureReason.MISSING_CODE
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.MISSING_CODE)
        elif not code_verifier:
            session.status = SpotifyAuthSessionStatus.FAILED
            session.failure_reason = SpotifyAuthSessionFailureReason.UNKNOWN_STATE
            raise SpotifyAuthCallbackError(SpotifyAuthSessionFailureReason.UNKNOWN_STATE)
        else:
            session.status = SpotifyAuthSessionStatus.CALLBACK_RECEIVED
            session.failure_reason = None
        return SpotifyCallbackExchange(
            session_id=session.session_id,
            code=code,
            code_verifier=code_verifier,
            redirect_uri=session.redirect_uri,
            scopes=session.scopes,
        )

    def mark_exchange_failed(self, session_id: str) -> SpotifyAuthSession:
        session = self._sessions[session_id]
        session.status = SpotifyAuthSessionStatus.FAILED
        session.failure_reason = SpotifyAuthSessionFailureReason.SPOTIFY_ERROR
        return session.safe_model()

    def mark_connected(self, session_id: str, account_display_name: Optional[str]) -> SpotifyAuthSession:
        session = self._sessions[session_id]
        session.status = SpotifyAuthSessionStatus.CONNECTED
        session.failure_reason = None
        session.account_display_name = account_display_name
        return session.safe_model()

    def _find_session_by_state(self, state: str) -> Optional[PendingSpotifyAuthSession]:
        session_id = state.split(".", 1)[0]
        session = self._sessions.get(session_id)
        if session is None or session.state != state:
            return None
        return session

    def _expire_stale_sessions(self) -> None:
        for session in self._sessions.values():
            self._expire_session_if_needed(session)

    def _expire_session_if_needed(self, session: PendingSpotifyAuthSession) -> None:
        if session.status == SpotifyAuthSessionStatus.WAITING and self._now() >= session.expires_at:
            session.status = SpotifyAuthSessionStatus.EXPIRED
            session.failure_reason = SpotifyAuthSessionFailureReason.EXPIRED_STATE
            session.code_verifier = None


class SpotifyAuthCallbackError(Exception):
    def __init__(self, reason: SpotifyAuthSessionFailureReason) -> None:
        super().__init__(reason.value)
        self.reason = reason


def exchange_and_persist_spotify_callback(
    *,
    callback_exchange: SpotifyCallbackExchange,
    settings: Settings,
    spotify_client: SpotifyClient,
    store: SpotifyAuthStore,
    now: Callable[[], datetime] = _utc_now,
) -> SpotifyAccountProfile:
    issued_at = now()
    token_response = spotify_client.exchange_authorization_code(
        token_url=settings.spotify_token_url,
        client_id=settings.spotify_client_id,
        redirect_uri=callback_exchange.redirect_uri,
        code=callback_exchange.code,
        code_verifier=callback_exchange.code_verifier,
    )
    profile = spotify_client.fetch_current_user_profile(access_token=token_response.access_token)
    expires_at = issued_at + timedelta(seconds=token_response.expires_in)
    store.upsert_auth_record(
        StoredSpotifyAuthRecord(
            access_token=token_response.access_token,
            refresh_token=token_response.refresh_token or "",
            token_type=token_response.token_type,
            scope=token_response.scope,
            expires_at=expires_at,
            issued_at=issued_at,
            connected_at=issued_at,
            updated_at=issued_at,
            account=StoredSpotifyAccount(
                account_id=profile.account_id,
                display_name=profile.display_name,
                product=profile.product,
                country=profile.country,
                is_premium=profile.is_premium,
            ),
        )
    )
    return profile


def should_refresh_spotify_access_token(
    record: StoredSpotifyAuthRecord,
    *,
    now: Optional[datetime] = None,
    window: timedelta = timedelta(minutes=5),
) -> bool:
    checked_at = now or _utc_now()
    return record.expires_at <= checked_at + window


def refresh_spotify_access_token(
    *,
    settings: Settings,
    spotify_client: SpotifyClient,
    store: SpotifyAuthStore,
    now: Callable[[], datetime] = _utc_now,
    force: bool = False,
) -> SpotifyAuthHealth:
    try:
        record = store.get_auth_record()
    except SpotifyAuthTokenStorageError:
        return SpotifyAuthHealth(
            status=SpotifyAuthStatus.RECONNECT_REQUIRED,
            reason=SpotifyAuthReason.TOKEN_REFRESH_FAILED,
        )
    if record is None:
        return SpotifyAuthHealth(status=SpotifyAuthStatus.NONE, reason=SpotifyAuthReason.NO_SESSION)

    checked_at = now()
    if not force and not should_refresh_spotify_access_token(record, now=checked_at):
        return spotify_auth_health_from_record(record, now=checked_at)

    try:
        token_response = spotify_client.refresh_access_token(
            token_url=settings.spotify_token_url,
            client_id=settings.spotify_client_id,
            refresh_token=record.refresh_token,
        )
    except SpotifyTokenRefreshError as exc:
        failed = _record_refresh_failure(record, exc.failure, checked_at)
        store.upsert_auth_record(failed)
        return spotify_auth_health_from_record(failed, now=checked_at)

    refreshed = StoredSpotifyAuthRecord(
        access_token=token_response.access_token,
        refresh_token=token_response.refresh_token or record.refresh_token,
        token_type=token_response.token_type,
        scope=token_response.scope,
        expires_at=checked_at + timedelta(seconds=token_response.expires_in),
        issued_at=checked_at,
        connected_at=record.connected_at,
        updated_at=checked_at,
        account=record.account,
        last_refresh_at=checked_at,
        last_refresh_error_code=None,
        revoked_at=None,
    )
    store.upsert_auth_record(refreshed)
    return spotify_auth_health_from_record(refreshed, now=checked_at)


def _record_refresh_failure(
    record: StoredSpotifyAuthRecord,
    failure: SpotifyTokenRefreshFailure,
    checked_at: datetime,
) -> StoredSpotifyAuthRecord:
    revoked_at = checked_at if failure in {SpotifyTokenRefreshFailure.AUTH, SpotifyTokenRefreshFailure.REVOKED} else record.revoked_at
    access_token = "" if revoked_at is not None else record.access_token
    return StoredSpotifyAuthRecord(
        access_token=access_token,
        refresh_token=record.refresh_token,
        token_type=record.token_type,
        scope=record.scope,
        expires_at=record.expires_at,
        issued_at=record.issued_at,
        connected_at=record.connected_at,
        updated_at=checked_at,
        account=record.account,
        last_refresh_at=record.last_refresh_at,
        last_refresh_error_code=failure.value,
        revoked_at=revoked_at,
    )


def spotify_auth_health_from_record(record: StoredSpotifyAuthRecord, *, now: Optional[datetime] = None) -> SpotifyAuthHealth:
    checked_at = now or _utc_now()
    if record.revoked_at is not None:
        return SpotifyAuthHealth(status=SpotifyAuthStatus.RECONNECT_REQUIRED, reason=SpotifyAuthReason.REVOKED)
    if record.last_refresh_error_code == SpotifyTokenRefreshFailure.NETWORK.value and record.expires_at <= checked_at:
        return SpotifyAuthHealth(
            status=SpotifyAuthStatus.RECONNECT_REQUIRED,
            reason=SpotifyAuthReason.NETWORK_UNAVAILABLE,
            account_display_name=record.account.display_name,
        )
    if record.last_refresh_error_code in {
        SpotifyTokenRefreshFailure.AUTH.value,
        SpotifyTokenRefreshFailure.REVOKED.value,
        SpotifyTokenRefreshFailure.INVALID_RESPONSE.value,
    }:
        return SpotifyAuthHealth(
            status=SpotifyAuthStatus.RECONNECT_REQUIRED,
            reason=SpotifyAuthReason.TOKEN_REFRESH_FAILED,
            account_display_name=record.account.display_name,
        )
    return SpotifyAuthHealth(
        status=SpotifyAuthStatus.CONNECTED,
        reason=SpotifyAuthReason.PREMIUM_REQUIRED if not record.account.is_premium else None,
        account_display_name=record.account.display_name,
    )


def _optional_str(value: object) -> Optional[str]:
    if value is None:
        return None
    return str(value)
