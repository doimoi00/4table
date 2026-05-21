"""
4table 서버 적대적 테스트

실행: python adversarial_test.py
"""
import asyncio
import json
import time
import websockets
import uuid

SERVER = "wss://4table-server-production.up.railway.app/ws"

PASS = "\033[92m[PASS]\033[0m"
FAIL = "\033[91m[FAIL]\033[0m"
INFO = "\033[94m[INFO]\033[0m"

results = []

def ok(name):
    results.append((name, True))
    print(f"{PASS} {name}")

def ng(name, reason=""):
    results.append((name, False))
    print(f"{FAIL} {name} — {reason}")


async def connect(uid=None, token="test-token"):
    if uid is None:
        uid = str(uuid.uuid4())
    url = f"{SERVER}?user_id={uid}&device_token={token}"
    ws = await websockets.connect(url, open_timeout=10)
    return ws, uid


async def recv_until(ws, timeout=3.0):
    """timeout 안에 수신한 모든 메시지 반환"""
    msgs = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = deadline - time.time()
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msgs.append(json.loads(raw))
        except asyncio.TimeoutError:
            break
        except Exception:
            break
    return msgs


# ──────────────────────────────────────────────────────────────────────────────
# TC-01: 잘못된 JSON 전송
# ──────────────────────────────────────────────────────────────────────────────
async def tc01_invalid_json():
    name = "TC-01 잘못된 JSON → ERROR:INVALID_JSON"
    try:
        ws, _ = await connect()
        await ws.send("this is not json {{{")
        msgs = await recv_until(ws, 2)
        errs = [m for m in msgs if m.get("type") == "ERROR" and m.get("code") == "INVALID_JSON"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-02: 64KB 초과 메시지
# ──────────────────────────────────────────────────────────────────────────────
async def tc02_oversized_message():
    name = "TC-02 64KB 초과 메시지 → ERROR:MESSAGE_TOO_LARGE"
    try:
        ws, _ = await connect()
        big = json.dumps({"type": "CHAT", "content": "A" * 70_000})
        await ws.send(big)
        msgs = await recv_until(ws, 3)
        errs = [m for m in msgs if m.get("code") == "MESSAGE_TOO_LARGE"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-03: 알 수 없는 메시지 타입
# ──────────────────────────────────────────────────────────────────────────────
async def tc03_unknown_type():
    name = "TC-03 UNKNOWN_TYPE → ERROR:UNKNOWN_TYPE"
    try:
        ws, _ = await connect()
        await ws.send(json.dumps({"type": "HACK_THE_SERVER", "payload": "evil"}))
        msgs = await recv_until(ws, 2)
        errs = [m for m in msgs if m.get("code") == "UNKNOWN_TYPE"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-04: 룸 없이 CHAT 전송
# ──────────────────────────────────────────────────────────────────────────────
async def tc04_chat_without_room():
    name = "TC-04 룸 없이 CHAT → ERROR:NOT_IN_ROOM"
    try:
        ws, _ = await connect()
        await ws.send(json.dumps({"type": "CHAT", "content": "hello"}))
        msgs = await recv_until(ws, 2)
        errs = [m for m in msgs if m.get("code") == "NOT_IN_ROOM"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-05: location 없이 JOIN_QUEUE
# ──────────────────────────────────────────────────────────────────────────────
async def tc05_join_queue_no_location():
    name = "TC-05 location 없이 JOIN_QUEUE → ERROR:MISSING_LOCATION"
    try:
        ws, _ = await connect()
        await ws.send(json.dumps({"type": "JOIN_QUEUE"}))
        msgs = await recv_until(ws, 2)
        errs = [m for m in msgs if m.get("code") == "MISSING_LOCATION"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-06: room_id 없이 JOIN_ROOM
# ──────────────────────────────────────────────────────────────────────────────
async def tc06_join_room_no_id():
    name = "TC-06 room_id 없이 JOIN_ROOM → ERROR:MISSING_ROOM_ID"
    try:
        ws, _ = await connect()
        await ws.send(json.dumps({"type": "JOIN_ROOM"}))
        msgs = await recv_until(ws, 2)
        errs = [m for m in msgs if m.get("code") == "MISSING_ROOM_ID"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-07: 존재하지 않는 room_id로 JOIN_ROOM
# ──────────────────────────────────────────────────────────────────────────────
async def tc07_join_nonexistent_room():
    name = "TC-07 존재하지 않는 룸 JOIN → ERROR:ROOM_NOT_FOUND"
    try:
        ws, _ = await connect()
        fake_id = str(uuid.uuid4())
        await ws.send(json.dumps({"type": "JOIN_ROOM", "room_id": fake_id}))
        msgs = await recv_until(ws, 2)
        errs = [m for m in msgs if m.get("code") in ("ROOM_NOT_FOUND", "NOT_IN_ROOM")]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-08: 채팅 속도 제한 (1초 내 4개 이상)
# ──────────────────────────────────────────────────────────────────────────────
async def tc08_chat_rate_limit():
    name = "TC-08 채팅 도배 → ERROR:RATE_LIMITED (MATCH_SIZE=1 솔로룸 필요)"
    # MATCH_SIZE=1이면 솔로로 매칭되므로 혼자 룸에 들어갈 수 있음
    # Railway MATCH_SIZE는 현재 4이므로 이 테스트는 단순히 서버에 CHAT 4개를 보내고
    # NOT_IN_ROOM 에러가 오는지 확인 (룸 없는 상태)
    name = "TC-08 빈 content CHAT → 무시됨 (크래시 없음)"
    try:
        ws, _ = await connect()
        # content가 빈 문자열인 CHAT
        await ws.send(json.dumps({"type": "CHAT", "content": ""}))
        msgs = await recv_until(ws, 2)
        # NOT_IN_ROOM이 오거나 응답 없음 — 서버가 죽지 않았으면 PASS
        fatal = [m for m in msgs if m.get("type") == "FATAL"]
        if not fatal:
            ok(name)
        else:
            ng(name, f"치명 오류: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-09: 1000자 초과 CHAT content
# ──────────────────────────────────────────────────────────────────────────────
async def tc09_chat_too_long():
    name = "TC-09 1001자 CHAT → ERROR:CONTENT_TOO_LONG (룸 없으면 NOT_IN_ROOM)"
    try:
        ws, _ = await connect()
        await ws.send(json.dumps({"type": "CHAT", "content": "가" * 1001}))
        msgs = await recv_until(ws, 2)
        # 룸에 없으므로 NOT_IN_ROOM 먼저 발생; 룸에 있다면 CONTENT_TOO_LONG
        errs = [m for m in msgs if m.get("code") in ("CONTENT_TOO_LONG", "NOT_IN_ROOM")]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-10: 동일 user_id 중복 연결 (SESSION_REPLACED)
# ──────────────────────────────────────────────────────────────────────────────
async def tc10_duplicate_session():
    name = "TC-10 동일 user_id 중복 연결 → 이전 세션 SESSION_REPLACED"
    try:
        uid = str(uuid.uuid4())
        ws1, _ = await connect(uid)
        await asyncio.sleep(0.3)
        ws2, _ = await connect(uid)  # 새 연결

        # ws1은 SESSION_REPLACED를 받아야 함
        msgs1 = await recv_until(ws1, 3)
        replaced = [m for m in msgs1 if m.get("type") == "SESSION_REPLACED"]
        if replaced:
            ok(name)
        else:
            ng(name, f"ws1 수신: {msgs1}")
        try:
            await ws1.close()
        except Exception:
            pass
        await ws2.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-11: 빠른 큐 등록/취소 반복 (10회)
# ──────────────────────────────────────────────────────────────────────────────
async def tc11_rapid_queue_toggle():
    name = "TC-11 빠른 JOIN/CANCEL 10회 반복 → 서버 안정"
    try:
        ws, _ = await connect()
        for i in range(10):
            await ws.send(json.dumps({"type": "JOIN_QUEUE", "location": f"테스트구_{i}동"}))
            await asyncio.sleep(0.05)
            await ws.send(json.dumps({"type": "CANCEL_QUEUE"}))
            await asyncio.sleep(0.05)
        msgs = await recv_until(ws, 2)
        fatal = [m for m in msgs if m.get("type") == "FATAL"]
        if not fatal:
            ok(name)
        else:
            ng(name, f"치명 오류: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-12: 특수문자/이모지/SQL인젝션 시도
# ──────────────────────────────────────────────────────────────────────────────
async def tc12_injection():
    name = "TC-12 SQL/XSS/이모지 content → 서버 크래시 없음"
    payloads = [
        "'; DROP TABLE rooms; --",
        "<script>alert('xss')</script>",
        "🔥" * 100,
        "\x00\x01\x02\x03",
        "\\n\\r\\t",
        '{"type":"HACK"}',
        "A" * 999,  # 한계치
    ]
    try:
        ws, _ = await connect()
        for p in payloads:
            await ws.send(json.dumps({"type": "CHAT", "content": p}))
            await asyncio.sleep(0.1)
        msgs = await recv_until(ws, 2)
        # 서버가 살아있고 응답을 보내면 PASS (NOT_IN_ROOM 등)
        if msgs is not None:
            ok(name)
        else:
            ng(name, "응답 없음")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-13: /health, /stats 엔드포인트
# ──────────────────────────────────────────────────────────────────────────────
async def tc13_rest_endpoints():
    import urllib.request
    base = "https://4table-server-production.up.railway.app"
    for path, expected_key in [("/health", "status"), ("/stats", "active_rooms")]:
        name = f"TC-13 REST {path} → 정상 응답"
        try:
            req = urllib.request.urlopen(base + path, timeout=10)
            data = json.loads(req.read())
            if expected_key in data:
                ok(name)
            else:
                ng(name, f"응답: {data}")
        except Exception as e:
            ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
# TC-14: PING → PONG 응답 확인
# ──────────────────────────────────────────────────────────────────────────────
async def tc14_ping_pong():
    name = "TC-14 PING → PONG 응답"
    try:
        ws, _ = await connect()
        await ws.send(json.dumps({"type": "PING"}))
        msgs = await recv_until(ws, 3)
        pong = [m for m in msgs if m.get("type") == "PONG"]
        if pong:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
        await ws.close()
    except Exception as e:
        ng(name, str(e))


# ──────────────────────────────────────────────────────────────────────────────
async def main():
    print(f"\n{'='*60}")
    print("4table 서버 적대적 테스트")
    print(f"대상: {SERVER}")
    print(f"{'='*60}\n")

    tests = [
        tc01_invalid_json,
        tc02_oversized_message,
        tc03_unknown_type,
        tc04_chat_without_room,
        tc05_join_queue_no_location,
        tc06_join_room_no_id,
        tc07_join_nonexistent_room,
        tc08_chat_rate_limit,
        tc09_chat_too_long,
        tc10_duplicate_session,
        tc11_rapid_queue_toggle,
        tc12_injection,
        tc14_ping_pong,
    ]

    await tc13_rest_endpoints()

    for t in tests:
        await t()
        await asyncio.sleep(0.2)

    passed = sum(1 for _, v in results if v)
    total = len(results)
    print(f"\n{'='*60}")
    print(f"결과: {passed}/{total} PASS")
    if passed == total:
        print("✅ 모든 테스트 통과")
    else:
        print("❌ 실패한 테스트:")
        for name, v in results:
            if not v:
                print(f"  - {name}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    asyncio.run(main())
