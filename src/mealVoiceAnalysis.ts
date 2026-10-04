import { z } from 'zod';
import { getOrCreateDeviceId } from './storage';

export const freeTierLimitPerDay = 8;

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const responseSchema = z.object({
  name: z.string(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative(),
  fats: z.number().nonnegative(),
  calories: z.number().nonnegative(),
  items: z
    .array(
      z.object({
        name: z.string(),
        weightGrams: z.number().nonnegative(),
        proteinPer100: z.number().nonnegative(),
        carbsPer100: z.number().nonnegative(),
        fatsPer100: z.number().nonnegative(),
      }),
    )
    .default([]),
});

const analysisSchema = z.object({
  analysis: responseSchema,
  remainingToday: z.number().int().nonnegative(),
});

const usageSchema = z.object({
  remainingToday: z.number().int().nonnegative(),
});

export type MealVoiceAnalysis = z.infer<typeof responseSchema>;

export async function getVoiceAnalysesLeft(): Promise<number> {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Configura EXPO_PUBLIC_SUPABASE_URL y EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  }

  const deviceId = await getOrCreateDeviceId();
  const response = await fetch(`${supabaseUrl}/functions/v1/parse-meal-description?usageOnly=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      'x-device-id': deviceId,
    },
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof raw?.error === 'string' ? raw.error : 'No pudimos consultar la cuota diaria.';
    throw new Error(message);
  }

  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('La respuesta de cuota no fue valida.');
  }

  return parsed.data.remainingToday;
}

export async function analyzeMealDescription(description: string): Promise<MealVoiceAnalysis> {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase no configurado.');
  }

  const cleanDescription = description.trim();
  if (!cleanDescription) {
    throw new Error('Escribe o dicta lo que comiste para analizarlo.');
  }

  const deviceId = await getOrCreateDeviceId();
  const response = await fetch(`${supabaseUrl}/functions/v1/parse-meal-description`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      'x-device-id': deviceId,
    },
    body: JSON.stringify({
      description: cleanDescription,
    }),
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof raw?.error === 'string' ? raw.error : 'No pudimos procesar tu descripcion.';
    throw new Error(message);
  }

  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('La respuesta del analisis no fue valida.');
  }

  return parsed.data.analysis;
}

export async function analyzeMealAudio(audioBase64: string, mimeType: string): Promise<MealVoiceAnalysis> {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase no configurado.');
  }

  if (!audioBase64) {
    throw new Error('No se detecto audio para analizar.');
  }

  const deviceId = await getOrCreateDeviceId();
  const response = await fetch(`${supabaseUrl}/functions/v1/parse-meal-description`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      'x-device-id': deviceId,
    },
    body: JSON.stringify({
      audioBase64,
      mimeType,
    }),
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof raw?.error === 'string' ? raw.error : 'No pudimos procesar tu descripcion.';
    throw new Error(message);
  }

  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('La respuesta del analisis no fue valida.');
  }

  return parsed.data.analysis;
}
