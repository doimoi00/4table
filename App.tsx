import { useCallback, useEffect, useRef } from 'react';
import { AppState, AppStateStatus, LogBox } from 'react-native';
import { NavigationContainer, NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';

import { wsClient } from './src/lib/websocket';
import { webrtcManager } from './src/lib/webrtc';
import { getOrCreateUserId } from './src/lib/uuid';
import { registerForPushNotifications } from './src/lib/notifications';
import { useStore } from './src/store/useStore';
import MatchScreen from './src/screens/MatchScreen';
import ChatScreen from './src/screens/ChatScreen';

LogBox.ignoreLogs(['new NativeEventEmitter']);

export type RootStackParamList = {
  Match: undefined;
  Chat: { roomId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const navRef = useRef<NavigationContainerRef<RootStackParamList>>(null);
  const {
    setUserId, setDeviceToken, userId,
    setQueueStatus, setQueueSize, setQueueNeeded, setRoomId,
    addMessage, setMessages, addReaction,
    setAllUsers, setConnectedUsers, setTypingUser,
    startTimebomb, cancelTimebomb,
    resetRoom, startMatchDeadline, setWsConnected,
  } = useStore();

  // ── 초기화 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const id = await getOrCreateUserId();
      setUserId(id);

      const token = await registerForPushNotifications();
      setDeviceToken(token);

      wsClient.setOnConnect(() => setWsConnected(true));
      wsClient.setOnDisconnect(() => setWsConnected(false));
      wsClient.connect(id, token);
    })();
  }, []);

  // ── AppState: 백→포그라운드 시 WS 재연결 ───────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active' && userId) {
        wsClient.reconnect();
      }
    });
    return () => sub.remove();
  }, [userId]);

  // ── WebRTC 수신 미디어 → 채팅 메시지로 추가 ─────────────────────────────
  useEffect(() => {
    webrtcManager.setMediaHandler((peerId, base64, mimeType) => {
      addMessage({
        id: `media-${Date.now()}-${peerId.slice(0, 4)}`,
        senderId: peerId,
        content: `data:${mimeType};base64,${base64}`,
        contentType: 'image',
        timestamp: new Date().toISOString(),
        isMine: false,
        reactions: {},
      });
    });
  }, [addMessage]);

  // ── ROOM_JOINED 핸들러 ───────────────────────────────────────────────────
  const handleRoomJoined = useCallback((msg: Record<string, unknown>) => {
    const allUsers = (msg.all_users as string[]) ?? [];
    const connected = (msg.connected_users as string[]) ?? [];
    if (allUsers.length > 0) setAllUsers(allUsers);
    setConnectedUsers(connected);
    setRoomId(msg.room_id as string);

    // 메시지 히스토리 복원
    const myId = useStore.getState().userId;
    const history = (msg.message_history as Array<Record<string, unknown>>) ?? [];
    if (history.length > 0) {
      setMessages(
        history.map((m) => ({
          id: (m.msg_id as string) ?? `hist-${m.sender_id}-${m.timestamp}`,
          senderId: m.sender_id as string,
          content: m.content as string,
          contentType: 'text' as const,
          timestamp: (m.timestamp as string) ?? new Date().toISOString(),
          isMine: (m.sender_id as string) === myId,
          reactions: (m.reactions as Record<string, string[]>) ?? {},
        }))
      );
    }

    if (msg.status === 'ACTIVE') {
      setQueueStatus('active');
      if (myId && allUsers.length > 0) {
        webrtcManager.cleanup();
        webrtcManager.initRoom(allUsers, myId);
      }
    } else if (msg.status === 'TIMEBOMB') {
      setQueueStatus('timebomb');
      startTimebomb((msg.timebomb_remaining_seconds as number) ?? 300);
    } else {
      setQueueStatus('matched_waiting');
    }
  }, [setAllUsers, setConnectedUsers, setRoomId, setQueueStatus, setMessages, startTimebomb]);

  // ── WS 메시지 핸들러 ────────────────────────────────────────────────────
  const handleWsMessage = useCallback((msg: Record<string, unknown>) => {
    const type = msg.type as string;

    switch (type) {
      case 'QUEUE_JOINED':
        setQueueStatus('queued');
        setQueueSize((msg.queue_size as number) ?? 0);
        setQueueNeeded((msg.needed as number) ?? 4);
        break;

      case 'QUEUE_SIZE_UPDATED':
        setQueueSize((msg.queue_size as number) ?? 0);
        setQueueNeeded((msg.needed as number) ?? 4);
        break;

      case 'QUEUE_CANCELLED':
      case 'QUEUE_EXPIRED':
        setQueueStatus('idle');
        setQueueSize(0);
        setQueueNeeded(4);
        break;

      case 'MATCHED': {
        const roomId = msg.room_id as string;
        setRoomId(roomId);
        setQueueStatus('matched_waiting');
        startMatchDeadline((msg.deadline_seconds as number) ?? 60);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (navRef.current?.isReady()) {
          navRef.current.navigate('Chat', { roomId });
        }
        break;
      }

      case 'ROOM_JOINED':
        handleRoomJoined(msg);
        break;

      case 'ROOM_ACTIVE': {
        const users = (msg.users as string[]) ?? [];
        setAllUsers(users);
        setConnectedUsers(users);
        setQueueStatus('active');
        const myId = useStore.getState().userId;
        if (myId && users.length > 0) {
          webrtcManager.cleanup();
          webrtcManager.initRoom(users, myId);
        }
        break;
      }

      case 'USER_CONNECTED':
      case 'USER_DISCONNECTED': {
        const connected = (msg.connected_users as string[]) ?? [];
        setConnectedUsers(connected);
        break;
      }

      case 'TYPING': {
        setTypingUser(msg.user_id as string, msg.is_typing as boolean);
        break;
      }

      case 'REACT': {
        addReaction(
          msg.message_id as string,
          msg.emoji as string,
          msg.sender_id as string,
        );
        break;
      }

      case 'PING':
        wsClient.send({ type: 'PONG' });
        break;

      case 'SESSION_REPLACED':
        wsClient.disconnect();
        break;

      case 'MATCH_FAILED':
        resetRoom();
        webrtcManager.cleanup();
        if (navRef.current?.getCurrentRoute()?.name === 'Chat') {
          navRef.current.navigate('Match');
        }
        break;

      case 'CHAT':
        addMessage({
          id: `${Date.now()}-${(msg.sender_id as string).slice(0, 4)}`,
          senderId: msg.sender_id as string,
          content: msg.content as string,
          contentType: 'text',
          timestamp: (msg.timestamp as string) ?? new Date().toISOString(),
          isMine: false,
          reactions: {},
        });
        break;

      case 'SIGNAL':
        webrtcManager.handleSignal(msg);
        break;

      case 'TIMEBOMB_TRIGGERED':
        startTimebomb((msg.countdown_seconds as number) ?? 300);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;

      case 'TIMEBOMB_CANCELLED':
        cancelTimebomb();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;

      case 'ROOM_DESTROYED':
        resetRoom();
        webrtcManager.cleanup();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        if (navRef.current?.isReady()) {
          navRef.current.navigate('Match');
        }
        break;
    }
  }, [
    setQueueStatus, setQueueSize, setQueueNeeded, setRoomId,
    addMessage, setMessages, addReaction,
    setAllUsers, setConnectedUsers, setTypingUser,
    startTimebomb, cancelTimebomb,
    resetRoom, startMatchDeadline, handleRoomJoined,
  ]);

  useEffect(() => {
    wsClient.setHandler(handleWsMessage);
  }, [handleWsMessage]);

  // ── 푸시 알림 응답 처리 (백그라운드 → 앱 복귀) ────────────────────────
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, string>;
      if (data?.type === 'MATCH_FOUND' && data?.room_id) {
        const roomId = data.room_id;
        setRoomId(roomId);
        setQueueStatus('matched_waiting');
        wsClient.reconnect();
        if (navRef.current?.isReady()) {
          navRef.current.navigate('Chat', { roomId });
        }
      }
    });
    return () => sub.remove();
  }, [setRoomId, setQueueStatus]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer ref={navRef}>
        <Stack.Navigator
          screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
          initialRouteName="Match"
        >
          <Stack.Screen name="Match" component={MatchScreen} />
          <Stack.Screen name="Chat" component={ChatScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
