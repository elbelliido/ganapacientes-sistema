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
// ============================================================
//  DASHBOARD MULTI-CLÍNICA + LOGIN
//  Pega esto en servidor.js ANTES de app.listen(...)
//  Uso: /dashboard?clave=TU_CLAVE&clinica=1
// ============================================================

// Login sencillo para el dashboard
app.use("/dashboard", (req, res, next) => {
  if (req.query.clave === process.env.DASHBOARD_CLAVE) return next();
  res.status(401).send("Acceso restringido. Añade ?clave=... a la URL");
});

app.get("/dashboard", async (req, res) => {
  const clinicaId = Number(req.query.clinica || 1); // qué clínica ver

  // Datos SOLO de esa clínica
  const [cli, pac, cit, dor] = await Promise.all([
    supabase.from("clinicas").select("*").eq("id", clinicaId).single(),
    supabase.from("pacientes").select("*").eq("clinica_id", clinicaId),
    supabase.from("citas").select("*").eq("clinica_id", clinicaId),
    supabase.from("dormidos").select("*").eq("clinica_id", clinicaId)
  ]);
  const clinica = cli.data || { nombre_clinica: "Clínica" };
  const pacientes = pac.data || [], citas = cit.data || [], dormidos = dor.data || [];

  const contactados = dormidos.filter(d => d.estado !== "pendiente").length;
  const recArr = dormidos.filter(d => d.estado === "recuperado");
  const eurosRec = recArr.reduce((s, d) => s + Number(d.importe || 0), 0);
  const potencial = dormidos.filter(d => d.estado !== "recuperado").reduce((s, d) => s + Number(d.importe || 0), 0);

  const clave = req.query.clave;
  const filasCitas = citas.map(c => `<tr><td>${c.nombre||"-"}</td><td>${c.fecha||"-"}</td><td>${c.hora||"-"}</td><td>${c.estado||"-"}</td></tr>`).join("") || `<tr><td colspan="4">Sin citas</td></tr>`;
  const filasDor = dormidos.map(d => `<tr><td>${d.nombre||"-"}</td><td>${d.tratamiento||"-"}</td><td>${Number(d.importe||0)} €</td><td><span class="badge ${d.estado}">${d.estado}</span></td></tr>`).join("") || `<tr><td colspan="4">Sin dormidos</td></tr>`;

  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Panel · ${clinica.nombre_clinica}</title><style>
    :root{--tinta:#16212E;--tinta2:#1E2C3B;--hueso:#FAF7F2;--ambar:#E8A24A;--bruma:#9AA3AE;--borde:#E7E0D6}
    *{box-sizing:border-box;margin:0;font-family:system-ui,sans-serif}
    body{background:var(--hueso);color:var(--tinta);padding:2rem;max-width:1100px;margin:0 auto}
    h1{font-size:1.6rem}.sub{color:var(--bruma);margin-bottom:2rem}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2.5rem}
    .card{background:#fff;border:1px solid var(--borde);border-radius:14px;padding:1.4rem}
    .card .n{font-size:2rem;font-weight:700}.card .l{color:var(--bruma);font-size:.85rem;margin-top:.2rem}
    .card.euros{background:var(--tinta);color:#fff;border:none}.card.euros .n{color:var(--ambar)}
    .cascada{background:#fff;border:1px solid var(--borde);border-radius:14px;padding:1.4rem;margin-bottom:2.5rem}
    .paso{display:flex;justify-content:space-between;padding:.6rem 0;border-bottom:1px solid #f0ece4}.paso span{color:var(--bruma)}
    h2{font-size:1.1rem;margin:1.5rem 0 .8rem}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;border:1px solid var(--borde)}
    th,td{padding:.7rem 1rem;text-align:left;border-bottom:1px solid #f0ece4;font-size:.9rem}th{background:var(--tinta2);color:#fff}
    .badge{padding:.2rem .6rem;border-radius:99px;font-size:.75rem;font-weight:600}
    .badge.pendiente{background:#FFF4E8;color:#C45A0C}.badge.contactado{background:#EEF2FF;color:#1847ED}.badge.recuperado{background:#EDFAF4;color:#0B7A5A}
    .switch{margin-bottom:1.5rem}.switch a{color:var(--bruma);text-decoration:none;margin-right:1rem;font-size:.85rem}
  </style></head><body>
    <h1>${clinica.nombre_clinica}</h1><p class="sub">Panel de resultados · en tiempo real</p>
    <div class="cards">
      <div class="card euros"><div class="n">${eurosRec} €</div><div class="l">Ingresos recuperados</div></div>
      <div class="card"><div class="n">${potencial} €</div><div class="l">Valor potencial en curso</div></div>
      <div class="card"><div class="n">${pacientes.length}</div><div class="l">Pacientes</div></div>
      <div class="card"><div class="n">${citas.length}</div><div class="l">Citas</div></div>
    </div>
    <div class="cascada"><h2 style="margin-top:0">Recuperación · la cascada</h2>
      <div class="paso"><b>En la lista</b><span>${dormidos.length}</span></div>
      <div class="paso"><b>Contactados</b><span>${contactados}</span></div>
      <div class="paso"><b>Recuperados</b><span>${recArr.length}</span></div>
      <div class="paso"><b>€ confirmados</b><span>${eurosRec} €</span></div>
    </div>
    <h2>Citas</h2><table><tr><th>Paciente</th><th>Fecha</th><th>Hora</th><th>Estado</th></tr>${filasCitas}</table>
    <h2>Ingresos Dormidos</h2><table><tr><th>Paciente</th><th>Tratamiento</th><th>Importe</th><th>Estado</th></tr>${filasDor}</table>
  </body></html>`);
});

app.listen(3000, () => console.log("Servidor multi-clínica despierto en el puerto 3000"));