import { type GoalType, type MacroBreakdown, type MealEntry, type Profile, type WeeklyWeighIn } from './types';

const GOAL_MULTIPLIER: Record<GoalType, number> = {
  deficit: 0.85,
  maintenance: 1,
  surplus: 1.08,
};

const WORK_NEAT_FACTOR = {
  sedentary: 1.2,
  active: 1.3,
  physical: 1.4,
} as const;

const LEGACY_ACTIVITY_ADJUSTMENT = {
  low: -0.02,
  medium: 0,
  high: 0.02,
} as const;

const TRAINING_MET = {
  low: 4.5,
  moderate: 6,
  high: 8,
} as const;

const GOAL_MACRO_RULES = {
  deficit: {
    proteinPerKg: 1.9,
    carbsFloorPerKg: 1.8,
    fatTargetPerKg: 0.8,
    fatMinPerKg: 0.65,
  },
  maintenance: {
    proteinPerKg: 1.7,
    carbsFloorPerKg: 2.2,
    fatTargetPerKg: 0.8,
    fatMinPerKg: 0.65,
  },
  surplus: {
    proteinPerKg: 1.6,
    carbsFloorPerKg: 2.8,
    fatTargetPerKg: 0.8,
    fatMinPerKg: 0.65,
  },
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getInitialProfile(): Profile {
  return {
    name: '',
    age: 28,
    weightKg: 70,
    heightCm: 175,
    sex: 'male',
    activityLevel: 'medium',
    workType: 'active',
    avgSteps: 8000,
    trainingDaysPerWeek: 4,
    trainingDurationMin: 60,
    trainingIntensity: 'moderate',
    advancedCut: false,
    goal: 'maintenance',
    calorieAdjustment: 0,
  };
}

export function normalizeProfile(profile: Profile): Profile {
  const defaults = getInitialProfile();
  return {
    ...defaults,
    ...profile,
    workType: profile.workType ?? defaults.workType,
    avgSteps: Number.isFinite(profile.avgSteps) ? profile.avgSteps : defaults.avgSteps,
    trainingDaysPerWeek: Number.isFinite(profile.trainingDaysPerWeek)
      ? profile.trainingDaysPerWeek
      : defaults.trainingDaysPerWeek,
    trainingDurationMin: Number.isFinite(profile.trainingDurationMin)
      ? profile.trainingDurationMin
      : defaults.trainingDurationMin,
    trainingIntensity: profile.trainingIntensity ?? defaults.trainingIntensity,
    advancedCut: Boolean(profile.advancedCut),
    calorieAdjustment: Number.isFinite(profile.calorieAdjustment)
      ? profile.calorieAdjustment
      : defaults.calorieAdjustment,
  };
}

function getStepsCorrection(avgSteps: number): number {
  if (avgSteps < 5000) {
    return -0.02;
  }

  if (avgSteps <= 10000) {
    return 0;
  }

  if (avgSteps <= 14000) {
    return 0.02;
  }

  return 0.03;
}

type NutritionComputation = {
  cleanProfile: Profile;
  safeWeightKg: number;
  safeHeightCm: number;
  safeAge: number;
  bmr: number;
  neatBase: number;
  neatCorrection: number;
  activityAdjustment: number;
  neatFactor: number;
  durationHours: number;
  sessionsPerWeek: number;
  netMet: number;
  trainingKcalNetDaily: number;
  tdee: number;
  targetCalories: number;
  proteinPerKg: number;
  protein: number;
  fatTarget: number;
  fatMin: number;
  fats: number;
  carbsFloor: number;
  carbs: number;
};

function computeNutrition(profile: Profile): NutritionComputation {
  const cleanProfile = normalizeProfile(profile);
  const safeWeightKg = clamp(cleanProfile.weightKg, 35, 220);
  const safeHeightCm = clamp(cleanProfile.heightCm, 130, 230);
  const safeAge = clamp(cleanProfile.age, 14, 90);
  const sexConstant = cleanProfile.sex === 'male' ? 5 : -161;
  const bmr = 10 * safeWeightKg + 6.25 * safeHeightCm - 5 * safeAge + sexConstant;
  const neatBase = WORK_NEAT_FACTOR[cleanProfile.workType];
  const neatCorrection = getStepsCorrection(cleanProfile.avgSteps);
  const activityAdjustment = LEGACY_ACTIVITY_ADJUSTMENT[cleanProfile.activityLevel];
  const neatFactor = clamp(neatBase + neatCorrection + activityAdjustment, 1.15, 1.52);
  const durationHours = clamp(cleanProfile.trainingDurationMin, 0, 180) / 60;
  const sessionsPerWeek = clamp(cleanProfile.trainingDaysPerWeek, 0, 14);
  const netMet = Math.max(TRAINING_MET[cleanProfile.trainingIntensity] - 1, 0);
  const trainingKcalNetDaily = (netMet * safeWeightKg * durationHours * sessionsPerWeek) / 7;
  const tdee = bmr * neatFactor + trainingKcalNetDaily;

  let targetCalories = tdee * GOAL_MULTIPLIER[cleanProfile.goal] + (cleanProfile.calorieAdjustment || 0);
  const macroRule = GOAL_MACRO_RULES[cleanProfile.goal];

  let proteinPerKg: number = macroRule.proteinPerKg;
  if (cleanProfile.goal === 'deficit' && cleanProfile.advancedCut) {
    proteinPerKg = 2.2;
  }

  const protein = clamp(safeWeightKg * proteinPerKg, safeWeightKg * 1.4, safeWeightKg * 2.4);
  const fatTarget = safeWeightKg * macroRule.fatTargetPerKg;
  const fatMin = safeWeightKg * macroRule.fatMinPerKg;
  let fats = Math.max(fatTarget, fatMin);
  let carbs = (targetCalories - protein * 4 - fats * 9) / 4;
  const carbsFloor = safeWeightKg * macroRule.carbsFloorPerKg;

  if (carbs < carbsFloor) {
    carbs = carbsFloor;
    fats = Math.max(fatTarget, fatMin);
    const requiredCalories = protein * 4 + carbs * 4 + fats * 9;
    if (targetCalories < requiredCalories) {
      targetCalories = requiredCalories;
    }

    if (fats < fatMin) {
      fats = fatMin;
      targetCalories = Math.max(targetCalories, protein * 4 + carbs * 4 + fats * 9);
    }
  }

  targetCalories = clamp(targetCalories, 1400, 6000);
  fats = Math.max(fats, fatMin);
  carbs = Math.max(carbs, carbsFloor);

  return {
    cleanProfile,
    safeWeightKg,
    safeHeightCm,
    safeAge,
    bmr,
    neatBase,
    neatCorrection,
    activityAdjustment,
    neatFactor,
    durationHours,
    sessionsPerWeek,
    netMet,
    trainingKcalNetDaily,
    tdee,
    targetCalories,
    proteinPerKg,
    protein,
    fatTarget,
    fatMin,
    fats,
    carbsFloor,
    carbs,
  };
}

export function calculateDailyTargets(profile: Profile): MacroBreakdown {
  const computed = computeNutrition(profile);

  return {
    calories: computed.targetCalories,
    protein: computed.protein,
    carbs: computed.carbs,
    fats: computed.fats,
  };
}

export type CalculationDiagnostics = {
  bmr: number;
  neatFactor: number;
  neatBase: number;
  neatStepsCorrection: number;
  activityLegacyAdjustment: number;
  trainingNetKcalDaily: number;
  tdee: number;
  goalMultiplier: number;
  calorieAdjustment: number;
  targetCalories: number;
  proteinPerKg: number;
  fatTargetG: number;
  fatMinG: number;
  carbsFloorG: number;
  macros: MacroBreakdown;
};

export function getCalculationDiagnostics(profile: Profile): CalculationDiagnostics {
  const computed = computeNutrition(profile);
  return {
    bmr: computed.bmr,
    neatFactor: computed.neatFactor,
    neatBase: computed.neatBase,
    neatStepsCorrection: computed.neatCorrection,
    activityLegacyAdjustment: computed.activityAdjustment,
    trainingNetKcalDaily: computed.trainingKcalNetDaily,
    tdee: computed.tdee,
    goalMultiplier: GOAL_MULTIPLIER[computed.cleanProfile.goal],
    calorieAdjustment: computed.cleanProfile.calorieAdjustment,
    targetCalories: computed.targetCalories,
    proteinPerKg: computed.proteinPerKg,
    fatTargetG: computed.fatTarget,
    fatMinG: computed.fatMin,
    carbsFloorG: computed.carbsFloor,
    macros: {
      calories: computed.targetCalories,
      protein: computed.protein,
      carbs: computed.carbs,
      fats: computed.fats,
    },
  };
}

export function aggregateDailyMacros(meals: MealEntry[], date: Date): MacroBreakdown {
  return meals.reduce<MacroBreakdown>(
    (acc, meal) => {
      const mealDate = new Date(meal.createdAt);
      const isSameDay =
        mealDate.getDate() === date.getDate() &&
        mealDate.getMonth() === date.getMonth() &&
        mealDate.getFullYear() === date.getFullYear();

      if (!isSameDay) {
        return acc;
      }

      return {
        calories: acc.calories + meal.calories,
        protein: acc.protein + meal.protein,
        carbs: acc.carbs + meal.carbs,
        fats: acc.fats + meal.fats,
      };
    },
    {
      calories: 0,
      protein: 0,
      carbs: 0,
      fats: 0,
    },
  );
}

export function formatGoalLabel(goal: GoalType): string {
  if (goal === 'deficit') {
    return 'Objetivo: Deficit calorico';
  }

  if (goal === 'surplus') {
    return 'Objetivo: Superavit para masa muscular';
  }

  return 'Objetivo: Mantenimiento';
}

export type RecalibrationSuggestion = {
  key: string;
  deltaCalories: number;
  reason: string;
  measuredWeeklyChangePct: number;
  expectedRange: { min: number; max: number };
};

export type RecalibrationContext = {
  adherencePct: number;
  hasAtypicalWeek: boolean;
};

function calculateAdherencePct(meals: MealEntry[], targetCalories: number): number {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 13);

  const dailyMap = new Map<string, number>();
  for (const meal of meals) {
    const mealDate = new Date(meal.createdAt);
    if (mealDate < start || mealDate > now) {
      continue;
    }
    const key = mealDate.toISOString().slice(0, 10);
    dailyMap.set(key, (dailyMap.get(key) ?? 0) + meal.calories);
  }

  if (dailyMap.size < 8 || targetCalories <= 0) {
    return 0;
  }

  let score = 0;
  for (const value of dailyMap.values()) {
    const deviation = Math.abs(value - targetCalories) / targetCalories;
    score += Math.max(0, 1 - deviation);
  }

  return (score / dailyMap.size) * 100;
}

export function buildRecalibrationSuggestion(
  profile: Profile,
  weighIns: WeeklyWeighIn[],
  meals: MealEntry[],
): RecalibrationSuggestion | null {
  if (weighIns.length < 2) {
    return null;
  }

  const cleanProfile = normalizeProfile(profile);

  const sorted = [...weighIns].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const latest = sorted[sorted.length - 1];
  const baseline = sorted[0];
  const millisDiff = new Date(latest.date).getTime() - new Date(baseline.date).getTime();
  const daysDiff = millisDiff / (1000 * 60 * 60 * 24);

  if (daysDiff < 14 || baseline.weightKg <= 0) {
    return null;
  }

  const lastTwo = sorted.slice(-2);
  const hasAtypicalWeek = lastTwo.some((entry) => entry.isAtypicalWeek);
  if (hasAtypicalWeek) {
    return null;
  }

  const adherencePct = calculateAdherencePct(meals, calculateDailyTargets(cleanProfile).calories);
  if (adherencePct < 80) {
    return null;
  }

  const weeklyChangePct = (((latest.weightKg - baseline.weightKg) / baseline.weightKg) * 100 * 7) / daysDiff;

  const ranges = {
    deficit: { min: -0.75, max: -0.25 },
    maintenance: { min: -0.2, max: 0.2 },
    surplus: { min: 0.1, max: 0.4 },
  } as const;

  const range = ranges[cleanProfile.goal];
  let deltaCalories = 0;
  let reason = '';

  if (cleanProfile.goal === 'deficit') {
    if (weeklyChangePct > range.max) {
      deltaCalories = -120;
      reason = 'No estas bajando peso al ritmo esperado para deficit.';
    } else if (weeklyChangePct < -0.9) {
      deltaCalories = 100;
      reason = 'Estas bajando peso muy rapido; ajustamos para proteger masa muscular.';
    }
  }

  if (cleanProfile.goal === 'surplus') {
    if (weeklyChangePct < range.min) {
      deltaCalories = 120;
      reason = 'No estas subiendo peso al ritmo esperado para superavit.';
    } else if (weeklyChangePct > 0.6) {
      deltaCalories = -100;
      reason = 'Estas subiendo peso muy rapido; ajustamos para evitar exceso de grasa.';
    }
  }

  if (cleanProfile.goal === 'maintenance') {
    if (weeklyChangePct > range.max) {
      deltaCalories = -100;
      reason = 'Estas subiendo peso sobre el rango de mantenimiento.';
    } else if (weeklyChangePct < range.min) {
      deltaCalories = 100;
      reason = 'Estas bajando peso sobre el rango de mantenimiento.';
    }
  }

  if (deltaCalories === 0) {
    return null;
  }

  return {
    key: `${cleanProfile.goal}-${latest.date}-${Math.sign(deltaCalories)}`,
    deltaCalories,
    reason: `${reason} (adherencia ${Math.round(adherencePct)}%).`,
    measuredWeeklyChangePct: weeklyChangePct,
    expectedRange: range,
  };
}
