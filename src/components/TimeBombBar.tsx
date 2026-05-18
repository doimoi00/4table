import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { TIMEBOMB_SECONDS } from '../constants/config';

type Props = {
  readonly endsAt: number; // Date.now() timestamp
  readonly onExpire: () => void;
};

export function TimeBombBar({ endsAt, onExpire }: Props) {
  const [remaining, setRemaining] = useState(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  const progress = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const tick = setInterval(() => {
      const secs = Math.ceil((endsAt - Date.now()) / 1000);
      setRemaining(Math.max(0, secs));
      if (secs <= 0) {
        clearInterval(tick);
        onExpire();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [endsAt, onExpire]);

  useEffect(() => {
    const ratio = remaining / TIMEBOMB_SECONDS;
    Animated.timing(progress, {
      toValue: ratio,
      duration: 800,
      useNativeDriver: false,
    }).start();
  }, [remaining, progress]);

  // 깜빡임 (30초 이하)
  const isCritical = remaining <= 30;
  useEffect(() => {
    if (!isCritical) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 400, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [isCritical, pulseAnim]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
  let barColor = '#EF4444';
  if (remaining > 120) barColor = '#F59E0B';
  else if (remaining > 30) barColor = '#F97316';

  return (
    <Animated.View style={[styles.container, { opacity: remaining <= 30 ? pulseAnim : 1 }]}>
      <View style={styles.header}>
        <Text style={styles.label}>💣 방이 폭파됩니다</Text>
        <Text style={[styles.timer, { color: barColor }]}>{timeStr}</Text>
      </View>
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.fill,
            {
              backgroundColor: barColor,
              width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1A0A0A',
    borderBottomWidth: 1,
    borderBottomColor: '#7F1D1D',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  label: { color: '#FCA5A5', fontSize: 12, fontWeight: '600' },
  timer: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: {
    height: 4,
    backgroundColor: '#3F1515',
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 2 },
});
