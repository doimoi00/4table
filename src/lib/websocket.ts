import { WS_URL } from '../constants/config';

type MessageHandler = (msg: Record<string, unknown>) => void;
type StateHandler = () => void;

const LOG = (msg: string) => console.log(`[WSClient] ${msg}`);

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
  private connTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private intentionalClose = false;

  setHandler(handler: MessageHandler) { this.handler = handler; }
  setOnConnect(fn: StateHandler) { this.onConnectCb = fn; }
  setOnDisconnect(fn: StateHandler) { this.onDisconnectCb = fn; }

  connect(userId: string, deviceToken: string) {
    this.userId = userId;
    this.deviceToken = deviceToken;
    this.intentionalClose = false;
    LOG(`connect() called. userId=${userId.slice(0, 8)}...`);
    this._open();
  }

  private _open() {
    const curState = this.ws?.readyState ?? -1;
    LOG(`_open() called. current WS readyState=${curState} wsGen=${this.wsGen}`);

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      LOG('_open() → SKIP: already CONNECTING');
      return;
    }

    this._cancelReconnect();
    this._cancelConnTimeout();

    // 이전 WS 핸들러를 먼저 제거해 stale onclose 이벤트 차단
    const old = this.ws;
    this.ws = null;
    if (old) {
      LOG(`_open() → closing old WS (readyState=${old.readyState})`);
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      if (old.readyState < WebSocket.CLOSING) old.close();
    }

    const gen = ++this.wsGen;
    LOG(`_open() → new WS gen=${gen}`);
    const url = `${WS_URL}?user_id=${encodeURIComponent(this.userId)}&device_token=${encodeURIComponent(this.deviceToken)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    // Android에서 onclose가 발화하지 않는 경우를 대비한 연결 타임아웃
    this.connTimeoutId = setTimeout(() => {
      if (this.wsGen !== gen) return;
      LOG(`connTimeout fired gen=${gen} → no onopen in 10s, retrying`);
      this._cancelConnTimeout();
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
      if (this.ws === ws) this.ws = null;
      this.connected = false;
      this._stopPing();
      this.onDisconnectCb?.();
      if (!this.intentionalClose && this.userId) {
        this.reconnectTimer = setTimeout(() => this._open(), 3000);
      }
    }, 10_000);

    ws.onopen = () => {
      LOG(`onopen fired gen=${gen} wsGen=${this.wsGen} match=${this.wsGen === gen}`);
      if (this.wsGen !== gen) {
        LOG('onopen → IGNORED (stale gen)');
        return;
      }
      this._cancelConnTimeout();
      this.connected = true;
      this._cancelReconnect();
      this._startPing();
      LOG('onopen → CONNECTED ✓ calling onConnectCb');
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
      LOG(`onclose fired gen=${gen} wsGen=${this.wsGen} match=${this.wsGen === gen}`);
      if (this.wsGen !== gen) {
        LOG('onclose → IGNORED (stale gen)');
        return;
      }
      this._cancelConnTimeout();
      this.connected = false;
      this._stopPing();
      LOG(`onclose → DISCONNECTED. intentionalClose=${this.intentionalClose}`);
      this.onDisconnectCb?.();
      if (!this.intentionalClose && this.userId) {
        LOG('onclose → scheduling reconnect in 3s');
        this.reconnectTimer = setTimeout(() => this._open(), 3000);
      }
    };

    ws.onerror = () => {
      LOG(`onerror fired gen=${gen} wsGen=${this.wsGen}`);
      if (this.wsGen !== gen) return;
    };
  }

  reconnect() {
    if (!this.userId) return;
    const state = this.ws?.readyState;
    LOG(`reconnect() called. WS readyState=${state ?? 'null'}`);
    // OPEN/CONNECTING 상태면 무시 — 끊고 새로 만들면 onopen 이벤트가 wsGen 불일치로 손실됨
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
      LOG('reconnect() → SKIP: already OPEN or CONNECTING');
      return;
    }
    this.intentionalClose = false;
    this._open();
  }

  disconnect() {
    LOG('disconnect() called (intentional)');
    this.intentionalClose = true;
    this.wsGen++;  // 모든 pending 이벤트 무효화
    this._stopPing();
    this._cancelReconnect();
    this._cancelConnTimeout();
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

  private _cancelConnTimeout() {
    if (this.connTimeoutId) { clearTimeout(this.connTimeoutId); this.connTimeoutId = null; }
  }
}

export const wsClient = new WSClient();
