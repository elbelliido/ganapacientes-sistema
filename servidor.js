// ============================================================
//  GANAPACIENTES · MODELO B (MULTI-CLÍNICA) · VERSIÓN MEJORADA
//  Un solo servidor atiende a MUCHAS clínicas.
//  Cada mensaje se identifica por el phone_number_id de destino,
//  y se carga la configuración de ESA clínica desde Supabase.
//
//  MEJORAS DE ESTA VERSIÓN (respecto a la anterior):
//   1. FIX CRÍTICO: el bloque de baja RGPD estaba fuera del webhook
//      y rompía el servidor. Ahora está dentro, en su sitio.
//   2. FIX MEMORIA: leerHistorial cogía los 10 PRIMEROS mensajes de
//      la historia, no los 10 últimos. Ahora coge los últimos.
//   3. FIX ZONA HORARIA: las reservas en Cal.com se creaban con la
//      hora como si fuera UTC (en verano, 2 horas de desfase).
//      Ahora se convierte Madrid → UTC correctamente.
//   4. FECHAS RELATIVAS: el prompt ahora incluye un calendario de
//      los próximos 14 días con su día de la semana, para que la IA
//      no se líe con "el jueves" o "pasado mañana".
//   5. PERSONALIDAD: system prompt profesional con reglas claras
//      (no inventar, no diagnosticar, cuándo derivar a humano).
//   6. ANTI-DUPLICADOS: Meta a veces reenvía el mismo webhook varias
//      veces; ahora se ignoran mensajes ya procesados.
//   7. MENSAJES NO-TEXTO (audio, foto...): antes se ignoraban en
//      silencio; ahora se responde con amabilidad.
//   8. RGPD: opt-out con "baja" + registro en conversaciones.
//   9. CAMPAÑA DORMIDOS multi-clínica recuperada como ruta protegida.
//  10. PUERTO: usa process.env.PORT (lo que Render espera).
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage() }); // los CSV se procesan en memoria

// ============================================================
//  UTILIDADES DE FECHA Y HORA (zona Europe/Madrid)
// ============================================================

// Fecha de hoy en Madrid, formato AAAA-MM-DD
function hoyMadrid() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

// Hora actual en Madrid, formato HH:MM
function horaMadrid() {
  return new Date().toLocaleTimeString("es-ES", {
    timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit"
  });
}

// Convierte "2026-07-09" + "10:30" (hora de Madrid) a un instante UTC
// que Cal.com entiende. Sin esto, en verano las citas salían 2h mal.
function madridAUTC(fecha, hora) {
  // 1) Suponemos que la hora fuera UTC (es solo una primera aproximación)
  const aprox = new Date(`${fecha}T${hora}:00Z`);
  // 2) Miramos qué hora sería esa en Madrid, y la diferencia es el offset
  const enMadrid = new Date(
    aprox.toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).replace(" ", "T") + "Z"
  );
  const offsetMs = enMadrid.getTime() - aprox.getTime(); // +1h o +2h según la época
  // 3) Restamos el offset: ese es el instante UTC real
  return new Date(aprox.getTime() - offsetMs).toISOString();
}

// Calendario de los próximos 14 días con día de la semana en español.
// Se mete en el prompt para que la IA resuelva bien "el jueves", "mañana"...
function calendarioProximosDias() {
  const lineas = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
    const fecha = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
    const diaSemana = d.toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", weekday: "long" });
    let etiqueta = "";
    if (i === 0) etiqueta = " (HOY)";
    if (i === 1) etiqueta = " (MAÑANA)";
    if (i === 2) etiqueta = " (PASADO MAÑANA)";
    lineas.push(`- ${diaSemana} ${fecha}${etiqueta}`);
  }
  return lineas.join("\n");
}

// ============================================================
//  ANTI-DUPLICADOS: Meta reenvía webhooks si tardamos en responder.
//  Guardamos los últimos IDs de mensaje procesados en memoria.
// ============================================================
const mensajesProcesados = new Set();
function yaProcesado(idMensaje) {
  if (mensajesProcesados.has(idMensaje)) return true;
  mensajesProcesados.add(idMensaje);
  // Limpieza: que el Set no crezca sin límite
  if (mensajesProcesados.size > 1000) {
    const primeros = [...mensajesProcesados].slice(0, 500);
    primeros.forEach(id => mensajesProcesados.delete(id));
  }
  return false;
}

// ============================================================
//  ENVÍO DE WHATSAPP (reutilizable: webhook, campañas, bajas...)
// ============================================================
async function enviarWhatsAppTexto(clinica, telefono, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${clinica.phone_number_id}/messages`,
      { messaging_product: "whatsapp", to: telefono, text: { body: texto } },
      { headers: { Authorization: `Bearer ${clinica.whatsapp_token}` } }
    );
    return true;
  } catch (e) {
    console.error(`❌ Error enviando WhatsApp [${clinica.nombre_clinica}]:`, e.response?.data || e.message);
    return false;
  }
}

async function enviarPlantilla(clinica, telefono, nombrePlantilla, parametros = []) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${clinica.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: telefono,
        type: "template",
        template: {
          name: nombrePlantilla,
          language: { code: "es" },
          components: parametros.length
            ? [{ type: "body", parameters: parametros.map(p => ({ type: "text", text: String(p) })) }]
            : []
        }
      },
      { headers: { Authorization: `Bearer ${clinica.whatsapp_token}` } }
    );
    return true;
  } catch (e) {
    console.error(`❌ Error enviando plantilla [${clinica.nombre_clinica}]:`, e.response?.data || e.message);
    return false;
  }
}

// ============================================================
//  IDENTIFICAR LA CLÍNICA por el phone_number_id del mensaje
// ============================================================
async function buscarClinica(phoneNumberId) {
  const { data } = await supabase
    .from("clinicas").select("*")
    .eq("phone_number_id", phoneNumberId)
    .eq("activa", true)
    .single();
  return data; // fila de la clínica, o null si no existe
}

// ============================================================
//  MEMORIA (filtrada por clínica)
//  FIX: antes con ascending+limit(10) se cogían los 10 PRIMEROS
//  mensajes de toda la historia. Ahora: los 10 ÚLTIMOS, en orden.
// ============================================================
async function leerHistorial(telefono, clinicaId) {
  const { data } = await supabase
    .from("conversaciones").select("rol,contenido")
    .eq("telefono", telefono).eq("clinica_id", clinicaId)
    .order("creado", { ascending: false }) // los más recientes primero...
    .limit(10);
  return (data || []).reverse() // ...y los damos la vuelta para orden cronológico
    .map(m => ({ role: m.rol, content: m.contenido }));
}

async function guardarMensaje(telefono, rol, contenido, clinicaId) {
  await supabase.from("conversaciones").insert({ telefono, rol, contenido, clinica_id: clinicaId });
}

// ============================================================
//  AGENDA (Cal.com v2) — recibe la config de la clínica
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
        // FIX zona horaria: convertimos la hora de Madrid a UTC real
        start: madridAUTC(fecha, hora),
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
    description: "Consulta las horas libres de la clínica para una fecha concreta. Úsala SIEMPRE antes de ofrecer horas: nunca inventes disponibilidad.",
    parameters: { type: "object", properties: { fecha: { type: "string", description: "Fecha exacta en formato AAAA-MM-DD. Resuélvela con el calendario del contexto." } }, required: ["fecha"] } } },
  { type: "function", function: { name: "reservarCita",
    description: "Reserva una cita. Úsala SOLO cuando tengas los tres datos confirmados por el paciente: fecha exacta, hora exacta (de las libres) y nombre completo.",
    parameters: { type: "object", properties: {
      fecha: { type: "string", description: "AAAA-MM-DD" },
      hora: { type: "string", description: "HH:MM, una de las horas libres consultadas" },
      nombre: { type: "string", description: "Nombre del paciente tal y como lo ha dado" }
    }, required: ["fecha", "hora", "nombre"] } } }
];

async function ejecutarHerramienta(nombre, args, telefono, clinica) {
  if (nombre === "consultarHuecos") {
    return JSON.stringify({ fecha: args.fecha, huecosLibres: await consultarHuecos(args.fecha, clinica) });
  }
  if (nombre === "reservarCita") {
    const r = await reservarCita(args.fecha, args.hora, args.nombre, telefono, clinica);
    return JSON.stringify({ reservado: r.ok });
  }
  return JSON.stringify({ error: "desconocida" });
}

// ============================================================
//  PERSONALIDAD DEL BOT
//  La base viene de la columna "personalidad" de cada clínica.
//  Aquí añadimos las REGLAS DE OFICIO comunes a todas: son las
//  que evitan que la IA invente, diagnostique o se líe con fechas.
// ============================================================
function construirSystemPrompt(clinica) {
  const base = clinica.personalidad ||
    `Eres la recepcionista virtual de una clínica. Cercana, profesional y resolutiva. Tuteas al paciente con naturalidad y calidez andaluza, sin pasarte de coloquial.`;

  return `${base}

DATOS FIJOS
- Te llamas ${clinica.nombre_bot}. Trabajas en ${clinica.nombre_clinica}.
- Hoy es ${hoyMadrid()} y son las ${horaMadrid()} (hora de Madrid).

CALENDARIO DE REFERENCIA (para resolver fechas como "el jueves" o "pasado mañana"):
${calendarioProximosDias()}
Cuando el paciente diga un día de la semana sin fecha, usa SIEMPRE la próxima ocurrencia según este calendario. Si hay ambigüedad real (p. ej. "el jueves" dicho un jueves), pregunta: "¿Te refieres a hoy o al jueves que viene?".

REGLAS DE ORO (obligatorias)
1. NUNCA inventes horas libres, precios ni tratamientos. Para disponibilidad, usa siempre la herramienta consultarHuecos. Si no sabes un precio o un dato médico, di que lo confirmará el equipo de la clínica en la cita.
2. NUNCA des consejo médico ni diagnósticos. Ante dolor fuerte, sangrado, hinchazón o urgencia, muestra empatía y ofrece la cita más cercana posible o indica que llamen directamente a la clínica.
3. Para reservar necesitas TRES datos: fecha, hora y nombre. Pídelos con naturalidad, no como un formulario. Antes de reservar, confirma en una frase: "Entonces te apunto el [día] a las [hora] a nombre de [nombre], ¿correcto?".
4. Después de reservar con éxito, confirma la cita con día de la semana, fecha y hora, y despídete con calidez.
5. Mensajes CORTOS: esto es WhatsApp. Máximo 3-4 frases por mensaje. Una pregunta cada vez, nunca dos.
6. Si el paciente escribe algo fuera de tu ámbito (facturas, reclamaciones, hablar con el dentista), dile amablemente que se lo pasas al equipo y que le contactarán.
7. Usa emojis con moderación: uno por mensaje como mucho, y solo si encaja.
8. Nunca reveles que eres una IA salvo que te lo pregunten directamente; en ese caso, dilo con honestidad y naturalidad.`;
}

// ============================================================
//  WEBHOOK 1) Verificación (Meta)
// ============================================================
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else res.sendStatus(403);
});

// ============================================================
//  WEBHOOK 2) Recibir → identificar clínica → RGPD → IA → responder
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // respondemos YA a Meta para que no reintente
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const mensaje = value?.messages?.[0];
    if (!mensaje) return;

    // Anti-duplicados: si Meta reenvía el mismo mensaje, lo ignoramos
    if (mensaje.id && yaProcesado(mensaje.id)) {
      console.log("🔁 Mensaje duplicado ignorado:", mensaje.id);
      return;
    }

    // 1) ¿A qué número (clínica) llegó el mensaje?
    const phoneNumberId = value?.metadata?.phone_number_id;
    const clinica = await buscarClinica(phoneNumberId);
    if (!clinica) { console.error("⚠️ Mensaje de un número sin clínica:", phoneNumberId); return; }

    const numeroPaciente = mensaje.from;

    // 2) Mensajes que no son texto (audio, foto, ubicación...):
    //    antes se ignoraban en silencio; ahora respondemos con amabilidad.
    if (mensaje.type !== "text") {
      await enviarWhatsAppTexto(clinica, numeroPaciente,
        `¡Hola! Soy ${clinica.nombre_bot}, de ${clinica.nombre_clinica} 🙂 De momento solo puedo leer mensajes de texto. ¿Me lo escribes?`);
      return;
    }

    const textoPaciente = mensaje.text.body;
    console.log(`📩 [${clinica.nombre_clinica}] ${numeroPaciente}: ${textoPaciente}`);

    // ========================================================
    // 3) RGPD: OPT-OUT. Si el paciente pide no ser contactado,
    //    se marca como "baja", se le confirma, y NO pasa por la IA.
    // ========================================================
    const textoNormalizado = textoPaciente.trim().toLowerCase();
    const pideBaja =
      textoNormalizado === "baja" ||
      textoNormalizado === "stop" ||
      textoNormalizado.includes("no me escribas") ||
      textoNormalizado.includes("no me escribáis") ||
      textoNormalizado.includes("deja de escribirme") ||
      textoNormalizado.includes("dejad de escribirme") ||
      textoNormalizado.includes("no quiero recibir") ||
      textoNormalizado.includes("borra mis datos") ||
      textoNormalizado.includes("dar de baja") ||
      textoNormalizado.includes("darme de baja");

    if (pideBaja) {
      await supabase.from("dormidos")
        .update({ estado: "baja" })
        .eq("telefono", numeroPaciente)
        .eq("clinica_id", clinica.id);

      // Dejamos constancia en el historial (útil si algún día hay reclamación)
      await guardarMensaje(numeroPaciente, "user", textoPaciente, clinica.id);
      await guardarMensaje(numeroPaciente, "assistant", "[BAJA RGPD confirmada]", clinica.id);

      await enviarWhatsAppTexto(clinica, numeroPaciente,
        "Entendido, no volverás a recibir mensajes nuestros. Si algún día cambias de opinión, escríbenos por aquí. Un saludo 🙂");
      console.log(`🛑 [${clinica.nombre_clinica}] Baja RGPD: ${numeroPaciente}`);
      return; // cortamos aquí: no pasa por OpenAI
    }

    // 4) Contexto: personalidad + reglas + memoria de la conversación
    const historial = await leerHistorial(numeroPaciente, clinica.id);
    const messages = [
      { role: "system", content: construirSystemPrompt(clinica) },
      ...historial,
      { role: "user", content: textoPaciente }
    ];
    await guardarMensaje(numeroPaciente, "user", textoPaciente, clinica.id);

    // 5) IA con herramientas (bucle de function calling)
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

    // 6) Responder con el token y número de ESA clínica
    await enviarWhatsAppTexto(clinica, numeroPaciente, textoRespuesta);
    console.log("✅ Enviado");
  } catch (error) {
    console.error("❌ Error webhook:", error.response?.data || error.message);
  }
});

// ============================================================
//  CAMPAÑA DE DORMIDOS (multi-clínica, protegida con clave)
//  Envía la plantilla de reactivación SOLO a los "pendiente"
//  (los "baja" y "recuperado" quedan fuera automáticamente).
//  Uso: /campana-dormidos?clave=TU_CLAVE&clinica=1
// ============================================================
app.get("/campana-dormidos", async (req, res) => {
  if (req.query.clave !== process.env.DASHBOARD_CLAVE) {
    return res.status(401).send("Acceso denegado");
  }
  try {
    const clinicaId = Number(req.query.clinica);
    if (!clinicaId) return res.status(400).send("Falta ?clinica=ID");

    const { data: clinica } = await supabase
      .from("clinicas").select("*").eq("id", clinicaId).eq("activa", true).single();
    if (!clinica) return res.status(404).send("Clínica no encontrada o inactiva");

    // SOLO pendientes: así respetamos bajas y no repetimos contactados
    const { data: dormidos } = await supabase
      .from("dormidos").select("*")
      .eq("clinica_id", clinicaId)
      .eq("estado", "pendiente")
      .limit(200); // techo de seguridad: máx. 200 por campaña

    let enviados = 0, fallidos = 0;
    for (const d of dormidos || []) {
      const ok = await enviarPlantilla(clinica, d.telefono, "reactivacion_presupuesto",
        [d.nombre || "paciente", d.tratamiento || "tu tratamiento"]);
      if (ok) {
        await supabase.from("dormidos").update({ estado: "contactado" }).eq("id", d.id);
        enviados++;
      } else {
        fallidos++;
      }
      // Pequeña pausa entre envíos para no saturar la API de Meta
      await new Promise(r => setTimeout(r, 300));
    }

    res.send(`Campaña [${clinica.nombre_clinica}]: ${enviados} enviados, ${fallidos} fallidos, ${(dormidos || []).length} pendientes procesados.`);
  } catch (e) {
    console.error("Error campaña:", e.message);
    res.status(500).send("Error en la campaña: " + e.message);
  }
});

// ============================================================
//  DASHBOARD MULTI-CLÍNICA + LOGIN
//  Uso: /dashboard?clave=TU_CLAVE&clinica=1
// ============================================================
app.use("/dashboard", (req, res, next) => {
  if (req.query.clave === process.env.DASHBOARD_CLAVE) return next();
  res.status(401).send("Acceso restringido. Añade ?clave=... a la URL");
});

app.get("/dashboard", async (req, res) => {
  const clinicaId = Number(req.query.clinica || 1);

  const [cli, pac, cit, dor] = await Promise.all([
    supabase.from("clinicas").select("*").eq("id", clinicaId).single(),
    supabase.from("pacientes").select("*").eq("clinica_id", clinicaId),
    supabase.from("citas").select("*").eq("clinica_id", clinicaId).order("fecha", { ascending: false }),
    supabase.from("dormidos").select("*").eq("clinica_id", clinicaId)
  ]);
  const clinica = cli.data || { nombre_clinica: "Clínica" };
  const pacientes = pac.data || [], citas = cit.data || [], dormidos = dor.data || [];

  // La cascada honesta: bajas separadas, no maquilladas
  const bajas = dormidos.filter(d => d.estado === "baja");
  const activos = dormidos.filter(d => d.estado !== "baja");
  const contactados = activos.filter(d => d.estado !== "pendiente").length;
  const recArr = activos.filter(d => d.estado === "recuperado");
  const eurosRec = recArr.reduce((s, d) => s + Number(d.importe || 0), 0);
  const potencial = activos.filter(d => d.estado !== "recuperado").reduce((s, d) => s + Number(d.importe || 0), 0);

  const clave = encodeURIComponent(req.query.clave);
  const filasCitas = citas.map(c => `<tr><td>${c.nombre || "-"}</td><td>${c.fecha || "-"}</td><td>${c.hora || "-"}</td><td>${c.estado || "confirmada"}</td></tr>`).join("") || `<tr><td colspan="4">Sin citas todavía</td></tr>`;
  const filasDor = dormidos.map(d => `<tr><td>${d.nombre || "-"}</td><td>${d.tratamiento || "-"}</td><td>${Number(d.importe || 0)} €</td><td><span class="badge ${d.estado}">${d.estado}</span></td></tr>`).join("") || `<tr><td colspan="4">Sin dormidos. Súbelos desde "Importar CSV".</td></tr>`;

  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Panel · ${clinica.nombre_clinica}</title><style>
    :root{--tinta:#16212E;--tinta2:#1E2C3B;--hueso:#FAF7F2;--ambar:#E8A24A;--bruma:#9AA3AE;--borde:#E7E0D6}
    *{box-sizing:border-box;margin:0;font-family:system-ui,sans-serif}
    body{background:var(--hueso);color:var(--tinta);padding:2rem;max-width:1100px;margin:0 auto}
    header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem;margin-bottom:2rem}
    h1{font-size:1.6rem}.sub{color:var(--bruma)}
    .acciones a{display:inline-block;background:var(--tinta);color:#fff;text-decoration:none;padding:.55rem 1rem;border-radius:10px;font-size:.85rem;margin-left:.5rem}
    .acciones a.ambar{background:var(--ambar);color:var(--tinta);font-weight:700}
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
    .badge.pendiente{background:#FFF4E8;color:#C45A0C}.badge.contactado{background:#EEF2FF;color:#1847ED}
    .badge.recuperado{background:#EDFAF4;color:#0B7A5A}.badge.baja{background:#FEF2F2;color:#C42B2B}
    .rgpd{font-size:.8rem;color:var(--bruma);margin-top:2rem}
  </style></head><body>
    <header>
      <div><h1>${clinica.nombre_clinica}</h1><p class="sub">Panel de resultados · en tiempo real</p></div>
      <div class="acciones">
        <a href="/subir-dormidos?clave=${clave}">Importar CSV</a>
        <a class="ambar" href="/campana-dormidos?clave=${clave}&clinica=${clinicaId}" onclick="return confirm('¿Lanzar la campaña de reactivación a todos los pendientes de esta clínica?')">Lanzar campaña</a>
      </div>
    </header>
    <div class="cards">
      <div class="card euros"><div class="n">${eurosRec} €</div><div class="l">Ingresos recuperados</div></div>
      <div class="card"><div class="n">${potencial} €</div><div class="l">Valor potencial en curso</div></div>
      <div class="card"><div class="n">${pacientes.length}</div><div class="l">Pacientes</div></div>
      <div class="card"><div class="n">${citas.length}</div><div class="l">Citas</div></div>
    </div>
    <div class="cascada"><h2 style="margin-top:0">Recuperación · la cascada</h2>
      <div class="paso"><b>En la lista</b><span>${activos.length}</span></div>
      <div class="paso"><b>Contactados</b><span>${contactados}</span></div>
      <div class="paso"><b>Recuperados</b><span>${recArr.length}</span></div>
      <div class="paso"><b>€ confirmados</b><span>${eurosRec} €</span></div>
    </div>
    <h2>Citas</h2><table><tr><th>Paciente</th><th>Fecha</th><th>Hora</th><th>Estado</th></tr>${filasCitas}</table>
    <h2>Ingresos Dormidos</h2><table><tr><th>Paciente</th><th>Tratamiento</th><th>Importe</th><th>Estado</th></tr>${filasDor}</table>
    <p class="rgpd">${bajas.length} paciente(s) han ejercido su derecho de baja y no volverán a ser contactados (RGPD).</p>
  </body></html>`);
});

// ============================================================
//  SUBIDA DE CSV DE DORMIDOS (protegida con clave)
//  Formato: telefono,nombre,tratamiento,importe
// ============================================================
app.get("/subir-dormidos", (req, res) => {
  if (req.query.clave !== process.env.DASHBOARD_CLAVE) {
    return res.status(401).send("Acceso denegado");
  }
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Subir dormidos — GanaPacientes</title>
    <style>
      body{font-family:system-ui,sans-serif;background:#FAF7F2;color:#16212E;display:flex;justify-content:center;padding:60px 20px}
      .card{background:#fff;border-radius:16px;padding:40px;max-width:520px;box-shadow:0 4px 24px rgba(22,33,46,.08)}
      h1{font-size:24px;margin-top:0}
      label{display:block;margin:18px 0 6px;font-weight:600;font-size:14px}
      input{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:15px;box-sizing:border-box}
      button{margin-top:24px;background:#E8A24A;color:#16212E;border:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;width:100%}
      .nota{font-size:13px;color:#666;margin-top:16px;line-height:1.5}
      code{background:#f4f1ea;padding:2px 6px;border-radius:4px}
      a{color:#E8A24A;font-weight:700}
    </style></head><body>
    <div class="card">
      <h1>Subir pacientes dormidos</h1>
      <form action="/subir-dormidos?clave=${encodeURIComponent(req.query.clave)}" method="POST" enctype="multipart/form-data">
        <label>ID de la clínica</label>
        <input type="number" name="clinica_id" required placeholder="Ej: 1">
        <label>Archivo CSV</label>
        <input type="file" name="csv" accept=".csv" required>
        <button type="submit">Subir e importar</button>
      </form>
      <p class="nota">
        Formato: <code>telefono,nombre,tratamiento,importe</code><br>
        Teléfonos españoles de 9 dígitos (el 34 se añade solo).<br>
        Duplicados (mismo teléfono en esa clínica) se ignoran — incluidas las bajas RGPD, que nunca se reimportan.
      </p>
      <p class="nota"><a href="/dashboard?clave=${encodeURIComponent(req.query.clave)}">← Volver al panel</a></p>
    </div></body></html>`);
});

app.post("/subir-dormidos", upload.single("csv"), async (req, res) => {
  if (req.query.clave !== process.env.DASHBOARD_CLAVE) {
    return res.status(401).send("Acceso denegado");
  }
  try {
    const clinicaId = parseInt(req.body.clinica_id);
    if (!clinicaId) return res.status(400).send("Falta el ID de clínica");
    if (!req.file) return res.status(400).send("Falta el archivo CSV");

    const { data: clinica } = await supabase
      .from("clinicas").select("id, nombre_clinica").eq("id", clinicaId).single();
    if (!clinica) return res.status(404).send("No existe ninguna clínica con ese ID");

    const texto = req.file.buffer.toString("utf-8");
    const lineas = texto.split(/\r?\n/).filter(l => l.trim() !== "");

    // ¿La primera línea es cabecera?
    let inicio = 0;
    if (lineas[0] && lineas[0].toLowerCase().includes("telefono")) inicio = 1;

    // Teléfonos ya existentes en esta clínica (incluye bajas: NUNCA se reimportan)
    const { data: existentes } = await supabase
      .from("dormidos").select("telefono").eq("clinica_id", clinicaId);
    const telefonosExistentes = new Set((existentes || []).map(d => d.telefono));

    const validos = [];
    const errores = [];
    let duplicados = 0;

    for (let i = inicio; i < lineas.length; i++) {
      const partes = lineas[i].split(",").map(p => p.trim());
      const [telefonoRaw, nombre, tratamiento, importeRaw] = partes;

      // Teléfono: quitar espacios/guiones/prefijo y validar formato español
      let telefono = (telefonoRaw || "").replace(/[\s\-\.]/g, "").replace(/^\+?34/, "");
      if (!/^[6789]\d{8}$/.test(telefono)) {
        errores.push(`Línea ${i + 1}: teléfono inválido ("${telefonoRaw}")`);
        continue;
      }
      telefono = "34" + telefono; // formato internacional de WhatsApp

      if (!nombre) {
        errores.push(`Línea ${i + 1}: falta el nombre`);
        continue;
      }
      if (telefonosExistentes.has(telefono)) {
        duplicados++;
        continue;
      }
      telefonosExistentes.add(telefono); // evita duplicados dentro del propio CSV

      // Importe: admite "1.200,50", "1200.50", "1200 €"
      let importe = null;
      if (importeRaw) {
        const limpio = importeRaw.replace(/\./g, "").replace(",", ".").replace("€", "").trim();
        const num = parseFloat(limpio);
        if (!isNaN(num)) importe = num;
      }

      validos.push({
        clinica_id: clinicaId,
        telefono, nombre,
        tratamiento: tratamiento || null,
        importe,
        estado: "pendiente"
      });
    }

    if (validos.length > 0) {
      const { error } = await supabase.from("dormidos").insert(validos);
      if (error) throw error;
    }

    const clave = encodeURIComponent(req.query.clave);
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Resultado</title>
      <style>
        body{font-family:system-ui,sans-serif;background:#FAF7F2;color:#16212E;display:flex;justify-content:center;padding:60px 20px}
        .card{background:#fff;border-radius:16px;padding:40px;max-width:520px;box-shadow:0 4px 24px rgba(22,33,46,.08)}
        .ok{color:#0B7A5A;font-size:32px;font-weight:800;margin:0}
        ul{color:#C42B2B;font-size:13px}
        a{color:#E8A24A;font-weight:700}
      </style></head><body>
      <div class="card">
        <p class="ok">${validos.length} importados</p>
        <p><strong>Clínica:</strong> ${clinica.nombre_clinica}<br>
        <strong>Duplicados ignorados:</strong> ${duplicados}<br>
        <strong>Líneas con error:</strong> ${errores.length}</p>
        ${errores.length > 0 ? "<ul>" + errores.slice(0, 20).map(e => `<li>${e}</li>`).join("") + "</ul>" : ""}
        <p><a href="/subir-dormidos?clave=${clave}">← Subir otro CSV</a> · <a href="/dashboard?clave=${clave}&clinica=${clinicaId}">Ver panel</a></p>
      </div></body></html>`);
  } catch (err) {
    console.error("Error subiendo CSV:", err);
    res.status(500).send("Error procesando el CSV: " + err.message);
  }
});

// ============================================================
//  RUTA DE SALUD (para comprobar rápido que el servidor vive)
// ============================================================
app.get("/", (req, res) => {
  res.send("GanaPacientes · servidor multi-clínica activo ✅");
});

// ============================================================
//  ARRANQUE — app.listen SIEMPRE la última línea del archivo.
//  Render inyecta el puerto en process.env.PORT.
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor multi-clínica despierto en el puerto ${PORT}`));