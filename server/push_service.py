"""
FCM HTTP v1 API를 사용한 푸시 알림 서비스.

준비 사항:
  1. Firebase Console > 프로젝트 설정 > 서비스 계정 > 새 비공개 키 생성
  2. serviceAccount.json 을 서버 루트에 저장
  3. .env 에 FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_FILE 설정
"""

import asyncio
import logging
from typing import List, Optional

import aiohttp

logger = logging.getLogger(__name__)

_access_token_cache: Optional[str] = None
_token_expiry: float = 0.0


async def _get_access_token(service_account_file: str) -> str:
    """google-auth로 FCM v1 Bearer 토큰 발급 (캐시 60분)."""
    import time
    global _access_token_cache, _token_expiry

    if _access_token_cache and time.time() < _token_expiry:
        return _access_token_cache

    try:
        import google.auth.transport.requests
        import google.oauth2.service_account

        creds = google.oauth2.service_account.Credentials.from_service_account_file(
            service_account_file,
            scopes=["https://www.googleapis.com/auth/firebase.messaging"],
        )
        request = google.auth.transport.requests.Request()
        creds.refresh(request)
        _access_token_cache = creds.token
        _token_expiry = time.time() + 3500  # 약 58분 후 갱신
        return _access_token_cache
    except Exception as e:
        logger.error(f"FCM 토큰 발급 실패: {e}")
        raise


async def send_push(
    device_tokens: List[str],
    title: str,
    body: str,
    data: Optional[dict] = None,
) -> None:
    """FCM v1 API로 다수 기기에 푸시 발송 (토큰별 개별 요청)."""
    from config import FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_FILE, FCM_V1_URL

    if not FCM_PROJECT_ID:
        logger.warning("FCM_PROJECT_ID 미설정 — 푸시 건너뜀 (개발 모드)")
        for token in device_tokens:
            logger.debug(f"[DEV] 푸시 → {token[:20]}… | {title}: {body}")
        return

    try:
        token = await _get_access_token(FCM_SERVICE_ACCOUNT_FILE)
    except Exception:
        return

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    async with aiohttp.ClientSession() as session:
        tasks = [
            _send_single(session, headers, FCM_V1_URL, device_token, title, body, data or {})
            for device_token in device_tokens
        ]
        await asyncio.gather(*tasks, return_exceptions=True)


async def _send_single(
    session: aiohttp.ClientSession,
    headers: dict,
    url: str,
    device_token: str,
    title: str,
    body: str,
    data: dict,
) -> None:
    payload = {
        "message": {
            "token": device_token,
            "notification": {"title": title, "body": body},
            "data": {k: str(v) for k, v in data.items()},
            "android": {
                "priority": "high",
                "notification": {
                    "channel_id": "4table-match",
                    "notification_priority": "PRIORITY_HIGH",
                    "sound": "default",
                    "default_vibrate_timings": True,
                },
            },
            "apns": {
                "headers": {"apns-priority": "10"},
                "payload": {"aps": {"content-available": 1}},
            },
        }
    }
    try:
        async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            result = await resp.json()
            if resp.status != 200:
                logger.error(f"FCM 오류 [{device_token[:12]}…]: {result}")
            else:
                logger.debug(f"FCM 성공 [{device_token[:12]}…]")
    except Exception as e:
        logger.error(f"FCM 요청 실패 [{device_token[:12]}…]: {e}")


async def notify_match_found(room_id: str, location: str, device_tokens: List[str]) -> None:
    await send_push(
        device_tokens=device_tokens,
        title="4table이 준비되었습니다! 🎉",
        body="1분 내에 입장하세요! 자리가 채워졌어요.",
        data={"type": "MATCH_FOUND", "room_id": room_id, "location": location},
    )


async def notify_match_failed(device_tokens: List[str]) -> None:
    await send_push(
        device_tokens=device_tokens,
        title="매칭이 취소되었습니다",
        body="입장 시간 초과로 매칭이 무효가 되었습니다. 다시 시도해주세요.",
        data={"type": "MATCH_FAILED"},
    )
