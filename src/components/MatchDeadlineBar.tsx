import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { MATCH_TIMEOUT_SECONDS } from '../constants/config';

type Props = {
  readonly endsAt: number;
};

export function MatchDeadlineBar({ endsAt }: Props) {
  const [remaining, setRemaining] = useState(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  const progress = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const tick = setInterval(() => {
      const secs = Math.ceil((endsAt - Date.now()) / 1000);
      setRemaining(Math.max(0, secs));
    }, 500);
    return () => clearInterval(tick);
  }, [endsAt]);

  useEffect(() => {
    Animated.timing(progress, {
      toValue: remaining / MATCH_TIMEOUT_SECONDS,
      duration: 400,
      useNativeDriver: false,
    }).start();
  }, [remaining, progress]);

  const secs = remaining % 60;
  const timeStr = `${secs}초`;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>⚡ 1분 내 입장하지 않으면 매칭 취소</Text>
        <Text style={styles.timer}>{timeStr}</Text>
      </View>
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.fill,
            {
              width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0F1629',
    borderBottomWidth: 1,
    borderBottomColor: '#1E3A5F',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 6,
  },
  label: { color: '#93C5FD', fontSize: 12, fontWeight: '600' },
  timer: { fontSize: 15, fontWeight: '800', color: '#60A5FA', fontVariant: ['tabular-nums'] },
  track: { height: 4, backgroundColor: '#1E3A5F', borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: '#3B82F6', borderRadius: 2 },
});
