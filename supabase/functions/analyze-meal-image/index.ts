import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FREE_TIER_LIMIT_PER_DAY = 8;

type Analysis = {
  name: string;
  protein: number;
  carbs: number;
  fats: number;
  calories: number;
  items: AnalysisItem[];
};

type AnalysisItem = {
  name: string;
  weightGrams: number;
  proteinPer100: number;
  carbsPer100: number;
  fatsPer100: number;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function extractModelText(payload: GeminiResponse): string {
  return (
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim() ?? ''
  );
}

function parseAnalysisFromText(rawText: string): Analysis {
  const jsonText = rawText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(jsonText) as Partial<Analysis> & {
    items?: Partial<AnalysisItem>[];
  };

  if (
    !parsed.name ||
    typeof parsed.protein !== 'number' ||
    typeof parsed.carbs !== 'number' ||
    typeof parsed.fats !== 'number' ||
    typeof parsed.calories !== 'number'
  ) {
    throw new Error('Respuesta del modelo invalida.');
  }

  const parsedItems =
    parsed.items
      ?.filter((item) =>
        item &&
        typeof item.name === 'string' &&
        typeof item.weightGrams === 'number' &&
        typeof item.proteinPer100 === 'number' &&
        typeof item.carbsPer100 === 'number' &&
        typeof item.fatsPer100 === 'number',
      )
      .slice(0, 6)
      .map((item) => ({
        name: (item.name as string).trim(),
        weightGrams: Math.max(0, item.weightGrams as number),
        proteinPer100: Math.max(0, item.proteinPer100 as number),
        carbsPer100: Math.max(0, item.carbsPer100 as number),
        fatsPer100: Math.max(0, item.fatsPer100 as number),
      })) ?? [];

  const fallbackItems: AnalysisItem[] = [
    {
      name: parsed.name,
      weightGrams: 100,
      proteinPer100: Math.max(0, parsed.protein),
      carbsPer100: Math.max(0, parsed.carbs),
      fatsPer100: Math.max(0, parsed.fats),
    },
  ];

  return {
    name: parsed.name,
    protein: Math.max(0, parsed.protein),
    carbs: Math.max(0, parsed.carbs),
    fats: Math.max(0, parsed.fats),
    calories: Math.max(0, parsed.calories),
    items: parsedItems.length > 0 ? parsedItems : fallbackItems,
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Metodo no permitido.' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  const geminiModel = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash';

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: 'Supabase no configurado en la funcion.' });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const accessToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!accessToken) {
    return jsonResponse(401, { error: 'Debes iniciar sesion.' });
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
  const userId = authData.user?.id;
  if (authError || !userId) {
    return jsonResponse(401, { error: 'La sesion no es valida.' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const usageOnly = new URL(request.url).searchParams.get('usageOnly') === '1';

  const { data: usageRow, error: usageError } = await supabase
    .from('daily_user_ai_usage')
    .select('request_count')
    .eq('usage_date', today)
    .eq('user_id', userId)
    .maybeSingle();

  if (usageError) {
    return jsonResponse(500, { error: 'No pudimos validar la cuota diaria.' });
  }

  const usedToday = usageRow?.request_count ?? 0;
  const remainingToday = Math.max(0, FREE_TIER_LIMIT_PER_DAY - usedToday);

  if (usageOnly) {
    return jsonResponse(200, { remainingToday });
  }

  if (remainingToday <= 0) {
    return jsonResponse(429, { error: 'Llegaste al limite diario de analisis gratis.' });
  }

  if (!geminiApiKey) {
    return jsonResponse(500, { error: 'Falta GEMINI_API_KEY en secretos de Supabase.' });
  }

  let body: { imageBase64?: string; mimeType?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Body invalido.' });
  }

  if (!body.imageBase64) {
    return jsonResponse(400, { error: 'Falta imageBase64.' });
  }

  const prompt = [
    'Analiza esta imagen de comida y devuelve una estimacion nutricional para el plato y por alimento detectado.',
    'Responde solo JSON valido sin markdown con esta estructura exacta:',
    '{"name":"string","protein":0,"carbs":0,"fats":0,"calories":0,"items":[{"name":"string","weightGrams":0,"proteinPer100":0,"carbsPer100":0,"fatsPer100":0}]}',
    'En items, incluye cada alimento visible separado (ejemplo: pollo, arroz, ensalada).',
    'Si no sabes el peso exacto, usa una estimacion razonable en weightGrams.',
    'Todos los valores deben ser numeros en gramos y calorias totales.',
    'Si no estas seguro, igualmente devuelve una mejor estimacion razonable.',
  ].join(' ');

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: body.mimeType ?? 'image/jpeg',
                  data: body.imageBase64,
                },
              },
            ],
          },
        ],
      }),
    },
  );

  if (!geminiResponse.ok) {
    const geminiRawError = await geminiResponse.text();
    let geminiMessage = 'La API de Gemini devolvio error.';
    try {
      const parsed = JSON.parse(geminiRawError) as { error?: { message?: string } };
      if (parsed?.error?.message) {
        geminiMessage = parsed.error.message;
      }
    } catch {
      if (geminiRawError.trim()) {
        geminiMessage = geminiRawError.trim();
      }
    }

    await supabase.from('photo_analyses').insert({
      user_id: userId,
      status: 'error',
      error_message: geminiMessage,
    });

    return jsonResponse(502, { error: `Gemini (${geminiModel}): ${geminiMessage}` });
  }

  let analysis: Analysis;
  try {
    const geminiPayload = (await geminiResponse.json()) as GeminiResponse;
    analysis = parseAnalysisFromText(extractModelText(geminiPayload));
  } catch {
    await supabase.from('photo_analyses').insert({
      user_id: userId,
      status: 'error',
      error_message: 'No se pudo parsear la respuesta de Gemini.',
    });

    return jsonResponse(502, { error: 'No pudimos interpretar el analisis.' });
  }

  const nextCount = usedToday + 1;

  const { error: upsertError } = await supabase.from('daily_user_ai_usage').upsert(
    {
      usage_date: today,
      user_id: userId,
      request_count: nextCount,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'usage_date,user_id' },
  );

  if (upsertError) {
    return jsonResponse(500, { error: 'No pudimos actualizar la cuota diaria.' });
  }

  await supabase.from('photo_analyses').insert({
    user_id: userId,
    meal_name: analysis.name,
    protein: analysis.protein,
    carbs: analysis.carbs,
    fats: analysis.fats,
    calories: analysis.calories,
    status: 'success',
  });

  return jsonResponse(200, {
    analysis,
    remainingToday: Math.max(0, FREE_TIER_LIMIT_PER_DAY - nextCount),
  });
});
