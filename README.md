# FitTrack MVP

App mobile (Expo + React Native) para contar macros orientada a deficit/superavit calorico.

## Incluye en esta primera version

- Onboarding con objetivo (deficit, mantenimiento, superavit)
- Calculo automatico de calorias y macros diarios
- Carga manual de comidas
- Analisis de comida por voz/texto con IA (Gemini, cuota diaria gratis con limite server-side)
- Seguimiento de peso semanal con sugerencias de recalibracion (requiere confirmacion)
- Persistencia local con AsyncStorage
- Sincronizacion opcional a Supabase (si se configuran variables)

## Requisitos

- Node 18+
- Expo CLI via `npx`

## Configuracion

1. Copiar variables de entorno:

```bash
cp .env.example .env
```

2. Completar en `.env`:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

## Ejecutar

```bash
npm install
npm run start
```

Para ejecutar la version web:

```bash
npm run web
```

El navegador necesita permiso de microfono. En produccion, la grabacion solo funciona bajo HTTPS.

## Build web y PWA

Generar la version estatica de produccion:

```bash
npm run build:web
```

El resultado queda en `dist/` e incluye manifest, service worker e iconos para instalar FitTrack desde la pantalla de inicio.

### Cloudflare Pages

- Build command: `npm run build:web`
- Build output directory: `dist`
- Variables: `EXPO_PUBLIC_SUPABASE_URL` y `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Luego de abrir la URL publicada en iPhone, usar `Compartir > Agregar a inicio` para instalarla como PWA.

## Supabase (recomendado)

Ejecutar `supabase/schema.sql` en el SQL editor de tu proyecto.

Desplegar Edge Function principal:

```bash
supabase functions deploy parse-meal-description
```

Configurar secreto de Gemini en Supabase:

```bash
supabase secrets set GEMINI_API_KEY=tu_api_key
```

Modelo de Gemini (opcional, por defecto usa `gemini-2.5-flash`):

```bash
supabase secrets set GEMINI_MODEL=gemini-2.5-flash
```

## Notas

- La estimacion IA es orientativa y siempre debe poder corregirse.
- El modo voz/texto procesa descripciones tipo "200g pollo + 100g arroz" y propone macros por alimento.
- Hay limite diario por dispositivo gestionado en backend.
- BYOK para usuarios finales queda planificado para fase 2.
