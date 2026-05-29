import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import Settings
from .contract import SpotifyAuthSession, SpotifyAuthSessionFailureReason, SpotifyAuthSessionStatus
from .spotify_store import StoredSpotifyAccount, StoredSpotifyAuthRecord, SpotifyAuthStore


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
    refresh_token: str
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


class SpotifyTokenExchangeError(Exception):
    pass


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
            refresh_token=token_response.refresh_token,
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


def _optional_str(value: object) -> Optional[str]:
    if value is None:
        return None
    return str(value)
