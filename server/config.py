import os
from dotenv import load_dotenv

load_dotenv()

# FCM 설정 (Firebase Cloud Messaging)
FCM_SERVER_KEY = os.getenv("FCM_SERVER_KEY", "")
FCM_PROJECT_ID = os.getenv("FCM_PROJECT_ID", "")
FCM_SERVICE_ACCOUNT_FILE = os.getenv("FCM_SERVICE_ACCOUNT_FILE", "serviceAccount.json")

# FCM v1 API endpoint (legacy: https://fcm.googleapis.com/fcm/send)
FCM_V1_URL = f"https://fcm.googleapis.com/v1/projects/{FCM_PROJECT_ID}/messages:send"

# 타이밍 상수
MATCH_TIMEOUT_SECONDS = 60        # 매칭 후 입장 제한시간 (1분)
TIMEBOMB_SECONDS = 300             # 폭탄 타이머 (5분)
RECONNECT_GRACE_SECONDS = 30      # 연결 끊긴 후 재접속 유예시간
QUEUE_IDLE_TIMEOUT_SECONDS = 3600  # 큐 최대 대기 시간 (1시간)

# 매칭 인원
MATCH_SIZE = 4
