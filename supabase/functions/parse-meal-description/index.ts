import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FREE_TIER_LIMIT_PER_DAY = 8;

type AnalysisItem = {
  name: string;
  weightGrams: number;
  proteinPer100: number;
  carbsPer100: number;
  fatsPer100: number;
};

type Analysis = {
  description: string;
  name: string;
  protein: number;
  carbs: number;
  fats: number;
  calories: number;
  items: AnalysisItem[];
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

function parseAnalysis(rawText: string): Analysis {
  const jsonText = rawText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(jsonText) as Partial<Analysis>;

  if (
    !parsed.name ||
    typeof parsed.protein !== 'number' ||
    typeof parsed.carbs !== 'number' ||
    typeof parsed.fats !== 'number' ||
    typeof parsed.calories !== 'number' ||
    !Array.isArray(parsed.items)
  ) {
    throw new Error('Respuesta del modelo invalida.');
  }

  const items = parsed.items
    .filter(
      (item) =>
        item &&
        typeof item.name === 'string' &&
        typeof item.weightGrams === 'number' &&
        typeof item.proteinPer100 === 'number' &&
        typeof item.carbsPer100 === 'number' &&
        typeof item.fatsPer100 === 'number',
    )
    .slice(0, 8)
    .map((item) => ({
      name: item.name,
      weightGrams: Math.max(0, item.weightGrams),
      proteinPer100: Math.max(0, item.proteinPer100),
      carbsPer100: Math.max(0, item.carbsPer100),
      fatsPer100: Math.max(0, item.fatsPer100),
    }));

  if (items.length === 0) {
    throw new Error('No se detectaron alimentos en la descripcion.');
  }

  return {
    description:
      typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : parsed.name,
    name: parsed.name,
    protein: Math.max(0, parsed.protein),
    carbs: Math.max(0, parsed.carbs),
    fats: Math.max(0, parsed.fats),
    calories: Math.max(0, parsed.calories),
    items,
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

  if (!geminiApiKey) {
    return jsonResponse(500, { error: 'Falta GEMINI_API_KEY en secretos de Supabase.' });
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

  let body: { description?: string; audioBase64?: string; mimeType?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Body invalido.' });
  }

  const description = body.description?.trim();
  const hasAudio = Boolean(body.audioBase64);
  if (!description && !hasAudio) {
    return jsonResponse(400, { error: 'Escribe o dicta lo que comiste.' });
  }

  const promptParts = [
    'Actua como nutricionista y parser de comidas.',
    'Si recibes audio, primero transcribelo a texto.',
    'Convierte la descripcion final en una estimacion de macros.',
    'Responde solo JSON valido sin markdown con esta estructura exacta:',
    '{"description":"string","name":"string","protein":0,"carbs":0,"fats":0,"calories":0,"items":[{"name":"string","weightGrams":0,"proteinPer100":0,"carbsPer100":0,"fatsPer100":0}]}',
    'description debe contener la transcripcion o descripcion completa de lo que entendiste del usuario.',
    'Usa todos los alimentos mencionados. Si falta algun peso, estimarlo razonablemente.',
    'calories debe coincidir aproximadamente con protein*4 + carbs*4 + fats*9.',
  ];

  if (description) {
    promptParts.push(`Descripcion: ${description}`);
  } else {
    promptParts.push('Descripcion: tomada desde audio del usuario.');
  }

  const prompt = promptParts.join(' ');

  const requestParts: Array<Record<string, unknown>> = [{ text: prompt }];

  if (hasAudio) {
    requestParts.push({
      inlineData: {
        mimeType: body.mimeType ?? 'audio/m4a',
        data: body.audioBase64,
      },
    });
  }

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: requestParts,
          },
        ],
      }),
    },
  );

  if (!geminiResponse.ok) {
    const rawError = await geminiResponse.text();
    let message = 'La API de Gemini devolvio error.';
    try {
      const parsedError = JSON.parse(rawError) as { error?: { message?: string } };
      if (parsedError?.error?.message) {
        message = parsedError.error.message;
      }
    } catch {
      if (rawError.trim()) {
        message = rawError.trim();
      }
    }

    await supabase.from('photo_analyses').insert({
      user_id: userId,
      status: 'error',
      error_message: message,
    });

    return jsonResponse(502, { error: `Gemini (${geminiModel}): ${message}` });
  }

  let analysis: Analysis;
  try {
    const payload = (await geminiResponse.json()) as GeminiResponse;
    analysis = parseAnalysis(extractModelText(payload));
  } catch {
    return jsonResponse(502, { error: 'No pudimos interpretar la respuesta del analisis.' });
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
