"""
지역 기반 매칭 큐 관리자.

★ 핵심 원칙:
  - WebSocket 연결이 끊어져도 유저를 큐에서 제거하지 않는다.
  - 오직 명시적 CANCEL_QUEUE 또는 큐 idle 타임아웃(1시간)만 유저를 제거한다.
  - 4명이 모이면 즉시 room_manager에 위임하고 해당 유저들을 큐에서 꺼낸다.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Dict, List, Optional

from config import MATCH_SIZE, QUEUE_IDLE_TIMEOUT_SECONDS
from models import QueueEntry

if TYPE_CHECKING:
    from fastapi import WebSocket
    from room_manager import RoomManager

logger = logging.getLogger(__name__)


class MatchMaker:
    def __init__(self, room_manager: "RoomManager") -> None:
        self.room_manager = room_manager
        self.local_queues: Dict[str, List[QueueEntry]] = {}  # location -> entries
        self.user_location_map: Dict[str, str] = {}          # user_id -> location
        self._cleanup_task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        self._cleanup_task = asyncio.create_task(self._idle_cleanup_loop())

    async def stop(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()

    # ─── Public API ──────────────────────────────────────────────────────────

    async def join_queue(
        self,
        user_id: str,
        device_token: str,
        location: str,
        ws: Optional["WebSocket"] = None,
    ) -> None:
        # 기존 큐 항목 제거 (재등록 처리)
        if user_id in self.user_location_map:
            self._remove_from_queue(user_id, silent=True)

        entry = QueueEntry(
            user_id=user_id,
            device_token=device_token,
            location=location,
            ws=ws,
        )

        self.local_queues.setdefault(location, []).append(entry)
        self.user_location_map[user_id] = location

        queue_len = len(self.local_queues[location])
        logger.info(f"[큐] {user_id} → {location} (현재 {queue_len}명)")

        if ws:
            await ws.send_json({
                "type": "QUEUE_JOINED",
                "location": location,
                "queue_size": queue_len,
                "needed": max(0, MATCH_SIZE - queue_len),
            })

        # 기존 대기 유저들에게 큐 변경 알림
        await self._broadcast_queue_update(location, exclude_user=user_id)
        await self._try_match(location)

    async def cancel_queue(self, user_id: str) -> bool:
        """명시적 매칭 취소."""
        location = self.user_location_map.get(user_id)
        removed = self._remove_from_queue(user_id)
        logger.info(f"[큐] {user_id} 매칭 취소 (removed={removed})")
        if removed and location:
            await self._broadcast_queue_update(location)
        return removed

    def update_ws(self, user_id: str, ws: Optional["WebSocket"]) -> None:
        """포그라운드/백그라운드 전환 시 WebSocket 핸들 갱신."""
        location = self.user_location_map.get(user_id)
        if not location:
            return
        for entry in self.local_queues.get(location, []):
            if entry.user_id == user_id:
                entry.ws = ws
                break

    def is_queued(self, user_id: str) -> bool:
        return user_id in self.user_location_map

    # ─── Internal ────────────────────────────────────────────────────────────

    async def _broadcast_queue_update(self, location: str, exclude_user: str = "") -> None:
        """같은 지역 대기 유저 전원에게 현재 큐 크기 알림."""
        queue = self.local_queues.get(location, [])
        queue_len = len(queue)
        for entry in queue:
            if entry.user_id == exclude_user or not entry.ws:
                continue
            try:
                await entry.ws.send_json({
                    "type": "QUEUE_SIZE_UPDATED",
                    "location": location,
                    "queue_size": queue_len,
                    "needed": max(0, MATCH_SIZE - queue_len),
                })
            except Exception:
                pass

    def _remove_from_queue(self, user_id: str, silent: bool = False) -> bool:
        location = self.user_location_map.pop(user_id, None)
        if not location:
            return False
        before = len(self.local_queues.get(location, []))
        self.local_queues[location] = [
            e for e in self.local_queues.get(location, []) if e.user_id != user_id
        ]
        if not self.local_queues[location]:
            del self.local_queues[location]
        if not silent:
            logger.debug(f"[큐] {user_id} 제거 from {location}")
        return len(self.local_queues.get(location, [])) < before

    async def _try_match(self, location: str) -> None:
        queue = self.local_queues.get(location, [])
        if len(queue) < MATCH_SIZE:
            return

        matched = queue[:MATCH_SIZE]
        self.local_queues[location] = queue[MATCH_SIZE:]
        if not self.local_queues[location]:
            del self.local_queues[location]

        for entry in matched:
            self.user_location_map.pop(entry.user_id, None)

        room_id = str(uuid.uuid4())
        logger.info(f"[매칭] {location} → room {room_id} | users: {[e.user_id for e in matched]}")
        await self.room_manager.create_room(room_id, location, matched)

        # 매칭 후 남은 대기 유저에게 큐 크기 갱신 알림
        if self.local_queues.get(location):
            await self._broadcast_queue_update(location)

    async def _idle_cleanup_loop(self) -> None:
        """시간 초과된 큐 항목을 1분마다 정리."""
        while True:
            await asyncio.sleep(60)
            cutoff = datetime.utcnow() - timedelta(seconds=QUEUE_IDLE_TIMEOUT_SECONDS)
            for location in list(self.local_queues.keys()):
                queue = self.local_queues.get(location, [])
                expired = [e for e in queue if e.joined_at < cutoff]
                if not expired:
                    continue
                self.local_queues[location] = [e for e in queue if e.joined_at >= cutoff]
                if not self.local_queues[location]:
                    del self.local_queues[location]
                for e in expired:
                    self.user_location_map.pop(e.user_id, None)
                    if e.ws:
                        try:
                            await e.ws.send_json({"type": "QUEUE_EXPIRED", "reason": "idle_timeout"})
                        except Exception:
                            pass
                logger.info(f"[큐 정리] {location}: {len(expired)}명 만료 제거")
