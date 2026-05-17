import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, FlatList, Image, KeyboardAvoidingView, Platform,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
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

function UserDot({ userId, users, connectedUsers }: {
  userId: string; users: string[]; connectedUsers: string[];
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
    userId, messages, addMessage, connectedUsers,
    queueStatus, timebombEndsAt, matchDeadlineEndsAt,
    resetRoom, roomId, allUsers, wsConnected,
  } = useStore();

  const [input, setInput] = useState('');
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (!roomId) {
      wsClient.send({ type: 'JOIN_ROOM', room_id: routeRoomId });
    }
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  useEffect(() => {
    if (queueStatus === 'idle') {
      nav.navigate('Match');
    }
  }, [queueStatus, nav]);

  function sendMessage() {
    const text = input.trim();
    if (!text) return;
    wsClient.send({ type: 'CHAT', content: text, timestamp: new Date().toISOString() });
    addMessage({
      id: `${Date.now()}`,
      senderId: userId,
      content: text,
      contentType: 'text',
      timestamp: new Date().toISOString(),
      isMine: true,
    });
    setInput('');
  }

  const sendImage = useCallback(async (fromCamera: boolean) => {
    let result: ImagePicker.ImagePickerResult;
    if (fromCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('권한 필요', '카메라 접근 권한이 필요합니다.');
        return;
      }
      result = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 });
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('권한 필요', '사진 접근 권한이 필요합니다.');
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.6,
      });
    }
    if (result.canceled || !result.assets[0].base64) return;

    const asset = result.assets[0];
    const mimeType = asset.mimeType ?? 'image/jpeg';
    const base64 = asset.base64!;
    const msgId = `img-${Date.now()}`;

    webrtcManager.sendImageToAll(msgId, base64, mimeType);
    addMessage({
      id: msgId,
      senderId: userId,
      content: `data:${mimeType};base64,${base64}`,
      contentType: 'image',
      timestamp: new Date().toISOString(),
      isMine: true,
    });
  }, [userId, addMessage]);

  const pickAndSendImage = useCallback(() => {
    Alert.alert('사진 전송', '사진을 선택하세요', [
      { text: '카메라', onPress: () => sendImage(true) },
      { text: '앨범', onPress: () => sendImage(false) },
      { text: '취소', style: 'cancel' },
    ]);
  }, [sendImage]);

  const saveImage = useCallback(async (uri: string) => {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('권한 필요', '사진 저장을 위해 미디어 접근 권한이 필요합니다.');
      return;
    }
    try {
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert('저장 완료', '사진이 갤러리에 저장되었습니다.');
    } catch {
      Alert.alert('저장 실패', '사진 저장 중 오류가 발생했습니다.');
    }
  }, []);

  function handleLeave() {
    Alert.alert(
      '나가기',
      '나가면 5분 후 방이 종료됩니다. 나가시겠습니까?',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '나가기',
          style: 'destructive',
          onPress: () => {
            wsClient.send({ type: 'LEAVE' });
            resetRoom();
            nav.navigate('Match');
          },
        },
      ]
    );
  }

  const getColor = (senderId: string) => {
    const idx = allUsers.indexOf(senderId);
    return idx >= 0 ? USER_COLORS[idx % USER_COLORS.length] : '#6B7280';
  };

  const canChat = queueStatus === 'active' || queueStatus === 'timebomb';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ConnectionBanner visible={!wsConnected} />

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

      {/* 매칭 대기 타이머 */}
      {queueStatus === 'matched_waiting' && matchDeadlineEndsAt && (
        <MatchDeadlineBar endsAt={matchDeadlineEndsAt} />
      )}

      {/* 시한폭탄 바 */}
      {queueStatus === 'timebomb' && timebombEndsAt && (
        <TimeBombBar endsAt={timebombEndsAt} onExpire={() => {}} />
      )}

      {/* 대기 중 오버레이 */}
      {queueStatus === 'matched_waiting' && (
        <View style={styles.waitingOverlay}>
          <Text style={styles.waitingText}>⏳ 나머지 인원 입장 대기 중...</Text>
          <Text style={styles.waitingConnected}>{connectedUsers.length} / 4 명 입장 완료</Text>
        </View>
      )}

      {showScrollBtn && (
        <TouchableOpacity
          style={styles.scrollBtn}
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
        >
          <Text style={styles.scrollBtnText}>↓</Text>
        </TouchableOpacity>
      )}

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
            setShowScrollBtn(distFromBottom > 120);
          }}
          scrollEventThrottle={200}
          renderItem={({ item }) => {
            const senderIdx = allUsers.indexOf(item.senderId);
            const senderColor = getColor(item.senderId);
            const senderLabel = senderIdx >= 0 ? `#${senderIdx + 1}` : '?';
            return (
              <View style={[styles.bubble, item.isMine && styles.bubbleMine]}>
                {!item.isMine && (
                  <View style={styles.senderCol}>
                    <View style={[styles.senderDot, { backgroundColor: senderColor }]} />
                    <Text style={[styles.senderLabel, { color: senderColor }]}>{senderLabel}</Text>
                  </View>
                )}
                <View style={[
                  styles.bubbleBody,
                  item.isMine ? styles.bubbleBodyMine : styles.bubbleBodyOther,
                  !item.isMine && { borderLeftColor: senderColor, borderLeftWidth: 3 },
                ]}>
                  {item.contentType === 'image' ? (
                    <TouchableOpacity
                      onLongPress={() => saveImage(item.content)}
                      activeOpacity={0.85}
                    >
                      <Image
                        source={{ uri: item.content }}
                        style={styles.bubbleImage}
                        resizeMode="contain"
                      />
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.bubbleText}>{item.content}</Text>
                  )}
                  <Text style={styles.bubbleTime}>
                    {new Date(item.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                  </Text>
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
            onChangeText={setInput}
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
  senderCol: { alignItems: 'center', marginRight: 6, marginBottom: 4 },
  senderDot: { width: 8, height: 8, borderRadius: 4 },
  senderLabel: { fontSize: 9, fontWeight: '700', marginTop: 2 },
  bubbleBody: {
    maxWidth: '78%', backgroundColor: '#111827',
    borderRadius: 16, padding: 12,
  },
  bubbleBodyMine: { backgroundColor: '#4C1D95' },
  bubbleBodyOther: { paddingLeft: 10 },
  bubbleText: { color: '#F9FAFB', fontSize: 15, lineHeight: 22 },
  bubbleImage: { width: 200, height: 200, borderRadius: 12 },
  bubbleTime: { color: '#6B7280', fontSize: 10, marginTop: 4, textAlign: 'right' },

  emptyContainer: { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptyText: { color: '#374151', fontSize: 14 },

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
});
