import asyncio
from typing import Any, Dict, Set

from fastapi import WebSocket, WebSocketDisconnect

from .contract import AppEvent, AppSnapshot, utc_now


class EventHub:
    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue[AppEvent]] = set()

    def snapshot_event(self, snapshot: AppSnapshot) -> AppEvent:
        return AppEvent(type="app.snapshot", payload=snapshot.model_dump(mode="json", by_alias=True), emitted_at=utc_now())

    def publish(self, event_type: str, payload: Dict[str, Any]) -> None:
        event = AppEvent(type=event_type, payload=payload, emitted_at=utc_now())
        for queue in list(self._subscribers):
            queue.put_nowait(event)

    async def websocket_session(self, websocket: WebSocket, initial_snapshot: AppSnapshot) -> None:
        await websocket.accept()
        await websocket.send_json(self.snapshot_event(initial_snapshot).model_dump(mode="json", by_alias=True))

        queue: asyncio.Queue[AppEvent] = asyncio.Queue()
        self._subscribers.add(queue)
        sender = asyncio.create_task(self._send_events(websocket, queue))
        receiver = asyncio.create_task(self._receive_until_disconnect(websocket))
        try:
            done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
        finally:
            self._subscribers.discard(queue)

    async def _send_events(self, websocket: WebSocket, queue: asyncio.Queue[AppEvent]) -> None:
        while True:
            event = await queue.get()
            await websocket.send_json(event.model_dump(mode="json", by_alias=True))

    async def _receive_until_disconnect(self, websocket: WebSocket) -> None:
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            return
