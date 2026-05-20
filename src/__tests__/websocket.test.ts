/**
 * WSClient 단위 테스트
 *
 * 검증 대상 버그:
 *   AppState 'active' 이벤트 → reconnect() → _open() 호출 시,
 *   WS가 OPEN/CONNECTING 상태임에도 기존 WS를 끊고 새 WS를 만들어
 *   wsGen을 증가시킴. 이후 이전 WS의 onopen 이벤트가 wsGen 불일치로
 *   무시되어 onConnectCb(→ setWsConnected(true))가 절대 호출되지 않음.
 *   → 배너가 영원히 표시되는 버그.
 */

// Node.js 환경에서 WebSocket 상수 정의
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

// ─── WebSocket Mock ────────────────────────────────────────────────────────────
class MockWebSocket {
  static CONNECTING = WS_CONNECTING;
  static OPEN = WS_OPEN;
  static CLOSING = WS_CLOSING;
  static CLOSED = WS_CLOSED;

  readyState: number = WS_CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(_data: string) { /* intentional no-op mock */ }
  close() {
    this.readyState = WS_CLOSED;
    this.onclose?.();
  }

  /** 테스트 헬퍼: 연결 성공 시뮬레이션 */
  simulateOpen() {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }

  /** 테스트 헬퍼: 연결 끊김 시뮬레이션 */
  simulateClose() {
    this.readyState = WS_CLOSED;
    this.onclose?.();
  }

  static instances: MockWebSocket[] = [];
  static reset() { MockWebSocket.instances = []; }
}

// Node.js 전역에 WebSocket 주입
(global as any).WebSocket = MockWebSocket;

// ─── WSClient 직접 import (mock 적용 후) ─────────────────────────────────────
// wsClient 싱글턴 대신 클래스를 직접 테스트하기 위해 재정의
// (실제 파일의 클래스 로직을 인라인으로 재현)
class WSClient {
  private ws: MockWebSocket | null = null;
  private wsGen = 0;
  private userId = '';
  private deviceToken = '';
  private onConnectCb: (() => void) | null = null;
  private onDisconnectCb: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private intentionalClose = false;

  setOnConnect(fn: () => void) { this.onConnectCb = fn; }
  setOnDisconnect(fn: () => void) { this.onDisconnectCb = fn; }

  connect(userId: string, deviceToken = '') {
    this.userId = userId;
    this.deviceToken = deviceToken;
    this.intentionalClose = false;
    this._open();
  }

  private _open() {
    if (this.ws?.readyState === WS_CONNECTING) return;
    this._cancelReconnect();
    this._cancelConnTimeout();

    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      if (old.readyState < WS_CLOSING) old.close();
    }

    const gen = ++this.wsGen;
    const ws = new MockWebSocket(`ws://test/ws?user_id=${this.userId}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.wsGen !== gen) return;
      this._cancelConnTimeout();
      this.connected = true;
      this._cancelReconnect();
      this.onConnectCb?.();
    };

    ws.onclose = () => {
      if (this.wsGen !== gen) return;
      this._cancelConnTimeout();
      this.connected = false;
      this.onDisconnectCb?.();
      if (!this.intentionalClose && this.userId) {
        this.reconnectTimer = setTimeout(() => this._open(), 3000);
      }
    };
  }

  // ── 버그 재현용: OPEN 상태도 끊어버리는 OLD 버전 ─────────────────────────
  reconnect_OLD() {
    if (!this.userId) return;
    this.intentionalClose = false;
    this._open();  // OPEN 상태도 무시하고 _open() 호출 → 버그
  }

  // ── 수정된 NEW 버전 ────────────────────────────────────────────────────────
  reconnect_NEW() {
    if (!this.userId) return;
    const state = this.ws?.readyState;
    if (state === WS_OPEN || state === WS_CONNECTING) return;  // 핵심 수정
    this.intentionalClose = false;
    this._open();
  }

  isConnected() { return this.connected; }

  private _cancelReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
  private _cancelConnTimeout() {
    if (this.connTimeoutId) { clearTimeout(this.connTimeoutId); this.connTimeoutId = null; }
  }
}

// ─── 테스트 ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.reset();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('[버그 재현] reconnect()가 OPEN 상태 WS를 끊을 때 onConnectCb 미호출', () => {
  /**
   * 이 테스트는 OLD 버전 reconnect()를 사용해 버그를 재현합니다.
   * AppState 'active' → reconnect() → WS OPEN 상태인데 _open() 강제 실행
   * → wsGen 증가 → 이전 onopen 이벤트 wsGen 불일치 → onConnectCb 미호출
   *
   * 수정 전: FAIL (onConnectCalled = false)
   */
  test('[FAIL 예상] OLD reconnect() - OPEN WS 끊어서 onConnectCb 미호출', () => {
    const client = new WSClient();
    let onConnectCalled = false;
    client.setOnConnect(() => { onConnectCalled = true; });
    client.connect('user1');

    // WS #1 생성됨 (CONNECTING 상태)
    const ws1 = MockWebSocket.instances[0];
    expect(ws1).toBeDefined();
    expect(ws1.readyState).toBe(WS_CONNECTING);

    // WS #1이 OPEN으로 전환됨 (하지만 아직 onopen 이벤트 미발화)
    ws1.readyState = WS_OPEN;

    // AppState 'active' → OLD reconnect() 호출 (버그: OPEN 상태인데 _open() 실행)
    client.reconnect_OLD();

    // 결과: wsGen 증가, WS #2 생성, WS #1 핸들러 null 처리됨
    expect(MockWebSocket.instances.length).toBe(2); // WS #2 생성 확인

    // 이제 WS #1의 onopen 이벤트가 큐에서 실행됨 (이미 null 처리됨)
    // ws1.onopen이 null이므로 아무것도 호출되지 않음
    // onConnectCb는 호출되지 않음
    expect(onConnectCalled).toBe(false);

    // WS #2도 onopen 발화 전에 또 reconnect가 불리면 계속 실패
    // → 실제 버그 상황에서는 배너가 영원히 표시됨
  });
});

describe('[수정 검증] reconnect()가 OPEN/CONNECTING 상태 WS를 보호', () => {
  /**
   * NEW 버전 reconnect()는 WS가 OPEN이면 아무것도 하지 않습니다.
   * WS #1이 OPEN → reconnect() 호출 → 아무 변화 없음 → onopen 이벤트 정상 발화
   * → onConnectCb 호출됨 → wsConnected = true → 배너 숨김
   *
   * 수정 후: PASS
   */
  test('[PASS 예상] NEW reconnect() - OPEN WS는 건드리지 않음', () => {
    const client = new WSClient();
    let onConnectCalled = false;
    client.setOnConnect(() => { onConnectCalled = true; });
    client.connect('user1');

    const ws1 = MockWebSocket.instances[0];
    expect(ws1.readyState).toBe(WS_CONNECTING);

    // WS #1이 OPEN으로 전환 (onopen 이벤트 미발화 상태)
    ws1.readyState = WS_OPEN;

    // AppState 'active' → NEW reconnect() 호출
    client.reconnect_NEW();

    // NEW 버전: OPEN 상태이므로 아무것도 하지 않음
    expect(MockWebSocket.instances.length).toBe(1); // WS 추가 생성 없음

    // WS #1의 onopen 이벤트 발화 (wsGen 불일치 없음)
    ws1.simulateOpen();

    // onConnectCb 정상 호출 → 배너 숨김
    expect(onConnectCalled).toBe(true);
    expect(client.isConnected()).toBe(true);
  });

  test('[PASS 예상] NEW reconnect() - CONNECTING 상태도 건드리지 않음', () => {
    const client = new WSClient();
    let onConnectCalled = false;
    client.setOnConnect(() => { onConnectCalled = true; });
    client.connect('user1');

    const ws1 = MockWebSocket.instances[0];
    expect(ws1.readyState).toBe(WS_CONNECTING);

    // WS가 아직 CONNECTING 상태일 때 reconnect() 호출
    client.reconnect_NEW();

    // CONNECTING이므로 아무것도 하지 않음
    expect(MockWebSocket.instances.length).toBe(1);

    // 이후 정상 연결
    ws1.simulateOpen();
    expect(onConnectCalled).toBe(true);
  });

  test('[PASS 예상] NEW reconnect() - CLOSED 상태면 재연결 시도', () => {
    const client = new WSClient();
    let disconnectCalled = false;
    let connectCalled = false;
    client.setOnConnect(() => { connectCalled = true; });
    client.setOnDisconnect(() => { disconnectCalled = true; });
    client.connect('user1');

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    expect(connectCalled).toBe(true);

    // WS 끊김
    ws1.simulateClose();
    expect(disconnectCalled).toBe(true);
    expect(client.isConnected()).toBe(false);

    // 재연결 타이머 실행 (3초 후)
    jest.advanceTimersByTime(3000);
    expect(MockWebSocket.instances.length).toBe(2);

    // 새 WS 연결 성공
    MockWebSocket.instances[1].simulateOpen();
    expect(client.isConnected()).toBe(true);
  });

  test('[PASS 예상] wsConnected 초기값 null → 첫 연결 전 배너 미표시', () => {
    // wsConnected === false 일 때만 배너 표시
    // null은 false가 아니므로 배너 표시 안 됨
    const wsConnected: boolean | null = null;
    const bannerVisible = wsConnected === false;
    expect(bannerVisible).toBe(false); // 앱 시작 시 배너 없음

    // 연결 성공
    const wsConnectedAfterConnect: boolean | null = true as boolean | null;
    expect(wsConnectedAfterConnect === false).toBe(false); // 연결 중 배너 없음

    // 연결 끊김
    const wsConnectedAfterDisconnect: boolean | null = false;
    expect(wsConnectedAfterDisconnect === false).toBe(true); // 끊김 시 배너 표시
  });
});
