/**
 * WebRTC P2P 미디어 전송 — 이미지(데이터 채널) + 음성(오디오 트랙)
 *
 * 4명 메시 토폴로지: 낮은 인덱스 유저가 높은 인덱스 유저에게 offer
 * 데이터 채널: 이미지 청크 (14KB/chunk)
 * 음성: audio track — signal_type 접두어 'voice_'
 */

import { wsClient } from './websocket';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const CHUNK_SIZE = 14_000;

type MediaReceivedHandler = (peerId: string, base64: string, mimeType: string) => void;
export type VoiceChangeHandler = (active: boolean, muted: boolean) => void;
export type VoiceInviteHandler = (hasPending: boolean) => void;
export type VoiceParticipantHandler = (participants: string[]) => void;

// react-native-webrtc 런타임 import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RNWebRTC: any = null;
function getRNWebRTC() {
  if (!RNWebRTC) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      RNWebRTC = require('react-native-webrtc');
    } catch {
      console.warn('[WebRTC] react-native-webrtc 로드 실패');
    }
  }
  return RNWebRTC;
}

// PeerConn / VoicePeerConn 공통 헬퍼 — stale ICE candidate 무시
async function safeAddIceCandidate(pc: unknown, payload: unknown) {
  const lib = getRNWebRTC();
  if (!lib || !pc) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (pc as any).addIceCandidate(new lib.RTCIceCandidate(payload));
  } catch { /* stale candidate */ }
}

async function safeHandleAnswer(pc: unknown, payload: unknown) {
  const lib = getRNWebRTC();
  if (!lib || !pc) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (pc as any).setRemoteDescription(new lib.RTCSessionDescription(payload));
}

// ─── 이미지 데이터 채널 피어 ───────────────────────────────────────────────

class PeerConn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dc: any = null;
  private incomingChunks: Record<string, {
    chunks: string[]; total: number; mime: string;
    timer: ReturnType<typeof setTimeout>;
  }> = {};

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
    dc.onmessage = (e: { data: string }) => this._handleChunk(e.data);
  }

  private _handleChunk(json: string) {
    try {
      const { id, index, total, mime, data } = JSON.parse(json);
      if (!this.incomingChunks[id]) {
        const timer = setTimeout(() => { delete this.incomingChunks[id]; }, 30_000);
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
    } catch { /* malformed chunk */ }
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
    return safeHandleAnswer(this.pc, payload);
  }

  async addCandidate(payload: unknown) {
    return safeAddIceCandidate(this.pc, payload);
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
    for (const entry of Object.values(this.incomingChunks)) clearTimeout(entry.timer);
    this.incomingChunks = {};
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
  }
}

// ─── 음성 채팅 피어 ───────────────────────────────────────────────────────────

class VoicePeerConn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pc: any;

  constructor(private readonly peerId: string) {
    const lib = getRNWebRTC();
    if (!lib) return;
    this.pc = new lib.RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e: { candidate: unknown }) => {
      if (e.candidate) {
        wsClient.send({
          type: 'SIGNAL', signal_type: 'voice_candidate',
          target_user_id: peerId, payload: e.candidate,
        });
      }
    };
    // Remote audio track plays automatically via system audio output
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addLocalTrack(track: any, stream: any) {
    if (this.pc) this.pc.addTrack(track, stream);
  }

  async createOffer() {
    if (!this.pc) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    wsClient.send({
      type: 'SIGNAL', signal_type: 'voice_offer',
      target_user_id: this.peerId, payload: offer,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleOffer(payload: unknown, localStream: any | null) {
    const lib = getRNWebRTC();
    if (!lib || !this.pc) return;
    await this.pc.setRemoteDescription(new lib.RTCSessionDescription(payload));
    if (localStream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      localStream.getAudioTracks().forEach((track: any) => this.pc.addTrack(track, localStream));
    }
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    wsClient.send({
      type: 'SIGNAL', signal_type: 'voice_answer',
      target_user_id: this.peerId, payload: answer,
    });
  }

  async handleAnswer(payload: unknown) {
    return safeHandleAnswer(this.pc, payload);
  }

  async addCandidate(payload: unknown) {
    return safeAddIceCandidate(this.pc, payload);
  }

  close() {
    try { this.pc?.close(); } catch { /* ignore */ }
  }
}

// ─── WebRTC 매니저 ────────────────────────────────────────────────────────────

class WebRTCManager {
  private readonly peers = new Map<string, PeerConn>();
  private onMedia: MediaReceivedHandler | null = null;

  // 음성 채팅 상태
  private readonly voicePeers = new Map<string, VoicePeerConn>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private localStream: any = null;
  private pendingVoiceOffers = new Map<string, unknown>();
  private onVoiceChange: VoiceChangeHandler | null = null;
  private onVoiceInvite: VoiceInviteHandler | null = null;
  private onVoiceParticipants: VoiceParticipantHandler | null = null;
  private voiceParticipantIds = new Set<string>();
  private _isMuted = false;
  private _allUsers: string[] = [];
  private _myUserId = '';

  setMediaHandler(fn: MediaReceivedHandler) { this.onMedia = fn; }
  setVoiceChangeHandler(fn: VoiceChangeHandler) { this.onVoiceChange = fn; }
  setVoiceInviteHandler(fn: VoiceInviteHandler) { this.onVoiceInvite = fn; }
  setVoiceParticipantHandler(fn: VoiceParticipantHandler) { this.onVoiceParticipants = fn; }

  private _notifyParticipants() {
    this.onVoiceParticipants?.([...this.voiceParticipantIds]);
  }

  // 방 활성화 시 호출 — 이미지 피어 + 룸 메타데이터 저장
  initRoom(allUsers: string[], myUserId: string) {
    this._allUsers = allUsers;
    this._myUserId = myUserId;
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

  // ── 음성 채팅 ─────────────────────────────────────────────────────────────

  get voiceActive() { return !!this.localStream; }
  get isMuted() { return this._isMuted; }

  async startVoice() {
    const lib = getRNWebRTC();
    if (!lib) throw new Error('WebRTC를 사용할 수 없습니다');
    if (this.localStream) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.localStream = await lib.mediaDevices.getUserMedia({ audio: true }) as any;
    this._isMuted = false;
    this.voiceParticipantIds.add(this._myUserId);

    this._allUsers.forEach((peerId) => {
      if (peerId === this._myUserId) return;
      const voicePeer = new VoicePeerConn(peerId);
      this.voicePeers.set(peerId, voicePeer);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.localStream!.getAudioTracks().forEach((track: any) => voicePeer.addLocalTrack(track, this.localStream));

      const pending = this.pendingVoiceOffers.get(peerId);
      if (pending) {
        this.pendingVoiceOffers.delete(peerId);
        voicePeer.handleOffer(pending, this.localStream).catch(console.warn);
      } else {
        voicePeer.createOffer().catch(console.warn);
      }
    });

    this._notifyParticipants();
    this.onVoiceChange?.(true, false);
    this.onVoiceInvite?.(false);
  }

  toggleMute() {
    if (!this.localStream) return;
    this._isMuted = !this._isMuted;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.localStream.getAudioTracks().forEach((track: any) => { track.enabled = !this._isMuted; });
    this.onVoiceChange?.(true, this._isMuted);
  }

  stopVoice() {
    if (this.localStream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.localStream.getTracks().forEach((track: any) => track.stop());
      this.localStream = null;
    }
    this.voicePeers.forEach((p) => p.close());
    this.voicePeers.clear();
    this.pendingVoiceOffers.clear();
    this._isMuted = false;
    this.voiceParticipantIds.clear();
    this._notifyParticipants();
    this.onVoiceChange?.(false, false);
    this.onVoiceInvite?.(false);
  }

  handleVoiceSignal(signal: Record<string, unknown>) {
    const { signal_type, sender_id, payload } = signal as {
      signal_type: string; sender_id: string; payload: unknown;
    };

    if (signal_type === 'voice_offer') {
      if (this.localStream) {
        let peer = this.voicePeers.get(sender_id);
        if (!peer) {
          peer = new VoicePeerConn(sender_id);
          this.voicePeers.set(sender_id, peer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.localStream.getAudioTracks().forEach((track: any) => peer!.addLocalTrack(track, this.localStream));
        }
        peer.handleOffer(payload, this.localStream).catch(console.warn);
      } else {
        this.pendingVoiceOffers.set(sender_id, payload);
        this.onVoiceInvite?.(true);
      }
    } else if (signal_type === 'voice_answer') {
      this.voicePeers.get(sender_id)?.handleAnswer(payload).catch(console.warn);
      this.voiceParticipantIds.add(sender_id);
      this._notifyParticipants();
    } else if (signal_type === 'voice_candidate') {
      this.voicePeers.get(sender_id)?.addCandidate(payload).catch(console.warn);
    }
  }

  sendImageToAll(id: string, base64: string, mimeType: string) {
    this.peers.forEach((peer) => peer.sendBase64(id, base64, mimeType));
  }

  reinviteVoicePeer(peerId: string) {
    if (!this.localStream) return;
    const existing = this.voicePeers.get(peerId);
    if (existing) { existing.close(); this.voicePeers.delete(peerId); }
    const voicePeer = new VoicePeerConn(peerId);
    this.voicePeers.set(peerId, voicePeer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.localStream!.getAudioTracks().forEach((track: any) => voicePeer.addLocalTrack(track, this.localStream));
    voicePeer.createOffer().catch(console.warn);
  }

  cleanup() {
    this.stopVoice();
    this.peers.forEach((p) => p.close());
    this.peers.clear();
    this.voiceParticipantIds.clear();
    this._allUsers = [];
    this._myUserId = '';
  }
}

export const webrtcManager = new WebRTCManager();
