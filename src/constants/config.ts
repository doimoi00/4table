// 서버 주소 - 배포 시 실제 서버 IP/도메인으로 변경
export const SERVER_HOST = '192.168.0.1:8000';
export const WS_URL = `ws://${SERVER_HOST}/ws`;
export const API_URL = `http://${SERVER_HOST}`;

export const MATCH_TIMEOUT_SECONDS = 60;
export const TIMEBOMB_SECONDS = 300;
export const RECONNECT_GRACE_SECONDS = 30;

// 유저 색상 (4명 고정)
export const USER_COLORS = ['#7C3AED', '#10B981', '#F59E0B', '#EF4444'];
