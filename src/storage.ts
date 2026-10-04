import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AppState } from './types';

const APP_STATE_KEY = 'fittrack:app-state';
const DEVICE_ID_KEY = 'fittrack:device-id';

const EMPTY_STATE: AppState = {
  profile: null,
  meals: [],
  weighIns: [],
  frequentMeals: [],
};

export async function loadAppState(): Promise<AppState> {
  const raw = await AsyncStorage.getItem(APP_STATE_KEY);
  if (!raw) {
    return EMPTY_STATE;
  }

  try {
    const parsed = JSON.parse(raw) as AppState;
    return {
      profile: parsed.profile,
      meals: parsed.meals ?? [],
      weighIns: parsed.weighIns ?? [],
      frequentMeals: parsed.frequentMeals ?? [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

export async function saveAppState(state: AppState): Promise<void> {
  await AsyncStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
}

export async function readCounterForToday(keyPrefix: string): Promise<number> {
  const dayKey = `${keyPrefix}:${new Date().toISOString().slice(0, 10)}`;
  const raw = await AsyncStorage.getItem(dayKey);
  return Number(raw || 0);
}

export async function incrementCounterForToday(keyPrefix: string): Promise<number> {
  const dayKey = `${keyPrefix}:${new Date().toISOString().slice(0, 10)}`;
  const currentValue = await readCounterForToday(keyPrefix);
  const next = currentValue + 1;
  await AsyncStorage.setItem(dayKey, String(next));
  return next;
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
