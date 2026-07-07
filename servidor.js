// ============================================================
//  GANAPACIENTES · MODELO B (MULTI-CLÍNICA)
//  Un solo servidor atiende a MUCHAS clínicas.
//  Cada mensaje se identifica por el phone_number_id de destino,
//  y se carga la configuración de ESA clínica desde Supabase.
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============================================================
//  IDENTIFICAR LA CLÍNICA por el phone_number_id del mensaje
// ============================================================
async function buscarClinica(phoneNumberId) {
  const { data } = await supabase
    .from("clinicas").select("*")
    .eq("phone_number_id", phoneNumberId)
    .eq("activa", true)
    .single();
  return data; // devuelve la fila de la clínica (o null si no existe)
}

// ============================================================
//  MEMORIA (ahora filtrada por clínica)
// ============================================================
async function leerHistorial(telefono, clinicaId) {
  const { data } = await supabase
    .from("conversaciones").select("rol,contenido")
    .eq("telefono", telefono).eq("clinica_id", clinicaId)
    .order("creado", { ascending: true }).limit(10);
  return (data || []).map(m => ({ role: m.rol, content: m.contenido }));
}
async function guardarMensaje(telefono, rol, contenido, clinicaId) {
  await supabase.from("conversaciones").insert({ telefono, rol, contenido, clinica_id: clinicaId });
}

// ============================================================
//  AGENDA (Cal.com) — ahora recibe la config de la clínica
// ============================================================
async function consultarHuecos(fecha, clinica) {
  try {
    const r = await axios.get("https://api.cal.com/v2/slots", {
      headers: { Authorization: `Bearer ${clinica.cal_api_key}`, "cal-api-version": "2024-09-04" },
      params: { eventTypeId: Number(clinica.cal_event_id), start: fecha, end: fecha, timeZone: "Europe/Madrid" }
    });
    const slots = (r.data.data || {})[fecha] || [];
    return slots.map(s => s.start.slice(11, 16));
  } catch (e) {
    console.error("Error consultarHuecos:", e.response?.data || e.message);
    return [];
  }
}
async function reservarCita(fecha, hora, nombre, telefono, clinica) {
  try {
    await axios.post("https://api.cal.com/v2/bookings",
      {
        eventTypeId: Number(clinica.cal_event_id),
        start: `${fecha}T${hora}:00.000Z`,
        attendee: { name: nombre, email: "paciente@ganapacientes.es", timeZone: "Europe/Madrid", language: "es" },
        bookingFieldsResponses: { notes: `Reserva por WhatsApp. Tel: ${telefono}` }
      },
      { headers: { Authorization: `Bearer ${clinica.cal_api_key}`, "cal-api-version": "2024-08-13" } }
    );
    // Guardamos la cita con la clínica correcta
    await supabase.from("citas").insert({ telefono, nombre, fecha, hora, clinica_id: clinica.id });
    // Si venía de un dormido, lo marcamos recuperado (dentro de su clínica)
    await supabase.from("dormidos").update({ estado: "recuperado" })
      .eq("telefono", telefono).eq("clinica_id", clinica.id);
    return { ok: true };
  } catch (e) {
    console.error("Error reservarCita:", e.response?.data || e.message);
    return { ok: false };
  }
}

const TOOLS = [
  { type: "function", function: { name: "consultarHuecos",
    description: "Consulta las horas libres de la clínica para una fecha.",
    parameters: { type: "object", properties: { fecha: { type: "string", description: "AAAA-MM-DD" } }, required: ["fecha"] } } },
  { type: "function", function: { name: "reservarCita",
    description: "Reserva una cita cuando hay fecha, hora y nombre.",
    parameters: { type: "object", properties: {
      fecha: { type: "string" }, hora: { type: "string" }, nombre: { type: "string" }
    }, required: ["fecha", "hora", "nombre"] } } }
];

// Ejecuta la herramienta pedida, pasándole la config de la clínica
async function ejecutarHerramienta(nombre, args, telefono, clinica) {
  if (nombre === "consultarHuecos") {
    return JSON.stringify({ huecosLibres: await consultarHuecos(args.fecha, clinica) });
  }
  if (nombre === "reservarCita") {
    const r = await reservarCita(args.fecha, args.hora, args.nombre, telefono, clinica);
    return JSON.stringify({ reservado: r.ok });
  }
  return JSON.stringify({ error: "desconocida" });
}

// ============================================================
//  WEBHOOK 1) Verificación (igual que antes)
// ============================================================
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else res.sendStatus(403);
});

// ============================================================
//  WEBHOOK 2) Recibir -> identificar clínica -> IA con SU config -> responder
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const mensaje = value?.messages?.[0];
    if (!mensaje || mensaje.type !== "text") return;

    // 1) ¿A qué número (clínica) llegó el mensaje?
    const phoneNumberId = value?.metadata?.phone_number_id;
    const clinica = await buscarClinica(phoneNumberId);
    if (!clinica) { console.error("⚠️ Mensaje de un número sin clínica:", phoneNumberId); return; }

    const textoPaciente = mensaje.text.body;
    const numeroPaciente = mensaje.from;
    const hoy = new Date().toISOString().slice(0, 10);
    console.log(`📩 [${clinica.nombre_clinica}] ${textoPaciente}`);

    // 2) Montamos el contexto con la personalidad DE ESA CLÍNICA
    const historial = await leerHistorial(numeroPaciente, clinica.id);
    const systemPrompt = (clinica.personalidad || "Eres la recepcionista de una clínica.")
      + `\nTe llamas ${clinica.nombre_bot}. La clínica es ${clinica.nombre_clinica}. Hoy es ${hoy}.`;
    const messages = [
      { role: "system", content: systemPrompt },
      ...historial,
      { role: "user", content: textoPaciente }
    ];
    await guardarMensaje(numeroPaciente, "user", textoPaciente, clinica.id);

    // 3) IA con herramientas (bucle de function calling)
    let respuesta = await openai.chat.completions.create({ model: "gpt-4o-mini", messages, tools: TOOLS });
    let msg = respuesta.choices[0].message;
    let vueltas = 0;
    while (msg.tool_calls && vueltas < 3) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        const resultado = await ejecutarHerramienta(call.function.name, args, numeroPaciente, clinica);
        console.log("🔧", call.function.name, args, "->", resultado);
        messages.push({ role: "tool", tool_call_id: call.id, content: resultado });
      }
      respuesta = await openai.chat.completions.create({ model: "gpt-4o-mini", messages, tools: TOOLS });
      msg = respuesta.choices[0].message;
      vueltas++;
    }

    const textoRespuesta = msg.content || "Perdona, ¿me lo repites? 🙂";
    console.log(`🤖 [${clinica.nombre_clinica}] ${textoRespuesta}`);
    await guardarMensaje(numeroPaciente, "assistant", textoRespuesta, clinica.id);

    // 4) Responder con el TOKEN Y NÚMERO DE ESA CLÍNICA
    await axios.post(
      `https://graph.facebook.com/v21.0/${clinica.phone_number_id}/messages`,
      { messaging_product: "whatsapp", to: numeroPaciente, text: { body: textoRespuesta } },
      { headers: { Authorization: `Bearer ${clinica.whatsapp_token}` } }
    );
    console.log("✅ Enviado");
  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
  }
});

app.listen(3000, () => console.log("Servidor multi-clínica despierto en el puerto 3000"));