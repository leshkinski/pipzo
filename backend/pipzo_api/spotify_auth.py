import base64
import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional
from urllib.parse import urlencode

from .config import Settings
from .contract import SpotifyAuthSession, SpotifyAuthSessionFailureReason, SpotifyAuthSessionStatus


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

    def safe_model(self) -> SpotifyAuthSession:
        return SpotifyAuthSession(
            session_id=self.session_id,
            status=self.status,
            created_at=self.created_at,
            expires_at=self.expires_at,
            start_url=self.start_url,
            failure_reason=self.failure_reason,
        )


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

    def record_callback(
        self,
        *,
        state: Optional[str],
        code: Optional[str],
        error: Optional[str],
    ) -> SpotifyAuthSession:
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

        session.code_verifier = None
        if error is not None:
            session.status = SpotifyAuthSessionStatus.FAILED
            session.failure_reason = SpotifyAuthSessionFailureReason.SPOTIFY_ERROR
        elif not code:
            session.status = SpotifyAuthSessionStatus.FAILED
            session.failure_reason = SpotifyAuthSessionFailureReason.MISSING_CODE
        else:
            session.status = SpotifyAuthSessionStatus.CALLBACK_RECEIVED
            session.failure_reason = None
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
