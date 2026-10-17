import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AppState } from './types';

const LEGACY_APP_STATE_KEY = 'fittrack:app-state';
const USER_APP_STATE_PREFIX = 'fittrack:app-state:user:';
const LEGACY_MIGRATED_KEY = 'fittrack:legacy-state-migrated';
const LAST_USERNAME_KEY = 'fittrack:last-username';
const DEVICE_ID_KEY = 'fittrack:device-id';

export const EMPTY_STATE: AppState = {
  profile: null,
  meals: [],
  weighIns: [],
  frequentMeals: [],
};

function parseAppState(raw: string | null): AppState | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as AppState;
    return {
      profile: parsed.profile ?? null,
      meals: parsed.meals ?? [],
      weighIns: parsed.weighIns ?? [],
      frequentMeals: parsed.frequentMeals ?? [],
    };
  } catch {
    return null;
  }
}

export async function loadUserAppState(userId: string): Promise<AppState | null> {
  return parseAppState(await AsyncStorage.getItem(`${USER_APP_STATE_PREFIX}${userId}`));
}

export async function saveUserAppState(userId: string, state: AppState): Promise<void> {
  await AsyncStorage.setItem(`${USER_APP_STATE_PREFIX}${userId}`, JSON.stringify(state));
}

export async function loadLegacyAppStateForMigration(): Promise<AppState | null> {
  const migrated = await AsyncStorage.getItem(LEGACY_MIGRATED_KEY);
  if (migrated === '1') {
    return null;
  }
  return parseAppState(await AsyncStorage.getItem(LEGACY_APP_STATE_KEY));
}

export async function markLegacyAppStateMigrated(): Promise<void> {
  await AsyncStorage.setItem(LEGACY_MIGRATED_KEY, '1');
}

export async function getLastUsername(): Promise<string> {
  return (await AsyncStorage.getItem(LAST_USERNAME_KEY)) ?? '';
}

export async function saveLastUsername(username: string): Promise<void> {
  await AsyncStorage.setItem(LAST_USERNAME_KEY, username);
}

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }

  const created = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await AsyncStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}
