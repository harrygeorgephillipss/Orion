"""In-process publish/subscribe used to push real-time events to WebSocket clients."""
from __future__ import annotations

import asyncio
import time
from typing import Any


class Bus:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, type_: str, **data: Any) -> None:
        msg = {"type": type_, "at": int(time.time() * 1000), **data}
        for q in list(self._subs):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:  # slow client: drop oldest so it still gets the newest state
                try:
                    q.get_nowait()
                    q.put_nowait(msg)
                except Exception:
                    pass

    @property
    def subscribers(self) -> int:
        return len(self._subs)


bus = Bus()
