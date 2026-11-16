"""Small in-memory sliding-window rate limiter (single-process deployment)."""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status


class RateLimiter:
    def __init__(self, limit: int, window_s: float) -> None:
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests — slow down", headers={"Retry-After": str(int(self.window))})
        q.append(now)

    def reset(self) -> None:
        self.hits.clear()


login_limiter = RateLimiter(limit=10, window_s=60)
command_limiter = RateLimiter(limit=20, window_s=60)


def limit(limiter: RateLimiter, scope: str):
    async def dep(request: Request) -> None:
        limiter.check(f"{scope}:{request.client.host if request.client else '?'}")

    return dep
