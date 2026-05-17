import AsyncStorage from '@react-native-async-storage/async-storage';

function generate(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  // eslint-disable-next-line sonarjs/pseudo-random -- 익명 사용자 ID용, 보안 암호화 불필요
  for (let i = 0; i < 16; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return `${Date.now().toString(36)}-${result}`;
}

export async function getOrCreateUserId(): Promise<string> {
  const stored = await AsyncStorage.getItem('4table_user_id');
  if (stored) return stored;
  const id = generate();
  await AsyncStorage.setItem('4table_user_id', id);
  return id;
}
