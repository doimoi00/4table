# 4table WebSocket 메시지 프로토콜

## 연결

```
ws://host:8000/ws?user_id=<uid>&device_token=<fcm_token>
```

- `user_id`: 앱 내 고유 식별자 (UUID 권장)
- `device_token`: FCM 등록 토큰 (푸시 알림용)

---

## 1. 매칭 큐 플로우

### 클라이언트 → 서버

#### JOIN_QUEUE — 매칭 대기 등록
```json
{
  "type": "JOIN_QUEUE",
  "location": "강남구_역삼동"
}
```

#### CANCEL_QUEUE — 매칭 취소
```json
{
  "type": "CANCEL_QUEUE"
}
```

### 서버 → 클라이언트

#### QUEUE_JOINED — 큐 등록 확인
```json
{
  "type": "QUEUE_JOINED",
  "location": "강남구_역삼동",
  "queue_size": 2,
  "needed": 2
}
```

#### MATCHED — 4명 매칭 완료 (WS 연결 중인 경우 즉시 수신)
```json
{
  "type": "MATCHED",
  "room_id": "550e8400-e29b-41d4-a716-446655440000",
  "location": "강남구_역삼동",
  "message": "4명이 매칭되었습니다! 1분 내에 입장하세요.",
  "deadline_seconds": 60
}
```

#### QUEUE_CANCELLED — 취소 확인
```json
{
  "type": "QUEUE_CANCELLED",
  "success": true
}
```

#### QUEUE_EXPIRED — 1시간 경과로 자동 만료
```json
{
  "type": "QUEUE_EXPIRED",
  "reason": "idle_timeout"
}
```

---

## 2. 백그라운드 → 푸시 → 재입장 플로우

앱이 백그라운드 상태일 때 매칭이 완료되면 FCM 푸시를 수신합니다.

### FCM 푸시 data 페이로드 (notification 아님, data 필드)
```json
{
  "type": "MATCH_FOUND",
  "room_id": "550e8400-e29b-41d4-a716-446655440000",
  "location": "강남구_역삼동"
}
```

### 앱 처리 순서
1. 푸시 수신 → data.type == "MATCH_FOUND" 확인
2. `room_id` 를 로컬 저장
3. 앱 포그라운드 진입 → WebSocket 재연결
4. WS 연결 직후 서버가 자동으로 기존 룸 복귀 처리 (auto-join)
   - 또는 명시적으로 JOIN_ROOM 전송:

```json
{
  "type": "JOIN_ROOM",
  "room_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 서버 → 클라이언트

#### ROOM_JOINED — 입장 확인
```json
{
  "type": "ROOM_JOINED",
  "room_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "MATCHED_WAITING_FOR_CONNECTIONS",
  "connected_users": ["user_a", "user_b"],
  "total_users": 4
}
```

#### ROOM_ACTIVE — 4명 전원 입장, 채팅 시작
```json
{
  "type": "ROOM_ACTIVE",
  "room_id": "550e8400-e29b-41d4-a716-446655440000",
  "users": ["user_a", "user_b", "user_c", "user_d"],
  "message": "4명 모두 입장! 대화를 시작하세요."
}
```

#### MATCH_FAILED — 60초 내 전원 미입장
```json
{
  "type": "MATCH_FAILED",
  "reason": "connection_timeout",
  "missing_user_ids": ["user_c"],
  "message": "1분 내에 전원이 입장하지 않아 매칭이 취소되었습니다."
}
```

---

## 3. 텍스트 채팅 (ROOM_ACTIVE 상태에서만)

### 클라이언트 → 서버
```json
{
  "type": "CHAT",
  "content": "안녕하세요!",
  "timestamp": "2026-05-17T12:34:56Z"
}
```

### 서버 → 클라이언트 (나머지 3명에게 중계)
```json
{
  "type": "CHAT",
  "sender_id": "user_a",
  "content": "안녕하세요!",
  "timestamp": "2026-05-17T12:34:56Z"
}
```

---

## 4. WebRTC P2P 미디어 시그널링

미디어(사진/영상)는 서버를 거치지 않고 P2P로 직송합니다.
시그널링(offer/answer/ICE candidate)만 서버 WebSocket을 통해 중계합니다.

4명 기준 피어 쌍: A↔B, A↔C, A↔D, B↔C, B↔D, C↔D (총 6쌍)

### SDP Offer 전송
```json
{
  "type": "SIGNAL",
  "signal_type": "offer",
  "target_user_id": "user_b",
  "payload": {
    "sdp": "v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\n..."
  }
}
```

### SDP Answer 전송
```json
{
  "type": "SIGNAL",
  "signal_type": "answer",
  "target_user_id": "user_a",
  "payload": {
    "sdp": "v=0\r\no=- 12345678 2 IN IP4 127.0.0.1\r\n..."
  }
}
```

### ICE Candidate 전송
```json
{
  "type": "SIGNAL",
  "signal_type": "candidate",
  "target_user_id": "user_b",
  "payload": {
    "candidate": "candidate:1 1 UDP 2130706431 192.168.1.10 54321 typ host",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

### 서버 → 클라이언트 (target_user_id에게만 전달)
```json
{
  "type": "SIGNAL",
  "signal_type": "offer",
  "sender_id": "user_a",
  "target_user_id": "user_b",
  "payload": { "sdp": "..." }
}
```

---

## 5. 퇴장 및 5분 시한폭탄

### 클라이언트 → 서버: 명시적 퇴장
```json
{
  "type": "LEAVE"
}
```

### 서버 → 클라이언트: 폭탄 트리거 (한 명이라도 이탈 시)
```json
{
  "type": "TIMEBOMB_TRIGGERED",
  "room_id": "550e8400-e29b-41d4-a716-446655440000",
  "trigger_user_id": "user_c",
  "reason": "explicit_leave",
  "countdown_seconds": 300,
  "message": "한 명이 나갔습니다. 300초 후 방이 폭파됩니다."
}
```

- `reason`: `"explicit_leave"` (나가기 버튼) | `"reconnect_timeout"` (30초 내 재접속 실패)

### 서버 → 클라이언트: 폭탄 해제 (이탈 유저가 30초 내 복귀 시)
```json
{
  "type": "TIMEBOMB_CANCELLED",
  "room_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "모두 돌아왔습니다! 대화를 계속합니다."
}
```

### 서버 → 클라이언트: 방 폭파
```json
{
  "type": "ROOM_DESTROYED",
  "room_id": "550e8400-e29b-41d4-a716-446655440000",
  "reason": "timebomb_detonated",
  "message": "방이 종료되었습니다."
}
```

---

## 6. 기타

### PING / PONG (연결 유지)
```json
{ "type": "PING" }
{ "type": "PONG" }
```

### 오류 응답
```json
{
  "type": "ERROR",
  "code": "ROOM_NOT_FOUND | NOT_IN_ROOM | MISSING_LOCATION | MISSING_ROOM_ID | INVALID_JSON | UNKNOWN_TYPE"
}
```

---

## 서버 상태 코드 요약

| `type` | 방향 | 설명 |
|--------|------|------|
| `JOIN_QUEUE` | C→S | 매칭 큐 등록 |
| `CANCEL_QUEUE` | C→S | 매칭 취소 |
| `JOIN_ROOM` | C→S | 룸 입장 (푸시 복귀) |
| `CHAT` | 양방향 | 텍스트 채팅 |
| `SIGNAL` | 양방향 | WebRTC 시그널링 |
| `LEAVE` | C→S | 명시적 퇴장 |
| `PING` | C→S | 연결 유지 |
| `QUEUE_JOINED` | S→C | 큐 등록 확인 |
| `QUEUE_CANCELLED` | S→C | 큐 취소 확인 |
| `QUEUE_EXPIRED` | S→C | 큐 만료 (1시간) |
| `MATCHED` | S→C | 4인 매칭 완료 |
| `ROOM_JOINED` | S→C | 룸 입장 확인 |
| `ROOM_ACTIVE` | S→C | 전원 입장, 채팅 시작 |
| `MATCH_FAILED` | S→C | 60초 타임아웃 |
| `TIMEBOMB_TRIGGERED` | S→C | 5분 카운트다운 시작 |
| `TIMEBOMB_CANCELLED` | S→C | 카운트다운 해제 |
| `ROOM_DESTROYED` | S→C | 방 폭파 |
| `PONG` | S→C | 연결 유지 응답 |
| `ERROR` | S→C | 오류 |
