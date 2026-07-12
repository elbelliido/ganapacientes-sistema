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
//  11. CINTURONES DE RESERVA: si la IA consulta huecos de un día
//      pero intenta reservar en otro, el servidor corrige la fecha;
//      y verifica que la hora sigue libre justo antes de reservar.
//  12. NATURALIDAD (v3): doble check azul + indicador "escribiendo",
//      agrupación de mensajes en ráfaga (buffer de 6s), pausa humana
//      proporcional a la longitud, respuestas partidas en 2 globos
//      (separador ||) y modelo GPT-4o completo para la clínica DEMO.
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
//  NATURALIDAD: utilidades
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

// La demo usa el modelo grande (volumen mínimo, máxima naturalidad);
// producción sigue en mini (económico). Si algún día añades una
// columna "modelo" a la tabla clinicas, tendrá prioridad.
function elegirModelo(clinica) {
  if (clinica.modelo) return clinica.modelo;
  return clinica.nombre_clinica.includes("DEMO") ? "gpt-4o" : "gpt-4o-mini";
}

// Doble check azul + "escribiendo…" en el WhatsApp del paciente.
// Meta lo permite marcando el mensaje entrante como leído con
// typing_indicator. El indicador dura hasta 25s o hasta que respondemos.
async function marcarLeidoYEscribiendo(clinica, messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${clinica.phone_number_id}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId,
        typing_indicator: { type: "text" } },
      { headers: { Authorization: `Bearer ${clinica.whatsapp_token}` } }
    );
  } catch (e) { /* no es crítico: si falla, seguimos sin indicador */ }
}

// ============================================================
//  BUFFER DE RÁFAGAS: la gente escribe "Hola" / "quiero cita" /
//  "para limpieza" en 3 mensajes seguidos. En vez de contestar a
//  cada uno (efecto metralleta), esperamos unos segundos y
//  respondemos a todo junto, como haría una persona.
// ============================================================
const ESPERA_AGRUPACION_MS = 6000;
const bufferRafagas = new Map(); // clave `${clinicaId}-${telefono}` → { textos, timer }

function encolarMensaje(clinica, telefono, texto) {
  const clave = `${clinica.id}-${telefono}`;
  const previo = bufferRafagas.get(clave);
  if (previo) {
    clearTimeout(previo.timer);
    previo.textos.push(texto);
    // Techo de seguridad: si acumula 5, procesamos ya
    if (previo.textos.length >= 5) {
      bufferRafagas.delete(clave);
      procesarTextoPaciente(clinica, telefono, previo.textos.join("\n"));
      return;
    }
    previo.timer = setTimeout(() => {
      bufferRafagas.delete(clave);
      procesarTextoPaciente(clinica, telefono, previo.textos.join("\n"));
    }, ESPERA_AGRUPACION_MS);
  } else {
    const entrada = { textos: [texto], timer: null };
    entrada.timer = setTimeout(() => {
      bufferRafagas.delete(clave);
      procesarTextoPaciente(clinica, telefono, entrada.textos.join("\n"));
    }, ESPERA_AGRUPACION_MS);
    bufferRafagas.set(clave, entrada);
  }
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
//  CINTURÓN DE SEGURIDAD DE RESERVAS
//  Última consulta de huecos por conversación (clínica+teléfono).
//  Si la IA consulta huecos del día X pero luego intenta reservar
//  en el día Y, corregimos la fecha automáticamente.
// ============================================================
const ultimaConsulta = new Map(); // clave: `${clinicaId}-${telefono}` → { fecha, huecos }

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

async function enviarPlantilla(clinica, telefono, nombrePlantilla, parametros = [], idioma = "es") {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${clinica.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: telefono,
        type: "template",
        template: {
          name: nombrePlantilla,
          language: { code: idioma },
          components: parametros.length
            ? [{ type: "body", parameters: parametros.map(p => ({ type: "text", text: String(p) })) }]
            : []
        }
      },
      { headers: { Authorization: `Bearer ${clinica.whatsapp_token}` } }
    );
    return true;
  } catch (e) {
    const err = e.response?.data?.error;
    // Si no existe en "es", probamos "es_ES" (español de España) una vez
    if (err?.code === 132001 && idioma === "es") {
      return enviarPlantilla(clinica, telefono, nombrePlantilla, parametros, "es_ES");
    }
    console.error(`   ❌ Plantilla ${nombrePlantilla} [${idioma}] → ${telefono}:`, JSON.stringify(err?.message || e.message));
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
  const clave = `${clinica.id}-${telefono}`;

  if (nombre === "consultarHuecos") {
    const huecos = await consultarHuecos(args.fecha, clinica);
    // Recordamos qué fecha se consultó y qué huecos había
    ultimaConsulta.set(clave, { fecha: args.fecha, huecos });
    if (ultimaConsulta.size > 500) {
      // limpieza para que no crezca sin límite
      const primera = ultimaConsulta.keys().next().value;
      ultimaConsulta.delete(primera);
    }
    return JSON.stringify({ fecha: args.fecha, huecosLibres: huecos });
  }

  if (nombre === "reservarCita") {
    let fecha = args.fecha;
    const previa = ultimaConsulta.get(clave);

    // 🛡️ CINTURÓN 1 — fecha cambiada: si la IA consultó huecos de una
    // fecha pero intenta reservar en OTRA, y la hora elegida estaba en
    // la lista consultada, la fecha buena es la consultada.
    if (previa && fecha !== previa.fecha && previa.huecos.includes(args.hora)) {
      console.log(`🛡️ Fecha corregida: la IA pidió ${fecha}, la consulta fue ${previa.fecha}`);
      fecha = previa.fecha;
    }

    // 🛡️ CINTURÓN 2 — verificación final: la hora debe seguir libre
    // en la fecha definitiva justo antes de reservar.
    const libresAhora = await consultarHuecos(fecha, clinica);
    if (!libresAhora.includes(args.hora)) {
      return JSON.stringify({
        reservado: false,
        motivo: "hora_no_disponible",
        fecha,
        huecosLibres: libresAhora
      });
    }

    const r = await reservarCita(fecha, args.hora, args.nombre, telefono, clinica);
    return JSON.stringify({ reservado: r.ok, fecha, hora: args.hora });
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
7. Usa emojis con moderación: uno por mensaje como mucho, y no en todos los mensajes.
8. Nunca reveles que eres una IA salvo que te lo pregunten directamente; en ese caso, dilo con honestidad y naturalidad.

CÓMO SONAR HUMANA (tan importante como el resto)
- Adapta la LONGITUD al mensaje recibido: a un "ok" o "gracias" se responde con 2-5 palabras ("¡Genial!", "A ti 😊"), no con un párrafo.
- Varía tus arranques: no empieces dos mensajes seguidos con la misma palabra ni uses siempre "¡Hola!" o "¡Perfecto!".
- No termines todos los mensajes con una pregunta; solo pregunta cuando haga falta de verdad.
- Si el paciente escribe con faltas, abreviado o confuso, interpreta la intención con naturalidad y responde sin corregirle jamás.
- Si el paciente mezcla varias cosas en un mensaje, respóndelas todas en orden, sin ignorar ninguna.
- Puedes usar muletillas suaves y cercanas de recepcionista real ("claro", "sin problema", "ahora te miro eso") cuando encajen.
- Si un mensaje no tiene nada que ver con la clínica, síguele la corriente con simpatía UNA frase y reconduce con gracia.
- OPCIONAL: si la respuesta queda más natural en dos globos (por ejemplo, una confirmación corta y luego el detalle), sepárala con || — el sistema la enviará como dos mensajes. Úsalo como mucho una vez por respuesta y solo cuando realmente suene mejor.`;
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
// ============================================================
//  PROCESADO DE UN TEXTO DE PACIENTE (ya agrupado por el buffer)
//  Memoria → IA (con herramientas) → pausa humana → envío
//  (partido en dos globos si la IA usó el separador ||)
// ============================================================
async function procesarTextoPaciente(clinica, numeroPaciente, textoPaciente) {
  try {
    console.log(`📩 [${clinica.nombre_clinica}] ${numeroPaciente}: ${textoPaciente.replace(/\n/g, " | ")}`);

    // Contexto: personalidad + reglas + memoria de la conversación
    const historial = await leerHistorial(numeroPaciente, clinica.id);
    const messages = [
      { role: "system", content: construirSystemPrompt(clinica) },
      ...historial,
      { role: "user", content: textoPaciente }
    ];
    await guardarMensaje(numeroPaciente, "user", textoPaciente, clinica.id);

    // IA con herramientas (bucle de function calling)
    const modelo = elegirModelo(clinica);
    let respuesta = await openai.chat.completions.create({ model: modelo, messages, tools: TOOLS });
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
      respuesta = await openai.chat.completions.create({ model: modelo, messages, tools: TOOLS });
      msg = respuesta.choices[0].message;
      vueltas++;
    }

    const textoRespuesta = msg.content || "Perdona, ¿me lo repites? 🙂";
    console.log(`🤖 [${clinica.nombre_clinica}] (${modelo}) ${textoRespuesta}`);
    await guardarMensaje(numeroPaciente, "assistant", textoRespuesta, clinica.id);

    // Pausa humana: nadie teclea una respuesta larga en 2 segundos.
    // Proporcional a la longitud, con techo para no exasperar.
    await sleep(Math.min(900 + textoRespuesta.length * 22, 4000));

    // Globos partidos: si la IA usó ||, enviamos dos mensajes con
    // una pequeña pausa entre ellos (como quien sigue tecleando).
    const partes = textoRespuesta.split("||").map(p => p.trim()).filter(Boolean);
    for (let i = 0; i < partes.length && i < 3; i++) {
      if (i > 0) await sleep(Math.min(700 + partes[i].length * 20, 2500));
      await enviarWhatsAppTexto(clinica, numeroPaciente, partes[i]);
    }
    console.log("✅ Enviado");
  } catch (error) {
    console.error("❌ Error procesando texto:", error.response?.data || error.message);
  }
}

// ============================================================
//  WEBHOOK 2) Recibir → identificar clínica → RGPD → buffer → IA
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

    // 2) Naturalidad: doble check azul + "escribiendo…" al instante
    if (mensaje.id) marcarLeidoYEscribiendo(clinica, mensaje.id);

    // 3) Mensajes que no son texto (audio, foto, ubicación...)
    if (mensaje.type !== "text") {
      await sleep(1200);
      await enviarWhatsAppTexto(clinica, numeroPaciente,
        `¡Hola! Soy ${clinica.nombre_bot}, de ${clinica.nombre_clinica} 🙂 De momento solo puedo leer mensajes de texto. ¿Me lo escribes?`);
      return;
    }

    const textoPaciente = mensaje.text.body;

    // ========================================================
    // 4) RGPD: OPT-OUT. Se comprueba mensaje a mensaje (sin
    //    esperar al buffer) y corta cualquier ráfaga pendiente.
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
      // Cortar cualquier ráfaga pendiente de este paciente
      const clave = `${clinica.id}-${numeroPaciente}`;
      const pendiente = bufferRafagas.get(clave);
      if (pendiente) { clearTimeout(pendiente.timer); bufferRafagas.delete(clave); }

      await supabase.from("dormidos")
        .update({ estado: "baja" })
        .eq("telefono", numeroPaciente)
        .eq("clinica_id", clinica.id);

      await guardarMensaje(numeroPaciente, "user", textoPaciente, clinica.id);
      await guardarMensaje(numeroPaciente, "assistant", "[BAJA RGPD confirmada]", clinica.id);

      await enviarWhatsAppTexto(clinica, numeroPaciente,
        "Entendido, no volverás a recibir mensajes nuestros. Si algún día cambias de opinión, escríbenos por aquí. Un saludo 🙂");
      console.log(`🛑 [${clinica.nombre_clinica}] Baja RGPD: ${numeroPaciente}`);
      return;
    }

    // 5) A la cola de ráfagas: si escriben varios mensajes seguidos,
    //    se agrupan y se responde a todo junto (como una persona).
    encolarMensaje(clinica, numeroPaciente, textoPaciente);
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
//  DASHBOARD v2 · GANAPACIENTES
// ============================================================

app.get("/dashboard", async (req, res) => {
  const clinicaId = Number(req.query.clinica || 1);

  const [cli, cit, dor, conv] = await Promise.all([
    supabase.from("clinicas").select("*").eq("id", clinicaId).single(),
    supabase.from("citas").select("*").eq("clinica_id", clinicaId).order("fecha", { ascending: true }).order("hora", { ascending: true }),
    supabase.from("dormidos").select("*").eq("clinica_id", clinicaId),
    supabase.from("conversaciones").select("telefono").eq("clinica_id", clinicaId)
  ]);
  const clinica = cli.data || { nombre_clinica: "Clínica" };
  const citas = cit.data || [], dormidos = dor.data || [];

  // Conversaciones = teléfonos únicos que han hablado con el bot (dato REAL,
  // sustituye a la antigua tarjeta "Pacientes" que leía una tabla vacía)
  const conversaciones = new Set((conv.data || []).map(c => c.telefono)).size;

  // Cascada honesta (las bajas RGPD se cuentan aparte, nunca se maquillan)
  const bajas = dormidos.filter(d => d.estado === "baja");
  const activos = dormidos.filter(d => d.estado !== "baja");
  const contactados = activos.filter(d => d.estado !== "pendiente").length;
  const recArr = activos.filter(d => d.estado === "recuperado");
  const eurosRec = recArr.reduce((s, d) => s + Number(d.importe || 0), 0);
  const potencial = activos.filter(d => d.estado !== "recuperado").reduce((s, d) => s + Number(d.importe || 0), 0);

  // Anchos del funnel (relativos al total de la lista)
  const pct = n => activos.length ? Math.max(Math.round(n / activos.length * 100), n > 0 ? 8 : 0) : 0;

  // Citas: separamos próximas y pasadas
  const hoy = hoyMadrid();
  const proximas = citas.filter(c => (c.fecha || "") >= hoy);
  const pasadas = citas.filter(c => (c.fecha || "") < hoy).reverse();

  const fmtFecha = f => {
    if (!f) return "—";
    const d = new Date(f + "T12:00:00");
    return d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
  };
  const fmtEuros = n => n.toLocaleString("es-ES") + " €";

  const filaCita = c => `<tr><td>${c.nombre || "—"}</td><td>${fmtFecha(c.fecha)}</td><td>${c.hora || "—"}</td><td><span class="chip ok">${c.estado || "reservada"}</span></td></tr>`;
  const filasProximas = proximas.map(filaCita).join("") || `<tr><td colspan="4" class="vacio">Sin citas próximas — cuando Lucía reserve, aparecerán aquí</td></tr>`;
  const filasPasadas = pasadas.slice(0, 10).map(filaCita).join("");

  const filasDor = dormidos
    .sort((a, b) => Number(b.importe || 0) - Number(a.importe || 0))
    .map(d => `<tr><td>${d.nombre || "—"}</td><td>${d.tratamiento || "—"}</td><td class="num">${fmtEuros(Number(d.importe || 0))}</td><td><span class="chip ${d.estado}">${d.estado}</span></td></tr>`)
    .join("") || `<tr><td colspan="4" class="vacio">Sin pacientes en la lista — impórtalos con el botón «Importar CSV»</td></tr>`;

  const clave = encodeURIComponent(req.query.clave);
  const fechaHoy = new Date().toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", year: "numeric" });

  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Panel · ${clinica.nombre_clinica}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root{
      --tinta:#16212E; --tinta2:#1E2C3B; --hueso:#FAF7F2; --hueso2:#F2EDE4;
      --ambar:#E8A24A; --ambar-osc:#B57724; --bruma:#9AA3AE; --borde:#E7E0D6;
      --verde:#0B7A5A; --verde-bg:#EDFAF4; --azul:#1847ED; --azul-bg:#EEF2FF;
      --naranja:#C45A0C; --naranja-bg:#FFF4E8; --rojo:#C42B2B; --rojo-bg:#FEF2F2;
    }
    *{box-sizing:border-box;margin:0}
    body{background:var(--hueso);color:var(--tinta);font-family:Inter,system-ui,sans-serif;padding:2.2rem 1.4rem;max-width:1100px;margin:0 auto}
    h1,h2{font-family:Fraunces,serif}

    /* Cabecera */
    header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem;margin-bottom:2rem}
    .marca{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ambar-osc);font-weight:700;margin-bottom:.35rem}
    h1{font-size:2rem;font-weight:700;letter-spacing:-.01em}
    .sub{color:var(--bruma);font-size:.85rem;margin-top:.3rem;text-transform:capitalize}
    .acciones{display:flex;gap:.6rem}
    .btn{display:inline-block;text-decoration:none;padding:.65rem 1.2rem;border-radius:12px;font-size:.85rem;font-weight:600;transition:transform .15s,box-shadow .15s}
    .btn:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(22,33,46,.14)}
    .btn.sec{background:#fff;color:var(--tinta);border:1px solid var(--borde)}
    .btn.pri{background:var(--ambar);color:var(--tinta)}

    /* Tarjetas KPI */
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.4rem}
    .card{background:#fff;border:1px solid var(--borde);border-radius:18px;padding:1.5rem 1.4rem;position:relative;overflow:hidden}
    .card .n{font-family:Fraunces,serif;font-size:2.3rem;font-weight:700;letter-spacing:-.02em;line-height:1}
    .card .l{color:var(--bruma);font-size:.8rem;margin-top:.55rem;font-weight:500}
    .card.euros{background:linear-gradient(135deg,var(--tinta) 0%,var(--tinta2) 100%);color:#fff;border:none}
    .card.euros .n{color:var(--ambar)}
    .card.euros::after{content:"";position:absolute;right:-30px;top:-30px;width:110px;height:110px;border-radius:50%;background:rgba(232,162,74,.12)}
    .card.euros .l{color:rgba(255,255,255,.65)}

    /* Secciones */
    section{background:#fff;border:1px solid var(--borde);border-radius:18px;padding:1.6rem;margin-bottom:1.4rem}
    h2{font-size:1.15rem;font-weight:600;margin-bottom:1.1rem}
    .hint{color:var(--bruma);font-size:.78rem;font-weight:400;margin-left:.5rem;font-family:Inter}

    /* Funnel */
    .fila-funnel{display:grid;grid-template-columns:130px 1fr 60px;align-items:center;gap:1rem;padding:.45rem 0}
    .fila-funnel .et{font-size:.85rem;font-weight:600}
    .pista{background:var(--hueso2);border-radius:99px;height:22px;overflow:hidden}
    .barra{height:100%;border-radius:99px;transition:width .6s ease}
    .barra.b1{background:var(--bruma)} .barra.b2{background:var(--azul)} .barra.b3{background:var(--verde)}
    .fila-funnel .num{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
    .euros-linea{display:flex;justify-content:space-between;border-top:1px solid var(--hueso2);margin-top:.9rem;padding-top:.9rem;font-size:.9rem}
    .euros-linea b{color:var(--verde)}

    /* Tablas */
    table{width:100%;border-collapse:collapse}
    th{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--bruma);text-align:left;padding:.5rem .8rem;border-bottom:2px solid var(--hueso2);font-weight:600}
    td{padding:.75rem .8rem;border-bottom:1px solid var(--hueso2);font-size:.88rem}
    tr:last-child td{border-bottom:none}
    tbody tr:hover td{background:var(--hueso)}
    td.num{font-variant-numeric:tabular-nums;font-weight:600}
    td.vacio{color:var(--bruma);font-style:italic;text-align:center;padding:1.6rem}
    .chip{padding:.22rem .7rem;border-radius:99px;font-size:.72rem;font-weight:700}
    .chip.ok,.chip.recuperado{background:var(--verde-bg);color:var(--verde)}
    .chip.pendiente{background:var(--naranja-bg);color:var(--naranja)}
    .chip.contactado{background:var(--azul-bg);color:var(--azul)}
    .chip.baja{background:var(--rojo-bg);color:var(--rojo)}
    details{margin-top:.8rem}
    summary{cursor:pointer;color:var(--bruma);font-size:.82rem;font-weight:600}

    .rgpd{font-size:.76rem;color:var(--bruma);text-align:center;margin:1.6rem 0 .4rem}
    @media (max-width:640px){
      body{padding:1.2rem .8rem}
      h1{font-size:1.5rem}
      .fila-funnel{grid-template-columns:90px 1fr 44px}
      .acciones{width:100%}.btn{flex:1;text-align:center}
    }
  </style></head><body>
    <header>
      <div>
        <div class="marca">GanaPacientes</div>
        <h1>${clinica.nombre_clinica}</h1>
        <p class="sub">${fechaHoy}</p>
      </div>
      <div class="acciones">
        <a class="btn sec" href="/subir-dormidos?clave=${clave}">Importar CSV</a>
        <a class="btn pri" href="/campana-dormidos?clave=${clave}&clinica=${clinicaId}" onclick="return confirm('Vas a enviar el WhatsApp de reactivación a TODOS los pacientes en estado pendiente de esta clínica. ¿Lanzar la campaña?')">Lanzar campaña</a>
      </div>
    </header>

    <div class="cards">
      <div class="card euros"><div class="n">${fmtEuros(eurosRec)}</div><div class="l">Ingresos recuperados · confirmados</div></div>
      <div class="card"><div class="n">${fmtEuros(potencial)}</div><div class="l">Valor potencial en curso</div></div>
      <div class="card"><div class="n">${conversaciones}</div><div class="l">Conversaciones con Lucía</div></div>
      <div class="card"><div class="n">${citas.length}</div><div class="l">Citas reservadas</div></div>
    </div>

    <section>
      <h2>Recuperación · la cascada <span class="hint">de la lista al sillón, sin maquillaje</span></h2>
      <div class="fila-funnel"><span class="et">En la lista</span><div class="pista"><div class="barra b1" style="width:${activos.length ? 100 : 0}%"></div></div><span class="num">${activos.length}</span></div>
      <div class="fila-funnel"><span class="et">Contactados</span><div class="pista"><div class="barra b2" style="width:${pct(contactados)}%"></div></div><span class="num">${contactados}</span></div>
      <div class="fila-funnel"><span class="et">Recuperados</span><div class="pista"><div class="barra b3" style="width:${pct(recArr.length)}%"></div></div><span class="num">${recArr.length}</span></div>
      <div class="euros-linea"><span>€ confirmados (solo pacientes que han reservado)</span><b>${fmtEuros(eurosRec)}</b></div>
    </section>

    <section>
      <h2>Próximas citas</h2>
      <table><thead><tr><th>Paciente</th><th>Fecha</th><th>Hora</th><th>Estado</th></tr></thead>
      <tbody>${filasProximas}</tbody></table>
      ${filasPasadas ? `<details><summary>Ver citas pasadas (${pasadas.length})</summary><table><tbody>${filasPasadas}</tbody></table></details>` : ""}
    </section>

    <section>
      <h2>Ingresos Dormidos <span class="hint">ordenados por importe</span></h2>
      <table><thead><tr><th>Paciente</th><th>Tratamiento</th><th>Importe</th><th>Estado</th></tr></thead>
      <tbody>${filasDor}</tbody></table>
    </section>

    <p class="rgpd">${bajas.length} paciente(s) han ejercido su derecho de baja y no volverán a ser contactados (RGPD) · Panel GanaPacientes</p>
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
//  FORMULARIOS INTELIGENTES · MODELO B
//  Qué hace: la web de la clínica envía nombre + teléfono + interés
//  a POST /formulario con el ID de la clínica. El sistema:
//   1. Valida y guarda el lead en la tabla `pacientes`.
//   2. Lucía escribe PRIMERO al lead por WhatsApp (plantilla
//      `bienvenida_lead`, necesaria porque fuera de la ventana de
//      24h Meta no permite texto libre).
//   3. Guarda ese primer mensaje en `conversaciones`, de modo que
//      cuando el lead responda, Lucía tenga el contexto ("me
//      interesaba el implante") y siga la conversación con memoria.
// ============================================================

// CORS: la web de la clínica está en otro dominio, así que el
// navegador exige estos permisos para poder enviar el formulario.
app.options("/formulario", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.sendStatus(204);
});

app.post("/formulario", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const { clinica_id, nombre, telefono, interes, empresa } = req.body || {};

    // Anti-spam (honeypot): el campo "empresa" está oculto en el HTML.
    // Los humanos no lo ven; los bots de spam lo rellenan. Si llega
    // con contenido, respondemos OK (para no dar pistas) y descartamos.
    if (empresa) return res.json({ ok: true });

    // Validaciones
    const clinicaId = parseInt(clinica_id);
    if (!clinicaId) return res.status(400).json({ ok: false, error: "Falta clinica_id" });
    if (!nombre || !nombre.trim()) return res.status(400).json({ ok: false, error: "Falta el nombre" });

    let tel = (telefono || "").replace(/[\s\-\.]/g, "").replace(/^\+?34/, "");
    if (!/^[6789]\d{8}$/.test(tel)) return res.status(400).json({ ok: false, error: "Teléfono no válido" });
    tel = "34" + tel;

    // La clínica debe existir y estar activa
    const { data: clinica } = await supabase
      .from("clinicas").select("*").eq("id", clinicaId).eq("activa", true).single();
    if (!clinica) return res.status(404).json({ ok: false, error: "Clínica no encontrada" });

    // RGPD: si este teléfono pidió la baja en esta clínica, no le escribimos
    const { data: enBaja } = await supabase
      .from("dormidos").select("id").eq("telefono", tel)
      .eq("clinica_id", clinicaId).eq("estado", "baja").limit(1);
    const respetarBaja = (enBaja || []).length > 0;

    // Guardamos el lead en `pacientes`
    await supabase.from("pacientes").insert({
      clinica_id: clinicaId,
      nombre: nombre.trim(),
      telefono: tel,
      interes: (interes || "").trim() || null,
      origen: "formulario_web"
    });
    console.log(`📝 [${clinica.nombre_clinica}] Lead nuevo: ${nombre} (${tel}) — ${interes || "sin interés indicado"}`);

    // Primer contacto de Lucía (plantilla aprobada en Meta)
    if (!respetarBaja) {
      const enviado = await enviarPlantilla(clinica, tel, "bienvenida_lead",
        [nombre.trim().split(" ")[0], clinica.nombre_clinica, (interes || "tu consulta").trim()]);

      if (enviado) {
        // Guardamos el mensaje en la memoria: cuando el lead responda,
        // Lucía sabrá que le escribió primero y por qué.
        await guardarMensaje(tel, "assistant",
          `[Mensaje de bienvenida enviado desde el formulario web. El paciente se llama ${nombre.trim()} y ha indicado interés en: ${interes || "no especificado"}. Continúa la conversación con ese contexto y trata de agendar una cita.]`,
          clinicaId);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Error /formulario:", e.message);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// ============================================================
//  SOLICITUD DE CITA DESDE LA WEB + HUECOS REALES
//  La web pinta la disponibilidad real (GET /huecos) y el paciente
//  SOLICITA una cita (POST /solicitud-cita). Lucía le escribe con
//  la solicitud ya masticada: si el hueco sigue libre lo reserva,
//  y si no, propone alternativas. Todo pasa por el bot.
// ============================================================

// --- Huecos reales de una clínica para una fecha (para pintar el calendario) ---
app.get("/huecos", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const clinicaId = parseInt(req.query.clinica);
    const fecha = req.query.fecha; // AAAA-MM-DD
    if (!clinicaId || !/^\d{4}-\d{2}-\d{2}$/.test(fecha || "")) {
      return res.status(400).json({ ok: false, error: "Parámetros inválidos" });
    }
    const { data: clinica } = await supabase
      .from("clinicas").select("*").eq("id", clinicaId).eq("activa", true).single();
    if (!clinica) return res.status(404).json({ ok: false, error: "Clínica no encontrada" });

    const huecos = await consultarHuecos(fecha, clinica); // la función de siempre (Cal.com)
    res.json({ ok: true, fecha, huecos });
  } catch (e) {
    console.error("Error /huecos:", e.message);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// --- Solicitud de cita: guarda el lead y Lucía escribe primero ---
app.options("/solicitud-cita", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.sendStatus(204);
});

app.post("/solicitud-cita", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const { clinica_id, nombre, telefono, fecha, hora, empresa } = req.body || {};
    if (empresa) return res.json({ ok: true }); // honeypot anti-spam

    const clinicaId = parseInt(clinica_id);
    if (!clinicaId || !nombre || !fecha || !hora) {
      return res.status(400).json({ ok: false, error: "Faltan datos" });
    }
    let tel = (telefono || "").replace(/[\s\-\.]/g, "").replace(/^\+?34/, "");
    if (!/^[6789]\d{8}$/.test(tel)) return res.status(400).json({ ok: false, error: "Teléfono no válido" });
    tel = "34" + tel;

    const { data: clinica } = await supabase
      .from("clinicas").select("*").eq("id", clinicaId).eq("activa", true).single();
    if (!clinica) return res.status(404).json({ ok: false, error: "Clínica no encontrada" });

    // RGPD: si pidió la baja, guardamos el lead pero no escribimos
    const { data: enBaja } = await supabase
      .from("dormidos").select("id").eq("telefono", tel)
      .eq("clinica_id", clinicaId).eq("estado", "baja").limit(1);

    // Guardar el lead
    await supabase.from("pacientes").insert({
      clinica_id: clinicaId, nombre: nombre.trim(), telefono: tel,
      interes: `Solicitud de cita: ${fecha} ${hora}`, origen: "solicitud_web"
    });

    if (!(enBaja || []).length) {
      // Fecha bonita para el mensaje: "jueves 16 de julio a las 10:00"
      const bonita = new Date(fecha + "T12:00:00")
        .toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }) +
        " a las " + hora;

      const enviado = await enviarPlantilla(clinica, tel, "solicitud_cita",
        [nombre.trim().split(" ")[0], clinica.nombre_clinica, bonita]);

      if (enviado) {
        // Contexto para Lucía: cuando el paciente responda, ella remata.
        await guardarMensaje(tel, "assistant",
          `[Solicitud de cita desde la web: ${nombre.trim()} quiere el ${fecha} a las ${hora}. ` +
          `Cuando responda: consulta los huecos de esa fecha con la herramienta. ` +
          `Si la hora sigue libre, confirma y reserva a su nombre. Si está ocupada, ` +
          `propónle las 2-3 horas libres más cercanas de ese día o del siguiente. ` +
          `Ya tienes su nombre: no se lo vuelvas a pedir.]`, clinicaId);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Error /solicitud-cita:", e.message);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// ============================================================
//  ARRANQUE — app.listen SIEMPRE la última línea del archivo.
//  Render inyecta el puerto en process.env.PORT.
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor multi-clínica despierto en el puerto ${PORT}`));