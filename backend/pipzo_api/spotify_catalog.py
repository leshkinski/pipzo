from datetime import datetime
from typing import Optional

from .config import Settings
from .contract import (
    ActionResult,
    LibraryCategoryId,
    LibraryCategoryResponse,
    LibraryHomeResponse,
    LibraryItem,
    LibraryItemType,
    LibraryPlayRequest,
    LibraryPlaybackKind,
    LibrarySearchResponse,
    LibrarySection,
    PlaybackDeviceReason,
    RecoveryActionState,
    SpotifyAuthStatus,
    utc_now,
)
from .spotify_auth import (
    SpotifyCatalogApiError,
    SpotifyCatalogApiFailure,
    SpotifyClient,
    SpotifyPlaybackApiError,
    SpotifyPlaybackApiFailure,
    refresh_spotify_access_token,
)
from .spotify_store import SpotifyAuthStore, SpotifyAuthTokenStorageError


MOCK_LIBRARY_ITEMS: dict[LibraryCategoryId, list[LibraryItem]] = {
    LibraryCategoryId.PLAYLISTS: [
        LibraryItem(
            id="playlist-bedtime",
            type=LibraryItemType.PLAYLIST,
            uri="spotify:playlist:pipzo-bedtime",
            title="Bedtime Favorites",
            subtitle="12 familiar songs",
            artwork_url=None,
            source=LibraryCategoryId.PLAYLISTS,
            playback_kind=LibraryPlaybackKind.CONTEXT,
        ),
        LibraryItem(
            id="playlist-car",
            type=LibraryItemType.PLAYLIST,
            uri="spotify:playlist:pipzo-car",
            title="Car Singalong",
            subtitle="Family playlist",
            artwork_url=None,
            source=LibraryCategoryId.PLAYLISTS,
            playback_kind=LibraryPlaybackKind.CONTEXT,
        ),
    ],
    LibraryCategoryId.ALBUMS: [
        LibraryItem(
            id="album-lullabies",
            type=LibraryItemType.ALBUM,
            uri="spotify:album:pipzo-lullabies",
            title="Soft Lullabies",
            subtitle="Pipzo Mock Artist",
            artwork_url=None,
            source=LibraryCategoryId.ALBUMS,
            playback_kind=LibraryPlaybackKind.CONTEXT,
        ),
    ],
    LibraryCategoryId.ARTISTS: [
        LibraryItem(
            id="artist-mock",
            type=LibraryItemType.ARTIST,
            uri="spotify:artist:pipzo-mock",
            title="Pipzo Mock Artist",
            subtitle="From saved music",
            artwork_url=None,
            source=LibraryCategoryId.ARTISTS,
            playback_kind=LibraryPlaybackKind.UNAVAILABLE,
            playable=False,
        ),
    ],
    LibraryCategoryId.LIKED_SONGS: [
        LibraryItem(
            id="track-bedtime-song",
            type=LibraryItemType.TRACK,
            uri="spotify:track:pipzo-bedtime-song",
            title="Bedtime Song",
            subtitle="Pipzo Mock Artist / Mock Library",
            artwork_url=None,
            source=LibraryCategoryId.LIKED_SONGS,
            playback_kind=LibraryPlaybackKind.TRACK,
        ),
        LibraryItem(
            id="track-quiet-song",
            type=LibraryItemType.TRACK,
            uri="spotify:track:pipzo-quiet-song",
            title="Quiet Favorite",
            subtitle="Pipzo Mock Artist / Soft Lullabies",
            artwork_url=None,
            source=LibraryCategoryId.LIKED_SONGS,
            playback_kind=LibraryPlaybackKind.TRACK,
        ),
    ],
    LibraryCategoryId.RECENTLY_PLAYED: [
        LibraryItem(
            id="track-recent",
            type=LibraryItemType.TRACK,
            uri="spotify:track:pipzo-recent",
            title="Recently Played Tune",
            subtitle="Pipzo Mock Artist / Today",
            artwork_url=None,
            source=LibraryCategoryId.RECENTLY_PLAYED,
            playback_kind=LibraryPlaybackKind.TRACK,
        ),
    ],
}


CATEGORY_TITLES = {
    LibraryCategoryId.PLAYLISTS: ("Playlists", "Saved and followed playlists visible to the connected account."),
    LibraryCategoryId.ALBUMS: ("Albums", "Albums saved in the Spotify library."),
    LibraryCategoryId.ARTISTS: ("Artists", "Artists derived from saved and recently played music."),
    LibraryCategoryId.LIKED_SONGS: ("Liked songs", "Tracks saved in the Spotify library."),
    LibraryCategoryId.RECENTLY_PLAYED: ("Recently played", "Recent tracks from the connected Spotify account."),
}


def mock_library_home(limit: int = 8) -> LibraryHomeResponse:
    return LibraryHomeResponse(sections=[_section(category, items[:limit]) for category, items in MOCK_LIBRARY_ITEMS.items()], generated_at=utc_now())


def mock_library_category(category: LibraryCategoryId, limit: int = 20) -> LibraryCategoryResponse:
    items = MOCK_LIBRARY_ITEMS.get(category, [])[:limit]
    title, description = CATEGORY_TITLES[category]
    return LibraryCategoryResponse(category=category, title=title, description=description, items=items, generated_at=utc_now())


def mock_library_search(query: str, limit: int = 20) -> LibrarySearchResponse:
    return _search_response(query, MOCK_LIBRARY_ITEMS, limit)


def library_home(settings: Settings, spotify_client: SpotifyClient, limit: int = 8) -> LibraryHomeResponse:
    items_by_category = _fetch_all_categories(settings, spotify_client, limit=limit)
    return LibraryHomeResponse(sections=[_section(category, items) for category, items in items_by_category.items()], generated_at=utc_now())


def library_category(
    settings: Settings,
    spotify_client: SpotifyClient,
    category: LibraryCategoryId,
    limit: int = 20,
) -> LibraryCategoryResponse:
    limit = _bounded_limit(limit)
    if category == LibraryCategoryId.HOME:
        raise ValueError("home is not a browsable category")
    access_token = _catalog_access_token(settings, spotify_client)
    items = _fetch_category(settings, spotify_client, access_token, category, limit)
    title, description = CATEGORY_TITLES[category]
    return LibraryCategoryResponse(category=category, title=title, description=description, items=items, generated_at=utc_now())


def library_search(settings: Settings, spotify_client: SpotifyClient, query: str, limit: int = 20) -> LibrarySearchResponse:
    items_by_category = _fetch_all_categories(settings, spotify_client, limit=50)
    return _search_response(query, items_by_category, limit)


def start_library_playback(settings: Settings, spotify_client: SpotifyClient, body: LibraryPlayRequest) -> ActionResult:
    started_at = utc_now()
    if body.playback_kind == LibraryPlaybackKind.UNAVAILABLE:
        return _library_action_result("start", started_at, RecoveryActionState.BLOCKED, PlaybackDeviceReason.UNKNOWN)
    try:
        access_token = _catalog_access_token(settings, spotify_client, require_premium=True)
        spotify_client.start_playback(
            api_base_url=settings.spotify_api_base_url,
            access_token=access_token,
            playback_kind=str(body.playback_kind),
            uri=body.uri,
            device_id=body.device_id,
        )
    except SpotifyCatalogApiError as exc:
        return _catalog_action_error("start", started_at, exc)
    except SpotifyPlaybackApiError as exc:
        return _playback_action_error("start", started_at, exc)
    return _library_action_result("start", started_at, RecoveryActionState.SUCCEEDED, None)


def _catalog_access_token(settings: Settings, spotify_client: SpotifyClient, require_premium: bool = False) -> str:
    store = SpotifyAuthStore.from_settings(settings)
    health = refresh_spotify_access_token(settings=settings, spotify_client=spotify_client, store=store)
    if health.status != SpotifyAuthStatus.CONNECTED:
        raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.AUTH)
    try:
        record = store.get_auth_record()
    except SpotifyAuthTokenStorageError as exc:
        raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.AUTH) from exc
    if record is None or not record.access_token:
        raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.AUTH)
    if require_premium and not record.account.is_premium:
        raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.FORBIDDEN)
    return record.access_token


def _fetch_all_categories(
    settings: Settings,
    spotify_client: SpotifyClient,
    limit: int,
) -> dict[LibraryCategoryId, list[LibraryItem]]:
    limit = _bounded_limit(limit)
    access_token = _catalog_access_token(settings, spotify_client)
    items_by_category: dict[LibraryCategoryId, list[LibraryItem]] = {}
    for category in (
        LibraryCategoryId.PLAYLISTS,
        LibraryCategoryId.ALBUMS,
        LibraryCategoryId.LIKED_SONGS,
        LibraryCategoryId.RECENTLY_PLAYED,
    ):
        items_by_category[category] = _fetch_category(settings, spotify_client, access_token, category, limit)
    items_by_category[LibraryCategoryId.ARTISTS] = _derive_artists(items_by_category, limit)
    return items_by_category


def _fetch_category(
    settings: Settings,
    spotify_client: SpotifyClient,
    access_token: str,
    category: LibraryCategoryId,
    limit: int,
) -> list[LibraryItem]:
    if category == LibraryCategoryId.PLAYLISTS:
        payload = spotify_client.fetch_library_json(
            api_base_url=settings.spotify_api_base_url,
            access_token=access_token,
            path="/v1/me/playlists",
            params={"limit": limit, "offset": 0},
        )
        return [_playlist_item(item) for item in _payload_items(payload) if isinstance(item, dict)]
    if category == LibraryCategoryId.ALBUMS:
        payload = spotify_client.fetch_library_json(
            api_base_url=settings.spotify_api_base_url,
            access_token=access_token,
            path="/v1/me/albums",
            params={"limit": limit, "offset": 0},
        )
        return [_album_item(item.get("album", {}), LibraryCategoryId.ALBUMS) for item in _payload_items(payload) if isinstance(item, dict)]
    if category == LibraryCategoryId.LIKED_SONGS:
        payload = spotify_client.fetch_library_json(
            api_base_url=settings.spotify_api_base_url,
            access_token=access_token,
            path="/v1/me/tracks",
            params={"limit": limit, "offset": 0},
        )
        return [_track_item(item.get("track", {}), LibraryCategoryId.LIKED_SONGS) for item in _payload_items(payload) if isinstance(item, dict)]
    if category == LibraryCategoryId.RECENTLY_PLAYED:
        payload = spotify_client.fetch_library_json(
            api_base_url=settings.spotify_api_base_url,
            access_token=access_token,
            path="/v1/me/player/recently-played",
            params={"limit": limit},
        )
        return [_track_item(item.get("track", {}), LibraryCategoryId.RECENTLY_PLAYED) for item in _payload_items(payload) if isinstance(item, dict)]
    if category == LibraryCategoryId.ARTISTS:
        samples = {
            LibraryCategoryId.ALBUMS: _fetch_category(settings, spotify_client, access_token, LibraryCategoryId.ALBUMS, limit),
            LibraryCategoryId.LIKED_SONGS: _fetch_category(settings, spotify_client, access_token, LibraryCategoryId.LIKED_SONGS, limit),
            LibraryCategoryId.RECENTLY_PLAYED: _fetch_category(settings, spotify_client, access_token, LibraryCategoryId.RECENTLY_PLAYED, limit),
        }
        return _derive_artists(samples, limit)
    return []


def _payload_items(payload: dict) -> list[object]:
    items = payload.get("items", [])
    return items if isinstance(items, list) else []


def _playlist_item(item: dict) -> LibraryItem:
    return LibraryItem(
        id=str(item.get("id") or item.get("uri") or "playlist"),
        type=LibraryItemType.PLAYLIST,
        uri=str(item.get("uri") or ""),
        title=str(item.get("name") or "Untitled playlist"),
        subtitle=_playlist_subtitle(item),
        artwork_url=_image_url(item),
        source=LibraryCategoryId.PLAYLISTS,
        playback_kind=LibraryPlaybackKind.CONTEXT,
        playable=bool(item.get("uri")),
    )


def _album_item(album: dict, source: LibraryCategoryId) -> LibraryItem:
    return LibraryItem(
        id=str(album.get("id") or album.get("uri") or "album"),
        type=LibraryItemType.ALBUM,
        uri=str(album.get("uri") or ""),
        title=str(album.get("name") or "Untitled album"),
        subtitle=_artist_names(album.get("artists")),
        artwork_url=_image_url(album),
        source=source,
        playback_kind=LibraryPlaybackKind.CONTEXT,
        playable=bool(album.get("uri")),
    )


def _track_item(track: dict, source: LibraryCategoryId) -> LibraryItem:
    album = track.get("album") if isinstance(track.get("album"), dict) else {}
    artists = _artist_names(track.get("artists"))
    album_name = album.get("name") if isinstance(album, dict) else None
    subtitle = " / ".join(part for part in [artists, str(album_name) if album_name else None] if part)
    return LibraryItem(
        id=str(track.get("id") or track.get("uri") or "track"),
        type=LibraryItemType.TRACK,
        uri=str(track.get("uri") or ""),
        title=str(track.get("name") or "Untitled track"),
        subtitle=subtitle or None,
        artwork_url=_image_url(album),
        source=source,
        playback_kind=LibraryPlaybackKind.TRACK,
        playable=bool(track.get("uri")) and not bool(track.get("is_local")),
    )


def _derive_artists(items_by_category: dict[LibraryCategoryId, list[LibraryItem]], limit: int) -> list[LibraryItem]:
    seen: set[str] = set()
    artists: list[LibraryItem] = []
    for category, source_items in items_by_category.items():
        if category == LibraryCategoryId.PLAYLISTS:
            continue
        for item in source_items:
            if not item.subtitle:
                continue
            artist_name = item.subtitle.split(" / ", 1)[0]
            if not artist_name or artist_name in seen:
                continue
            seen.add(artist_name)
            artists.append(
                LibraryItem(
                    id=f"artist-{len(artists) + 1}",
                    type=LibraryItemType.ARTIST,
                    uri=f"pipzo:derived-artist:{len(artists) + 1}",
                    title=artist_name,
                    subtitle="From saved music",
                    artwork_url=item.artwork_url,
                    source=LibraryCategoryId.ARTISTS,
                    playback_kind=LibraryPlaybackKind.UNAVAILABLE,
                    playable=False,
                )
            )
            if len(artists) >= limit:
                return artists
    return artists


def _search_response(
    query: str,
    items_by_category: dict[LibraryCategoryId, list[LibraryItem]],
    limit: int,
) -> LibrarySearchResponse:
    normalized = query.strip().lower()
    sections: list[LibrarySection] = []
    if normalized:
        for category, items in items_by_category.items():
            matches = [
                item
                for item in items
                if normalized in item.title.lower() or (item.subtitle is not None and normalized in item.subtitle.lower())
            ][: _bounded_limit(limit)]
            if matches:
                sections.append(_section(category, matches))
    return LibrarySearchResponse(query=query, sections=sections, generated_at=utc_now())


def _section(category: LibraryCategoryId, items: list[LibraryItem]) -> LibrarySection:
    title, description = CATEGORY_TITLES[category]
    return LibrarySection(id=category, title=title, description=description, items=items)


def _playlist_subtitle(item: dict) -> Optional[str]:
    tracks = item.get("tracks") if isinstance(item.get("tracks"), dict) else {}
    total = tracks.get("total")
    owner = item.get("owner") if isinstance(item.get("owner"), dict) else {}
    owner_name = owner.get("display_name")
    parts = []
    if isinstance(total, int):
        parts.append(f"{total} tracks")
    if owner_name:
        parts.append(str(owner_name))
    return " / ".join(parts) or None


def _artist_names(artists: object) -> Optional[str]:
    if not isinstance(artists, list):
        return None
    names = [str(artist.get("name")) for artist in artists if isinstance(artist, dict) and artist.get("name")]
    return ", ".join(names) if names else None


def _image_url(item: object) -> Optional[str]:
    images = item.get("images") if isinstance(item, dict) else None
    if not isinstance(images, list) or not images:
        return None
    first = images[0]
    if not isinstance(first, dict) or not first.get("url"):
        return None
    return str(first["url"])


def _bounded_limit(limit: int) -> int:
    return max(1, min(50, limit))


def _catalog_action_error(action: str, started_at: datetime, exc: SpotifyCatalogApiError) -> ActionResult:
    reason_by_failure = {
        SpotifyCatalogApiFailure.AUTH: PlaybackDeviceReason.AUTH_REQUIRED,
        SpotifyCatalogApiFailure.FORBIDDEN: PlaybackDeviceReason.PREMIUM_REQUIRED,
        SpotifyCatalogApiFailure.RATE_LIMITED: PlaybackDeviceReason.SPOTIFY_API_ERROR,
        SpotifyCatalogApiFailure.NETWORK: PlaybackDeviceReason.NETWORK_UNAVAILABLE,
        SpotifyCatalogApiFailure.INVALID_RESPONSE: PlaybackDeviceReason.SPOTIFY_API_ERROR,
    }
    return _library_action_result(action, started_at, RecoveryActionState.BLOCKED, reason_by_failure[exc.failure])


def _playback_action_error(action: str, started_at: datetime, exc: SpotifyPlaybackApiError) -> ActionResult:
    reason_by_failure = {
        SpotifyPlaybackApiFailure.AUTH: PlaybackDeviceReason.AUTH_REQUIRED,
        SpotifyPlaybackApiFailure.PREMIUM_REQUIRED: PlaybackDeviceReason.PREMIUM_REQUIRED,
        SpotifyPlaybackApiFailure.DEVICE_NOT_FOUND: PlaybackDeviceReason.DEVICE_NOT_REGISTERED,
        SpotifyPlaybackApiFailure.RATE_LIMITED: PlaybackDeviceReason.SPOTIFY_API_ERROR,
        SpotifyPlaybackApiFailure.NETWORK: PlaybackDeviceReason.NETWORK_UNAVAILABLE,
        SpotifyPlaybackApiFailure.INVALID_RESPONSE: PlaybackDeviceReason.SPOTIFY_API_ERROR,
    }
    return _library_action_result(action, started_at, RecoveryActionState.BLOCKED, reason_by_failure[exc.failure])


def _library_action_result(
    action: str,
    started_at: datetime,
    state: RecoveryActionState,
    reason: Optional[PlaybackDeviceReason],
) -> ActionResult:
    return ActionResult(
        id=f"library-{action}",
        domain="library",
        action=action,
        state=state,
        reason=reason,
        mock=False,
        started_at=started_at,
        completed_at=utc_now(),
    )
