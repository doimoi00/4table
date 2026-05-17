"""
4table 백엔드 서버 — FastAPI + WebSocket

실행:
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload

WebSocket 연결:
  ws://host:8000/ws?user_id=<uid>&device_token=<fcm_token>
"""

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


# ─── WebSocket Endpoint ───────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(
    ws: WebSocket,
    user_id: str = Query(..., description="유저 고유 ID"),
    device_token: str = Query(..., description="FCM 디바이스 토큰"),
):
    await ws.accept()
    logger.info(f"[WS 연결] user={user_id}")

    current_room_id: Optional[str] = None

    # 재접속 처리: 이미 룸에 소속된 경우 자동 복귀
    existing_room_id = room_manager.get_user_room(user_id)
    if existing_room_id:
        success = await room_manager.join_room(existing_room_id, user_id, ws)
        if success:
            current_room_id = existing_room_id
            logger.info(f"[WS 재접속] user={user_id} → room={existing_room_id}")
    else:
        # 큐에 대기 중이었다면 WS 핸들 갱신 (백그라운드 → 포그라운드)
        matchmaker.update_ws(user_id, ws)

    try:
        while True:
            raw = await ws.receive_text()
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

            # ── 방 입장 (푸시 받고 복귀) ──────────────────────────────────────
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
                content = data.get("content", "")
                if not content:
                    continue
                await room_manager.relay_message(
                    current_room_id,
                    user_id,
                    {"type": "CHAT", "content": content, "timestamp": data.get("timestamp")},
                )

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
                        "signal_type": data.get("signal_type"),   # offer | answer | candidate
                        "target_user_id": data.get("target_user_id"),
                        "payload": data.get("payload"),
                    },
                )

            # ── 명시적 퇴장 ──────────────────────────────────────────────────
            elif msg_type == "LEAVE":
                if current_room_id:
                    await room_manager.handle_leave(current_room_id, user_id)
                    current_room_id = None

            # ── 핑/퐁 ────────────────────────────────────────────────────────
            elif msg_type == "PING":
                await ws.send_json({"type": "PONG"})

            else:
                await ws.send_json({"type": "ERROR", "code": "UNKNOWN_TYPE", "received": msg_type})

    except WebSocketDisconnect:
        logger.info(f"[WS 해제] user={user_id}")
    except Exception as e:
        logger.error(f"[WS 오류] user={user_id}: {e}", exc_info=True)
    finally:
        # 큐 대기 중: WS를 None으로 → 큐에서 제거하지 않음 (핵심 동작)
        matchmaker.update_ws(user_id, None)
        # 룸 활성 중: 재접속 유예 타이머 시작
        if current_room_id:
            await room_manager.handle_disconnect(current_room_id, user_id)


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
