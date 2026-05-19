import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { wsClient } from '../lib/websocket';

type Props = {
  readonly visible: boolean;
};

export function ConnectionBanner({ visible }: Props) {
  const slideAnim = useRef(new Animated.Value(-44)).current;
  const visibleRef = useRef(false);

  useEffect(() => {
    if (visible === visibleRef.current) return;
    visibleRef.current = visible;

    Animated.timing(slideAnim, {
      toValue: visible ? 0 : -44,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [visible, slideAnim]);

  // 컴포넌트는 항상 마운트 — 애니메이션으로만 show/hide
  return (
    <Animated.View
      style={[styles.banner, { transform: [{ translateY: slideAnim }] }]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      <Text style={styles.text}>🔌 서버 연결 끊김 — 재연결 중...</Text>
      <TouchableOpacity onPress={() => wsClient.reconnect()} style={styles.btn}>
        <Text style={styles.btnText}>지금 재연결</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#1F1506',
    borderBottomWidth: 1,
    borderBottomColor: '#92400E',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: { color: '#FCD34D', fontSize: 12, flex: 1 },
  btn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#D97706' },
  btnText: { color: '#F59E0B', fontSize: 11, fontWeight: '600' },
});
