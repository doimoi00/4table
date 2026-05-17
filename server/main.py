"""
4table 백엔드 서버 — FastAPI + WebSocket

실행:
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload

WebSocket 연결:
  ws://host:8000/ws?user_id=<uid>&device_token=<fcm_token>
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from matchmaker import MatchMaker
from room_manager import RoomManager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

room_manager = RoomManager()
matchmaker = MatchMaker(room_manager)

# 메시지 크기 한계 (bytes)
MAX_MESSAGE_BYTES = 64_000   # 64KB — SIGNAL/SDP 최대 크기
MAX_CHAT_LENGTH = 1_000      # 채팅 텍스트 최대 길이 (문자)

# 서버→클라이언트 ping 주기/타임아웃
SERVER_PING_INTERVAL = 30    # 초마다 ping 발송
SERVER_PING_TIMEOUT = 15     # ping 후 N초 안에 응답 없으면 연결 종료


@asynccontextmanager
async def lifespan(app: FastAPI):
    await matchmaker.start()
    logger.info("✅ 4table 서버 시작")
    yield
    await matchmaker.stop()
    logger.info("4table 서버 종료")


app = FastAPI(title="4table Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── REST Endpoints ───────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/stats")
async def stats():
    queue_stats = {
        loc: len(q)
        for loc, q in matchmaker.local_queues.items()
        if q
    }
    return {
        "active_rooms": len(room_manager.rooms),
        "rooms_by_status": {
            status: sum(1 for r in room_manager.rooms.values() if r.status == status)
            for status in ["MATCHED_WAITING_FOR_CONNECTIONS", "ACTIVE", "TIMEBOMB"]
        },
        "queue_by_location": queue_stats,
        "total_queued": sum(queue_stats.values()),
    }


# ─── WS 세션 레지스트리 (user_id → ws, 중복 연결 처리용) ─────────────────────

_active_sessions: dict[str, WebSocket] = {}


async def _close_previous_session(user_id: str, new_ws: WebSocket) -> None:
    """같은 user_id로 새 연결이 들어오면 이전 WS를 강제 종료."""
    old_ws = _active_sessions.get(user_id)
    if old_ws and old_ws is not new_ws:
        try:
            await old_ws.send_json({"type": "SESSION_REPLACED"})
            await old_ws.close(code=4001)
        except Exception:
            pass
        logger.info(f"[WS 세션 교체] user={user_id} 이전 연결 종료")
    _active_sessions[user_id] = new_ws


# ─── 서버 사이드 ping (죽은 연결 감지) ───────────────────────────────────────

async def _keepalive_loop(user_id: str, ws: WebSocket, stop: asyncio.Event) -> None:
    """주기적으로 서버 ping을 보내고 타임아웃 시 연결 종료."""
    while not stop.is_set():
        await asyncio.sleep(SERVER_PING_INTERVAL)
        if stop.is_set():
            break
        try:
            await asyncio.wait_for(ws.send_json({"type": "PING"}), timeout=5)
        except Exception:
            logger.info(f"[Keepalive] user={user_id} ping 실패 → 연결 종료")
            try:
                await ws.close(code=1001)
            except Exception:
                pass
            stop.set()
            return

        # 타임아웃 대기 (클라이언트가 PONG 보내지 않아도 허용 — 연결 유지만 확인)
        await asyncio.sleep(SERVER_PING_TIMEOUT)


# ─── WebSocket Endpoint ───────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(
    ws: WebSocket,
    user_id: str = Query(..., description="유저 고유 ID"),
    device_token: str = Query(..., description="FCM 디바이스 토큰"),
):
    await ws.accept()
    logger.info(f"[WS 연결] user={user_id}")

    # 이전 세션 정리
    await _close_previous_session(user_id, ws)

    stop_keepalive = asyncio.Event()
    keepalive_task = asyncio.create_task(_keepalive_loop(user_id, ws, stop_keepalive))

    current_room_id: Optional[str] = None

    # 재접속: 이미 룸에 소속된 경우 자동 복귀
    existing_room_id = room_manager.get_user_room(user_id)
    if existing_room_id:
        success = await room_manager.join_room(existing_room_id, user_id, ws)
        if success:
            current_room_id = existing_room_id
            logger.info(f"[WS 재접속] user={user_id} → room={existing_room_id}")
    else:
        matchmaker.update_ws(user_id, ws)

    try:
        while True:
            raw = await ws.receive_text()

            # 메시지 크기 검사
            if len(raw.encode()) > MAX_MESSAGE_BYTES:
                await ws.send_json({"type": "ERROR", "code": "MESSAGE_TOO_LARGE"})
                continue

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "ERROR", "code": "INVALID_JSON"})
                continue

            msg_type = data.get("type", "")

            # ── 매칭 큐 ──────────────────────────────────────────────────────
            if msg_type == "JOIN_QUEUE":
                location = (data.get("location") or "").strip()
                if not location:
                    await ws.send_json({"type": "ERROR", "code": "MISSING_LOCATION"})
                    continue
                await matchmaker.join_queue(
                    user_id=user_id,
                    device_token=device_token,
                    location=location,
                    ws=ws,
                )

            elif msg_type == "CANCEL_QUEUE":
                removed = await matchmaker.cancel_queue(user_id)
                await ws.send_json({"type": "QUEUE_CANCELLED", "success": removed})

            # ── 방 입장 (푸시 받고 복귀) ─────────────────────────────────────
            elif msg_type == "JOIN_ROOM":
                room_id = data.get("room_id", "")
                if not room_id:
                    await ws.send_json({"type": "ERROR", "code": "MISSING_ROOM_ID"})
                    continue
                success = await room_manager.join_room(room_id, user_id, ws)
                if success:
                    current_room_id = room_id

            # ── 텍스트 채팅 ──────────────────────────────────────────────────
            elif msg_type == "CHAT":
                if not current_room_id:
                    await ws.send_json({"type": "ERROR", "code": "NOT_IN_ROOM"})
                    continue
                content = (data.get("content") or "").strip()
                if not content:
                    continue
                if len(content) > MAX_CHAT_LENGTH:
                    await ws.send_json({"type": "ERROR", "code": "CONTENT_TOO_LONG"})
                    continue
                ok = await room_manager.relay_message(
                    current_room_id,
                    user_id,
                    {"type": "CHAT", "content": content, "timestamp": data.get("timestamp")},
                )
                if not ok:
                    await ws.send_json({"type": "ERROR", "code": "RATE_LIMITED"})

            # ── 이모지 리액션 ─────────────────────────────────────────────────
            elif msg_type == "REACT":
                if not current_room_id:
                    await ws.send_json({"type": "ERROR", "code": "NOT_IN_ROOM"})
                    continue
                message_id = (data.get("message_id") or "").strip()
                emoji = (data.get("emoji") or "").strip()
                if not message_id or not emoji:
                    continue
                ok = await room_manager.relay_react(
                    current_room_id, user_id, message_id, emoji
                )
                if not ok:
                    await ws.send_json({"type": "ERROR", "code": "INVALID_EMOJI"})

            # ── WebRTC 시그널링 ───────────────────────────────────────────────
            elif msg_type == "SIGNAL":
                if not current_room_id:
                    await ws.send_json({"type": "ERROR", "code": "NOT_IN_ROOM"})
                    continue
                await room_manager.relay_message(
                    current_room_id,
                    user_id,
                    {
                        "type": "SIGNAL",
                        "signal_type": data.get("signal_type"),
                        "target_user_id": data.get("target_user_id"),
                        "payload": data.get("payload"),
                    },
                )

            # ── 타이핑 인디케이터 ─────────────────────────────────────────────
            elif msg_type == "TYPING":
                if current_room_id:
                    await room_manager.relay_typing(
                        current_room_id, user_id, bool(data.get("is_typing", False))
                    )

            # ── 명시적 퇴장 ──────────────────────────────────────────────────
            elif msg_type == "LEAVE":
                if current_room_id:
                    await room_manager.handle_leave(current_room_id, user_id)
                    current_room_id = None

            # ── 핑/퐁 ────────────────────────────────────────────────────────
            elif msg_type == "PING":
                await ws.send_json({"type": "PONG"})

            elif msg_type == "PONG":
                pass  # 서버 keepalive ping에 대한 클라이언트 응답 — 무시

            else:
                await ws.send_json({"type": "ERROR", "code": "UNKNOWN_TYPE", "received": msg_type})

    except WebSocketDisconnect:
        logger.info(f"[WS 해제] user={user_id}")
    except Exception as e:
        logger.error(f"[WS 오류] user={user_id}: {e}", exc_info=True)
    finally:
        stop_keepalive.set()
        keepalive_task.cancel()
        # SESSION_REPLACED 레이스 방지: 이 WS가 아직 active session인 경우만 정리
        if _active_sessions.get(user_id) is ws:
            _active_sessions.pop(user_id, None)
            matchmaker.update_ws(user_id, None)
        if current_room_id:
            await room_manager.handle_disconnect(current_room_id, user_id, ws)


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
