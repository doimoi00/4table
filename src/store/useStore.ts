import { create } from 'zustand';

export type QueueStatus = 'idle' | 'queued' | 'matched_waiting' | 'active' | 'timebomb';

export type ChatMessage = {
  id: string;
  senderId: string;
  content: string;
  contentType: 'text' | 'image';
  timestamp: string;
  isMine: boolean;
};

type State = {
  userId: string;
  deviceToken: string;
  locationKey: string;
  locationDisplay: string;
  queueStatus: QueueStatus;
  queueSize: number;
  roomId: string | null;
  allUsers: string[];          // 방의 전체 4명 (순서 고정 — 색상 지정 기준)
  connectedUsers: string[];    // 현재 WS 연결된 유저
  typingUsers: string[];       // 현재 입력 중인 유저 ID 목록
  messages: ChatMessage[];
  timebombSeconds: number | null;
  timebombEndsAt: number | null;
  matchDeadlineEndsAt: number | null;
  wsConnected: boolean;
};

type Actions = {
  setUserId: (id: string) => void;
  setDeviceToken: (token: string) => void;
  setLocation: (key: string, display: string) => void;
  setQueueStatus: (status: QueueStatus) => void;
  setQueueSize: (n: number) => void;
  setRoomId: (id: string | null) => void;
  setAllUsers: (users: string[]) => void;
  setConnectedUsers: (users: string[]) => void;
  setTypingUser: (userId: string, isTyping: boolean) => void;
  addMessage: (msg: ChatMessage) => void;
  startTimebomb: (seconds: number) => void;
  cancelTimebomb: () => void;
  startMatchDeadline: (seconds: number) => void;
  setWsConnected: (connected: boolean) => void;
  resetRoom: () => void;
};

export const useStore = create<State & Actions>((set) => ({
  userId: '',
  deviceToken: '',
  locationKey: '',
  locationDisplay: '',
  queueStatus: 'idle',
  queueSize: 0,
  roomId: null,
  allUsers: [],
  connectedUsers: [],
  typingUsers: [],
  messages: [],
  timebombSeconds: null,
  timebombEndsAt: null,
  matchDeadlineEndsAt: null,
  wsConnected: false,

  setUserId: (id) => set({ userId: id }),
  setDeviceToken: (token) => set({ deviceToken: token }),
  setLocation: (key, display) => set({ locationKey: key, locationDisplay: display }),
  setQueueStatus: (status) => set({ queueStatus: status }),
  setQueueSize: (n) => set({ queueSize: n }),
  setRoomId: (id) => set({ roomId: id }),
  setAllUsers: (users) => set({ allUsers: users }),
  setConnectedUsers: (users) => set({ connectedUsers: users }),
  setTypingUser: (userId, isTyping) =>
    set((s) => ({
      typingUsers: isTyping
        ? s.typingUsers.includes(userId) ? s.typingUsers : [...s.typingUsers, userId]
        : s.typingUsers.filter((id) => id !== userId),
    })),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  startTimebomb: (seconds) =>
    set({ timebombSeconds: seconds, timebombEndsAt: Date.now() + seconds * 1000, queueStatus: 'timebomb' }),
  cancelTimebomb: () =>
    set({ timebombSeconds: null, timebombEndsAt: null, queueStatus: 'active' }),
  startMatchDeadline: (seconds) =>
    set({ matchDeadlineEndsAt: Date.now() + seconds * 1000 }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  resetRoom: () =>
    set({
      queueStatus: 'idle',
      roomId: null,
      allUsers: [],
      connectedUsers: [],
      typingUsers: [],
      messages: [],
      timebombSeconds: null,
      timebombEndsAt: null,
      matchDeadlineEndsAt: null,
    }),
}));
