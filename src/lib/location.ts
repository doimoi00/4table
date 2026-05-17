import * as Location from 'expo-location';

export type LocationInfo = {
  key: string;    // 서버 큐 키 (예: "강남구_역삼동")
  display: string; // 화면 표시용 (예: "역삼동")
};

export async function requestLocationAndGetDistrict(): Promise<LocationInfo | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return null;

  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const [place] = await Location.reverseGeocodeAsync({
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
  });

  if (!place) return null;

  // Expo reverseGeocode 필드: city, district, subregion, street
  const district = place.district || place.subregion || place.city || '';
  const city = place.city || place.subregion || '';

  // 법정동/행정동 단위 키 생성
  const key = district
    ? `${city}_${district}`.replace(/\s+/g, '_')
    : city.replace(/\s+/g, '_');

  return {
    key: key || 'unknown',
    display: district || city || '알 수 없음',
  };
}
