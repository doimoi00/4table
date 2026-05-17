import { WS_URL } from '../constants/config';

type MessageHandler = (msg: Record<string, unknown>) => void;
type StateHandler = () => void;

class WSClient {
  private ws: WebSocket | null = null;
  private wsGen = 0;  // 세대 카운터 — 구버전 WS 이벤트 무시
  private userId = '';
  private deviceToken = '';
  private handler: MessageHandler | null = null;
  private onConnectCb: StateHandler | null = null;
  private onDisconnectCb: StateHandler | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private intentionalClose = false;

  setHandler(handler: MessageHandler) { this.handler = handler; }
  setOnConnect(fn: StateHandler) { this.onConnectCb = fn; }
  setOnDisconnect(fn: StateHandler) { this.onDisconnectCb = fn; }

  connect(userId: string, deviceToken: string) {
    this.userId = userId;
    this.deviceToken = deviceToken;
    this.intentionalClose = false;
    this._open();
  }

  private _open() {
    // 이미 연결 시도 중이면 중복 시작 방지
    if (this.ws?.readyState === WebSocket.CONNECTING) return;

    this._cancelReconnect();

    // 이전 WS 핸들러를 먼저 제거해 stale onclose 이벤트 차단
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      if (old.readyState < WebSocket.CLOSING) old.close();
    }

    const gen = ++this.wsGen;
    const url = `${WS_URL}?user_id=${encodeURIComponent(this.userId)}&device_token=${encodeURIComponent(this.deviceToken)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.wsGen !== gen) return;
      this.connected = true;
      this._cancelReconnect();
      this._startPing();
      this.onConnectCb?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.wsGen !== gen) return;
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        this.handler?.(msg);
      } catch {
        // invalid JSON
      }
    };

    ws.onclose = () => {
      if (this.wsGen !== gen) return;  // 구버전 WS 이벤트 무시
      this.connected = false;
      this._stopPing();
      this.onDisconnectCb?.();
      if (!this.intentionalClose && this.userId) {
        this.reconnectTimer = setTimeout(() => this._open(), 3000);
      }
    };

    ws.onerror = () => {
      if (this.wsGen !== gen) return;
      // onclose가 바로 뒤에 호출되므로 여기서는 별도 처리 불필요
    };
  }

  reconnect() {
    if (!this.userId) return;
    this.intentionalClose = false;
    this._open();  // _open()이 이전 WS 정리 + 새 연결 모두 처리
  }

  disconnect() {
    this.intentionalClose = true;
    this.wsGen++;  // 모든 pending 이벤트 무효화
    this._stopPing();
    this._cancelReconnect();
    const old = this.ws;
    this.ws = null;
    this.connected = false;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      old.close();
    }
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  isConnected() { return this.connected; }

  private _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => this.send({ type: 'PING' }), 25_000);
  }

  private _stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  private _cancelReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

export const wsClient = new WSClient();
