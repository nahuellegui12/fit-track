import { createClient } from '@supabase/supabase-js';
import { type MealEntry } from './types';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        persistSession: false,
      },
    })
  : null;

export async function syncMealIfSupabaseConfigured(meal: MealEntry): Promise<void> {
  if (!supabase) {
    return;
  }

  await supabase.from('meals').insert({
    id: meal.id,
    name: meal.name,
    meal_type: meal.mealType,
    protein: meal.protein,
    carbs: meal.carbs,
    fats: meal.fats,
    calories: meal.calories,
    created_at: meal.createdAt,
  });
}
