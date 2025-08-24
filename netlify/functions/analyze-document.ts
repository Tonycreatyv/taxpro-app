import type { Context } from "@netlify/functions"
import { createClient } from '@supabase/supabase-js'

// Interfaz para definir la estructura del webhook de Supabase
interface WebhookPayload {
  type: 'INSERT';
  table: string;
  record: {
    id: number;
    client_id: number;
    file_path: string;
  };
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent"

export default async (req: Request, context: Context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // --- OBTENER SECRETOS ---
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    // --- CONECTAR A SUPABASE ---
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    // --- PROCESAR LA ENTRADA DEL WEBHOOK ---
    const payload: WebhookPayload = await req.json();
    const documentRecord = payload.record;

    // --- DESCARGAR EL ARCHIVO DE SUPABASE STORAGE ---
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('tax-documents') // Asegúrate de que este es el nombre de tu bucket
      .download(documentRecord.file_path);

    if (downloadError) throw downloadError;

    // --- PREPARAR EL ARCHIVO PARA GEMINI ---
    // Convertir el archivo a un formato que Gemini entiende (Base64)
    const fileBuffer = await fileBlob.arrayBuffer();
    const base64File = btoa(String.fromCharCode(...new Uint8Array(fileBuffer)));
    const mimeType = fileBlob.type; // ej. "image/png" o "application/pdf"

    // --- LLAMAR A LA API DE GEMINI CON EL ARCHIVO Y EL PROMPT ---
    const prompt = `Analiza este documento fiscal. Extrae en formato JSON: el tipo de documento (W-2, 1099-INT, etc.), el año fiscal, el nombre del emisor y las cifras clave.`;
    
    const geminiResponse = await fetch(`${GEMINI_URL}?key=${geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }] },
          { parts: [{ inline_data: { mime_type: mimeType, data: base64File } }] }
        ]
      })
    });

    if (!geminiResponse.ok) {
      throw new Error(`Error en la API de Gemini: ${geminiResponse.statusText}`);
    }

    const responseData = await geminiResponse.json();
    let analysisText = responseData.candidates[0].content.parts[0].text;
    
    // Limpiar la respuesta de Gemini para que sea un JSON válido
    analysisText = analysisText.replace(/```json\n|\n```/g, '');
    const analysisJson = JSON.parse(analysisText);

    // --- GUARDAR EL ANÁLISIS EN LA BASE DE DATOS ---
    const { error: insertError } = await supabase
      .from('document_analyses')
      .insert({
        document_id: documentRecord.id,
        status: 'completed',
        document_type: analysisJson.tipo_de_documento,
        tax_year: analysisJson.año_fiscal,
        issuer_name: analysisJson.nombre_del_emisor,
        key_figures: analysisJson.cifras_clave,
        summary: 'Análisis completado por IA.'
      });

    if (insertError) throw insertError;

    // --- DEVOLVER RESPUESTA DE ÉXITO ---
    return new Response(JSON.stringify({ success: true, analysis: analysisJson }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
};
