import { Handler } from "@netlify/functions";
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Función para convertir el archivo a la parte generativa que necesita Gemini
function fileToGenerativePart(buffer: Buffer, mimeType: string) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType,
    },
  };
}

const handler: Handler = async (event) => {
  if (!event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "No se recibió cuerpo en la solicitud." }),
    };
  }

  try {
    // 1. Extraer la ruta del archivo del webhook
    const webhookPayload = JSON.parse(event.body);
    const filePath = webhookPayload.record.file_path;

    if (!filePath) {
      throw new Error("No se encontró file_path en el payload del webhook.");
    }

    // 2. Conectar con Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );

    // 3. Descargar el archivo desde Supabase Storage
    const { data: fileData, error: downloadError } = await supabase
      .storage
      .from('tax-documents') // Asegúrate que este es el nombre de tu bucket
      .download(filePath);

    if (downloadError) {
      throw new Error(`Error al descargar el archivo: ${downloadError.message}`);
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    // Por ahora asumimos PDF, esto se puede mejorar después
    const mimeType = "application/pdf"; 

    // 4. Preparar la llamada a la API de Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = "Analiza este documento de impuestos. Extrae el tipo de documento (ej. W-2, 1099-NEC), el año fiscal, el nombre del emisor, y las cifras clave como ingresos totales. Proporciona un breve resumen. Responde únicamente en formato JSON.";
    
    const filePart = fileToGenerativePart(buffer, mimeType);

    const requestBody = {
        contents: [{ parts: [filePart, { text: prompt }] }],
    };

    // ==================================================================
    // LÍNEA CLAVE DE DEPURACIÓN: Imprime el cuerpo de la petición en el log
    console.log("Enviando el siguiente cuerpo de solicitud a Gemini:", JSON.stringify(requestBody, null, 2));
    // ==================================================================

    // 5. Llamar a la API de Gemini
    const result = await model.generateContent(requestBody);
    const response = result.response;
    const analysisText = response.text();

    console.log("Respuesta de Gemini:", analysisText);
    
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, analysis: analysisText }),
    };

  } catch (error) {
    console.error("Error en la función analyze-document:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Error en la API de Gemini: ${error.message}` }),
    };
  }
};

export { handler };