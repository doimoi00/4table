"""
방 생명주기 관리자.

상태 전이:
  MATCHED_WAITING → ACTIVE → (TIMEBOMB) → DESTROYED

★ 5분 시한폭탄 규칙:
  - ACTIVE 상태에서 유저 연결이 끊기면 30초 재접속 유예
  - 유예 후에도 돌아오지 않으면 TIMEBOMB 상태로 전환 + 300초 카운트다운
  - 카운트다운 중 전원 재접속 시 폭탄 해제
  - 명시적 LEAVE는 즉시 폭탄 트리거 (유예 없음)
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import WebSocket

from config import MATCH_TIMEOUT_SECONDS, RECONNECT_GRACE_SECONDS, TIMEBOMB_SECONDS
from models import Room, RoomStatus, RoomUser
from push_service import notify_match_failed, notify_match_found

logger = logging.getLogger(__name__)


class RoomManager:
    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}
        self.user_room_map: Dict[str, str] = {}  # user_id -> room_id

    # ─── 방 생성 ─────────────────────────────────────────────────────────────

    async def create_room(self, room_id: str, location: str, matched_entries: list) -> None:
        users = {
            e.user_id: RoomUser(
                user_id=e.user_id,
                device_token=e.device_token,
                ws=e.ws,
                connected=e.ws is not None,
            )
            for e in matched_entries
        }
        room = Room(room_id=room_id, location=location, users=users)
        self.rooms[room_id] = room
        for uid in users:
            self.user_room_map[uid] = room_id

        # 현재 연결된 유저에게 WS로 즉시 알림
        match_payload = {
            "type": "MATCHED",
            "room_id": room_id,
            "location": location,
            "message": "4명이 매칭되었습니다! 1분 내에 입장하세요.",
            "deadline_seconds": MATCH_TIMEOUT_SECONDS,
        }
        for user in users.values():
            if user.ws:
                try:
                    await user.ws.send_json(match_payload)
                except Exception as e:
                    logger.warning(f"WS 알림 실패 [{user.user_id}]: {e}")

        # 백그라운드 유저를 포함한 전원에게 푸시 알림
        tokens = [e.device_token for e in matched_entries]
        asyncio.create_task(notify_match_found(room_id, location, tokens))

        # 60초 연결 타임아웃 시작
        room.connection_timeout_task = asyncio.create_task(
            self._connection_timeout(room_id)
        )
        logger.info(f"[룸:{room_id}] 생성 완료 | {location} | 60초 타임아웃 시작")

    # ─── 입장 ────────────────────────────────────────────────────────────────

    async def join_room(self, room_id: str, user_id: str, ws: WebSocket) -> bool:
        room = self.rooms.get(room_id)
        if not room:
            await ws.send_json({"type": "ERROR", "code": "ROOM_NOT_FOUND", "room_id": room_id})
            return False
        if room.status == RoomStatus.DESTROYED:
            await ws.send_json({"type": "ERROR", "code": "ROOM_DESTROYED", "room_id": room_id})
            return False
        if user_id not in room.users:
            await ws.send_json({"type": "ERROR", "code": "NOT_IN_ROOM"})
            return False

        user = room.users[user_id]
        user.ws = ws
        user.connected = True
        user.disconnected_at = None

        # 재접속 유예 타이머 취소
        task = room.reconnect_tasks.pop(user_id, None)
        if task:
            task.cancel()

        all_user_ids = list(room.users.keys())
        connected_ids = [uid for uid, u in room.users.items() if u.connected]

        join_payload: dict = {
            "type": "ROOM_JOINED",
            "room_id": room_id,
            "status": room.status,
            "all_users": all_user_ids,
            "connected_users": connected_ids,
            "total_users": len(room.users),
        }

        # 폭탄 상태로 재입장: 남은 시간 포함
        if room.status == RoomStatus.TIMEBOMB and room.timebomb_started_at:
            import time as _time
            from config import TIMEBOMB_SECONDS
            elapsed = (datetime.utcnow() - room.timebomb_started_at).total_seconds()
            join_payload["timebomb_remaining_seconds"] = max(0, int(TIMEBOMB_SECONDS - elapsed))

        await ws.send_json(join_payload)

        # 다른 연결된 멤버에게 입장자 알림
        await self._broadcast(room_id, {
            "type": "USER_CONNECTED",
            "user_id": user_id,
            "connected_users": connected_ids,
        }, exclude=user_id)

        if room.status == RoomStatus.MATCHED_WAITING:
            if len(connected_ids) == len(room.users):
                await self._activate_room(room_id)
        elif room.status == RoomStatus.TIMEBOMB:
            if len(connected_ids) == len(room.users):
                await self._cancel_timebomb(room_id)

        return True

    # ─── 메시지 중계 ─────────────────────────────────────────────────────────

    async def relay_message(self, room_id: str, sender_id: str, message: dict) -> None:
        room = self.rooms.get(room_id)
        if not room or room.status not in (RoomStatus.ACTIVE, RoomStatus.TIMEBOMB):
            return

        payload = {**message, "sender_id": sender_id}
        target_id = message.get("target_user_id")

        if target_id:
            # WebRTC 시그널링: 특정 유저에게만 전달
            target = room.users.get(target_id)
            if target and target.ws and target.connected:
                try:
                    await target.ws.send_json(payload)
                except Exception as e:
                    logger.warning(f"[룸:{room_id}] 시그널 릴레이 실패 → {target_id}: {e}")
        else:
            # 텍스트 채팅: 나머지 전원에게 브로드캐스트
            for uid, user in room.users.items():
                if uid != sender_id and user.ws and user.connected:
                    try:
                        await user.ws.send_json(payload)
                    except Exception as e:
                        logger.warning(f"[룸:{room_id}] 브로드캐스트 실패 → {uid}: {e}")

    # ─── 연결 해제 처리 ───────────────────────────────────────────────────────

    async def handle_disconnect(self, room_id: str, user_id: str) -> None:
        """WebSocket 연결이 끊겼을 때 — 재접속 유예 후 폭탄 트리거."""
        room = self.rooms.get(room_id)
        if not room or room.status in (RoomStatus.DESTROYED, RoomStatus.MATCHED_WAITING):
            return

        user = room.users.get(user_id)
        if not user:
            return

        user.connected = False
        user.disconnected_at = datetime.utcnow()
        user.ws = None

        logger.info(f"[룸:{room_id}] {user_id} 연결 끊김")

        if room.status == RoomStatus.ACTIVE:
            task = asyncio.create_task(self._reconnect_grace(room_id, user_id))
            room.reconnect_tasks[user_id] = task

    async def handle_leave(self, room_id: str, user_id: str) -> None:
        """명시적 퇴장 — 즉시 폭탄 트리거."""
        room = self.rooms.get(room_id)
        if not room or room.status == RoomStatus.DESTROYED:
            return

        user = room.users.get(user_id)
        if user:
            user.connected = False
            user.ws = None

        logger.info(f"[룸:{room_id}] {user_id} 명시적 퇴장 → 즉시 폭탄")

        if room.status == RoomStatus.ACTIVE:
            await self._trigger_timebomb(room_id, user_id, reason="explicit_leave")

    # ─── 유틸 ────────────────────────────────────────────────────────────────

    def get_user_room(self, user_id: str) -> Optional[str]:
        return self.user_room_map.get(user_id)

    # ─── Private lifecycle ───────────────────────────────────────────────────

    async def _activate_room(self, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return

        if room.connection_timeout_task:
            room.connection_timeout_task.cancel()
            room.connection_timeout_task = None

        room.status = RoomStatus.ACTIVE
        room.activated_at = datetime.utcnow()
        logger.info(f"[룸:{room_id}] ACTIVE — 채팅 시작")

        await self._broadcast(room_id, {
            "type": "ROOM_ACTIVE",
            "room_id": room_id,
            "users": [uid for uid in room.users],
            "message": "4명 모두 입장! 대화를 시작하세요.",
        })

    async def _connection_timeout(self, room_id: str) -> None:
        """60초 내 전원 미입장 시 매칭 무효."""
        await asyncio.sleep(MATCH_TIMEOUT_SECONDS)

        room = self.rooms.get(room_id)
        if not room or room.status != RoomStatus.MATCHED_WAITING:
            return

        missing = [uid for uid, u in room.users.items() if not u.connected]
        logger.info(f"[룸:{room_id}] 연결 타임아웃 | 미입장: {missing}")

        # 패널티 대상 유저 정보 포함
        await self._broadcast(room_id, {
            "type": "MATCH_FAILED",
            "reason": "connection_timeout",
            "missing_user_ids": missing,
            "message": "1분 내에 전원이 입장하지 않아 매칭이 취소되었습니다.",
        })

        # 미입장 유저에게도 푸시 (패널티 안내)
        penalty_tokens = [room.users[uid].device_token for uid in missing]
        if penalty_tokens:
            asyncio.create_task(notify_match_failed(penalty_tokens))

        await self._destroy_room(room_id)

    async def _reconnect_grace(self, room_id: str, user_id: str) -> None:
        """연결 끊김 후 RECONNECT_GRACE_SECONDS 동안 재접속 기다림."""
        await asyncio.sleep(RECONNECT_GRACE_SECONDS)

        room = self.rooms.get(room_id)
        if not room:
            return

        user = room.users.get(user_id)
        if not user or user.connected:
            return  # 유예 시간 내 재접속 성공

        logger.info(f"[룸:{room_id}] {user_id} 유예 초과 → 폭탄 트리거")
        await self._trigger_timebomb(room_id, user_id, reason="reconnect_timeout")

    async def _trigger_timebomb(self, room_id: str, trigger_user_id: str, reason: str = "") -> None:
        room = self.rooms.get(room_id)
        if not room or room.status in (RoomStatus.TIMEBOMB, RoomStatus.DESTROYED):
            return

        room.status = RoomStatus.TIMEBOMB
        room.timebomb_started_at = datetime.utcnow()
        logger.info(f"[룸:{room_id}] ⏰ TIMEBOMB 시작 (trigger={trigger_user_id}, reason={reason})")

        await self._broadcast(room_id, {
            "type": "TIMEBOMB_TRIGGERED",
            "room_id": room_id,
            "trigger_user_id": trigger_user_id,
            "reason": reason,
            "countdown_seconds": TIMEBOMB_SECONDS,
            "message": f"한 명이 나갔습니다. {TIMEBOMB_SECONDS}초 후 방이 폭파됩니다.",
        })

        room.timebomb_task = asyncio.create_task(self._timebomb_countdown(room_id))

    async def _timebomb_countdown(self, room_id: str) -> None:
        await asyncio.sleep(TIMEBOMB_SECONDS)

        room = self.rooms.get(room_id)
        if not room or room.status != RoomStatus.TIMEBOMB:
            return

        logger.info(f"[룸:{room_id}] 💥 폭탄 폭발 — 방 파괴")
        await self._broadcast(room_id, {
            "type": "ROOM_DESTROYED",
            "room_id": room_id,
            "reason": "timebomb_detonated",
            "message": "방이 종료되었습니다.",
        })
        await self._destroy_room(room_id)

    async def _cancel_timebomb(self, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return

        if room.timebomb_task:
            room.timebomb_task.cancel()
            room.timebomb_task = None

        room.status = RoomStatus.ACTIVE
        logger.info(f"[룸:{room_id}] 폭탄 해제 — 전원 재접속")

        await self._broadcast(room_id, {
            "type": "TIMEBOMB_CANCELLED",
            "room_id": room_id,
            "message": "모두 돌아왔습니다! 대화를 계속합니다.",
        })

    async def _broadcast(self, room_id: str, message: dict, exclude: Optional[str] = None) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return
        for uid, user in room.users.items():
            if uid == exclude:
                continue
            if user.ws and user.connected:
                try:
                    await user.ws.send_json(message)
                except Exception as e:
                    logger.warning(f"[룸:{room_id}] 브로드캐스트 실패 [{uid}]: {e}")

    async def _destroy_room(self, room_id: str) -> None:
        room = self.rooms.pop(room_id, None)
        if not room:
            return

        if room.connection_timeout_task:
            room.connection_timeout_task.cancel()
        if room.timebomb_task:
            room.timebomb_task.cancel()
        for task in room.reconnect_tasks.values():
            task.cancel()

        for uid in room.users:
            self.user_room_map.pop(uid, None)

        logger.info(f"[룸:{room_id}] 메모리 완전 초기화 ✓")
