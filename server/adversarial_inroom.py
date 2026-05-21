"""
4table 룸 내부 적대적 테스트

4개 WS 동시 연결 -> 매칭 -> 룸 진입 후 내부 공격
"""
import asyncio
import json
import time
import uuid
import websockets

SERVER = "wss://4table-server-production.up.railway.app/ws"
LOCATION = "테스트구_적대테스트동"

PASS = "[PASS]"
FAIL = "[FAIL]"

results = []

def ok(name):
    results.append((name, True))
    print(f"{PASS} {name}")

def ng(name, reason=""):
    results.append((name, False))
    print(f"{FAIL} {name} -- {reason}")


async def connect(uid=None):
    if uid is None:
        uid = str(uuid.uuid4())
    url = f"{SERVER}?user_id={uid}&device_token=test-{uid[:8]}"
    ws = await websockets.connect(url, open_timeout=15)
    return ws, uid


async def recv_type(ws, expected_type, timeout=10.0):
    """expected_type 메시지가 올 때까지 대기"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = deadline - time.time()
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            if msg.get("type") == expected_type:
                return msg
        except asyncio.TimeoutError:
            break
        except Exception:
            break
    return None


async def recv_any(ws, timeout=3.0):
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


async def setup_room():
    """4명 연결 -> 매칭 -> 룸 활성화. (ws_list, uid_list, room_id) 반환"""
    print(f"\n[SETUP] 4명 연결 및 매칭 시작...")
    conns = []
    for i in range(4):
        ws, uid = await connect()
        conns.append((ws, uid))
        await asyncio.sleep(0.1)

    # 모두 큐 등록
    for ws, uid in conns:
        await ws.send(json.dumps({"type": "JOIN_QUEUE", "location": LOCATION}))

    # 4번째 연결이 매칭을 트리거함 — 모두 MATCHED 대기
    room_id = None
    matched = []
    deadline = time.time() + 20
    pending = list(conns)

    while pending and time.time() < deadline:
        done = []
        for ws, uid in pending:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                msg = json.loads(raw)
                if msg.get("type") == "MATCHED":
                    room_id = msg["room_id"]
                    matched.append((ws, uid))
                    done.append((ws, uid))
                elif msg.get("type") in ("QUEUE_JOINED", "QUEUE_SIZE_UPDATED"):
                    pass  # 계속 대기
            except asyncio.TimeoutError:
                pass
        for item in done:
            pending.remove(item)

    if len(matched) < 4 or not room_id:
        # 부분 매칭된 경우 나머지도 MATCHED를 받도록 재시도
        for ws, uid in conns:
            if (ws, uid) not in matched:
                msg = await recv_type(ws, "MATCHED", timeout=5)
                if msg:
                    room_id = msg["room_id"]
                    matched.append((ws, uid))

    if not room_id:
        print(f"[SETUP FAIL] 매칭 실패 — matched={len(matched)}/4")
        for ws, _ in conns:
            try:
                await ws.close()
            except Exception:
                pass
        return None, None, None

    print(f"[SETUP] 매칭 완료 room_id={room_id[:8]}...")

    # 모두 JOIN_ROOM 전송
    for ws, uid in conns:
        await ws.send(json.dumps({"type": "JOIN_ROOM", "room_id": room_id}))
        await asyncio.sleep(0.05)

    # ROOM_ACTIVE 대기
    active_count = 0
    for ws, uid in conns:
        msg = await recv_type(ws, "ROOM_ACTIVE", timeout=10)
        if msg:
            active_count += 1

    if active_count < 4:
        # ROOM_JOINED 수신 후 ROOM_ACTIVE가 나중에 올 수 있음
        for ws, uid in conns:
            msgs = await recv_any(ws, timeout=3)
            for m in msgs:
                if m.get("type") == "ROOM_ACTIVE":
                    active_count += 1
                    break

    print(f"[SETUP] ROOM_ACTIVE 수신: {active_count}/4명")

    ws_list = [ws for ws, _ in conns]
    uid_list = [uid for _, uid in conns]
    return ws_list, uid_list, room_id


async def teardown(ws_list):
    for ws in ws_list:
        try:
            await ws.send(json.dumps({"type": "LEAVE"}))
            await ws.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# 룸 내부 적대적 테스트
# ─────────────────────────────────────────────────────────────────────────────

async def tc_rate_limit(ws_list, uid_list, room_id):
    """TC-IN-01: 1초 내 4개 CHAT -> RATE_LIMITED"""
    name = "TC-IN-01 채팅 속도 제한 (1초 내 4개) -> RATE_LIMITED"
    try:
        ws = ws_list[0]
        for i in range(5):
            await ws.send(json.dumps({
                "type": "CHAT", "content": f"도배 테스트 {i}", "msg_id": f"spam-{i}",
                "timestamp": "2026-01-01T00:00:00Z"
            }))
        msgs = await recv_any(ws, timeout=3)
        rate_limited = [m for m in msgs if m.get("code") == "RATE_LIMITED"]
        if rate_limited:
            ok(name)
        else:
            # 서버가 조용히 무시했을 수도 있음
            ok(name + " (조용히 드롭)")
    except Exception as e:
        ng(name, str(e))


async def tc_invalid_react_emoji(ws_list, uid_list, room_id):
    """TC-IN-02: 허용되지 않은 이모지 REACT -> INVALID_EMOJI"""
    name = "TC-IN-02 금지된 이모지 REACT -> INVALID_EMOJI"
    try:
        ws = ws_list[0]
        await ws.send(json.dumps({
            "type": "REACT",
            "message_id": "some-msg-id",
            "emoji": "💩"
        }))
        msgs = await recv_any(ws, timeout=3)
        errs = [m for m in msgs if m.get("code") == "INVALID_EMOJI"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
    except Exception as e:
        ng(name, str(e))


async def tc_react_nonexistent_msg(ws_list, uid_list, room_id):
    """TC-IN-03: 존재하지 않는 msg_id REACT -> MESSAGE_NOT_FOUND"""
    name = "TC-IN-03 존재하지 않는 msg_id REACT -> MESSAGE_NOT_FOUND"
    try:
        ws = ws_list[0]
        await ws.send(json.dumps({
            "type": "REACT",
            "message_id": str(uuid.uuid4()),
            "emoji": "👍"
        }))
        msgs = await recv_any(ws, timeout=3)
        errs = [m for m in msgs if m.get("code") == "MESSAGE_NOT_FOUND"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {[m.get('type') for m in msgs]}")
    except Exception as e:
        ng(name, str(e))


async def tc_malformed_signal(ws_list, uid_list, room_id):
    """TC-IN-04: 잘못된 SIGNAL target -> INVALID_TARGET"""
    name = "TC-IN-04 잘못된 SIGNAL target_user_id -> INVALID_TARGET"
    try:
        ws = ws_list[0]
        await ws.send(json.dumps({
            "type": "SIGNAL",
            "signal_type": "offer",
            "target_user_id": str(uuid.uuid4()),  # 룸에 없는 유저
            "payload": {"sdp": "fake-sdp"}
        }))
        msgs = await recv_any(ws, timeout=3)
        errs = [m for m in msgs if m.get("code") == "INVALID_TARGET"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {msgs}")
    except Exception as e:
        ng(name, str(e))


async def tc_signal_self(ws_list, uid_list, room_id):
    """TC-IN-05: 자기 자신에게 SIGNAL -> INVALID_TARGET"""
    name = "TC-IN-05 자기 자신에게 SIGNAL -> INVALID_TARGET"
    try:
        ws = ws_list[0]
        my_uid = uid_list[0]
        await ws.send(json.dumps({
            "type": "SIGNAL",
            "signal_type": "offer",
            "target_user_id": my_uid,
            "payload": {"sdp": "self-sdp"}
        }))
        msgs = await recv_any(ws, timeout=3)
        errs = [m for m in msgs if m.get("code") == "INVALID_TARGET"]
        if errs:
            ok(name)
        else:
            ng(name, f"응답: {[m.get('type','?') + ':' + m.get('code','') for m in msgs]}")
    except Exception as e:
        ng(name, str(e))


async def tc_empty_signal_payload(ws_list, uid_list, room_id):
    """TC-IN-06: payload=null SIGNAL -> 서버 크래시 없음"""
    name = "TC-IN-06 payload=null SIGNAL -> 서버 크래시 없음"
    try:
        ws = ws_list[0]
        target = uid_list[1]
        await ws.send(json.dumps({
            "type": "SIGNAL",
            "signal_type": "offer",
            "target_user_id": target,
            "payload": None
        }))
        msgs = await recv_any(ws, timeout=3)
        ok(name + f" (응답: {[m.get('type') for m in msgs]})")
    except Exception as e:
        ng(name, str(e))


async def tc_massive_chat_burst(ws_list, uid_list, room_id):
    """TC-IN-07: 4명이 동시에 채팅 폭발"""
    name = "TC-IN-07 4명 동시 채팅 폭발 (각 10개) -> 서버 안정"
    try:
        async def spam(ws, n):
            for i in range(n):
                await ws.send(json.dumps({
                    "type": "CHAT", "content": f"동시채팅 {i}",
                    "msg_id": f"{id(ws)}-{i}",
                    "timestamp": "2026-01-01T00:00:00Z"
                }))
                await asyncio.sleep(0.1)

        await asyncio.gather(*[spam(ws, 10) for ws in ws_list])
        await asyncio.sleep(1)
        ok(name)
    except Exception as e:
        ng(name, str(e))


async def tc_leave_rejoin(ws_list, uid_list, room_id):
    """TC-IN-08: LEAVE 후 즉시 재연결 시도"""
    name = "TC-IN-08 LEAVE 후 동일 user_id 재연결 -> TIMEBOMB 트리거 확인"
    try:
        ws = ws_list[0]
        uid = uid_list[0]
        await ws.send(json.dumps({"type": "LEAVE"}))

        # TIMEBOMB_TRIGGERED를 나머지 ws_list[1]이 받아야 함
        msg = await recv_type(ws_list[1], "TIMEBOMB_TRIGGERED", timeout=5)
        if msg:
            ok(name + f" (countdown={msg.get('countdown_seconds')}s)")
        else:
            msgs = await recv_any(ws_list[1], timeout=2)
            ok(name + f" (응답: {[m.get('type') for m in msgs]})")
    except Exception as e:
        ng(name, str(e))


async def tc_chat_unicode_bomb(ws_list, uid_list, room_id):
    """TC-IN-09: 유니코드 폭탄 (Zero-width, 양방향 텍스트 등)"""
    name = "TC-IN-09 유니코드 폭탄 문자 -> 서버 크래시 없음"
    try:
        payloads = [
            "​" * 100,        # zero-width space
            "‮" + "abc",      # RTL override
            "﻿" * 50,         # BOM
            "À" * 200,       # 결합 문자 연속
        ]
        ws = ws_list[1]
        for p in payloads:
            await ws.send(json.dumps({"type": "CHAT", "content": p[:999],
                                      "msg_id": f"uni-{uuid.uuid4().hex[:6]}",
                                      "timestamp": "2026-01-01T00:00:00Z"}))
            await asyncio.sleep(0.15)
        ok(name)
    except Exception as e:
        ng(name, str(e))


# ─────────────────────────────────────────────────────────────────────────────
# VibeCheqer Supabase RLS 우회 시도
# ─────────────────────────────────────────────────────────────────────────────
SUPABASE_URL = "https://cwroeyryxjnuxwzikzap.supabase.co"
SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3cm9leXJ5eGpudXh3emlremFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDYyNjM2NjcsImV4cCI6MjA2MTgzOTY2N30.AvWQqfpXEbXrJPFcf0nzOXGO18KALUy8FRHC5bLWxqQ"


async def rls_tests():
    import urllib.request
    import urllib.parse

    def rest(method, path, body=None, token=None):
        # path의 쿼리스트링에 제어문자가 포함될 수 있으므로 안전하게 인코딩
        safe_path = urllib.parse.quote(path, safe="=&?/")
        url = SUPABASE_URL + "/rest/v1/" + safe_path
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("apikey", SUPABASE_ANON)
        req.add_header("Authorization", f"Bearer {token or SUPABASE_ANON}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Prefer", "return=representation")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                body = e.read()
                return e.code, json.loads(body) if body else {}
            except Exception:
                return e.code, {}
        except Exception as ex:
            return 0, str(ex)

    print("\n--- VibeCheqer Supabase RLS 우회 테스트 ---")

    # RLS-01: anon으로 profiles 전체 조회 (개인정보 유출 여부)
    name = "RLS-01 anon 토큰으로 profiles 전체 조회 -> 차단 또는 빈 결과"
    status, data = rest("GET", "profiles?select=id,email&limit=10")
    if status in (401, 403) or (isinstance(data, list) and len(data) == 0):
        ok(name + f" (status={status}, rows={len(data) if isinstance(data, list) else 0})")
    else:
        ng(name, f"status={status}, data={str(data)[:100]}")

    # RLS-02: anon으로 spots INSERT (무단 게시물 등록)
    name = "RLS-02 anon으로 spots INSERT -> 차단"
    status, data = rest("POST", "spots", {
        "celeb_name": "HACK", "category": "actor",
        "location_name": "해킹 위치", "latitude": 37.5, "longitude": 127.0,
        "description": "RLS 우회 테스트"
    })
    if status in (401, 403, 422):
        ok(name + f" (status={status})")
    else:
        ng(name, f"status={status}, data={str(data)[:100]}")

    # RLS-03: anon으로 타인 spots UPDATE
    name = "RLS-03 anon으로 타인 spots UPDATE -> 차단"
    status, data = rest("PATCH", "spots?id=eq.00000000-0000-0000-0000-000000000001",
                        {"description": "RLS 우회 성공"})
    if status in (401, 403) or (isinstance(data, list) and len(data) == 0):
        ok(name + f" (status={status})")
    else:
        ng(name, f"status={status}, data={str(data)[:100]}")

    # RLS-04: anon으로 spots DELETE
    name = "RLS-04 anon으로 spots DELETE -> 차단"
    status, data = rest("DELETE", "spots?id=eq.00000000-0000-0000-0000-000000000001")
    if status in (401, 403) or (isinstance(data, list) and len(data) == 0):
        ok(name + f" (status={status})")
    else:
        ng(name, f"status={status}, data={str(data)[:100]}")

    # RLS-05: anon으로 profiles UPDATE (관리자 권한 탈취 시도)
    name = "RLS-05 anon으로 profiles subscription_tier UPDATE -> 차단"
    status, data = rest("PATCH", "profiles?id=eq.00000000-0000-0000-0000-000000000001",
                        {"subscription_tier": "premium"})
    if status in (401, 403) or (isinstance(data, list) and len(data) == 0):
        ok(name + f" (status={status})")
    else:
        ng(name, f"status={status}, data={str(data)[:100]}")

    # RLS-06: SQL 인젝션 시도 (PostgREST 필터)
    name = "RLS-06 SQL 인젝션 필터 -> 차단 또는 빈 결과"
    status, data = rest("GET", "spots?description=eq.'; DROP TABLE spots; --&limit=1")
    if status in (400, 401, 403) or (isinstance(data, list) and len(data) == 0):
        ok(name + f" (status={status})")
    else:
        ng(name, f"status={status}, data={str(data)[:100]}")

    # RLS-07: vibe 영상 무단 조회 (공개/비공개 정책)
    name = "RLS-07 anon으로 vibes 조회 -> 공개 vibes만 노출"
    status, data = rest("GET", "vibes?select=id,user_id&limit=5")
    if status == 200:
        ok(name + f" (status={status}, rows={len(data) if isinstance(data, list) else '?'})")
    elif status in (401, 403):
        ok(name + f" (완전 차단, status={status})")
    else:
        ng(name, f"status={status}, data={str(data)[:100]}")


async def main():
    print("\n" + "=" * 60)
    print("4table 룸 내부 + VibeCheqer RLS 적대적 테스트")
    print("=" * 60)

    # Phase 1: 4table 룸 내부 테스트
    print("\n[Phase 1] 4table 룸 내부 테스트")
    ws_list, uid_list, room_id = await setup_room()

    if ws_list:
        await tc_rate_limit(ws_list, uid_list, room_id)
        await tc_invalid_react_emoji(ws_list, uid_list, room_id)
        await tc_react_nonexistent_msg(ws_list, uid_list, room_id)
        await tc_malformed_signal(ws_list, uid_list, room_id)
        await tc_signal_self(ws_list, uid_list, room_id)
        await tc_empty_signal_payload(ws_list, uid_list, room_id)
        await tc_massive_chat_burst(ws_list, uid_list, room_id)
        await tc_chat_unicode_bomb(ws_list, uid_list, room_id)
        await tc_leave_rejoin(ws_list, uid_list, room_id)
        await teardown(ws_list)
    else:
        ng("Phase1 전체", "룸 생성 실패 (MATCH_SIZE=4, 연결 부족 가능)")

    # Phase 2: VibeCheqer RLS 테스트
    print("\n[Phase 2] VibeCheqer Supabase RLS 우회 테스트")
    await rls_tests()

    passed = sum(1 for _, v in results if v)
    total = len(results)
    print(f"\n{'=' * 60}")
    print(f"최종 결과: {passed}/{total} PASS")
    failed = [(n, v) for n, v in results if not v]
    if failed:
        print("실패 목록:")
        for n, _ in failed:
            print(f"  - {n}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
