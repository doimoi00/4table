import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerForPushNotifications(): Promise<string> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return '';
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('4table-match', {
      name: '4table 매칭 알림',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#7C3AED',
      sound: 'default',
    });
  }

  // 서버가 FCM HTTP v1 API를 직접 호출하므로 Expo 프록시 토큰이 아닌 네이티브 FCM 토큰이 필요
  const token = await Notifications.getDevicePushTokenAsync();
  return token.data as string;
}
