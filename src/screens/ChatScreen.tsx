import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, FlatList, Image, KeyboardAvoidingView, Modal, Platform,
  Share, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as Haptics from 'expo-haptics';
import { useStore } from '../store/useStore';
import { wsClient } from '../lib/websocket';
import { webrtcManager } from '../lib/webrtc';
import { TimeBombBar } from '../components/TimeBombBar';
import { MatchDeadlineBar } from '../components/MatchDeadlineBar';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { USER_COLORS } from '../constants/config';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Chat'>;
type Route = RouteProp<RootStackParamList, 'Chat'>;

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'] as const;
const TYPING_STOP_DELAY = 2500;
const TYPING_THROTTLE_MS = 1000;

function genMsgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function UserDot({ userId, users, connectedUsers }: {
  readonly userId: string; readonly users: string[]; readonly connectedUsers: string[];
}) {
  const index = users.indexOf(userId);
  const color = USER_COLORS[index % USER_COLORS.length];
  const isConnected = connectedUsers.includes(userId);
  return (
    <View style={[styles.userDot, { backgroundColor: color, opacity: isConnected ? 1 : 0.3 }]}>
      <Text style={styles.userDotText}>{index + 1}</Text>
    </View>
  );
}

export default function ChatScreen() {
  const route = useRoute<Route>();
  const nav = useNavigation<Nav>();
  const { roomId: routeRoomId } = route.params;

  const {
    userId, messages, addMessage, connectedUsers, typingUsers,
    queueStatus, timebombEndsAt, matchDeadlineEndsAt,
    resetRoom, roomId, allUsers, wsConnected,
  } = useStore();

  const [input, setInput] = useState('');
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [reactionTargetId, setReactionTargetId] = useState<string | null>(null);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);

  const listRef = useRef<FlatList>(null);
  const isMountedRef = useRef(true);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingTrueAt = useRef<number>(0);
  const prevMsgCount = useRef(0);
  const isNearBottomRef = useRef(true);
  const isLeavingRef = useRef(false);
  const handleLeaveRef = useRef<() => void>(() => {});

  const typingLabels = typingUsers
    .filter((uid) => uid !== userId)
    .map((uid) => {
      const idx = allUsers.indexOf(uid);
      return idx >= 0 ? `#${idx + 1}` : '?';
    });

  // 타이핑 점 애니메이션
  const dotAnims = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (typingLabels.length === 0) {
      dotAnims.forEach((a) => a.setValue(0));
      return;
    }
    const animations = dotAnims.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(anim, { toValue: 1, duration: 280, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 280, useNativeDriver: true }),
        ])
      )
    );
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [typingLabels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    isMountedRef.current = true;
    if (!roomId) {
      wsClient.send({ type: 'JOIN_ROOM', room_id: routeRoomId });
    }
    return () => {
      isMountedRef.current = false;
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 새 메시지 도착 시 스크롤 + 햅틱
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      const latest = messages.at(-1);
      if (latest && !latest.isMine && latest.contentType !== 'system') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      if (isNearBottomRef.current) {
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
        setUnreadCount(0);
      } else if (latest && !latest.isMine && latest.contentType !== 'system') {
        setUnreadCount((c) => c + (messages.length - prevMsgCount.current));
      }
    }
    prevMsgCount.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    if (queueStatus === 'idle') {
      nav.navigate('Match');
    }
  }, [queueStatus, nav]);

  // 안드로이드 뒤로가기 버튼 가로채기
  useEffect(() => {
    const unsubscribe = nav.addListener('beforeRemove', (e) => {
      if (isLeavingRef.current) return;
      e.preventDefault();
      handleLeaveRef.current();
    });
    return unsubscribe;
  }, [nav]);

  function sendMessage() {
    const text = input.trim();
    if (!text || !canChat) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    wsClient.send({ type: 'TYPING', is_typing: false });

    const msgId = genMsgId();
    wsClient.send({ type: 'CHAT', msg_id: msgId, content: text, timestamp: new Date().toISOString() });
    addMessage({
      id: msgId,
      senderId: userId,
      content: text,
      contentType: 'text',
      timestamp: new Date().toISOString(),
      isMine: true,
      reactions: {},
    });
    setInput('');
  }

  function handleInputChange(text: string) {
    setInput(text);
    if (!canChat) return;

    const now = Date.now();
    if (typingTimer.current) clearTimeout(typingTimer.current);

    if (text.length > 0) {
      if (now - lastTypingTrueAt.current >= TYPING_THROTTLE_MS) {
        wsClient.send({ type: 'TYPING', is_typing: true });
        lastTypingTrueAt.current = now;
      }
      typingTimer.current = setTimeout(() => {
        wsClient.send({ type: 'TYPING', is_typing: false });
      }, TYPING_STOP_DELAY);
    } else {
      wsClient.send({ type: 'TYPING', is_typing: false });
    }
  }

  // 리액션 피커에서 선택 시
  function sendReaction(messageId: string, emoji: string) {
    wsClient.send({ type: 'REACT', message_id: messageId, emoji });
    useStore.getState().addReaction(messageId, emoji, userId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setReactionTargetId(null);
  }

  const sendImage = useCallback(async (fromCamera: boolean) => {
    try {
      let result: ImagePicker.ImagePickerResult;
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!isMountedRef.current) return;
        if (!perm.granted) {
          Alert.alert('권한 필요', '카메라 접근 권한이 필요합니다.');
          return;
        }
        result = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 });
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!isMountedRef.current) return;
        if (!perm.granted) {
          Alert.alert('권한 필요', '사진 접근 권한이 필요합니다.');
          return;
        }
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as any,
          base64: true,
          quality: 0.6,
        });
      }
      if (!isMountedRef.current) return;
      if (result.canceled || !result.assets?.[0]?.base64) return;

      const asset = result.assets[0];
      const mimeType = asset.mimeType ?? 'image/jpeg';
      const base64 = asset.base64!;
      const msgId = `img-${genMsgId()}`;

      webrtcManager.sendImageToAll(msgId, base64, mimeType);
      addMessage({
        id: msgId,
        senderId: userId,
        content: `data:${mimeType};base64,${base64}`,
        contentType: 'image',
        timestamp: new Date().toISOString(),
        isMine: true,
        reactions: {},
      });
    } catch {
      if (!isMountedRef.current) return;
      Alert.alert('오류', '이미지 처리 중 문제가 발생했습니다.');
    }
  }, [userId, addMessage]);

  const pickAndSendImage = useCallback(() => {
    Alert.alert('사진 전송', '사진을 선택하세요', [
      { text: '카메라', onPress: () => sendImage(true) },
      { text: '앨범', onPress: () => sendImage(false) },
      { text: '취소', style: 'cancel' },
    ]);
  }, [sendImage]);

  const saveImage = useCallback(async (uri: string) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (!isMountedRef.current) return;
      if (status !== 'granted') {
        Alert.alert('권한 필요', '사진 저장을 위해 미디어 접근 권한이 필요합니다.');
        return;
      }
      let fileUri = uri;
      if (uri.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(uri);
        if (!match) { Alert.alert('저장 실패', '이미지 형식이 올바르지 않습니다.'); return; }
        const ext = match[1].split('/')[1] ?? 'jpg';
        fileUri = `${FileSystem.cacheDirectory}4table_save_${Date.now()}.${ext}`;
        await FileSystem.writeAsStringAsync(fileUri, match[2], { encoding: FileSystem.EncodingType.Base64 });
      }
      await MediaLibrary.saveToLibraryAsync(fileUri);
      if (!isMountedRef.current) return;
      Alert.alert('저장 완료', '사진이 갤러리에 저장되었습니다.');
    } catch {
      if (!isMountedRef.current) return;
      Alert.alert('저장 실패', '사진 저장 중 오류가 발생했습니다.');
    }
  }, []);

  function handleLeave() {
    const isTimebomb = queueStatus === 'timebomb';
    Alert.alert(
      '나가기',
      isTimebomb
        ? '폭탄이 이미 시작된 상태입니다. 지금 나가면 방이 즉시 종료될 수 있습니다. 나가시겠습니까?'
        : '나가면 5분 후 방이 종료됩니다. 나가시겠습니까?',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '나가기',
          style: 'destructive',
          onPress: () => {
            if (typingTimer.current) clearTimeout(typingTimer.current);
            wsClient.send({ type: 'LEAVE' });
            isLeavingRef.current = true;
            resetRoom();
            nav.navigate('Match');
          },
        },
      ]
    );
  }
  handleLeaveRef.current = handleLeave;

  const getColor = (senderId: string) => {
    const idx = allUsers.indexOf(senderId);
    return idx >= 0 ? USER_COLORS[idx % USER_COLORS.length] : '#6B7280';
  };

  const canChat = queueStatus === 'active' || queueStatus === 'timebomb';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ConnectionBanner visible={wsConnected === false} />

      {/* 헤더 */}
      <View style={styles.header}>
        <Text style={styles.logo}>4table</Text>
        <View style={styles.usersRow}>
          {allUsers.map((uid) => (
            <UserDot key={uid} userId={uid} users={allUsers} connectedUsers={connectedUsers} />
          ))}
        </View>
        <TouchableOpacity style={styles.leaveBtn} onPress={handleLeave}>
          <Text style={styles.leaveBtnText}>나가기</Text>
        </TouchableOpacity>
      </View>

      {queueStatus === 'matched_waiting' && matchDeadlineEndsAt && (
        <MatchDeadlineBar endsAt={matchDeadlineEndsAt} />
      )}
      {queueStatus === 'timebomb' && timebombEndsAt && (
        <TimeBombBar endsAt={timebombEndsAt} onExpire={() => {
          resetRoom();
          webrtcManager.cleanup();
          nav.navigate('Match');
        }} />
      )}
      {queueStatus === 'matched_waiting' && (
        <View style={styles.waitingOverlay}>
          <Text style={styles.waitingText}>⏳ 나머지 인원 입장 대기 중...</Text>
          <Text style={styles.waitingConnected}>{connectedUsers.length} / 4 명 입장 완료</Text>
        </View>
      )}

      {showScrollBtn && (
        <TouchableOpacity
          style={styles.scrollBtn}
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setUnreadCount(0);
          }}
        >
          <Text style={styles.scrollBtnText}>↓</Text>
          {unreadCount > 0 && (
            <View style={styles.scrollBtnBadge}>
              <Text style={styles.scrollBtnBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* 이모지 리액션 피커 모달 */}
      <Modal
        visible={reactionTargetId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setReactionTargetId(null)}
      >
        <TouchableOpacity
          style={styles.reactionOverlay}
          activeOpacity={1}
          onPress={() => setReactionTargetId(null)}
        >
          <View style={styles.reactionPicker}>
            {REACTION_EMOJIS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                style={styles.reactionBtn}
                onPress={() => reactionTargetId && sendReaction(reactionTargetId, emoji)}
              >
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 이미지 풀스크린 모달 */}
      <Modal
        visible={fullscreenImage !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setFullscreenImage(null)}
        statusBarTranslucent
      >
        <TouchableOpacity
          style={styles.fullscreenOverlay}
          activeOpacity={1}
          onPress={() => setFullscreenImage(null)}
        >
          <Image
            source={{ uri: fullscreenImage! }}
            style={styles.fullscreenImg}
            resizeMode="contain"
          />
        </TouchableOpacity>
      </Modal>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messageList}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
            const near = distFromBottom < 120;
            isNearBottomRef.current = near;
            setShowScrollBtn(!near);
            if (near) setUnreadCount(0);
          }}
          scrollEventThrottle={200}
          renderItem={({ item }) => {
            // 시스템 메시지 (입장/퇴장/폭탄 알림)
            if (item.contentType === 'system') {
              return (
                <View style={styles.systemMsgRow}>
                  <Text style={styles.systemMsgText}>{item.content}</Text>
                </View>
              );
            }

            const senderIdx = allUsers.indexOf(item.senderId);
            const senderColor = getColor(item.senderId);
            const senderLabel = senderIdx >= 0 ? `#${senderIdx + 1}` : '?';
            const reactionEntries = (Object.entries(item.reactions ?? {}) as [string, string[]][])
              .filter(([, uids]) => uids.length > 0);

            return (
              <View style={[styles.bubble, item.isMine && styles.bubbleMine]}>
                {!item.isMine && (
                  <View style={styles.senderCol}>
                    <View style={[styles.senderDot, { backgroundColor: senderColor }]} />
                    <Text style={[styles.senderLabel, { color: senderColor }]}>{senderLabel}</Text>
                  </View>
                )}
                <View style={styles.bubbleCol}>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => {
                      if (item.contentType === 'image') setFullscreenImage(item.content);
                    }}
                    onLongPress={() => {
                      if (item.contentType === 'image') {
                        saveImage(item.content);
                      } else {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        Alert.alert('메시지', undefined, [
                          { text: '공유', onPress: () => Share.share({ message: item.content }) },
                          { text: '리액션', onPress: () => setReactionTargetId(item.id) },
                          { text: '취소', style: 'cancel' },
                        ]);
                      }
                    }}
                  >
                    <View style={[
                      styles.bubbleBody,
                      item.isMine ? styles.bubbleBodyMine : styles.bubbleBodyOther,
                      !item.isMine && { borderLeftColor: senderColor, borderLeftWidth: 3 },
                    ]}>
                      {item.contentType === 'image' ? (
                        <Image
                          source={{ uri: item.content }}
                          style={styles.bubbleImage}
                          resizeMode="contain"
                        />
                      ) : (
                        <Text style={styles.bubbleText}>{item.content}</Text>
                      )}
                      <Text style={styles.bubbleTime}>
                        {new Date(item.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  {/* 리액션 칩 */}
                  {reactionEntries.length > 0 && (
                    <View style={[styles.reactionsRow, item.isMine && styles.reactionsRowMine]}>
                      {reactionEntries.map(([emoji, uids]) => {
                        const iMine = uids.includes(userId);
                        return (
                          <TouchableOpacity
                            key={emoji}
                            style={[styles.reactionChip, iMine && styles.reactionChipMine]}
                            onPress={() => sendReaction(item.id, emoji)}
                          >
                            <Text style={styles.reactionChipEmoji}>{emoji}</Text>
                            <Text style={styles.reactionChipCount}>{uids.length}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                {queueStatus === 'matched_waiting'
                  ? '모두 입장하면 대화가 시작됩니다'
                  : '첫 메시지를 보내보세요'}
              </Text>
            </View>
          }
        />

        {/* 타이핑 인디케이터 (애니메이션 점) */}
        {typingLabels.length > 0 && (
          <View style={styles.typingRow}>
            <View style={styles.typingDots}>
              {(['tdot-0', 'tdot-1', 'tdot-2'] as const).map((dotKey, i) => (
                <Animated.View
                  key={dotKey}
                  style={[styles.typingDot, {
                    transform: [{ translateY: dotAnims[i].interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
                    opacity: dotAnims[i].interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
                  }]}
                />
              ))}
            </View>
            <Text style={styles.typingText}>{typingLabels.join(', ')} 입력 중</Text>
          </View>
        )}

        <SafeAreaView edges={['bottom']} style={styles.inputArea}>
          <TouchableOpacity
            style={styles.imageBtn}
            onPress={pickAndSendImage}
            disabled={!canChat}
          >
            <Text style={[styles.imageBtnText, !canChat && styles.imageBtnDisabled]}>📷</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={handleInputChange}
            placeholder="메시지 입력..."
            placeholderTextColor="#4B5563"
            returnKeyType="send"
            onSubmitEditing={sendMessage}
            editable={canChat}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
            onPress={sendMessage}
            disabled={!input.trim()}
          >
            <Text style={styles.sendBtnText}>전송</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0E1A' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1F2937',
  },
  logo: { fontSize: 18, fontWeight: '900', color: '#F9FAFB', marginRight: 12 },
  usersRow: { flex: 1, flexDirection: 'row', gap: 6 },
  userDot: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  userDotText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  leaveBtn: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 8, borderWidth: 1, borderColor: '#374151',
  },
  leaveBtnText: { color: '#9CA3AF', fontSize: 13 },

  waitingOverlay: {
    backgroundColor: '#111827',
    padding: 16, alignItems: 'center',
    borderBottomWidth: 1, borderBottomColor: '#1F2937',
  },
  waitingText: { color: '#D1D5DB', fontSize: 14, fontWeight: '600' },
  waitingConnected: { color: '#6B7280', fontSize: 12, marginTop: 4 },

  messageList: { padding: 16, paddingBottom: 8 },
  bubble: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-end' },
  bubbleMine: { flexDirection: 'row-reverse' },
  bubbleCol: { maxWidth: '78%' },
  senderCol: { alignItems: 'center', marginRight: 6, marginBottom: 4 },
  senderDot: { width: 8, height: 8, borderRadius: 4 },
  senderLabel: { fontSize: 9, fontWeight: '700', marginTop: 2 },

  bubbleBody: {
    backgroundColor: '#111827', borderRadius: 16, padding: 12,
  },
  bubbleBodyMine: { backgroundColor: '#4C1D95' },
  bubbleBodyOther: { paddingLeft: 10 },
  bubbleText: { color: '#F9FAFB', fontSize: 15, lineHeight: 22 },
  bubbleImage: { width: 200, height: 200, borderRadius: 12 },
  bubbleTime: { color: '#6B7280', fontSize: 10, marginTop: 4, textAlign: 'right' },

  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionsRowMine: { justifyContent: 'flex-end' },
  reactionChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1F2937', borderRadius: 12,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 1, borderColor: '#374151',
  },
  reactionChipMine: { borderColor: '#7C3AED', backgroundColor: '#2D1B69' },
  reactionChipEmoji: { fontSize: 13 },
  reactionChipCount: { color: '#9CA3AF', fontSize: 11, marginLeft: 3 },

  emptyContainer: { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptyText: { color: '#374151', fontSize: 14 },

  typingRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 6,
  },
  typingDots: { flexDirection: 'row', gap: 4, marginRight: 8, alignItems: 'flex-end' },
  typingDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: '#7C3AED',
  },
  typingText: { color: '#6B7280', fontSize: 12 },

  inputArea: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: '#1F2937',
    backgroundColor: '#0A0E1A',
  },
  imageBtn: { paddingHorizontal: 8, paddingVertical: 10, marginRight: 4 },
  imageBtnText: { fontSize: 22 },
  imageBtnDisabled: { opacity: 0.3 },
  input: {
    flex: 1, backgroundColor: '#111827',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
    color: '#F9FAFB', fontSize: 15, maxHeight: 100,
    marginRight: 8, borderWidth: 1, borderColor: '#1F2937',
  },
  sendBtn: {
    backgroundColor: '#7C3AED', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  sendBtnDisabled: { backgroundColor: '#1F2937' },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  scrollBtn: {
    position: 'absolute', bottom: 80, right: 16, zIndex: 10,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#4C1D95', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  scrollBtnText: { color: '#fff', fontSize: 18, lineHeight: 22 },
  scrollBtnBadge: {
    position: 'absolute', top: -4, right: -4,
    backgroundColor: '#EF4444', borderRadius: 10,
    minWidth: 18, height: 18,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3,
  },
  scrollBtnBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  systemMsgRow: { alignItems: 'center', marginVertical: 6 },
  systemMsgText: {
    color: '#6B7280', fontSize: 12, textAlign: 'center',
    backgroundColor: '#111827', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 4,
    overflow: 'hidden',
  },

  fullscreenOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center', alignItems: 'center',
  },
  fullscreenImg: { width: '100%', height: '100%' },

  reactionOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center',
  },
  reactionPicker: {
    flexDirection: 'row', gap: 8,
    backgroundColor: '#1F2937', borderRadius: 32,
    paddingHorizontal: 16, paddingVertical: 12,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 12,
    elevation: 10,
  },
  reactionBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#374151',
  },
  reactionEmoji: { fontSize: 22 },
});
