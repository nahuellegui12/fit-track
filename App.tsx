import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import {
  type GoalType,
  type FrequentMeal,
  type MacroBreakdown,
  type MealEntry,
  type Profile,
  type Sex,
  type TabId,
  type TrainingIntensity,
  type WeeklyWeighIn,
  type WorkType,
} from './src/types';
import { COLORS } from './src/theme';
import {
  aggregateDailyMacros,
  buildRecalibrationSuggestion,
  calculateDailyTargets,
  formatGoalLabel,
  getCalculationDiagnostics,
  getInitialProfile,
  normalizeProfile,
} from './src/nutrition';
import {
  analyzeMealAudio,
  freeTierLimitPerDay,
  getVoiceAnalysesLeft,
} from './src/mealVoiceAnalysis';
import {
  EMPTY_STATE,
  getLastUsername,
  loadLegacyAppStateForMigration,
  loadUserAppState,
  markLegacyAppStateMigrated,
  saveLastUsername,
  saveUserAppState,
} from './src/storage';
import { isSupabaseConfigured } from './src/supabase';
import {
  getCurrentAccount,
  loginWithUsername,
  logout,
  normalizeUsername,
  registerWithUsername,
  subscribeToAccount,
  type Account,
} from './src/auth';
import { loadCloudAppState, saveCloudAppState } from './src/cloudState';
import {
  createMealAudioRecorder,
  type MealAudioRecorder,
  playRecordingFeedback,
} from './src/mealAudioRecorder';

export default function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const accountIdRef = useRef<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('home');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [meals, setMeals] = useState<MealEntry[]>([]);
  const [weighIns, setWeighIns] = useState<WeeklyWeighIn[]>([]);
  const [frequentMeals, setFrequentMeals] = useState<FrequentMeal[]>([]);
  const [lastHandledSuggestionKey, setLastHandledSuggestionKey] = useState('');
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsAuthLoading(false);
      setIsHydrating(false);
      return;
    }

    const handleAccountChange = (nextAccount: Account | null) => {
      const nextAccountId = nextAccount?.id ?? null;
      if (accountIdRef.current === nextAccountId) {
        return;
      }

      accountIdRef.current = nextAccountId;
      if (nextAccount) {
        setIsHydrating(true);
      }
      setAccount(nextAccount);
    };

    const subscription = subscribeToAccount(handleAccountChange);
    getCurrentAccount()
      .then(handleAccountChange)
      .catch(() => handleAccountChange(null))
      .finally(() => setIsAuthLoading(false));

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!account) {
      setProfile(null);
      setMeals([]);
      setWeighIns([]);
      setFrequentMeals([]);
      setIsHydrating(false);
      return;
    }

    let cancelled = false;
    setIsHydrating(true);

    const hydrate = async () => {
      let cloudState = null;
      try {
        cloudState = await loadCloudAppState(account.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No pudimos descargar tus datos.';
        Alert.alert('Sincronizacion no disponible', `${message}\n\nSe usaran los datos guardados en este dispositivo.`);
      }

      const localState = await loadUserAppState(account.id);
      let appState = cloudState ?? localState;
      let migratedLegacyState = false;

      if (!appState) {
        const legacyState = await loadLegacyAppStateForMigration();
        if (legacyState) {
          appState = legacyState;
          migratedLegacyState = true;
        }
      }

      appState ??= EMPTY_STATE;
      if (cancelled) {
        return;
      }

      setProfile(appState.profile ? normalizeProfile(appState.profile) : null);
      setMeals(appState.meals ?? []);
      setWeighIns(appState.weighIns ?? []);
      setFrequentMeals(appState.frequentMeals ?? []);
      await saveUserAppState(account.id, appState);

      if (!cloudState) {
        await saveCloudAppState(account.id, appState);
      }
      if (migratedLegacyState) {
        await markLegacyAppStateMigrated();
      }
    };

    hydrate()
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'No pudimos preparar tu cuenta.';
        Alert.alert('Error al cargar la cuenta', message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsHydrating(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    if (!account || isHydrating) {
      return;
    }

    const appState = { profile, meals, weighIns, frequentMeals };
    saveUserAppState(account.id, appState).catch(() => undefined);

    const timer = setTimeout(() => {
      saveCloudAppState(account.id, appState).catch(() => undefined);
    }, 500);

    return () => clearTimeout(timer);
  }, [account, profile, meals, weighIns, frequentMeals, isHydrating]);

  useEffect(() => {
    if (!profile) {
      return;
    }

    const suggestion = buildRecalibrationSuggestion(profile, weighIns, meals);
    if (!suggestion || suggestion.key === lastHandledSuggestionKey) {
      return;
    }

    const deltaLabel = suggestion.deltaCalories > 0 ? `+${suggestion.deltaCalories}` : `${suggestion.deltaCalories}`;
    Alert.alert(
      'Recalibrar macros',
      `${suggestion.reason}\n\nCambio semanal detectado: ${suggestion.measuredWeeklyChangePct.toFixed(2)}%\nRango esperado: ${suggestion.expectedRange.min}% a ${suggestion.expectedRange.max}%\n\nPropuesta: ${deltaLabel} kcal/dia`,
      [
        {
          text: 'Cancelar',
          style: 'cancel',
          onPress: () => setLastHandledSuggestionKey(suggestion.key),
        },
        {
          text: 'Aplicar',
          onPress: () => {
            setProfile((prev) => {
              if (!prev) {
                return prev;
              }

              const nextAdjustment = Math.max(-700, Math.min(700, prev.calorieAdjustment + suggestion.deltaCalories));
              return {
                ...prev,
                calorieAdjustment: nextAdjustment,
              };
            });
            setLastHandledSuggestionKey(suggestion.key);
          },
        },
      ],
    );
  }, [profile, weighIns, meals, lastHandledSuggestionKey]);

  if (isAuthLoading || (account && isHydrating)) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Cargando FitTrack...</Text>
      </SafeAreaView>
    );
  }

  if (!account) {
    return <AuthScreen />;
  }

  if (!profile) {
    return <OnboardingScreen onComplete={setProfile} />;
  }

  const dailyTargets = calculateDailyTargets(profile);
  const dailyTotals = aggregateDailyMacros(meals, new Date());

  const addMeal = async (meal: Omit<MealEntry, 'id'>) => {
    const completeMeal = {
      ...meal,
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    };

    setMeals((prev) => [completeMeal, ...prev]);
    setActiveTab('home');
  };

  const addWeeklyWeighIn = (weightKg: number, isAtypicalWeek = false, atypicalReason = '') => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      date: new Date().toISOString(),
      weightKg,
      isAtypicalWeek,
      atypicalReason: atypicalReason.trim() || undefined,
    };

    setWeighIns((prev) => [entry, ...prev].slice(0, 20));
  };

  const updateWeeklyWeighIn = (id: string, weightKg: number) => {
    setWeighIns((prev) => prev.map((entry) => (entry.id === id ? { ...entry, weightKg } : entry)));
  };

  const deleteWeeklyWeighIn = (id: string) => {
    setWeighIns((prev) => prev.filter((entry) => entry.id !== id));
  };

  const upsertFrequentMeal = (
    payload: Omit<FrequentMeal, 'id' | 'createdAt'>,
    existingId?: string,
  ) => {
    const nextFrequentMeal: FrequentMeal = {
      ...payload,
      id: existingId ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
    };

    setFrequentMeals((prev) => {
      if (existingId) {
        return prev.map((item) => (item.id === existingId ? nextFrequentMeal : item));
      }

      return [nextFrequentMeal, ...prev].slice(0, 30);
    });
  };

  const deleteFrequentMeal = (id: string) => {
    setFrequentMeals((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.appHeader}>
        <View style={styles.brandRow}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarEmoji}>🧑‍💼</Text>
          </View>
          <View>
            <Text style={styles.brandTitle}>FitTrack</Text>
            <Text style={styles.brandSubtitle}>@{account.username} · {formatGoalLabel(profile.goal)}</Text>
          </View>
        </View>
        <View style={styles.kcalPill}>
          <Text style={styles.kcalPillText}>{Math.round(dailyTotals.calories)} kcal</Text>
        </View>
      </View>

      <View style={styles.screenContent}>
        {activeTab === 'home' && (
          <HomeTab
            dailyTotals={dailyTotals}
            dailyTargets={dailyTargets}
            meals={meals}
            weighIns={weighIns}
            onAddWeighIn={addWeeklyWeighIn}
            onLaunchCamera={() => setActiveTab('add')}
          />
        )}
        {activeTab === 'add' && (
          <AddMealTab
            onAddMeal={addMeal}
            frequentMeals={frequentMeals}
            onSaveFrequent={upsertFrequentMeal}
            onDeleteFrequent={deleteFrequentMeal}
          />
        )}
        {activeTab === 'profile' && (
          <ProfileTab
            profile={profile}
            weighIns={weighIns}
            onSave={(nextProfile) => setProfile(nextProfile)}
            onAddWeighIn={addWeeklyWeighIn}
            onUpdateWeighIn={updateWeeklyWeighIn}
            onDeleteWeighIn={deleteWeeklyWeighIn}
            username={account.username}
            onLogout={async () => {
              try {
                await logout();
                setActiveTab('home');
              } catch (error) {
                const message = error instanceof Error ? error.message : 'No pudimos cerrar la sesion.';
                Alert.alert('Error', message);
              }
            }}
          />
        )}
      </View>

      <View style={styles.bottomNav}>
        <TabButton label="HOME" icon="home" isActive={activeTab === 'home'} onPress={() => setActiveTab('home')} />
        <TabButton label="LOG" icon="log" isActive={activeTab === 'add'} onPress={() => setActiveTab('add')} />
        <TabButton label="PROFILE" icon="profile" isActive={activeTab === 'profile'} onPress={() => setActiveTab('profile')} />
      </View>
    </SafeAreaView>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    getLastUsername().then(setUsername).catch(() => undefined);
  }, []);

  const submit = async () => {
    if (mode === 'register' && password !== confirmPassword) {
      Alert.alert('Las contraseñas no coinciden', 'Revisa ambos campos e intenta nuevamente.');
      return;
    }

    setIsSubmitting(true);
    try {
      const account = mode === 'register'
        ? await registerWithUsername(username, password)
        : await loginWithUsername(username, password);
      await saveLastUsername(account.username);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No pudimos ingresar a tu cuenta.';
      Alert.alert(mode === 'register' ? 'No pudimos crear la cuenta' : 'No pudimos ingresar', message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.authContainer}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.authKeyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.authScrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.authBrandMark}>
            <Text style={styles.authBrandLetter}>F</Text>
          </View>
          <Text style={styles.authTitle}>FitTrack</Text>
          <Text style={styles.authSubtitle}>
            {mode === 'login'
              ? 'Ingresa para continuar con tu seguimiento.'
              : 'Crea tu cuenta personal en menos de un minuto.'}
          </Text>

          <View style={styles.authCard}>
            <View style={styles.authModeRow}>
              <Pressable
                style={[styles.authModeButton, mode === 'login' && styles.authModeButtonActive]}
                onPress={() => setMode('login')}
              >
                <Text style={[styles.authModeText, mode === 'login' && styles.authModeTextActive]}>Ingresar</Text>
              </Pressable>
              <Pressable
                style={[styles.authModeButton, mode === 'register' && styles.authModeButtonActive]}
                onPress={() => setMode('register')}
              >
                <Text style={[styles.authModeText, mode === 'register' && styles.authModeTextActive]}>Crear cuenta</Text>
              </Pressable>
            </View>

            {!isSupabaseConfigured && (
              <View style={styles.authErrorCard}>
                <Text style={styles.authErrorText}>Falta configurar Supabase en las variables de entorno.</Text>
              </View>
            )}

            <FormLabel text="Nombre de usuario" />
            <TextInput
              value={username}
              onChangeText={(value) => setUsername(normalizeUsername(value))}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
              placeholder="Ej: nahuel"
              placeholderTextColor={COLORS.textMuted}
              style={styles.authInput}
            />
            <Text style={styles.authHelper}>3 a 20 caracteres: letras, numeros, guion o guion bajo.</Text>

            <FormLabel text="Contraseña" />
            <TextInput
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              maxLength={72}
              placeholder="Minimo 8 caracteres"
              placeholderTextColor={COLORS.textMuted}
              style={styles.authInput}
            />
            <Text style={styles.authHelper}>Debe incluir al menos una letra y un numero.</Text>

            {mode === 'register' && (
              <>
                <FormLabel text="Repetir contraseña" />
                <TextInput
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  maxLength={72}
                  placeholder="Repeti la contraseña"
                  placeholderTextColor={COLORS.textMuted}
                  style={styles.authInput}
                />
              </>
            )}

            <Pressable
              style={[styles.authSubmitButton, (isSubmitting || !isSupabaseConfigured) && styles.buttonDisabled]}
              onPress={submit}
              disabled={isSubmitting || !isSupabaseConfigured}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.authSubmitText}>{mode === 'login' ? 'Ingresar' : 'Crear mi cuenta'}</Text>
              )}
            </Pressable>

            <Text style={styles.authPrivacyNote}>
              Tu nombre quedara recordado en este dispositivo. La contraseña nunca se guarda localmente.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function OnboardingScreen({ onComplete }: { onComplete: (profile: Profile) => void }) {
  const [form, setForm] = useState<Profile>(getInitialProfile());

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.formContainer}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Text style={styles.title}>Bienvenido a FitTrack</Text>
          <Text style={styles.subtitle}>Configuramos tus macros en menos de 1 minuto.</Text>

        <FormLabel text="Nombre" />
        <TextInput
          value={form.name}
          placeholder="Ej: Nahuel"
          placeholderTextColor={COLORS.textMuted}
          onChangeText={(value) => setForm((prev) => ({ ...prev, name: value }))}
          style={styles.input}
        />

        <FormLabel text="Edad" />
        <TextInput
          value={String(form.age)}
          keyboardType="number-pad"
          onChangeText={(value) => setForm((prev) => ({ ...prev, age: Number(value) || 0 }))}
          style={styles.input}
        />

        <FormLabel text="Peso (kg)" />
        <TextInput
          value={String(form.weightKg)}
          keyboardType="decimal-pad"
          onChangeText={(value) => setForm((prev) => ({ ...prev, weightKg: Number(value) || 0 }))}
          style={styles.input}
        />

        <FormLabel text="Altura (cm)" />
        <TextInput
          value={String(form.heightCm)}
          keyboardType="number-pad"
          onChangeText={(value) => setForm((prev) => ({ ...prev, heightCm: Number(value) || 0 }))}
          style={styles.input}
        />

        <FormLabel text="Sexo" />
        <RowChoices<Sex>
          options={[
            { value: 'male', label: 'Hombre' },
            { value: 'female', label: 'Mujer' },
          ]}
          selected={form.sex}
          onSelect={(value) => setForm((prev) => ({ ...prev, sex: value }))}
        />

        <FormLabel text="Actividad" />
        <RowChoices
          options={[
            { value: 'low', label: 'Baja' },
            { value: 'medium', label: 'Media' },
            { value: 'high', label: 'Alta' },
          ]}
          selected={form.activityLevel}
          onSelect={(value) => setForm((prev) => ({ ...prev, activityLevel: value }))}
        />
        <View style={styles.activityHintCard}>
          <Text style={styles.activityHintTitle}>Guia rapida de actividad</Text>
          <Text style={styles.activityHintLine}>Baja: oficina/sedentarismo, poca actividad diaria.</Text>
          <Text style={styles.activityHintLine}>Media: entrenas 3-5 dias por semana.</Text>
          <Text style={styles.activityHintLine}>Alta: entrenas intenso 6-7 dias o trabajo fisico.</Text>
        </View>

        <FormLabel text="Tipo de trabajo" />
        <RowChoices<WorkType>
          options={[
            { value: 'sedentary', label: 'Sedentario' },
            { value: 'active', label: 'Activo' },
            { value: 'physical', label: 'Fisico' },
          ]}
          selected={form.workType}
          onSelect={(workType) => setForm((prev) => ({ ...prev, workType }))}
        />

        <FormLabel text="Pasos promedio/dia" />
        <TextInput
          value={String(form.avgSteps)}
          keyboardType="number-pad"
          onChangeText={(value) => setForm((prev) => ({ ...prev, avgSteps: Number(value) || 0 }))}
          style={styles.input}
        />

        <FormLabel text="Entrenos por semana" />
        <TextInput
          value={String(form.trainingDaysPerWeek)}
          keyboardType="number-pad"
          onChangeText={(value) => setForm((prev) => ({ ...prev, trainingDaysPerWeek: Number(value) || 0 }))}
          style={styles.input}
        />

        <FormLabel text="Duracion por entreno (min)" />
        <TextInput
          value={String(form.trainingDurationMin)}
          keyboardType="number-pad"
          onChangeText={(value) => setForm((prev) => ({ ...prev, trainingDurationMin: Number(value) || 0 }))}
          style={styles.input}
        />

        <FormLabel text="Intensidad entrenamiento" />
        <RowChoices<TrainingIntensity>
          options={[
            { value: 'low', label: 'Baja' },
            { value: 'moderate', label: 'Media' },
            { value: 'high', label: 'Alta' },
          ]}
          selected={form.trainingIntensity}
          onSelect={(trainingIntensity) => setForm((prev) => ({ ...prev, trainingIntensity }))}
        />

        <Pressable
          style={[styles.booleanToggle, form.advancedCut && styles.booleanToggleActive]}
          onPress={() => setForm((prev) => ({ ...prev, advancedCut: !prev.advancedCut }))}
        >
          <Text style={[styles.booleanToggleText, form.advancedCut && styles.booleanToggleTextActive]}>
            Cut avanzado (proteina mas alta en deficit)
          </Text>
        </Pressable>

        <FormLabel text="Objetivo" />
        <RowChoices<GoalType>
          options={[
            { value: 'deficit', label: 'Deficit' },
            { value: 'maintenance', label: 'Mantener' },
            { value: 'surplus', label: 'Superavit' },
          ]}
          selected={form.goal}
          onSelect={(value) => setForm((prev) => ({ ...prev, goal: value }))}
        />

          <Pressable
            style={styles.primaryButton}
            onPress={() => {
              if (!form.name || form.age <= 0 || form.weightKg <= 0 || form.heightCm <= 0) {
                Alert.alert('Faltan datos', 'Completa todos los campos para continuar.');
                return;
              }

              onComplete(form);
            }}
          >
            <Text style={styles.primaryButtonText}>Crear plan diario</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function HomeTab({
  dailyTotals,
  dailyTargets,
  meals,
  weighIns,
  onAddWeighIn,
  onLaunchCamera,
}: {
  dailyTotals: MacroBreakdown;
  dailyTargets: MacroBreakdown;
  meals: MealEntry[];
  weighIns: WeeklyWeighIn[];
  onAddWeighIn: (weightKg: number, isAtypicalWeek?: boolean, atypicalReason?: string) => void;
  onLaunchCamera: () => void;
}) {
  const [weeklyWeightInput, setWeeklyWeightInput] = useState('');

  const todayMeals = useMemo(() => {
    const today = new Date();

    return meals.filter((meal) => {
      const date = new Date(meal.createdAt);
      return (
        date.getDate() === today.getDate() &&
        date.getMonth() === today.getMonth() &&
        date.getFullYear() === today.getFullYear()
      );
    });
  }, [meals]);

  const latestWeighIns = useMemo(() => {
    return [...weighIns]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 2);
  }, [weighIns]);

  const latestWeight = latestWeighIns[0]?.weightKg ?? null;
  const weeklyDelta =
    latestWeighIns.length > 1 ? latestWeighIns[0].weightKg - latestWeighIns[1].weightKg : null;
  const latestWeightDateLabel = latestWeighIns[0]
    ? new Date(latestWeighIns[0].date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })
    : '--';
  const weeklyDeltaArrow = weeklyDelta === null ? '•' : weeklyDelta > 0 ? '↑' : weeklyDelta < 0 ? '↓' : '→';

  return (
    <ScrollView contentContainerStyle={styles.homeContentContainer} showsVerticalScrollIndicator={false}>
      <View style={styles.summaryBlock}>
        <Text style={styles.summaryLabel}>TODAY'S SUMMARY</Text>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryValue}>{Math.round(dailyTotals.calories).toLocaleString()}</Text>
          <Text style={styles.summaryTarget}> / {Math.round(dailyTargets.calories).toLocaleString()} kcal</Text>
        </View>

        <View style={styles.macroStatsRow}>
          <MacroStat
            label="PROTEIN"
            value={dailyTotals.protein}
            target={dailyTargets.protein}
            color="#2f8a7f"
          />
          <MacroStat label="CARBS" value={dailyTotals.carbs} target={dailyTargets.carbs} color="#ef7054" />
          <MacroStat label="FATS" value={dailyTotals.fats} target={dailyTargets.fats} color="#b3bfd3" />
        </View>
      </View>

      <LinearGradient colors={['#1d4f64', '#67ccb7']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroCard}>
        <Image
          source={{
            uri: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=1200&q=80',
          }}
          style={styles.heroImage}
        />
        <View style={styles.heroOverlay}>
          <Text style={styles.heroBadge}>NEW FEATURE</Text>
          <Text style={styles.heroTitle}>Log Meal with Voice</Text>
          <Text style={styles.heroDescription}>Dicta tu comida con pesos y la app calcula macros.</Text>
          <Pressable style={styles.heroButton} onPress={onLaunchCamera}>
            <Text style={styles.heroButtonIcon}>🎙️</Text>
            <Text style={styles.heroButtonText}>Ir a dictado</Text>
          </Pressable>
        </View>
      </LinearGradient>

      <View style={styles.waterCard}>
        <Text style={styles.waterTitle}>Weekly Weight</Text>
        <Text style={styles.waterSubtitle}>Registra tu peso semanal para recalibrar macros.</Text>
        <View style={styles.waterRow}>
          <View style={styles.waterCircle}>
            <Text style={styles.waterCircleArrow}>{weeklyDeltaArrow}</Text>
            <Text style={styles.waterCircleText}>
              {weeklyDelta === null ? '--' : `${weeklyDelta > 0 ? '+' : ''}${weeklyDelta.toFixed(1)}kg`}
            </Text>
          </View>
          <View style={styles.weightHomeInfoWrap}>
            <Text style={styles.waterProgress}>{latestWeight === null ? '--' : `${latestWeight.toFixed(1)} kg`}</Text>
            <Text style={styles.waterAction}>Ultimo registro</Text>
            <Text style={styles.weightHomeDate}>{latestWeightDateLabel}</Text>
          </View>
        </View>
        <View style={styles.weightHomeEntryRow}>
          <TextInput
            value={weeklyWeightInput}
            onChangeText={setWeeklyWeightInput}
            keyboardType="decimal-pad"
            placeholder="Ej: 78.4"
            placeholderTextColor={COLORS.textMuted}
            style={styles.weightHomeInput}
          />
          <Pressable
            style={styles.weightHomeButton}
            onPress={() => {
              const parsed = Number(weeklyWeightInput.replace(',', '.'));
              if (!Number.isFinite(parsed) || parsed <= 0) {
                Alert.alert('Peso invalido', 'Ingresa un peso valido en kg.');
                return;
              }

              onAddWeighIn(parsed);
              setWeeklyWeightInput('');
            }}
          >
            <Text style={styles.weightHomeButtonText}>Registrar</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.logHeader}>
        <Text style={styles.logTitle}>Today's Log</Text>
        <Text style={styles.logHistory}>View History</Text>
      </View>

      {todayMeals.length === 0 ? (
        <View style={styles.emptyCardLight}>
          <Text style={styles.emptyText}>Todavia no cargaste comidas.</Text>
        </View>
      ) : (
        todayMeals.slice(0, 4).map((meal) => (
          <View key={meal.id} style={styles.mealListCard}>
            <View style={styles.mealIconWrap}>
              <Text style={styles.mealIcon}>{mealEmoji(meal.mealType)}</Text>
            </View>
            <View style={styles.mealInfoWrap}>
              <Text style={styles.mealTypeLabel}>{meal.mealType.toUpperCase()}</Text>
              <Text style={styles.mealNameDark}>{meal.name}</Text>
              <Text style={styles.mealMacroLine}>P {Math.round(meal.protein)}g   C {Math.round(meal.carbs)}g   F {Math.round(meal.fats)}g</Text>
            </View>
            <View>
              <Text style={styles.mealKcalValue}>{Math.round(meal.calories)}</Text>
              <Text style={styles.mealKcalLabel}>KCAL</Text>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function AddMealTab({
  onAddMeal,
  frequentMeals,
  onSaveFrequent,
  onDeleteFrequent,
}: {
  onAddMeal: (meal: Omit<MealEntry, 'id'>) => Promise<void>;
  frequentMeals: FrequentMeal[];
  onSaveFrequent: (payload: Omit<FrequentMeal, 'id' | 'createdAt'>, existingId?: string) => void;
  onDeleteFrequent: (id: string) => void;
}) {
  const [entryMode, setEntryMode] = useState<'total' | 'items'>('total');
  const [showDetailedMacros, setShowDetailedMacros] = useState(false);
  const [name, setName] = useState('');
  const [mealType, setMealType] = useState<MealEntry['mealType']>('almuerzo');
  const [weightGrams, setWeightGrams] = useState('0');
  const [protein, setProtein] = useState('0');
  const [carbs, setCarbs] = useState('0');
  const [fats, setFats] = useState('0');
  const [calories, setCalories] = useState('0');
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<MealAudioRecorder | null>(null);
  const [mealItems, setMealItems] = useState<
    { id: string; name: string; weightGrams: string; proteinPer100: string; carbsPer100: string; fatsPer100: string }[]
  >([
    {
      id: 'item-1',
      name: '',
      weightGrams: '100',
      proteinPer100: '0',
      carbsPer100: '0',
      fatsPer100: '0',
    },
  ]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysesLeft, setAnalysesLeft] = useState(freeTierLimitPerDay);
  const [spectrumLevels, setSpectrumLevels] = useState([0.2, 0.35, 0.25, 0.4, 0.3]);
  const [showFrequentPrompt, setShowFrequentPrompt] = useState(false);
  const [frequentDraftName, setFrequentDraftName] = useState('');
  const [showFrequentModal, setShowFrequentModal] = useState(false);
  const [pressedFrequentId, setPressedFrequentId] = useState<string | null>(null);
  const [editingFrequentId, setEditingFrequentId] = useState<string | null>(null);
  const [editingFrequentDraft, setEditingFrequentDraft] = useState<{
    id: string;
    name: string;
    mealType: MealEntry['mealType'];
    weightGrams: string;
    calories: string;
    protein: string;
    carbs: string;
    fats: string;
    entryMode: 'total' | 'items';
    items: FrequentMeal['items'];
  } | null>(null);
  const analysisMorph = useRef(new Animated.Value(0)).current;
  const frequentPressAnim = useRef(new Animated.Value(0)).current;

  const mealTypeOptions: { value: MealEntry['mealType']; label: string }[] = [
    { value: 'desayuno', label: 'Desayuno' },
    { value: 'almuerzo', label: 'Almuerzo' },
    { value: 'cena', label: 'Cena' },
    { value: 'snack', label: 'Snack' },
  ];

  const animateFrequentPressIn = (id: string) => {
    setPressedFrequentId(id);
    Animated.spring(frequentPressAnim, {
      toValue: 1,
      useNativeDriver: true,
      friction: 7,
      tension: 120,
    }).start();
  };

  const animateFrequentPressOut = () => {
    Animated.spring(frequentPressAnim, {
      toValue: 0,
      useNativeDriver: true,
      friction: 8,
      tension: 140,
    }).start(() => {
      setPressedFrequentId(null);
    });
  };

  const sortedFrequentMeals = useMemo(() => {
    return [...frequentMeals].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [frequentMeals]);

  const spectrumAnims = useMemo(
    () => spectrumLevels.map(() => new Animated.Value(0.3)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const parseField = (value: string) => Number(value.replace(',', '.')) || 0;

  const buildFrequentPayload = (customName?: string): Omit<FrequentMeal, 'id' | 'createdAt'> | null => {
    const mealName = (customName ?? name).trim();
    if (!mealName) {
      return null;
    }

    const totals =
      entryMode === 'items'
        ? {
            protein: calculatedFromItems.protein,
            carbs: calculatedFromItems.carbs,
            fats: calculatedFromItems.fats,
            calories: calculatedItemCalories,
            weightGrams: calculatedItemWeight,
          }
        : {
            protein: parseField(protein),
            carbs: parseField(carbs),
            fats: parseField(fats),
            calories: parseField(calories),
            weightGrams: parseField(weightGrams),
          };

    return {
      name: mealName,
      mealType,
      weightGrams: totals.weightGrams,
      protein: totals.protein,
      carbs: totals.carbs,
      fats: totals.fats,
      calories: totals.calories,
      entryMode,
      items: mealItems.map((item) => ({
        name: item.name,
        weightGrams: parseField(item.weightGrams),
        proteinPer100: parseField(item.proteinPer100),
        carbsPer100: parseField(item.carbsPer100),
        fatsPer100: parseField(item.fatsPer100),
      })),
    };
  };

  const persistFrequentMeal = (payload: Omit<FrequentMeal, 'id' | 'createdAt'>) => {
    const existing = sortedFrequentMeals.find(
      (meal) => meal.name.trim().toLowerCase() === payload.name.trim().toLowerCase(),
    );

    if (existing) {
      Alert.alert(
        'Comida frecuente existente',
        `Ya existe "${existing.name}". Queres reemplazarla con estos datos?`,
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Reemplazar',
            onPress: () => {
              onSaveFrequent(payload, existing.id);
              setShowFrequentPrompt(false);
              Alert.alert('Guardado', 'Comida frecuente actualizada.');
            },
          },
        ],
      );
      return;
    }

    onSaveFrequent(payload);
    setShowFrequentPrompt(false);
    Alert.alert('Guardado', 'Comida guardada en frecuentes.');
  };

  const saveCurrentAsFrequent = () => {
    const payload = buildFrequentPayload();
    if (!payload) {
      Alert.alert('Falta el nombre', 'Ingresa el nombre de la comida para guardarla en frecuentes.');
      return;
    }

    persistFrequentMeal(payload);
  };

  const savePromptAsFrequent = () => {
    const payload = buildFrequentPayload(frequentDraftName);
    if (!payload) {
      Alert.alert('Falta el nombre', 'Escribe el nombre con el que queres guardar la comida frecuente.');
      return;
    }

    persistFrequentMeal(payload);
  };

  const applyFrequentMeal = (frequentMeal: FrequentMeal) => {
    setName(frequentMeal.name);
    setMealType(frequentMeal.mealType);
    setWeightGrams(String(Math.round(frequentMeal.weightGrams || 0)));
    setProtein(String(Math.round(frequentMeal.protein || 0)));
    setCarbs(String(Math.round(frequentMeal.carbs || 0)));
    setFats(String(Math.round(frequentMeal.fats || 0)));
    setCalories(String(Math.round(frequentMeal.calories || 0)));
    setEntryMode(frequentMeal.entryMode);
    setShowDetailedMacros(frequentMeal.entryMode === 'items');
    setShowFrequentPrompt(false);
    setFrequentDraftName('');
    setMealItems(
      (frequentMeal.items.length > 0
        ? frequentMeal.items
        : [
            {
              name: frequentMeal.name,
              weightGrams: frequentMeal.weightGrams,
              proteinPer100: frequentMeal.protein,
              carbsPer100: frequentMeal.carbs,
              fatsPer100: frequentMeal.fats,
            },
          ]
      ).map((item) => ({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: item.name,
        weightGrams: String(Math.round(item.weightGrams || 0)),
        proteinPer100: String(Math.round(item.proteinPer100 || 0)),
        carbsPer100: String(Math.round(item.carbsPer100 || 0)),
        fatsPer100: String(Math.round(item.fatsPer100 || 0)),
      })),
    );
  };

  const startFrequentEdit = (frequentMeal: FrequentMeal) => {
    setEditingFrequentId(frequentMeal.id);
    setEditingFrequentDraft({
      id: frequentMeal.id,
      name: frequentMeal.name,
      mealType: frequentMeal.mealType,
      weightGrams: String(Math.round(frequentMeal.weightGrams || 0)),
      calories: String(Math.round(frequentMeal.calories || 0)),
      protein: String(Math.round(frequentMeal.protein || 0)),
      carbs: String(Math.round(frequentMeal.carbs || 0)),
      fats: String(Math.round(frequentMeal.fats || 0)),
      entryMode: frequentMeal.entryMode,
      items: frequentMeal.items,
    });
  };

  const cancelFrequentEdit = () => {
    setEditingFrequentId(null);
    setEditingFrequentDraft(null);
  };

  const saveFrequentEdit = () => {
    if (!editingFrequentDraft) {
      return;
    }

    const nextName = editingFrequentDraft.name.trim();
    if (!nextName) {
      Alert.alert('Falta nombre', 'Ingresa un nombre para la comida frecuente.');
      return;
    }

    onSaveFrequent(
      {
        name: nextName,
        mealType: editingFrequentDraft.mealType,
        weightGrams: parseField(editingFrequentDraft.weightGrams),
        calories: parseField(editingFrequentDraft.calories),
        protein: parseField(editingFrequentDraft.protein),
        carbs: parseField(editingFrequentDraft.carbs),
        fats: parseField(editingFrequentDraft.fats),
        entryMode: editingFrequentDraft.entryMode,
        items: editingFrequentDraft.items,
      },
      editingFrequentDraft.id,
    );

    cancelFrequentEdit();
    Alert.alert('Actualizado', 'Comida frecuente actualizada.');
  };

  const confirmDeleteFrequent = (frequentMeal: FrequentMeal) => {
    Alert.alert('Eliminar frecuente', `Eliminar "${frequentMeal.name}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: () => {
          onDeleteFrequent(frequentMeal.id);
          if (editingFrequentId === frequentMeal.id) {
            cancelFrequentEdit();
          }
        },
      },
    ]);
  };

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const timer = setInterval(() => {
      setSpectrumLevels((prev) => prev.map(() => 0.15 + Math.random() * 0.85));
    }, 140);

    return () => clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    spectrumLevels.forEach((level, index) => {
      Animated.timing(spectrumAnims[index], {
        toValue: level,
        duration: 120,
        useNativeDriver: false,
      }).start();
    });
  }, [spectrumLevels, spectrumAnims]);

  useEffect(() => {
    Animated.timing(analysisMorph, {
      toValue: isAnalyzing ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [isAnalyzing, analysisMorph]);

  useEffect(() => {
    return () => {
      if (recording) {
        void recording.cancel().catch(() => undefined);
      }
    };
  }, [recording]);

  const calculatedFromItems = useMemo(() => {
    return mealItems.reduce(
      (acc, item) => {
        const factor = Math.max(parseField(item.weightGrams), 0) / 100;
        const proteinTotal = parseField(item.proteinPer100) * factor;
        const carbsTotal = parseField(item.carbsPer100) * factor;
        const fatsTotal = parseField(item.fatsPer100) * factor;

        return {
          protein: acc.protein + proteinTotal,
          carbs: acc.carbs + carbsTotal,
          fats: acc.fats + fatsTotal,
        };
      },
      { protein: 0, carbs: 0, fats: 0 },
    );
  }, [mealItems]);

  const calculatedItemCalories =
    calculatedFromItems.protein * 4 + calculatedFromItems.carbs * 4 + calculatedFromItems.fats * 9;

  const calculatedItemWeight = useMemo(() => {
    return mealItems.reduce((acc, item) => acc + Math.max(parseField(item.weightGrams), 0), 0);
  }, [mealItems]);

  const updateItem = (
    itemId: string,
    field: 'name' | 'weightGrams' | 'proteinPer100' | 'carbsPer100' | 'fatsPer100',
    value: string,
  ) => {
    setMealItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, [field]: value } : item)));
  };

  const addItem = () => {
    setMealItems((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: '',
        weightGrams: '100',
        proteinPer100: '0',
        carbsPer100: '0',
        fatsPer100: '0',
      },
    ]);
  };

  const removeItem = (itemId: string) => {
    setMealItems((prev) => {
      if (prev.length <= 1) {
        return prev;
      }

      return prev.filter((item) => item.id !== itemId);
    });
  };

  useEffect(() => {
    getVoiceAnalysesLeft().then(setAnalysesLeft).catch(() => {
      setAnalysesLeft(0);
    });
  }, []);

  const startRecording = async () => {
    const nextRecording = createMealAudioRecorder();
    try {
      await nextRecording.start();
      playRecordingFeedback();
      setShowFrequentPrompt(false);
      setRecording(nextRecording);
      setIsRecording(true);
    } catch (error) {
      await nextRecording.cancel().catch(() => undefined);
      const message = error instanceof Error ? error.message : 'No pudimos iniciar la grabacion. Reintenta.';
      Alert.alert('No se pudo grabar', message);
    }
  };

  const stopRecordingAndAnalyze = async () => {
    if (!recording) {
      return;
    }

    try {
      const audio = await recording.stop();
      playRecordingFeedback();
      setIsRecording(false);
      setRecording(null);

      setIsAnalyzing(true);
      const analysis = await analyzeMealAudio(audio.base64, audio.mimeType);
      setName(analysis.name);
      setFrequentDraftName(analysis.name);
      setProtein(String(Math.round(analysis.protein)));
      setCarbs(String(Math.round(analysis.carbs)));
      setFats(String(Math.round(analysis.fats)));
      setCalories(String(Math.round(analysis.calories)));
      if (analysis.items.length > 0) {
        const totalWeight = analysis.items.reduce((acc, item) => acc + item.weightGrams, 0);
        setWeightGrams(String(Math.round(totalWeight)));
        setMealItems(
          analysis.items.map((item) => ({
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name: item.name,
            weightGrams: String(Math.round(item.weightGrams || 100)),
            proteinPer100: String(Math.round(item.proteinPer100)),
            carbsPer100: String(Math.round(item.carbsPer100)),
            fatsPer100: String(Math.round(item.fatsPer100)),
          })),
        );
      }

      setShowFrequentPrompt(true);

      setAnalysesLeft(await getVoiceAnalysesLeft());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No pudimos analizar el audio.';
      Alert.alert('Analisis no disponible', message);
    } finally {
      setIsRecording(false);
      setRecording(null);
      setIsAnalyzing(false);
    }
  };

  const cancelRecording = async () => {
    if (!recording) {
      return;
    }

    try {
      await recording.cancel();
      playRecordingFeedback();
      setFrequentDraftName('');
    } catch {
      return;
    } finally {
      setRecording(null);
      setIsRecording(false);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      await stopRecordingAndAnalyze();
      return;
    }

    await startRecording();
  };

  return (
    <KeyboardAvoidingView
      style={styles.keyboardContainer}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.logContentContainer}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.logMealTitle}>Log Meal</Text>
        <Text style={styles.logMealSubtitle}>Track your nutrition with precision.</Text>

        <View style={styles.aiCard}>
          <View style={styles.aiIconBubble}>
            <Text style={styles.aiIcon}>✦</Text>
          </View>
          <Text style={styles.aiCardTitle}>AI Meal Analysis</Text>
          <Text style={styles.aiCardDescription}>
            Toca para dictar tu comida y la IA calcula calorias y macros automaticamente.
          </Text>

          <Pressable
            style={[styles.aiPrimaryButton, isRecording && styles.voiceRecordButtonActive]}
            onPress={toggleRecording}
            disabled={isAnalyzing}
          >
            <Text style={styles.aiPrimaryButtonText}>{isRecording ? '⏹ Detener y analizar' : '🎙️ Tocar para hablar'}</Text>
          </Pressable>

          {isRecording && !isAnalyzing && (
            <Pressable style={styles.aiCancelButton} onPress={cancelRecording}>
              <Text style={styles.aiCancelButtonText}>Cancelar captura</Text>
            </Pressable>
          )}

          <View style={styles.audioFeedbackWrap}>
            <Animated.View
              style={[
                styles.spectrumRow,
                {
                  opacity: analysisMorph.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 0],
                  }),
                  transform: [
                    {
                      scale: analysisMorph.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 0.85],
                      }),
                    },
                  ],
                },
              ]}
            >
              {spectrumAnims.map((anim, index) => (
                <Animated.View
                  key={`bar-${index}`}
                  style={[
                    styles.spectrumBar,
                    {
                      height: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 26] }),
                      opacity: isRecording ? 1 : 0.4,
                    },
                  ]}
                />
              ))}
            </Animated.View>

            <Animated.View
              pointerEvents="none"
              style={[
                styles.audioProcessingWrap,
                {
                  opacity: analysisMorph,
                  transform: [
                    {
                      scale: analysisMorph.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.85, 1],
                      }),
                    },
                  ],
                },
              ]}
            >
              <ActivityIndicator size="small" color="#24456f" />
              <Text style={styles.audioProcessingText}>Procesando audio...</Text>
            </Animated.View>
          </View>

          <Text style={styles.aiHintText}>
            {isAnalyzing
              ? 'Estamos interpretando tu comida.'
              : isRecording
              ? 'Escuchando... presiona de nuevo para procesar.'
              : `Consultas IA restantes hoy: ${analysesLeft}`}
          </Text>

          {showFrequentPrompt && !isAnalyzing && (
            <View style={styles.frequentPromptCard}>
              <Text style={styles.frequentPromptText}>
                Comida completada por IA. ¿Querés guardarla en frecuentes para usarla en 2 toques?
              </Text>
              <View style={styles.frequentPromptPreviewCard}>
                <Text style={styles.frequentPromptPreviewTitle}>{name || 'Comida detectada'}</Text>
                <Text style={styles.frequentPromptPreviewMeta}>
                  {Math.round(parseField(calories))} kcal · P {Math.round(parseField(protein))} · C {Math.round(parseField(carbs))} · G {Math.round(parseField(fats))}
                </Text>
              </View>
              <Text style={styles.frequentPromptInputLabel}>Nombre para guardar</Text>
              <TextInput
                value={frequentDraftName}
                onChangeText={setFrequentDraftName}
                placeholder="Ej: Bowl de pollo post entrenamiento"
                placeholderTextColor={COLORS.textMuted}
                style={styles.frequentPromptInput}
              />
              <View style={styles.frequentPromptActions}>
                <Pressable style={styles.frequentPromptPrimary} onPress={savePromptAsFrequent}>
                  <Text style={styles.frequentPromptPrimaryText}>Agregar a frecuentes</Text>
                </Pressable>
                <Pressable style={styles.frequentPromptSecondary} onPress={() => setShowFrequentPrompt(false)}>
                  <Text style={styles.frequentPromptSecondaryText}>Ahora no</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <View style={styles.frequentSectionCard}>
          <View style={styles.frequentSectionHeader}>
            <Text style={styles.frequentSectionTitle}>Comidas frecuentes</Text>
            <View style={styles.frequentHeaderActions}>
              <Pressable style={styles.frequentViewMoreButton} onPress={() => setShowFrequentModal(true)}>
                <Text style={styles.frequentViewMoreButtonText}>Ver mas</Text>
              </Pressable>
            </View>
          </View>

          {sortedFrequentMeals.length === 0 ? (
            <Text style={styles.frequentEmptyText}>Todavia no guardaste comidas frecuentes.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.frequentListRow}>
              {sortedFrequentMeals.slice(0, 2).map((frequentMeal) => (
                <Animated.View
                  key={frequentMeal.id}
                  style={[
                    styles.frequentItemCard,
                    pressedFrequentId === frequentMeal.id && {
                      transform: [
                        {
                          scale: frequentPressAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [1, 0.97],
                          }),
                        },
                      ],
                      opacity: frequentPressAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 0.9],
                      }),
                    },
                  ]}
                >
                  <Pressable
                    onPress={() => applyFrequentMeal(frequentMeal)}
                    onPressIn={() => animateFrequentPressIn(frequentMeal.id)}
                    onPressOut={animateFrequentPressOut}
                    style={styles.frequentItemTouch}
                  >
                    <Text style={styles.frequentItemName}>{frequentMeal.name}</Text>
                    <Text style={styles.frequentItemMeta}>
                      {Math.round(frequentMeal.calories)} kcal · P {Math.round(frequentMeal.protein)}
                    </Text>
                    <Text style={styles.frequentTapHint}>Tocar para cargar</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => confirmDeleteFrequent(frequentMeal)}
                    style={styles.frequentDeleteButton}
                  >
                    <Text style={styles.frequentDeleteButtonText}>Eliminar</Text>
                  </Pressable>
                </Animated.View>
              ))}
            </ScrollView>
          )}
        </View>

        <Modal
          visible={showFrequentModal}
          animationType="slide"
          transparent
          onRequestClose={() => {
            setShowFrequentModal(false);
            cancelFrequentEdit();
          }}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeaderRow}>
                <Text style={styles.modalTitle}>Comidas frecuentes</Text>
                <Pressable
                  style={styles.modalCloseButton}
                  onPress={() => {
                    setShowFrequentModal(false);
                    cancelFrequentEdit();
                  }}
                >
                  <Text style={styles.modalCloseButtonText}>Cerrar</Text>
                </Pressable>
              </View>

              <ScrollView style={styles.modalList} contentContainerStyle={styles.modalListContent}>
                {sortedFrequentMeals.length === 0 ? (
                  <Text style={styles.frequentEmptyText}>Todavia no guardaste comidas frecuentes.</Text>
                ) : (
                  sortedFrequentMeals.map((frequentMeal) => {
                    const isEditing = editingFrequentId === frequentMeal.id && editingFrequentDraft;

                    return (
                      <Animated.View
                        key={frequentMeal.id}
                        style={[
                          styles.frequentModalItemCard,
                          pressedFrequentId === frequentMeal.id && {
                            transform: [
                              {
                                scale: frequentPressAnim.interpolate({
                                  inputRange: [0, 1],
                                  outputRange: [1, 0.97],
                                }),
                              },
                            ],
                            opacity: frequentPressAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [1, 0.9],
                            }),
                          },
                        ]}
                      >
                        {isEditing ? (
                          <>
                            <TextInput
                              value={editingFrequentDraft.name}
                              onChangeText={(value) =>
                                setEditingFrequentDraft((prev) => (prev ? { ...prev, name: value } : prev))
                              }
                              style={styles.frequentEditInput}
                            />

                            <View style={styles.mealTypeRow}>
                              {mealTypeOptions.map((option) => (
                                <Pressable
                                  key={`${frequentMeal.id}-${option.value}`}
                                  onPress={() =>
                                    setEditingFrequentDraft((prev) =>
                                      prev ? { ...prev, mealType: option.value } : prev,
                                    )
                                  }
                                  style={[
                                    styles.mealTypePill,
                                    editingFrequentDraft.mealType === option.value && styles.mealTypePillActive,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.mealTypePillText,
                                      editingFrequentDraft.mealType === option.value && styles.mealTypePillTextActive,
                                    ]}
                                  >
                                    {option.label}
                                  </Text>
                                </Pressable>
                              ))}
                            </View>

                            <View style={styles.frequentEditGrid}>
                              <TextInput
                                value={editingFrequentDraft.weightGrams}
                                onChangeText={(value) =>
                                  setEditingFrequentDraft((prev) => (prev ? { ...prev, weightGrams: value } : prev))
                                }
                                keyboardType="decimal-pad"
                                placeholder="Peso"
                                placeholderTextColor={COLORS.textMuted}
                                style={styles.frequentEditGridInput}
                              />
                              <TextInput
                                value={editingFrequentDraft.calories}
                                onChangeText={(value) =>
                                  setEditingFrequentDraft((prev) => (prev ? { ...prev, calories: value } : prev))
                                }
                                keyboardType="decimal-pad"
                                placeholder="Kcal"
                                placeholderTextColor={COLORS.textMuted}
                                style={styles.frequentEditGridInput}
                              />
                              <TextInput
                                value={editingFrequentDraft.protein}
                                onChangeText={(value) =>
                                  setEditingFrequentDraft((prev) => (prev ? { ...prev, protein: value } : prev))
                                }
                                keyboardType="decimal-pad"
                                placeholder="Proteina"
                                placeholderTextColor={COLORS.textMuted}
                                style={styles.frequentEditGridInput}
                              />
                              <TextInput
                                value={editingFrequentDraft.carbs}
                                onChangeText={(value) =>
                                  setEditingFrequentDraft((prev) => (prev ? { ...prev, carbs: value } : prev))
                                }
                                keyboardType="decimal-pad"
                                placeholder="Carbos"
                                placeholderTextColor={COLORS.textMuted}
                                style={styles.frequentEditGridInput}
                              />
                              <TextInput
                                value={editingFrequentDraft.fats}
                                onChangeText={(value) =>
                                  setEditingFrequentDraft((prev) => (prev ? { ...prev, fats: value } : prev))
                                }
                                keyboardType="decimal-pad"
                                placeholder="Grasas"
                                placeholderTextColor={COLORS.textMuted}
                                style={styles.frequentEditGridInput}
                              />
                            </View>

                            <View style={styles.frequentModalActions}>
                              <Pressable style={styles.frequentModalPrimaryButton} onPress={saveFrequentEdit}>
                                <Text style={styles.frequentModalPrimaryButtonText}>Guardar</Text>
                              </Pressable>
                              <Pressable style={styles.frequentModalSecondaryButton} onPress={cancelFrequentEdit}>
                                <Text style={styles.frequentModalSecondaryButtonText}>Cancelar</Text>
                              </Pressable>
                            </View>
                          </>
                        ) : (
                          <>
                            <Pressable
                              onPress={() => applyFrequentMeal(frequentMeal)}
                              onPressIn={() => animateFrequentPressIn(frequentMeal.id)}
                              onPressOut={animateFrequentPressOut}
                              style={styles.frequentItemTouch}
                            >
                              <Text style={styles.frequentItemName}>{frequentMeal.name}</Text>
                              <Text style={styles.frequentItemMeta}>
                                {frequentMeal.mealType} · {Math.round(frequentMeal.weightGrams)}g ·{' '}
                                {Math.round(frequentMeal.calories)} kcal
                              </Text>
                              <Text style={styles.frequentItemMeta}>
                                P {Math.round(frequentMeal.protein)} · C {Math.round(frequentMeal.carbs)} · G{' '}
                                {Math.round(frequentMeal.fats)}
                              </Text>
                            </Pressable>

                            <View style={styles.frequentModalActions}>
                              <Pressable
                                style={styles.frequentModalPrimaryButton}
                                onPress={() => startFrequentEdit(frequentMeal)}
                              >
                                <Text style={styles.frequentModalPrimaryButtonText}>Editar</Text>
                              </Pressable>
                              <Pressable
                                style={styles.frequentModalDeleteButton}
                                onPress={() => confirmDeleteFrequent(frequentMeal)}
                              >
                                <Text style={styles.frequentModalDeleteButtonText}>Eliminar</Text>
                              </Pressable>
                            </View>
                          </>
                        )}
                      </Animated.View>
                    );
                  })
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>

        <View style={styles.manualDividerRow}>
          <View style={styles.manualDividerLine} />
          <Text style={styles.manualDividerText}>MANUAL ENTRY</Text>
          <View style={styles.manualDividerLine} />
        </View>

        <FormLabel text="Nombre de la comida" />
        <TextInput
          value={name}
          placeholder="Ej: Ensalada de Quinoa"
          placeholderTextColor={COLORS.textMuted}
          onChangeText={setName}
          style={styles.logInput}
        />

        <FormLabel text="Tipo" />
        <View style={styles.mealTypeRow}>
          {[
            { value: 'desayuno', label: 'Desayuno' },
            { value: 'almuerzo', label: 'Almuerzo' },
            { value: 'cena', label: 'Cena' },
            { value: 'snack', label: 'Snack' },
          ].map((option) => {
            const selected = mealType === option.value;

            return (
              <Pressable
                key={option.value}
                onPress={() => setMealType(option.value as MealEntry['mealType'])}
                style={[styles.mealTypePill, selected && styles.mealTypePillActive]}
              >
                <Text style={[styles.mealTypePillText, selected && styles.mealTypePillTextActive]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.dualFieldRow}>
          <View style={styles.dualFieldCol}>
            <FormLabel text="Peso (g)" />
            <TextInput value={weightGrams} onChangeText={setWeightGrams} keyboardType="decimal-pad" style={styles.logInput} />
          </View>
          <View style={styles.dualFieldCol}>
            <FormLabel text="Calorias" />
            <TextInput value={calories} onChangeText={setCalories} keyboardType="decimal-pad" style={styles.logInput} />
          </View>
        </View>

        <Pressable style={styles.detailToggle} onPress={() => setShowDetailedMacros((prev) => !prev)}>
          <Text style={styles.detailToggleText}>
            {showDetailedMacros ? '▾' : '▸'} Añadir macros detallados (P/C/G)
          </Text>
        </Pressable>

        {showDetailedMacros && (
          <>
            <FormLabel text="Modo detallado" />
            <RowChoices
              options={[
                { value: 'items', label: 'Por alimentos' },
                { value: 'total', label: 'Totales P/C/G' },
              ]}
              selected={entryMode}
              onSelect={setEntryMode}
            />

            {entryMode === 'items' ? (
              <>
            {mealItems.map((item, index) => (
              <View key={item.id} style={styles.itemCard}>
                <View style={styles.itemCardHeader}>
                  <Text style={styles.itemCardTitle}>Alimento {index + 1}</Text>
                  <Pressable
                    onPress={() => removeItem(item.id)}
                    style={[styles.smallActionButton, mealItems.length <= 1 && styles.smallActionButtonDisabled]}
                    disabled={mealItems.length <= 1}
                  >
                    <Text style={styles.smallActionButtonText}>Quitar</Text>
                  </Pressable>
                </View>

                <FormLabel text="Nombre" />
                <TextInput value={item.name} onChangeText={(value) => updateItem(item.id, 'name', value)} style={styles.input} />

                <FormLabel text="Peso consumido (g)" />
                <TextInput
                  value={item.weightGrams}
                  onChangeText={(value) => updateItem(item.id, 'weightGrams', value)}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />

                <FormLabel text="Proteina por 100g" />
                <TextInput
                  value={item.proteinPer100}
                  onChangeText={(value) => updateItem(item.id, 'proteinPer100', value)}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />

                <FormLabel text="Carbos por 100g" />
                <TextInput
                  value={item.carbsPer100}
                  onChangeText={(value) => updateItem(item.id, 'carbsPer100', value)}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />

                <FormLabel text="Grasas por 100g" />
                <TextInput
                  value={item.fatsPer100}
                  onChangeText={(value) => updateItem(item.id, 'fatsPer100', value)}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
              </View>
            ))}

            <Pressable style={styles.secondaryButton} onPress={addItem}>
              <Text style={styles.secondaryButtonText}>Agregar alimento</Text>
            </Pressable>

            <View style={styles.targetCard}>
              <Text style={styles.targetTitle}>Resultado automatico</Text>
              <Text style={styles.targetLine}>P {Math.round(calculatedFromItems.protein)}g</Text>
              <Text style={styles.targetLine}>C {Math.round(calculatedFromItems.carbs)}g</Text>
              <Text style={styles.targetLine}>G {Math.round(calculatedFromItems.fats)}g</Text>
              <Text style={styles.targetLine}>Peso total: {Math.round(calculatedItemWeight)}g</Text>
              <Text style={styles.targetLine}>{Math.round(calculatedItemCalories)} kcal</Text>
            </View>
          </>
            ) : (
          <>
            <FormLabel text="Proteina (g)" />
            <TextInput value={protein} onChangeText={setProtein} keyboardType="decimal-pad" style={styles.logInput} />

            <FormLabel text="Carbos (g)" />
            <TextInput value={carbs} onChangeText={setCarbs} keyboardType="decimal-pad" style={styles.logInput} />

            <FormLabel text="Grasas (g)" />
            <TextInput value={fats} onChangeText={setFats} keyboardType="decimal-pad" style={styles.logInput} />
          </>
            )}
          </>
        )}

        <Pressable
          style={styles.logSaveButton}
          onPress={async () => {
            const mealName = name.trim();

            const totals =
              entryMode === 'items'
                ? {
                    protein: calculatedFromItems.protein,
                    carbs: calculatedFromItems.carbs,
                    fats: calculatedFromItems.fats,
                    calories: calculatedItemCalories,
                  }
                : {
                    protein: parseField(protein),
                    carbs: parseField(carbs),
                    fats: parseField(fats),
                    calories: parseField(calories),
                  };

            const nextMeal = {
              name: mealName,
              mealType,
              protein: totals.protein,
              carbs: totals.carbs,
              fats: totals.fats,
              calories: totals.calories,
              createdAt: new Date().toISOString(),
            };

            if (!mealName) {
              Alert.alert('Falta el nombre', 'Ingresa un nombre para guardar la comida.');
              return;
            }

            await onAddMeal(nextMeal);
            setName('');
            setProtein('0');
            setCarbs('0');
            setFats('0');
            setCalories('0');
            setWeightGrams('0');
            setShowDetailedMacros(false);
            setShowFrequentPrompt(false);
            setFrequentDraftName('');
            setMealItems([
              {
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                name: '',
                weightGrams: '100',
                proteinPer100: '0',
                carbsPer100: '0',
                fatsPer100: '0',
              },
            ]);
          }}
        >
          <Text style={styles.logSaveButtonText}>GUARDAR REGISTRO</Text>
        </Pressable>

        <Pressable style={styles.logFrequentButton} onPress={saveCurrentAsFrequent}>
          <Text style={styles.logFrequentButtonText}>AGREGAR A FRECUENTES</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ProfileTab({
  profile,
  weighIns,
  onSave,
  onAddWeighIn,
  onUpdateWeighIn,
  onDeleteWeighIn,
  username,
  onLogout,
}: {
  profile: Profile;
  weighIns: WeeklyWeighIn[];
  onSave: (next: Profile) => void;
  onAddWeighIn: (weightKg: number, isAtypicalWeek?: boolean, atypicalReason?: string) => void;
  onUpdateWeighIn: (id: string, weightKg: number) => void;
  onDeleteWeighIn: (id: string) => void;
  username: string;
  onLogout: () => Promise<void>;
}) {
  const [form, setForm] = useState(profile);
  const [weeklyWeight, setWeeklyWeight] = useState('');
  const [isAtypicalWeek, setIsAtypicalWeek] = useState(false);
  const [atypicalReason, setAtypicalReason] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [editingWeighInId, setEditingWeighInId] = useState<string | null>(null);
  const [editingWeighInValue, setEditingWeighInValue] = useState('');
  const [showAllWeighInsModal, setShowAllWeighInsModal] = useState(false);
  const targets = calculateDailyTargets(form);
  const diagnostics = getCalculationDiagnostics(form);
  const sortedWeighIns = useMemo(() => {
    return [...weighIns].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [weighIns]);
  const recentWeighIns = useMemo(() => sortedWeighIns.slice(0, 5), [sortedWeighIns]);

  useEffect(() => {
    setForm(profile);
  }, [profile]);

  return (
    <KeyboardAvoidingView
      style={styles.keyboardContainer}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.formContainer}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={styles.sectionTitle}>Perfil y objetivo</Text>

        <View style={styles.accountCard}>
          <View style={styles.accountInfo}>
            <Text style={styles.accountLabel}>CUENTA ACTIVA</Text>
            <Text style={styles.accountUsername}>@{username}</Text>
            <Text style={styles.accountHint}>Tus datos se sincronizan con esta cuenta.</Text>
          </View>
          <Pressable style={styles.logoutButton} onPress={onLogout}>
            <Text style={styles.logoutButtonText}>Cerrar sesion</Text>
          </Pressable>
        </View>

      <FormLabel text="Nombre" />
      <TextInput value={form.name} onChangeText={(name) => setForm((prev) => ({ ...prev, name }))} style={styles.input} />

      <FormLabel text="Peso (kg)" />
      <TextInput
        value={String(form.weightKg)}
        onChangeText={(value) => setForm((prev) => ({ ...prev, weightKg: Number(value) || 0 }))}
        keyboardType="decimal-pad"
        style={styles.input}
      />

      <FormLabel text="Actividad fisica" />
      <RowChoices
        options={[
          { value: 'low', label: 'Baja' },
          { value: 'medium', label: 'Media' },
          { value: 'high', label: 'Alta' },
        ]}
        selected={form.activityLevel}
        onSelect={(activityLevel) => setForm((prev) => ({ ...prev, activityLevel }))}
      />
      <View style={styles.activityHintCard}>
        <Text style={styles.activityHintTitle}>Guia rapida de actividad</Text>
        <Text style={styles.activityHintLine}>Baja: oficina/sedentarismo, poca actividad diaria.</Text>
        <Text style={styles.activityHintLine}>Media: entrenas 3-5 dias por semana.</Text>
        <Text style={styles.activityHintLine}>Alta: entrenas intenso 6-7 dias o trabajo fisico.</Text>
      </View>

      <FormLabel text="Tipo de trabajo" />
      <RowChoices<WorkType>
        options={[
          { value: 'sedentary', label: 'Sedentario' },
          { value: 'active', label: 'Activo' },
          { value: 'physical', label: 'Fisico' },
        ]}
        selected={form.workType}
        onSelect={(workType) => setForm((prev) => ({ ...prev, workType }))}
      />

      <FormLabel text="Pasos promedio/dia" />
      <TextInput
        value={String(form.avgSteps)}
        onChangeText={(value) => setForm((prev) => ({ ...prev, avgSteps: Number(value) || 0 }))}
        keyboardType="number-pad"
        style={styles.input}
      />

      <FormLabel text="Entrenos por semana" />
      <TextInput
        value={String(form.trainingDaysPerWeek)}
        onChangeText={(value) => setForm((prev) => ({ ...prev, trainingDaysPerWeek: Number(value) || 0 }))}
        keyboardType="number-pad"
        style={styles.input}
      />

      <FormLabel text="Duracion por entreno (min)" />
      <TextInput
        value={String(form.trainingDurationMin)}
        onChangeText={(value) => setForm((prev) => ({ ...prev, trainingDurationMin: Number(value) || 0 }))}
        keyboardType="number-pad"
        style={styles.input}
      />

      <FormLabel text="Intensidad entrenamiento" />
      <RowChoices<TrainingIntensity>
        options={[
          { value: 'low', label: 'Baja' },
          { value: 'moderate', label: 'Media' },
          { value: 'high', label: 'Alta' },
        ]}
        selected={form.trainingIntensity}
        onSelect={(trainingIntensity) => setForm((prev) => ({ ...prev, trainingIntensity }))}
      />

      <Pressable
        style={[styles.booleanToggle, form.advancedCut && styles.booleanToggleActive]}
        onPress={() => setForm((prev) => ({ ...prev, advancedCut: !prev.advancedCut }))}
      >
        <Text style={[styles.booleanToggleText, form.advancedCut && styles.booleanToggleTextActive]}>
          Cut avanzado (proteina mas alta en deficit)
        </Text>
      </Pressable>

      <FormLabel text="Tipo de trabajo" />
      <RowChoices<WorkType>
        options={[
          { value: 'sedentary', label: 'Sedentario' },
          { value: 'active', label: 'Activo' },
          { value: 'physical', label: 'Fisico' },
        ]}
        selected={form.workType}
        onSelect={(workType) => setForm((prev) => ({ ...prev, workType }))}
      />

      <FormLabel text="Pasos promedio/dia" />
      <TextInput
        value={String(form.avgSteps)}
        onChangeText={(value) => setForm((prev) => ({ ...prev, avgSteps: Number(value) || 0 }))}
        keyboardType="number-pad"
        style={styles.input}
      />

      <FormLabel text="Entrenos por semana" />
      <TextInput
        value={String(form.trainingDaysPerWeek)}
        onChangeText={(value) => setForm((prev) => ({ ...prev, trainingDaysPerWeek: Number(value) || 0 }))}
        keyboardType="number-pad"
        style={styles.input}
      />

      <FormLabel text="Duracion por entreno (min)" />
      <TextInput
        value={String(form.trainingDurationMin)}
        onChangeText={(value) => setForm((prev) => ({ ...prev, trainingDurationMin: Number(value) || 0 }))}
        keyboardType="number-pad"
        style={styles.input}
      />

      <FormLabel text="Intensidad entrenamiento" />
      <RowChoices<TrainingIntensity>
        options={[
          { value: 'low', label: 'Baja' },
          { value: 'moderate', label: 'Media' },
          { value: 'high', label: 'Alta' },
        ]}
        selected={form.trainingIntensity}
        onSelect={(trainingIntensity) => setForm((prev) => ({ ...prev, trainingIntensity }))}
      />

      <Pressable
        style={[styles.booleanToggle, form.advancedCut && styles.booleanToggleActive]}
        onPress={() => setForm((prev) => ({ ...prev, advancedCut: !prev.advancedCut }))}
      >
        <Text style={[styles.booleanToggleText, form.advancedCut && styles.booleanToggleTextActive]}>
          Cut avanzado (proteina mas alta en deficit)
        </Text>
      </Pressable>

      <FormLabel text="Objetivo" />
      <RowChoices<GoalType>
        options={[
          { value: 'deficit', label: 'Deficit' },
          { value: 'maintenance', label: 'Mantener' },
          { value: 'surplus', label: 'Superavit' },
        ]}
        selected={form.goal}
        onSelect={(goal) => setForm((prev) => ({ ...prev, goal }))}
      />

      <View style={styles.targetCard}>
        <Text style={styles.targetTitle}>Meta diaria estimada</Text>
        <Text style={styles.targetLine}>{Math.round(targets.calories)} kcal</Text>
        <Text style={styles.targetLine}>P {Math.round(targets.protein)}g</Text>
        <Text style={styles.targetLine}>C {Math.round(targets.carbs)}g</Text>
        <Text style={styles.targetLine}>G {Math.round(targets.fats)}g</Text>
        <Text style={styles.targetLine}>Ajuste activo: {Math.round(form.calorieAdjustment)} kcal</Text>
      </View>

      <View style={styles.diagnosticsCard}>
        <Pressable style={styles.diagnosticsHeader} onPress={() => setShowDiagnostics((prev) => !prev)}>
          <Text style={styles.targetTitle}>Diagnostico del calculo</Text>
          <Text style={styles.diagnosticsToggle}>{showDiagnostics ? 'Ocultar' : 'Ver detalle'}</Text>
        </Pressable>
        {showDiagnostics && (
          <View style={styles.diagnosticsList}>
            <Text style={styles.targetLine}>BMR: {Math.round(diagnostics.bmr)} kcal</Text>
            <Text style={styles.targetLine}>NEAT base: {diagnostics.neatBase.toFixed(2)}</Text>
            <Text style={styles.targetLine}>Ajuste pasos: {diagnostics.neatStepsCorrection.toFixed(2)}</Text>
            <Text style={styles.targetLine}>Ajuste actividad: {diagnostics.activityLegacyAdjustment.toFixed(2)}</Text>
            <Text style={styles.targetLine}>NEAT final: {diagnostics.neatFactor.toFixed(2)}</Text>
            <Text style={styles.targetLine}>Entreno neto diario: {Math.round(diagnostics.trainingNetKcalDaily)} kcal</Text>
            <Text style={styles.targetLine}>TDEE estimado: {Math.round(diagnostics.tdee)} kcal</Text>
            <Text style={styles.targetLine}>Multiplicador objetivo: {diagnostics.goalMultiplier.toFixed(2)}</Text>
            <Text style={styles.targetLine}>Ajuste manual/recalibracion: {Math.round(diagnostics.calorieAdjustment)} kcal</Text>
            <Text style={styles.targetLine}>Calorias objetivo final: {Math.round(diagnostics.targetCalories)} kcal</Text>
            <Text style={styles.targetLine}>Proteina objetivo: {diagnostics.proteinPerKg.toFixed(2)} g/kg</Text>
            <Text style={styles.targetLine}>Grasa target/min: {Math.round(diagnostics.fatTargetG)}g / {Math.round(diagnostics.fatMinG)}g</Text>
            <Text style={styles.targetLine}>Piso funcional carbos: {Math.round(diagnostics.carbsFloorG)}g</Text>
          </View>
        )}
      </View>

      <View style={styles.weightSectionCard}>
        <Text style={styles.targetTitle}>Seguimiento de peso semanal</Text>
        <Text style={styles.targetLine}>Registra tu peso y FitTrack sugerira recalibracion si hace falta.</Text>

        <FormLabel text="Peso de esta semana (kg)" />
        <View style={styles.weightRow}>
          <TextInput
            value={weeklyWeight}
            onChangeText={setWeeklyWeight}
            keyboardType="decimal-pad"
            placeholder="Ej: 78.4"
            placeholderTextColor={COLORS.textMuted}
            style={[styles.input, styles.weightInput]}
          />
          <Pressable
            style={styles.weightSaveButton}
            onPress={() => {
              const parsed = Number(weeklyWeight.replace(',', '.'));
              if (!Number.isFinite(parsed) || parsed <= 0) {
                Alert.alert('Peso invalido', 'Ingresa un peso valido en kg.');
                return;
              }

              onAddWeighIn(parsed, isAtypicalWeek, atypicalReason);
              setForm((prev) => ({ ...prev, weightKg: parsed }));
              setWeeklyWeight('');
              setIsAtypicalWeek(false);
              setAtypicalReason('');
            }}
          >
            <Text style={styles.weightSaveButtonText}>Registrar</Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.booleanToggle, isAtypicalWeek && styles.booleanToggleActive]}
          onPress={() => setIsAtypicalWeek((prev) => !prev)}
        >
          <Text style={[styles.booleanToggleText, isAtypicalWeek && styles.booleanToggleTextActive]}>
            Semana atipica (enfermedad, viaje, retencion, cambio fuerte de rutina)
          </Text>
        </Pressable>

        {isAtypicalWeek && (
          <TextInput
            value={atypicalReason}
            onChangeText={setAtypicalReason}
            placeholder="Motivo breve (opcional)"
            placeholderTextColor={COLORS.textMuted}
            style={styles.input}
          />
        )}

        {recentWeighIns.length === 0 ? (
          <Text style={styles.targetLine}>Todavia no hay pesajes registrados.</Text>
        ) : (
          recentWeighIns.map((entry) => (
            <View key={entry.id} style={styles.weighInPreviewRow}>
              <Text style={styles.weighInDate}>{new Date(entry.date).toLocaleDateString('es-AR')}</Text>
              <Text style={styles.weighInValue}>{entry.weightKg.toFixed(1)} kg</Text>
            </View>
          ))
        )}

        {sortedWeighIns.length > 5 && (
          <Pressable
            style={styles.viewMoreButton}
            onPress={() => {
              setEditingWeighInId(null);
              setEditingWeighInValue('');
              setShowAllWeighInsModal(true);
            }}
          >
            <Text style={styles.viewMoreButtonText}>Ver mas</Text>
          </Pressable>
        )}
      </View>

      <Modal
        visible={showAllWeighInsModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowAllWeighInsModal(false);
          setEditingWeighInId(null);
          setEditingWeighInValue('');
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Todos los pesajes</Text>
              <Pressable
                style={styles.modalCloseButton}
                onPress={() => {
                  setShowAllWeighInsModal(false);
                  setEditingWeighInId(null);
                  setEditingWeighInValue('');
                }}
              >
                <Text style={styles.modalCloseButtonText}>Cerrar</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.modalList} contentContainerStyle={styles.modalListContent}>
              {sortedWeighIns.map((entry) => (
                <View key={entry.id} style={styles.weighInRow}>
                  <Text style={styles.weighInDate}>{new Date(entry.date).toLocaleDateString('es-AR')}</Text>
                  {editingWeighInId === entry.id ? (
                    <View style={styles.weighInEditRow}>
                      <TextInput
                        value={editingWeighInValue}
                        onChangeText={setEditingWeighInValue}
                        keyboardType="decimal-pad"
                        style={styles.weighInEditInput}
                      />
                      <Pressable
                        style={styles.weighInActionButton}
                        onPress={() => {
                          const parsed = Number(editingWeighInValue.replace(',', '.'));
                          if (!Number.isFinite(parsed) || parsed <= 0) {
                            Alert.alert('Peso invalido', 'Ingresa un peso valido en kg.');
                            return;
                          }

                          onUpdateWeighIn(entry.id, parsed);
                          setEditingWeighInId(null);
                          setEditingWeighInValue('');
                        }}
                      >
                        <Text style={styles.weighInActionButtonText}>Guardar</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.weighInActionButton, styles.weighInDeleteButton]}
                        onPress={() => {
                          setEditingWeighInId(null);
                          setEditingWeighInValue('');
                        }}
                      >
                        <Text style={styles.weighInDeleteButtonText}>Cancelar</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View style={styles.weighInValueWrap}>
                      <Text style={styles.weighInValue}>{entry.weightKg.toFixed(1)} kg</Text>
                      <View style={styles.weighInActionsRow}>
                        <Pressable
                          style={styles.weighInActionButton}
                          onPress={() => {
                            setEditingWeighInId(entry.id);
                            setEditingWeighInValue(entry.weightKg.toFixed(1));
                          }}
                        >
                          <Text style={styles.weighInActionButtonText}>Editar</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.weighInActionButton, styles.weighInDeleteButton]}
                          onPress={() => {
                            Alert.alert('Eliminar pesaje', 'Este registro se eliminara de forma permanente.', [
                              { text: 'Cancelar', style: 'cancel' },
                              {
                                text: 'Eliminar',
                                style: 'destructive',
                                onPress: () => {
                                  onDeleteWeighIn(entry.id);
                                  if (editingWeighInId === entry.id) {
                                    setEditingWeighInId(null);
                                    setEditingWeighInValue('');
                                  }
                                },
                              },
                            ]);
                          }}
                        >
                          <Text style={styles.weighInDeleteButtonText}>Eliminar</Text>
                        </Pressable>
                      </View>
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

        <Pressable style={styles.primaryButton} onPress={() => onSave(form)}>
          <Text style={styles.primaryButtonText}>Guardar cambios</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function MacroCard({
  title,
  value,
  target,
  unit = '',
}: {
  title: string;
  value: number;
  target: number;
  unit?: string;
}) {
  const progress = Math.min(value / Math.max(target, 1), 1);

  return (
    <View style={styles.macroCard}>
      <View style={styles.macroHeader}>
        <Text style={styles.macroTitle}>{title}</Text>
        <Text style={styles.macroValue}>
          {Math.round(value)} / {Math.round(target)} {unit}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
}

function FormLabel({ text }: { text: string }) {
  return <Text style={styles.label}>{text}</Text>;
}

function RowChoices<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: { value: T; label: string }[];
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      {options.map((option) => {
        const isSelected = option.value === selected;

        return (
          <Pressable
            key={option.value}
            onPress={() => onSelect(option.value)}
            style={[styles.choiceButton, isSelected && styles.choiceButtonSelected]}
          >
            <Text style={[styles.choiceText, isSelected && styles.choiceTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TabButton({
  label,
  icon,
  isActive,
  onPress,
}: {
  label: string;
  icon: 'home' | 'log' | 'profile';
  isActive: boolean;
  onPress: () => void;
}) {
  const iconSource = getTabIconSource(icon, isActive);

  return (
    <Pressable style={[styles.bottomNavItem, isActive && styles.bottomNavItemActive]} onPress={onPress}>
      <Image source={iconSource} style={[styles.bottomNavIconImage, isActive && styles.bottomNavIconImageActive]} />
      <Text style={[styles.bottomNavLabel, isActive && styles.bottomNavLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function getTabIconSource(icon: 'home' | 'log' | 'profile', isActive: boolean) {
  if (icon === 'home') {
    return isActive
      ? require('./assets/icons/icon-home-on.png')
      : require('./assets/icons/icon-home-off.png');
  }

  if (icon === 'log') {
    return isActive
      ? require('./assets/icons/icon-log-on.png')
      : require('./assets/icons/icon-log-off.png');
  }

  return isActive
    ? require('./assets/icons/icon-profile-on.png')
    : require('./assets/icons/icon-profile-off.png');
}

function MacroStat({
  label,
  value,
  target,
  color,
}: {
  label: string;
  value: number;
  target: number;
  color: string;
}) {
  const progress = Math.min(value / Math.max(target, 1), 1);

  return (
    <View style={styles.macroStatBox}>
      <Text style={styles.macroStatLabel}>{label}</Text>
      <Text style={styles.macroStatValue}>
        {Math.round(value)}g <Text style={styles.macroStatTarget}>/ {Math.round(target)}g</Text>
      </Text>
      <View style={styles.macroBarTrack}>
        <View style={[styles.macroBarFill, { width: `${progress * 100}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function mealEmoji(mealType: MealEntry['mealType']): string {
  if (mealType === 'desayuno') {
    return '🍳';
  }

  if (mealType === 'almuerzo') {
    return '🥗';
  }

  if (mealType === 'cena') {
    return '🍲';
  }

  return '🥜';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  authContainer: {
    flex: 1,
    backgroundColor: '#eef3f8',
  },
  authKeyboardContainer: {
    flex: 1,
  },
  authScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 36,
  },
  authBrandMark: {
    width: 68,
    height: 68,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1d4f64',
    marginBottom: 14,
  },
  authBrandLetter: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '900',
  },
  authTitle: {
    color: '#111827',
    fontSize: 34,
    fontWeight: '900',
  },
  authSubtitle: {
    color: '#6b7588',
    fontSize: 15,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 22,
  },
  authCard: {
    width: '100%',
    maxWidth: 440,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#dce5ef',
    backgroundColor: '#ffffff',
    padding: 20,
    gap: 8,
  },
  authModeRow: {
    flexDirection: 'row',
    borderRadius: 14,
    padding: 4,
    backgroundColor: '#edf2f7',
    marginBottom: 10,
  },
  authModeButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 11,
    paddingVertical: 10,
  },
  authModeButtonActive: {
    backgroundColor: '#ffffff',
  },
  authModeText: {
    color: '#7b8798',
    fontWeight: '700',
  },
  authModeTextActive: {
    color: '#1d334d',
  },
  authInput: {
    borderWidth: 1,
    borderColor: '#d7e0eb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#111827',
    backgroundColor: '#f9fbfd',
    fontSize: 16,
  },
  authHelper: {
    color: '#8994a5',
    fontSize: 11,
    marginBottom: 4,
  },
  authSubmitButton: {
    minHeight: 48,
    marginTop: 12,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1d4f64',
  },
  authSubmitText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 15,
  },
  authPrivacyNote: {
    color: '#8994a5',
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 5,
  },
  authErrorCard: {
    borderRadius: 10,
    backgroundColor: '#fdecec',
    padding: 10,
  },
  authErrorText: {
    color: '#9b3030',
    fontSize: 12,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  keyboardContainer: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.bg,
    gap: 12,
  },
  loadingText: {
    color: COLORS.text,
    fontSize: 16,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  kcalText: {
    color: COLORS.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 10,
  },
  tabButton: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  tabButtonActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  tabLabel: {
    color: COLORS.text,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: COLORS.bg,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 12,
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 19,
    fontWeight: '700',
  },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#d8e3ef',
    backgroundColor: '#ffffff',
    padding: 14,
    marginBottom: 8,
  },
  accountInfo: {
    flex: 1,
    gap: 2,
  },
  accountLabel: {
    color: '#8793a5',
    fontSize: 10,
    letterSpacing: 1,
    fontWeight: '800',
  },
  accountUsername: {
    color: '#1d334d',
    fontSize: 18,
    fontWeight: '800',
  },
  accountHint: {
    color: '#7b8798',
    fontSize: 11,
  },
  logoutButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ebcaca',
    backgroundColor: '#fff3f3',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  logoutButtonText: {
    color: '#9a3d3d',
    fontSize: 12,
    fontWeight: '700',
  },
  macroCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    padding: 12,
    gap: 8,
  },
  macroHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  macroTitle: {
    color: COLORS.text,
    fontWeight: '600',
  },
  macroValue: {
    color: COLORS.text,
  },
  progressTrack: {
    height: 8,
    borderRadius: 99,
    backgroundColor: '#132126',
    overflow: 'hidden',
  },
  progressFill: {
    height: 8,
    borderRadius: 99,
    backgroundColor: COLORS.accent,
  },
  emptyCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 18,
    backgroundColor: COLORS.surface,
  },
  emptyText: {
    color: COLORS.textMuted,
  },
  mealCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    padding: 12,
    gap: 6,
  },
  mealName: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 15,
  },
  mealMeta: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  formContainer: {
    paddingHorizontal: 16,
    paddingBottom: 140,
    gap: 8,
  },
  logContentContainer: {
    paddingHorizontal: 16,
    paddingBottom: 150,
    gap: 10,
  },
  logMealTitle: {
    color: '#111827',
    fontSize: 44,
    fontWeight: '800',
    marginTop: 8,
  },
  logMealSubtitle: {
    color: '#6b7588',
    fontSize: 16,
    marginBottom: 12,
  },
  frequentSectionCard: {
    backgroundColor: '#f6f9fd',
    borderWidth: 1,
    borderColor: '#e0e8f3',
    borderRadius: 16,
    padding: 12,
    gap: 10,
  },
  frequentSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  frequentHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  frequentViewMoreButton: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#e3ebf7',
  },
  frequentViewMoreButtonText: {
    color: '#2a4060',
    fontSize: 12,
    fontWeight: '700',
  },
  frequentSectionTitle: {
    color: '#1a2940',
    fontSize: 15,
    fontWeight: '800',
  },
  frequentSaveButton: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#d5e3f6',
  },
  frequentSaveButtonText: {
    color: '#203652',
    fontSize: 12,
    fontWeight: '700',
  },
  frequentEmptyText: {
    color: '#77849a',
    fontSize: 13,
  },
  frequentListRow: {
    gap: 10,
    paddingRight: 8,
  },
  frequentItemCard: {
    width: 170,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dce5f2',
    backgroundColor: '#ffffff',
    padding: 10,
    gap: 4,
  },
  frequentItemTouch: {
    borderRadius: 10,
    padding: 8,
    backgroundColor: '#ffffff',
  },
  frequentItemTouchPressed: {
    transform: [{ scale: 0.97 }],
    backgroundColor: '#edf4ff',
  },
  frequentItemName: {
    color: '#15263e',
    fontWeight: '700',
    fontSize: 14,
  },
  frequentItemMeta: {
    color: '#5a6a82',
    fontSize: 12,
  },
  frequentTapHint: {
    color: '#6f8098',
    fontSize: 11,
    marginTop: 4,
  },
  frequentDeleteButton: {
    marginTop: 6,
    borderRadius: 8,
    paddingVertical: 5,
    alignItems: 'center',
    backgroundColor: '#f4d9d9',
  },
  frequentDeleteButtonText: {
    color: '#8c2f2f',
    fontWeight: '700',
    fontSize: 11,
  },
  frequentModalItemCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d8e2f0',
    backgroundColor: '#ffffff',
    padding: 10,
    gap: 8,
  },
  frequentEditInput: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cad7ea',
    backgroundColor: '#f8fbff',
    color: '#213450',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  frequentEditGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  frequentEditGridInput: {
    minWidth: 90,
    flexGrow: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cad7ea',
    backgroundColor: '#f8fbff',
    color: '#213450',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  frequentModalActions: {
    flexDirection: 'row',
    gap: 8,
  },
  frequentModalPrimaryButton: {
    borderRadius: 10,
    backgroundColor: '#dbe8fb',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  frequentModalPrimaryButtonText: {
    color: '#1f3555',
    fontWeight: '700',
    fontSize: 12,
  },
  frequentModalSecondaryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1dced',
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#f6f9fd',
  },
  frequentModalSecondaryButtonText: {
    color: '#566980',
    fontWeight: '700',
    fontSize: 12,
  },
  frequentModalDeleteButton: {
    borderRadius: 10,
    backgroundColor: '#f6dede',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  frequentModalDeleteButtonText: {
    color: '#842f2f',
    fontWeight: '700',
    fontSize: 12,
  },
  frequentPromptCard: {
    marginTop: 8,
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d8e3f3',
    backgroundColor: '#eef4fd',
    padding: 10,
    gap: 8,
  },
  frequentPromptText: {
    color: '#223653',
    fontSize: 12,
    lineHeight: 17,
  },
  frequentPromptPreviewCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cfdbef',
    backgroundColor: '#f6f9ff',
    padding: 8,
    gap: 2,
  },
  frequentPromptPreviewTitle: {
    color: '#1d314d',
    fontWeight: '700',
    fontSize: 13,
  },
  frequentPromptPreviewMeta: {
    color: '#5a6e8c',
    fontSize: 12,
  },
  frequentPromptInputLabel: {
    color: '#365276',
    fontSize: 12,
    fontWeight: '700',
  },
  frequentPromptInput: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c7d6eb',
    backgroundColor: '#ffffff',
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: '#1f314a',
  },
  frequentPromptActions: {
    flexDirection: 'row',
    gap: 8,
  },
  frequentPromptPrimary: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: '#1f3d66',
    paddingVertical: 9,
    alignItems: 'center',
  },
  frequentPromptPrimaryText: {
    color: '#eff4fd',
    fontWeight: '700',
    fontSize: 12,
  },
  frequentPromptSecondary: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c4d2e8',
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  frequentPromptSecondaryText: {
    color: '#4d6280',
    fontWeight: '700',
    fontSize: 12,
  },
  aiCard: {
    backgroundColor: '#fbfbfc',
    borderRadius: 24,
    padding: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e8edf5',
    gap: 10,
  },
  aiIconBubble: {
    width: 58,
    height: 58,
    borderRadius: 99,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8d7d0',
    marginTop: 6,
  },
  aiIcon: {
    color: '#a73a2f',
    fontSize: 24,
    fontWeight: '700',
  },
  aiCardTitle: {
    color: '#111827',
    fontWeight: '800',
    fontSize: 32,
    marginTop: 8,
  },
  aiCardDescription: {
    color: '#5e687a',
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 22,
    maxWidth: '90%',
  },
  aiPrimaryButton: {
    marginTop: 6,
    borderRadius: 22,
    backgroundColor: '#0f2b4f',
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
  },
  aiPrimaryButtonText: {
    color: '#f2f6fd',
    fontWeight: '800',
    fontSize: 16,
  },
  aiCancelButton: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d6dce9',
    backgroundColor: '#f4f6fb',
    paddingVertical: 10,
    width: '100%',
    alignItems: 'center',
  },
  aiCancelButtonText: {
    color: '#5d6b83',
    fontSize: 13,
    fontWeight: '700',
  },
  audioFeedbackWrap: {
    width: '100%',
    height: 34,
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioProcessingWrap: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  audioProcessingText: {
    color: '#24456f',
    fontSize: 12,
    fontWeight: '700',
  },
  aiHintText: {
    color: '#68758e',
    fontSize: 12,
    marginBottom: 2,
  },
  manualDividerRow: {
    marginTop: 14,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  manualDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#d8dfeb',
  },
  manualDividerText: {
    color: '#9aa2b3',
    fontSize: 12,
    letterSpacing: 2,
    fontWeight: '700',
  },
  label: {
    color: COLORS.text,
    marginTop: 10,
    marginBottom: 4,
    fontWeight: '600',
  },
  logInput: {
    borderWidth: 1,
    borderColor: '#dce4ef',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#1d2b3f',
    backgroundColor: '#e8eef7',
    fontSize: 16,
  },
  activityHintCard: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    backgroundColor: '#f6f9fd',
    padding: 10,
    gap: 4,
  },
  activityHintTitle: {
    color: '#22354f',
    fontSize: 12,
    fontWeight: '700',
  },
  activityHintLine: {
    color: '#5f6f86',
    fontSize: 12,
    lineHeight: 16,
  },
  booleanToggle: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#cfd9ea',
    borderRadius: 12,
    backgroundColor: '#f3f7fc',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  booleanToggleActive: {
    borderColor: '#94b2da',
    backgroundColor: '#dce9fb',
  },
  booleanToggleText: {
    color: '#3f5474',
    fontSize: 12,
    fontWeight: '600',
  },
  booleanToggleTextActive: {
    color: '#1f3c66',
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    backgroundColor: COLORS.surface,
  },
  mealTypeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  mealTypePill: {
    borderRadius: 18,
    backgroundColor: '#dfe7f3',
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  mealTypePillActive: {
    backgroundColor: '#c9dbf3',
  },
  mealTypePillText: {
    color: '#2c3748',
    fontWeight: '600',
    fontSize: 15,
  },
  mealTypePillTextActive: {
    color: '#1b2a40',
  },
  dualFieldRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-end',
  },
  dualFieldCol: {
    flex: 1,
  },
  detailToggle: {
    marginTop: 14,
    paddingVertical: 6,
  },
  detailToggleText: {
    color: '#31455f',
    fontWeight: '700',
    fontSize: 16,
  },
  voiceRecorderCard: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    backgroundColor: '#edf1f8',
    padding: 12,
    gap: 10,
  },
  voiceRecordButton: {
    borderRadius: 14,
    backgroundColor: '#132f5f',
    paddingVertical: 12,
    alignItems: 'center',
  },
  voiceRecordButtonActive: {
    backgroundColor: '#c94747',
  },
  voiceRecordButtonText: {
    color: '#f3f7fd',
    fontWeight: '800',
    fontSize: 14,
  },
  voiceHintText: {
    color: '#5e6d84',
    fontSize: 12,
  },
  spectrumRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 7,
    height: 34,
  },
  spectrumBar: {
    width: 8,
    borderRadius: 99,
    backgroundColor: '#5f7fb3',
  },
  choiceRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  choiceButton: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: COLORS.surface,
  },
  choiceButtonSelected: {
    borderColor: '#aac5e7',
    backgroundColor: '#cddff6',
  },
  choiceText: {
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  choiceTextSelected: {
    color: '#1b2f4b',
  },
  helperText: {
    color: COLORS.textMuted,
    marginBottom: 6,
  },
  primaryButton: {
    marginTop: 14,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    backgroundColor: COLORS.accent,
  },
  primaryButtonText: {
    color: COLORS.bg,
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#e8eef7',
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '700',
  },
  itemCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    backgroundColor: COLORS.surface,
  },
  itemCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemCardTitle: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 15,
  },
  smallActionButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#132126',
  },
  smallActionButtonDisabled: {
    opacity: 0.45,
  },
  smallActionButtonText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '600',
  },
  targetCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    backgroundColor: '#f7f9fc',
    gap: 4,
  },
  targetTitle: {
    color: COLORS.text,
    fontWeight: '700',
    marginBottom: 4,
  },
  targetLine: {
    color: COLORS.textMuted,
  },
  diagnosticsCard: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#d8e3f3',
    borderRadius: 14,
    backgroundColor: '#f7f9fd',
    padding: 10,
  },
  diagnosticsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  diagnosticsToggle: {
    color: '#375278',
    fontWeight: '700',
    fontSize: 12,
  },
  diagnosticsList: {
    marginTop: 8,
    gap: 2,
  },
  weightSectionCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    backgroundColor: '#f7f9fc',
    gap: 8,
  },
  weightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  weightInput: {
    flex: 1,
  },
  weightSaveButton: {
    borderRadius: 12,
    backgroundColor: '#cddff6',
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  weightSaveButtonText: {
    color: '#1f3249',
    fontWeight: '700',
  },
  weighInRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 8,
  },
  weighInPreviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 8,
  },
  weighInDate: {
    color: '#5f6d82',
    fontSize: 13,
  },
  weighInValue: {
    color: '#1d2b42',
    fontWeight: '700',
    fontSize: 14,
  },
  weighInValueWrap: {
    alignItems: 'flex-end',
    gap: 6,
  },
  weighInActionsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  weighInActionButton: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#dbe6f6',
  },
  weighInActionButtonText: {
    color: '#1d3551',
    fontSize: 12,
    fontWeight: '700',
  },
  weighInDeleteButton: {
    backgroundColor: '#f4d7d7',
  },
  weighInDeleteButtonText: {
    color: '#8a2e2e',
    fontSize: 12,
    fontWeight: '700',
  },
  weighInEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  weighInEditInput: {
    minWidth: 72,
    borderWidth: 1,
    borderColor: '#cfd9ea',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: '#1f2f45',
    backgroundColor: '#f6f9ff',
  },
  viewMoreButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#dce6f6',
  },
  viewMoreButtonText: {
    color: '#1f3553',
    fontWeight: '700',
    fontSize: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(7, 19, 30, 0.42)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 30,
  },
  modalCard: {
    backgroundColor: '#f8fafd',
    borderRadius: 18,
    padding: 14,
    maxHeight: '82%',
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalTitle: {
    color: '#17263d',
    fontWeight: '800',
    fontSize: 18,
  },
  modalCloseButton: {
    borderRadius: 10,
    backgroundColor: '#dce5f4',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  modalCloseButtonText: {
    color: '#223853',
    fontWeight: '700',
    fontSize: 12,
  },
  modalList: {
    maxHeight: '100%',
  },
  modalListContent: {
    gap: 2,
    paddingBottom: 8,
  },
  logSaveButton: {
    marginTop: 14,
    borderRadius: 20,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#d8e1ee',
  },
  logSaveButtonText: {
    color: '#203650',
    fontWeight: '800',
    letterSpacing: 1.6,
    fontSize: 18,
  },
  logFrequentButton: {
    marginTop: 8,
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#d4e0f1',
  },
  logFrequentButtonText: {
    color: '#27415f',
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 14,
  },
  appHeader: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarCircle: {
    width: 38,
    height: 38,
    borderRadius: 99,
    backgroundColor: '#e6ebf3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarEmoji: {
    fontSize: 18,
  },
  brandTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 26,
  },
  brandSubtitle: {
    color: COLORS.textMuted,
    fontSize: 10,
  },
  kcalPill: {
    backgroundColor: '#dbe3ef',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  kcalPillText: {
    color: '#243245',
    fontWeight: '700',
    fontSize: 14,
  },
  screenContent: {
    flex: 1,
  },
  homeContentContainer: {
    paddingHorizontal: 18,
    paddingBottom: 160,
    gap: 14,
  },
  summaryBlock: {
    marginTop: 8,
    gap: 6,
  },
  summaryLabel: {
    color: '#6f7889',
    letterSpacing: 1,
    fontSize: 12,
    fontWeight: '700',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  summaryValue: {
    color: '#0f172a',
    fontSize: 56,
    lineHeight: 58,
    fontWeight: '800',
  },
  summaryTarget: {
    color: '#9aa3b1',
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '700',
    marginBottom: 7,
  },
  macroStatsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 6,
  },
  macroStatBox: {
    flex: 1,
    gap: 6,
  },
  macroStatLabel: {
    fontSize: 12,
    letterSpacing: 1,
    color: '#7f8796',
    fontWeight: '700',
  },
  macroStatValue: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '700',
  },
  macroStatTarget: {
    color: '#9ea6b3',
    fontSize: 12,
    fontWeight: '600',
  },
  macroBarTrack: {
    height: 5,
    backgroundColor: '#d8dee9',
    borderRadius: 99,
    overflow: 'hidden',
  },
  macroBarFill: {
    height: 5,
    borderRadius: 99,
  },
  heroCard: {
    minHeight: 252,
    borderRadius: 26,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.52,
  },
  heroOverlay: {
    padding: 20,
    gap: 8,
    backgroundColor: 'rgba(5, 26, 41, 0.35)',
  },
  heroBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#eaf4f7',
    color: '#244056',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  heroTitle: {
    color: '#f6fbff',
    fontSize: 54,
    lineHeight: 56,
    fontWeight: '800',
    maxWidth: '75%',
  },
  heroDescription: {
    color: '#e5f0f6',
    fontSize: 13,
    maxWidth: '72%',
  },
  heroButton: {
    alignSelf: 'flex-start',
    marginTop: 4,
    backgroundColor: '#102f5a',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  heroButtonText: {
    color: '#eef4fb',
    fontWeight: '800',
    fontSize: 15,
  },
  heroButtonIcon: {
    fontSize: 16,
  },
  waterCard: {
    backgroundColor: '#e8edf5',
    borderRadius: 22,
    padding: 18,
    gap: 6,
  },
  waterTitle: {
    color: '#111827',
    fontSize: 23,
    fontWeight: '700',
  },
  waterSubtitle: {
    color: '#6f7a8c',
    fontSize: 14,
    marginBottom: 8,
  },
  waterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  waterCircle: {
    width: 72,
    height: 72,
    borderRadius: 99,
    borderWidth: 6,
    borderColor: '#b8c7e2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  waterCircleText: {
    fontWeight: '800',
    color: '#31425a',
    fontSize: 11,
  },
  waterCircleArrow: {
    color: '#4a5f82',
    fontWeight: '800',
    fontSize: 14,
  },
  waterProgress: {
    color: '#111827',
    fontWeight: '800',
    fontSize: 18,
  },
  waterAction: {
    color: '#2c9d28',
    fontWeight: '800',
    fontSize: 12,
    marginTop: 4,
  },
  weightHomeInfoWrap: {
    flex: 1,
  },
  weightHomeDate: {
    color: '#8b96aa',
    fontSize: 11,
    marginTop: 2,
  },
  weightHomeEntryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  weightHomeInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d2dbe9',
    borderRadius: 12,
    backgroundColor: '#f4f7fb',
    color: '#223047',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  weightHomeButton: {
    borderRadius: 12,
    backgroundColor: '#cdddf4',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  weightHomeButtonText: {
    color: '#213754',
    fontWeight: '700',
  },
  logHeader: {
    marginTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  logTitle: {
    color: '#111827',
    fontSize: 24,
    fontWeight: '800',
    flexShrink: 1,
  },
  logHistory: {
    color: '#313f53',
    fontSize: 13,
    fontWeight: '600',
  },
  emptyCardLight: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#dde3ee',
    padding: 16,
  },
  mealListCard: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  mealIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#f1f4fa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mealIcon: {
    fontSize: 23,
  },
  mealInfoWrap: {
    flex: 1,
    gap: 2,
  },
  mealTypeLabel: {
    color: '#9ba4b3',
    letterSpacing: 1,
    fontSize: 11,
    fontWeight: '700',
  },
  mealNameDark: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '700',
  },
  mealMacroLine: {
    color: '#44546b',
    fontSize: 11,
    fontWeight: '600',
  },
  mealKcalValue: {
    color: '#111827',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'right',
  },
  mealKcalLabel: {
    color: '#9da6b5',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
  },
  bottomNav: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 8,
    backgroundColor: '#edf1f8',
    borderRadius: 20,
    flexDirection: 'row',
    padding: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: '#dde3ed',
  },
  bottomNavItem: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 12,
    paddingVertical: 7,
  },
  bottomNavItemActive: {
    backgroundColor: '#cddff6',
  },
  bottomNavIconImage: {
    width: 22,
    height: 22,
    marginBottom: 4,
    resizeMode: 'contain',
    tintColor: '#7f8aa0',
  },
  bottomNavIconImageActive: {
    tintColor: '#24354b',
  },
  bottomNavLabel: {
    color: '#8995a9',
    fontSize: 11,
    letterSpacing: 0.5,
    fontWeight: '700',
  },
  bottomNavLabelActive: {
    color: '#1f3247',
  },
});
