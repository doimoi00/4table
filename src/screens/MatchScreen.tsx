import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, Linking, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useStore } from '../store/useStore';
import { wsClient } from '../lib/websocket';
import { requestLocationAndGetDistrict } from '../lib/location';
import { ConnectionBanner } from '../components/ConnectionBanner';
import type { RootStackParamList } from '../../App';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Match'>;

export default function MatchScreen() {
  const nav = useNavigation<Nav>();
  const {
    userId, locationKey, locationDisplay,
    setLocation, queueStatus, setQueueStatus, queueSize, setQueueSize,
    wsConnected,
  } = useStore();

  const [locLoading, setLocLoading] = useState(false);
  const dotOpacity = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.3)).current,
  ];

  // 대기 중 점 애니메이션
  useEffect(() => {
    if (queueStatus !== 'queued') return;
    const anims = dotOpacity.map((a, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 200),
          Animated.timing(a, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(a, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ])
      )
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [queueStatus]);

  // 매칭 완료 → 채팅방으로 이동
  const roomId = useStore((s) => s.roomId);
  useEffect(() => {
    if (
      (queueStatus === 'active' || queueStatus === 'matched_waiting') &&
      roomId
    ) {
      nav.navigate('Chat', { roomId });
    }
  }, [queueStatus, roomId, nav]);

  const detectLocation = useCallback(async () => {
    setLocLoading(true);
    try {
      const info = await requestLocationAndGetDistrict();
      if (info) {
        setLocation(info.key, info.display);
      } else {
        Alert.alert(
          '위치 권한 필요',
          '매칭을 위해 위치 접근 권한이 필요합니다.\n설정에서 위치 권한을 허용해주세요.',
          [
            { text: '취소', style: 'cancel' },
            { text: '설정 열기', onPress: () => Linking.openSettings() },
          ]
        );
      }
    } finally {
      setLocLoading(false);
    }
  }, [setLocation]);

  // 최초 진입 시 위치 감지
  useEffect(() => {
    if (!locationKey) detectLocation();
  }, []);

  function startMatching() {
    if (!locationKey || !userId) return;
    wsClient.send({ type: 'JOIN_QUEUE', location: locationKey });
    setQueueStatus('queued');
    setQueueSize(0);
  }

  function cancelMatching() {
    wsClient.send({ type: 'CANCEL_QUEUE' });
    setQueueStatus('idle');
    setQueueSize(0);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ConnectionBanner visible={!wsConnected} />
      <View style={styles.container}>
        {/* 헤더 */}
        <View style={styles.header}>
          <Text style={styles.logo}>4table</Text>
          <Text style={styles.tagline}>동네 사람 4명, 5분 대화</Text>
        </View>

        {/* 위치 */}
        <TouchableOpacity style={styles.locationChip} onPress={detectLocation} disabled={locLoading}>
          <Text style={styles.locationIcon}>📍</Text>
          <Text style={styles.locationText}>
            {locLoading ? '위치 감지 중...' : (locationDisplay || '위치를 탭해 감지하세요')}
          </Text>
        </TouchableOpacity>

        {/* 상태 카드 */}
        <View style={styles.statusCard}>
          {queueStatus === 'idle' && (
            <>
              <Text style={styles.statusEmoji}>🪑</Text>
              <Text style={styles.statusTitle}>자리가 비어있어요</Text>
              <Text style={styles.statusSub}>
                {locationDisplay
                  ? `${locationDisplay} 사람들과 익명으로 대화해보세요`
                  : '위치를 먼저 설정해주세요'}
              </Text>
            </>
          )}

          {queueStatus === 'queued' && (
            <>
              <Text style={styles.statusEmoji}>⏳</Text>
              <Text style={styles.statusTitle}>
                {4 - Math.min(queueSize, 4)}명을 더 기다리는 중
              </Text>
              <View style={styles.dotsRow}>
                {dotOpacity.map((opacity, i) => (
                  <Animated.View key={`dot-${i}`} style={[styles.dot, { opacity }]} />
                ))}
              </View>
              <Text style={styles.statusSub}>앱을 꺼도 대기는 유지됩니다</Text>
              <Text style={styles.queueInfo}>{locationDisplay} · 현재 {queueSize}명 대기 중</Text>
            </>
          )}

          {queueStatus === 'matched_waiting' && (
            <>
              <Text style={styles.statusEmoji}>🎉</Text>
              <Text style={styles.statusTitle}>매칭 완료!</Text>
              <Text style={styles.statusSub}>입장 중...</Text>
            </>
          )}
        </View>

        {/* 버튼 */}
        {queueStatus === 'idle' && (
          <TouchableOpacity
            style={[styles.btn, !locationKey && styles.btnDisabled]}
            onPress={startMatching}
            disabled={!locationKey}
          >
            <Text style={styles.btnText}>매칭 시작</Text>
          </TouchableOpacity>
        )}

        {queueStatus === 'queued' && (
          <TouchableOpacity style={[styles.btn, styles.btnCancel]} onPress={cancelMatching}>
            <Text style={[styles.btnText, styles.btnCancelText]}>매칭 취소</Text>
          </TouchableOpacity>
        )}

        {/* 안내 */}
        <View style={styles.infoRow}>
          {['익명', '4명', '5분'].map((label) => (
            <View key={label} style={styles.infoChip}>
              <Text style={styles.infoText}>{label}</Text>
            </View>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0E1A' },
  container: { flex: 1, paddingHorizontal: 24, paddingTop: 8, alignItems: 'center' },
  header: { alignItems: 'center', marginTop: 16, marginBottom: 28 },
  logo: { fontSize: 36, fontWeight: '900', color: '#F9FAFB', letterSpacing: 2 },
  tagline: { fontSize: 13, color: '#6B7280', marginTop: 4 },

  locationChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111827', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 8,
    borderWidth: 1, borderColor: '#1F2937',
    marginBottom: 28,
  },
  locationIcon: { fontSize: 14, marginRight: 6 },
  locationText: { color: '#9CA3AF', fontSize: 14 },

  statusCard: {
    flex: 1, width: '100%', backgroundColor: '#111827',
    borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#1F2937',
    marginBottom: 24, paddingHorizontal: 24,
  },
  statusEmoji: { fontSize: 56, marginBottom: 20 },
  statusTitle: { fontSize: 22, fontWeight: '700', color: '#F9FAFB', textAlign: 'center', marginBottom: 8 },
  statusSub: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 22 },
  queueInfo: { fontSize: 12, color: '#4B5563', marginTop: 12 },

  dotsRow: { flexDirection: 'row', gap: 8, marginVertical: 16 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#7C3AED' },

  btn: {
    width: '100%', backgroundColor: '#7C3AED',
    borderRadius: 16, paddingVertical: 18, alignItems: 'center',
    marginBottom: 16,
  },
  btnDisabled: { backgroundColor: '#374151' },
  btnCancel: { backgroundColor: '#111827', borderWidth: 1, borderColor: '#EF4444' },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  btnCancelText: { color: '#EF4444' },

  infoRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  infoChip: {
    backgroundColor: '#1F2937', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  infoText: { color: '#6B7280', fontSize: 12 },
});
