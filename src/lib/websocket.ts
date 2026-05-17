import { WS_URL } from '../constants/config';

type MessageHandler = (msg: Record<string, unknown>) => void;
type StateHandler = () => void;

class WSClient {
  private ws: WebSocket | null = null;
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
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    const url = `${WS_URL}?user_id=${encodeURIComponent(this.userId)}&device_token=${encodeURIComponent(this.deviceToken)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this._cancelReconnect();
      this._startPing();
      this.onConnectCb?.();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        this.handler?.(msg);
      } catch {
        // invalid json
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._stopPing();
      this.onDisconnectCb?.();
      // 의도하지 않은 종료면 5초 후 재연결 시도
      if (!this.intentionalClose && this.userId) {
        this.reconnectTimer = setTimeout(() => this._open(), 5000);
      }
    };

    this.ws.onerror = () => {
      this.connected = false;
    };
  }

  reconnect() {
    if (!this.userId) return;
    this.intentionalClose = false;
    this.ws?.close();
    this._open();
  }

  disconnect() {
    this.intentionalClose = true;
    this._stopPing();
    this._cancelReconnect();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
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
