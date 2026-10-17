export type GoalType = 'deficit' | 'maintenance' | 'surplus';

export type Sex = 'male' | 'female';

export type ActivityLevel = 'low' | 'medium' | 'high';
export type WorkType = 'sedentary' | 'active' | 'physical';
export type TrainingIntensity = 'low' | 'moderate' | 'high';

export type MealType = 'desayuno' | 'almuerzo' | 'cena' | 'snack';

export type TabId = 'home' | 'add' | 'profile';

export type MacroBreakdown = {
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
};

export type Profile = {
  name: string;
  age: number;
  weightKg: number;
  heightCm: number;
  sex: Sex;
  activityLevel: ActivityLevel;
  workType: WorkType;
  avgSteps: number;
  trainingDaysPerWeek: number;
  trainingDurationMin: number;
  trainingIntensity: TrainingIntensity;
  advancedCut: boolean;
  goal: GoalType;
  calorieAdjustment: number;
};

export type WeeklyWeighIn = {
  id: string;
  date: string;
  weightKg: number;
  isAtypicalWeek: boolean;
  atypicalReason?: string;
};

export type MealEntry = MacroBreakdown & {
  id: string;
  name: string;
  description?: string;
  mealType: MealType;
  createdAt: string;
};

export type FrequentMealItem = {
  name: string;
  weightGrams: number;
  proteinPer100: number;
  carbsPer100: number;
  fatsPer100: number;
};

export type FrequentMeal = {
  id: string;
  name: string;
  mealType: MealType;
  weightGrams: number;
  protein: number;
  carbs: number;
  fats: number;
  calories: number;
  entryMode: 'total' | 'items';
  items: FrequentMealItem[];
  createdAt: string;
};

export type AppState = {
  profile: Profile | null;
  meals: MealEntry[];
  weighIns: WeeklyWeighIn[];
  frequentMeals: FrequentMeal[];
};
