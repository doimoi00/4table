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
import time
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import WebSocket

from config import MATCH_TIMEOUT_SECONDS, RECONNECT_GRACE_SECONDS, TIMEBOMB_SECONDS
from models import Room, RoomStatus, RoomUser
from push_service import notify_match_failed, notify_match_found, notify_timebomb_triggered

logger = logging.getLogger(__name__)

# 채팅 도배 방지: 1초 내 최대 메시지 수
CHAT_RATE_LIMIT = 3
CHAT_RATE_WINDOW = 1.0  # seconds

# 메시지 히스토리 최대 저장 수
MAX_HISTORY = 50

# 유효한 이모지 리액션 목록
VALID_EMOJIS = {"👍", "❤️", "😂", "😮", "😢", "😡"}


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

        tokens = [e.device_token for e in matched_entries]
        asyncio.create_task(notify_match_found(room_id, location, tokens))

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
        if user_id not in room.users or self.user_room_map.get(user_id) != room_id:
            await ws.send_json({"type": "ERROR", "code": "NOT_IN_ROOM"})
            return False

        user = room.users[user_id]
        user.ws = ws
        user.connected = True
        user.disconnected_at = None

        task = room.reconnect_tasks.pop(user_id, None)
        if task:
            task.cancel()

        all_user_ids = list(room.users.keys())
        connected_ids = [uid for uid, u in room.users.items() if u.connected]

        voice_user_ids = [uid for uid, u in room.users.items() if u.voice_active]
        join_payload: dict = {
            "type": "ROOM_JOINED",
            "room_id": room_id,
            "status": room.status,
            "all_users": all_user_ids,
            "connected_users": connected_ids,
            "total_users": len(room.users),
            "message_history": room.message_history,  # 채팅 히스토리 전송
            "voice_users": voice_user_ids,
        }

        # 폭탄 상태로 재입장: 남은 시간 포함
        if room.status == RoomStatus.TIMEBOMB and room.timebomb_started_at:
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

    async def relay_message(
        self, room_id: str, sender_id: str, message: dict
    ) -> bool:
        """채팅/시그널 메시지를 중계합니다. 채팅 속도 제한 위반 시 False 반환."""
        room = self.rooms.get(room_id)
        if not room or room.status not in (RoomStatus.ACTIVE, RoomStatus.TIMEBOMB):
            return True

        msg_type = message.get("type")

        # 텍스트 채팅: 도배 방지 + 히스토리 저장
        if msg_type == "CHAT":
            if not self._check_chat_rate(room, sender_id):
                return False  # 속도 제한 초과

            # 클라이언트가 보낸 msg_id 사용 (없으면 서버에서 생성)
            msg_id = (message.get("msg_id") or "").strip()
            if not msg_id:
                import uuid as _uuid
                msg_id = str(_uuid.uuid4())[:12]

            payload = {**message, "sender_id": sender_id, "msg_id": msg_id, "reactions": {}}
            # 히스토리에 저장 (최대 MAX_HISTORY개)
            room.message_history.append(payload)
            if len(room.message_history) > MAX_HISTORY:
                room.message_history.pop(0)

            for uid, user in room.users.items():
                if uid != sender_id and user.ws and user.connected:
                    try:
                        await user.ws.send_json(payload)
                    except Exception as e:
                        logger.warning(f"[룸:{room_id}] 채팅 릴레이 실패 → {uid}: {e}")
            return True

        # WebRTC 시그널링: target_user_id에게만 전달
        payload = {**message, "sender_id": sender_id}
        target_id = message.get("target_user_id")
        if target_id:
            target = room.users.get(target_id)
            if target and target.ws and target.connected:
                try:
                    await target.ws.send_json(payload)
                except Exception as e:
                    logger.warning(f"[룸:{room_id}] 시그널 릴레이 실패 → {target_id}: {e}")
        else:
            for uid, user in room.users.items():
                if uid != sender_id and user.ws and user.connected:
                    try:
                        await user.ws.send_json(payload)
                    except Exception as e:
                        logger.warning(f"[룸:{room_id}] 브로드캐스트 실패 → {uid}: {e}")
        return True

    async def relay_react(
        self, room_id: str, sender_id: str, message_id: str, emoji: str
    ) -> tuple[bool, str]:
        """이모지 리액션을 중계하고 히스토리에도 반영합니다. (ok, error_code) 반환."""
        if emoji not in VALID_EMOJIS:
            return False, "INVALID_EMOJI"
        room = self.rooms.get(room_id)
        if not room or room.status not in (RoomStatus.ACTIVE, RoomStatus.TIMEBOMB):
            return False, "ROOM_NOT_ACTIVE"

        # 히스토리에서 해당 메시지 탐색 — 없으면 유령 리액션 방지
        found = False
        for msg in room.message_history:
            if msg.get("msg_id") == message_id:
                reactions = msg.setdefault("reactions", {})
                uids: list = reactions.setdefault(emoji, [])
                if sender_id in uids:
                    uids.remove(sender_id)
                else:
                    uids.append(sender_id)
                found = True
                break

        if not found:
            return False, "MESSAGE_NOT_FOUND"

        await self._broadcast(room_id, {
            "type": "REACT",
            "message_id": message_id,
            "sender_id": sender_id,
            "emoji": emoji,
        })
        return True, ""

    async def relay_voice_status(self, room_id: str, user_id: str, active: bool) -> None:
        """음성 채팅 참여 상태를 저장하고 룸 멤버에게 브로드캐스트."""
        room = self.rooms.get(room_id)
        if not room or room.status not in (RoomStatus.ACTIVE, RoomStatus.TIMEBOMB):
            return
        user = room.users.get(user_id)
        if user:
            user.voice_active = active
        await self._broadcast(room_id, {
            "type": "VOICE_STATUS",
            "user_id": user_id,
            "active": active,
        }, exclude=user_id)

    async def relay_typing(self, room_id: str, user_id: str, is_typing: bool) -> None:
        """타이핑 상태를 나머지 멤버에게 중계."""
        room = self.rooms.get(room_id)
        if not room or room.status not in (RoomStatus.ACTIVE, RoomStatus.TIMEBOMB):
            return
        await self._broadcast(room_id, {
            "type": "TYPING",
            "user_id": user_id,
            "is_typing": is_typing,
        }, exclude=user_id)

    # ─── 연결 해제 처리 ───────────────────────────────────────────────────────

    async def handle_disconnect(self, room_id: str, user_id: str, ws=None) -> None:
        """WebSocket 연결이 끊겼을 때 — 재접속 유예 후 폭탄 트리거."""
        room = self.rooms.get(room_id)
        if not room or room.status in (RoomStatus.DESTROYED, RoomStatus.MATCHED_WAITING):
            return

        user = room.users.get(user_id)
        if not user:
            return

        # SESSION_REPLACED 레이스 방지: 새 WS가 이미 연결된 경우 무시
        if ws is not None and user.ws is not None and user.ws is not ws:
            logger.info(f"[룸:{room_id}] {user_id} 연결 해제 무시 (새 WS로 교체됨)")
            return

        user.connected = False
        user.disconnected_at = datetime.utcnow()
        user.ws = None

        connected_ids = [uid for uid, u in room.users.items() if u.connected]
        logger.info(f"[룸:{room_id}] {user_id} 연결 끊김 (연결 중: {len(connected_ids)}명)")

        await self._broadcast(room_id, {
            "type": "USER_DISCONNECTED",
            "user_id": user_id,
            "connected_users": connected_ids,
        })

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

        # 명시적 퇴장은 재접속을 허용하지 않으므로 user_room_map에서 제거.
        # 제거하지 않으면 WS 재접속 시 auto-rejoin으로 TIMEBOMB 해제 버그 발생.
        self.user_room_map.pop(user_id, None)

        logger.info(f"[룸:{room_id}] {user_id} 명시적 퇴장 → 즉시 폭탄")

        if room.status in (RoomStatus.ACTIVE, RoomStatus.TIMEBOMB):
            await self._trigger_timebomb(room_id, user_id, reason="explicit_leave")

    # ─── 유틸 ────────────────────────────────────────────────────────────────

    def get_user_room(self, user_id: str) -> Optional[str]:
        return self.user_room_map.get(user_id)

    def is_room_member(self, room_id: str, user_id: str) -> bool:
        room = self.rooms.get(room_id)
        return room is not None and user_id in room.users

    # ─── Private ─────────────────────────────────────────────────────────────

    @staticmethod
    def _check_chat_rate(room: Room, user_id: str) -> bool:
        """채팅 속도 제한 확인. 1초 내 CHAT_RATE_LIMIT 초과 시 False."""
        user = room.users.get(user_id)
        if not user:
            return False
        now = time.monotonic()
        q = user.chat_timestamps
        while q and now - q[0] > CHAT_RATE_WINDOW:
            q.popleft()
        if len(q) >= CHAT_RATE_LIMIT:
            return False
        q.append(now)
        return True

    async def _activate_room(self, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return

        if room.connection_timeout_task:
            room.connection_timeout_task.cancel()
            room.connection_timeout_task = None

        room.status = RoomStatus.ACTIVE
        room.activated_at = datetime.utcnow()
        room.timebomb_started_at = None  # 이전 timebomb 잔재 초기화
        logger.info(f"[룸:{room_id}] ACTIVE — 채팅 시작")

        await self._broadcast(room_id, {
            "type": "ROOM_ACTIVE",
            "room_id": room_id,
            "users": list(room.users),
            "message": "4명 모두 입장! 대화를 시작하세요.",
        })

    async def _connection_timeout(self, room_id: str) -> None:
        await asyncio.sleep(MATCH_TIMEOUT_SECONDS)

        room = self.rooms.get(room_id)
        if not room or room.status != RoomStatus.MATCHED_WAITING:
            return

        missing = [uid for uid, u in room.users.items() if not u.connected]
        logger.info(f"[룸:{room_id}] 연결 타임아웃 | 미입장: {missing}")

        await self._broadcast(room_id, {
            "type": "MATCH_FAILED",
            "reason": "connection_timeout",
            "missing_user_ids": missing,
            "message": "1분 내에 전원이 입장하지 않아 매칭이 취소되었습니다.",
        })

        penalty_tokens = [room.users[uid].device_token for uid in missing]
        if penalty_tokens:
            asyncio.create_task(notify_match_failed(penalty_tokens))

        await self._destroy_room(room_id)

    async def _reconnect_grace(self, room_id: str, user_id: str) -> None:
        await asyncio.sleep(RECONNECT_GRACE_SECONDS)

        room = self.rooms.get(room_id)
        if not room:
            return

        user = room.users.get(user_id)
        if not user or user.connected:
            return

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

        # 오프라인 유저에게 푸시 알림
        offline_tokens = [
            u.device_token for u in room.users.values()
            if not u.connected and u.device_token
        ]
        if offline_tokens:
            asyncio.create_task(notify_timebomb_triggered(room_id, offline_tokens, TIMEBOMB_SECONDS))

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
        room.timebomb_started_at = None  # 폭탄 해제 시 시작 시각 초기화
        logger.info(f"[룸:{room_id}] 폭탄 해제 — 전원 재접속")

        await self._broadcast(room_id, {
            "type": "TIMEBOMB_CANCELLED",
            "room_id": room_id,
            "message": "모두 돌아왔습니다! 대화를 계속합니다.",
        })

    async def _broadcast(
        self, room_id: str, message: dict, exclude: Optional[str] = None
    ) -> None:
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
