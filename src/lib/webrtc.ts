/**
 * WebRTC P2P 미디어 전송 (이미지/영상)
 *
 * 4명 메시 토폴로지: 낮은 인덱스 유저가 높은 인덱스 유저에게 offer
 * 데이터 채널로 이미지 청크 전송 (16KB/chunk)
 *
 * 의존: react-native-webrtc (네이티브 빌드 필요)
 */

import { wsClient } from './websocket';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const CHUNK_SIZE = 14_000; // 14KB — data channel 안전 사이즈

type MediaReceivedHandler = (peerId: string, base64: string, mimeType: string) => void;

// react-native-webrtc 타입 (런타임 import)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RNWebRTC: any = null;
function getRNWebRTC() {
  if (!RNWebRTC) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      RNWebRTC = require('react-native-webrtc');
    } catch {
      console.warn('[WebRTC] react-native-webrtc 로드 실패 — 미디어 전송 불가');
    }
  }
  return RNWebRTC;
}

class PeerConn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dc: any = null;
  private incomingChunks: Record<string, { chunks: string[]; total: number; mime: string; timer: ReturnType<typeof setTimeout> }> = {};

  constructor(
    private readonly peerId: string,
    private readonly onMedia: MediaReceivedHandler,
  ) {
    const lib = getRNWebRTC();
    if (!lib) return;

    this.pc = new lib.RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e: { candidate: unknown }) => {
      if (e.candidate) {
        wsClient.send({
          type: 'SIGNAL', signal_type: 'candidate',
          target_user_id: peerId, payload: e.candidate,
        });
      }
    };

    this.pc.ondatachannel = (e: { channel: unknown }) => {
      this._setupDC(e.channel);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _setupDC(dc: any) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e: { data: string }) => {
      this._handleChunk(e.data);
    };
  }

  private _handleChunk(json: string) {
    try {
      const { id, index, total, mime, data } = JSON.parse(json);
      if (!this.incomingChunks[id]) {
        // 30초 내 완성되지 않은 청크는 메모리 누수 방지를 위해 자동 삭제
        const timer = setTimeout(() => {
          delete this.incomingChunks[id];
        }, 30_000);
        this.incomingChunks[id] = { chunks: [], total, mime, timer };
      }
      this.incomingChunks[id].chunks[index] = data;
      if (this.incomingChunks[id].chunks.filter(Boolean).length === total) {
        const base64 = this.incomingChunks[id].chunks.join('');
        const mimeType = this.incomingChunks[id].mime;
        clearTimeout(this.incomingChunks[id].timer);
        delete this.incomingChunks[id];
        this.onMedia(this.peerId, base64, mimeType);
      }
    } catch {
      // malformed chunk
    }
  }

  async createOffer() {
    const lib = getRNWebRTC();
    if (!lib || !this.pc) return;

    this.dc = this.pc.createDataChannel('media');
    this._setupDC(this.dc);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    wsClient.send({
      type: 'SIGNAL', signal_type: 'offer',
      target_user_id: this.peerId, payload: offer,
    });
  }

  async handleOffer(payload: unknown) {
    const lib = getRNWebRTC();
    if (!lib || !this.pc) return;
    await this.pc.setRemoteDescription(new lib.RTCSessionDescription(payload));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    wsClient.send({
      type: 'SIGNAL', signal_type: 'answer',
      target_user_id: this.peerId, payload: answer,
    });
  }

  async handleAnswer(payload: unknown) {
    const lib = getRNWebRTC();
    if (!lib || !this.pc) return;
    await this.pc.setRemoteDescription(new lib.RTCSessionDescription(payload));
  }

  async addCandidate(payload: unknown) {
    const lib = getRNWebRTC();
    if (!lib || !this.pc) return;
    await this.pc.addIceCandidate(new lib.RTCIceCandidate(payload));
  }

  sendBase64(id: string, base64: string, mimeType: string) {
    if (this.dc?.readyState !== 'open') return;
    const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const chunk = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      this.dc.send(JSON.stringify({ id, index: i, total: totalChunks, mime: mimeType, data: chunk }));
    }
  }

  close() {
    // 미완성 청크 타이머 정리
    for (const entry of Object.values(this.incomingChunks)) {
      clearTimeout(entry.timer);
    }
    this.incomingChunks = {};
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
  }
}

class WebRTCManager {
  private readonly peers = new Map<string, PeerConn>();
  private onMedia: MediaReceivedHandler | null = null;

  setMediaHandler(fn: MediaReceivedHandler) {
    this.onMedia = fn;
  }

  // ROOM_ACTIVE 후 호출 — 낮은 인덱스가 높은 인덱스에게 offer
  initRoom(allUsers: string[], myUserId: string) {
    const myIdx = allUsers.indexOf(myUserId);
    allUsers.slice(myIdx + 1).forEach((peerId) => {
      const peer = new PeerConn(peerId, (pid, b64, mime) => this.onMedia?.(pid, b64, mime));
      this.peers.set(peerId, peer);
      peer.createOffer().catch((e) => console.warn('[WebRTC] offer 실패:', e));
    });
  }

  handleSignal(signal: Record<string, unknown>) {
    const { signal_type, sender_id, payload } = signal as {
      signal_type: string; sender_id: string; payload: unknown;
    };
    let peer = this.peers.get(sender_id);

    if (signal_type === 'offer') {
      if (!peer) {
        peer = new PeerConn(sender_id, (pid, b64, mime) => this.onMedia?.(pid, b64, mime));
        this.peers.set(sender_id, peer);
      }
      peer.handleOffer(payload).catch((e) => console.warn('[WebRTC] handleOffer 실패:', e));
    } else if (signal_type === 'answer') {
      peer?.handleAnswer(payload).catch((e) => console.warn('[WebRTC] handleAnswer 실패:', e));
    } else if (signal_type === 'candidate') {
      peer?.addCandidate(payload).catch((e) => console.warn('[WebRTC] addCandidate 실패:', e));
    }
  }

  sendImageToAll(id: string, base64: string, mimeType: string) {
    this.peers.forEach((peer) => peer.sendBase64(id, base64, mimeType));
  }

  cleanup() {
    this.peers.forEach((p) => p.close());
    this.peers.clear();
  }
}

export const webrtcManager = new WebRTCManager();
