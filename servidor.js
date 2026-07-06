require("dotenv").config();               // carga las claves del .env
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// Cliente de OpenAI (usa la clave del .env)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1) SALUDO DE VERIFICACIÓN (igual que antes)
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// 2) RECIBIR MENSAJE → PENSAR CON IA → RESPONDER POR WHATSAPP
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // avisamos a Meta "recibido" enseguida

  try {
    // Sacamos el mensaje de dentro del paquete que manda Meta
    const entrada = req.body.entry?.[0]?.changes?.[0]?.value;
    const mensaje = entrada?.messages?.[0];

    // Si no es un mensaje de texto (ej: notificación de estado), lo ignoramos
    if (!mensaje || mensaje.type !== "text") return;

    const textoPaciente = mensaje.text.body;   // lo que escribió el paciente
    const numeroPaciente = mensaje.from;        // su número

    console.log("📩 Paciente dice:", textoPaciente);

    // --- La IA piensa la respuesta ---
   const respuestaIA = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres "Lucía", la asistente virtual de la Clínica Dental Sonrisa, por WhatsApp.

TONO:
- Cercana, amable y profesional. Tuteas al paciente.
- Respuestas BREVES (es WhatsApp): 2-4 frases máximo.
- Usa algún emoji con moderación cuando encaje, sin abusar.

QUÉ HACES:
- Resuelves dudas generales sobre tratamientos (limpiezas, ortodoncia, implantes, estética dental).
- Ayudas al paciente a pedir cita: le pides su nombre y qué día/hora le viene bien, y le dices que el equipo se lo confirmará.
- Si preguntan por horarios: la clínica abre de lunes a viernes, de 9:00 a 20:00.

QUÉ NO HACES NUNCA:
- No inventes precios. Si preguntan cuánto cuesta algo, di que depende de cada caso y que la primera visita es gratuita y sin compromiso.
- No des diagnósticos ni consejos médicos concretos. Ante dolor o urgencia, recomienda pedir cita cuanto antes.
- No prometas resultados ni plazos médicos.

OBJETIVO:
- Que el paciente termine pidiendo cita o dejando sus datos para que le llamen. Empuja suavemente hacia eso, sin ser pesada.`
        },
        { role: "user", content: textoPaciente }
      ]
    });


    const textoRespuesta = respuestaIA.choices[0].message.content;
    console.log("🤖 IA responde:", textoRespuesta);

    // --- Enviamos la respuesta de vuelta al paciente por WhatsApp ---
    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: numeroPaciente,
        text: { body: textoRespuesta }
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );

    console.log("✅ Respuesta enviada al paciente");

  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
  }
});

app.listen(3000, () => console.log("Servidor despierto en el puerto 3000"));