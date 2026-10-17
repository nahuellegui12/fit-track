import { type AppState } from './types';
import { requireSupabase } from './supabase';

type UserAppStateRow = {
  state: AppState;
};

export async function loadCloudAppState(userId: string): Promise<AppState | null> {
  const client = requireSupabase();
  const { data, error } = await client
    .from('user_app_states')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle<UserAppStateRow>();

  if (error) {
    throw new Error(`No pudimos descargar tus datos: ${error.message}`);
  }
  return data?.state ?? null;
}

export async function saveCloudAppState(userId: string, state: AppState): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from('user_app_states').upsert(
    {
      user_id: userId,
      state,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) {
    throw new Error(`No pudimos sincronizar tus datos: ${error.message}`);
  }
}
