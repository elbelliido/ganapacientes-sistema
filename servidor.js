// ============================================================
//  GANAPACIENTES Â· BOT DE WHATSAPP CON IA + AGENDA + MEMORIA
//  Piezas: WhatsApp (Meta) Â· IA (OpenAI) Â· Agenda (Cal.com v2) Â· Memoria (Supabase)
//  Flujo: paciente escribe -> se recupera su historial -> la IA decide
//         (consultar/reservar en Cal.com) -> responde -> se guarda todo.
//  Comentado en espaÃ±ol para que puedas leerlo y mantenerlo tÃº.
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Cliente de la base de datos (usa la URL y la clave service_role del .env)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ------------------------------------------------------------
//  PERSONALIDAD DE LUCÃA â€” todo lo que pongas aquÃ­, el bot lo obedece
// ------------------------------------------------------------
const PERSONALIDAD = `Eres "LucÃ­a", la recepcionista de la ClÃ­nica Dental Sonrisa. Hablas por WhatsApp con pacientes.

CÃ“MO HABLAS:
- Como una persona real, cÃ¡lida y natural. NUNCA robÃ³tica ni con listas largas.
- Frases cortas, tono de WhatsApp. AlgÃºn emoji suelto, sin abusar.
- No repitas "Â¿en quÃ© puedo ayudarte?". Sigue el hilo de lo que se estÃ¡ hablando.

CITAS (tu tarea principal):
- Para reservar necesitas 3 cosas: dÃ­a, hora y nombre. Ve pidiÃ©ndolas de forma natural, NO como un formulario.
- Cuando alguien pida cita, consulta los huecos con consultarHuecos y ofrece solo 2-3 opciones buenas (no toda la lista).
- EN CUANTO tengas dÃ­a + hora + nombre, reserva INMEDIATAMENTE con reservarCita. No vuelvas a preguntar lo que ya te dijeron.
- Si el paciente te dio parte de los datos en mensajes anteriores, ÃšSALOS, no los pidas otra vez.

REGLAS:
- No inventes precios: di que la primera visita es gratuita y sin compromiso.
- No des diagnÃ³sticos. Ante dolor o urgencia, recomienda venir cuanto antes.
- SÃ© breve. Esto es WhatsApp, no un email.`;

// ============================================================
//  MEMORIA (Supabase): leer y guardar el historial de cada paciente
// ============================================================

// Lee los Ãºltimos 10 mensajes de ese paciente, para que la IA "recuerde" la conversaciÃ³n
async function leerHistorial(telefono) {
  const { data } = await supabase
    .from("conversaciones")
    .select("rol,contenido")
    .eq("telefono", telefono)
    .order("creado", { ascending: true })
    .limit(10);
  return (data || []).map(m => ({ role: m.rol, content: m.contenido }));
}

// Guarda un mensaje en la base de datos (rol = 'user' o 'assistant')
async function guardarMensaje(telefono, rol, contenido) {
  await supabase.from("conversaciones").insert({ telefono, rol, contenido });
}

// ============================================================
//  AGENDA (Cal.com API v2): consultar huecos y reservar
// ============================================================

// HERRAMIENTA 1: consulta las horas libres para una fecha ("2026-07-13")
async function consultarHuecos(fecha) {
  try {
    const r = await axios.get("https://api.cal.com/v2/slots", {
      headers: {
        Authorization: `Bearer ${process.env.CAL_API_KEY}`,
        "cal-api-version": "2024-09-04"
      },
      params: {
        eventTypeId: Number(process.env.CAL_EVENT_TYPE_ID),
        start: fecha,
        end: fecha,
        timeZone: "Europe/Madrid"
      }
    });
    const dias = r.data.data || {};
    const slots = dias[fecha] || [];
    return slots.map(s => s.start.slice(11, 16)); // ["09:00","09:30",...]
  } catch (e) {
    console.error("Error consultarHuecos:", e.response?.data || e.message);
    return [];
  }
}

// HERRAMIENTA 2: reserva la cita en Cal.com y la guarda en la base de datos
async function reservarCita(fecha, hora, nombre, telefono) {
  try {
    const inicio = `${fecha}T${hora}:00.000Z`;
    const r = await axios.post(
      "https://api.cal.com/v2/bookings",
      {
        eventTypeId: Number(process.env.CAL_EVENT_TYPE_ID),
        start: inicio,
        attendee: {
          name: nombre,
          email: "paciente@ganapacientes.es", // Cal.com exige email; genÃ©rico de momento
          timeZone: "Europe/Madrid",
          language: "es"
        },
        bookingFieldsResponses: { notes: `Reserva por WhatsApp. Tel: ${telefono}` }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.CAL_API_KEY}`,
          "cal-api-version": "2024-08-13"
        }
      }
    );
    // Guardamos la cita tambiÃ©n en nuestra base de datos
    await supabase.from("citas").insert({ telefono, nombre, fecha, hora });
    return { ok: true, id: r.data.data?.id };
  } catch (e) {
    console.error("Error reservarCita:", e.response?.data || e.message);
    return { ok: false };
  }
}

// DescripciÃ³n de las herramientas PARA la IA (asÃ­ sabe que existen y cuÃ¡ndo usarlas)
const TOOLS = [
  {
    type: "function",
    function: {
      name: "consultarHuecos",
      description: "Consulta las horas libres de la clÃ­nica para una fecha concreta.",
      parameters: {
        type: "object",
        properties: { fecha: { type: "string", description: "Fecha en formato AAAA-MM-DD" } },
        required: ["fecha"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reservarCita",
      description: "Reserva una cita cuando el paciente ha elegido hora y ha dado su nombre.",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha AAAA-MM-DD" },
          hora: { type: "string", description: "Hora HH:MM (24h)" },
          nombre: { type: "string", description: "Nombre del paciente" }
        },
        required: ["fecha", "hora", "nombre"]
      }
    }
  }
];

// Ejecuta la herramienta que la IA pidiÃ³ y devuelve el resultado como texto (para dÃ¡rselo de vuelta a la IA)
async function ejecutarHerramienta(nombre, args, telefonoPaciente) {
  if (nombre === "consultarHuecos") {
    const huecos = await consultarHuecos(args.fecha);
    return JSON.stringify({ huecosLibres: huecos });
  }
  if (nombre === "reservarCita") {
    const res = await reservarCita(args.fecha, args.hora, args.nombre, telefonoPaciente);
    return JSON.stringify(res.ok ? { reservado: true } : { reservado: false });
  }
  return JSON.stringify({ error: "herramienta desconocida" });
}

// ============================================================
//  WEBHOOK 1) Saludo de verificaciÃ³n (Meta llama una vez con GET)
// ============================================================
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    console.log("âœ… Webhook verificado");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// ============================================================
//  WEBHOOK 2) Recibir mensaje -> memoria -> IA (con herramientas) -> responder -> guardar
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // avisamos a Meta "recibido" enseguida

  try {
    const entrada = req.body.entry?.[0]?.changes?.[0]?.value;
    const mensaje = entrada?.messages?.[0];
    if (!mensaje || mensaje.type !== "text") return;

    const textoPaciente = mensaje.text.body;
    const numeroPaciente = mensaje.from;
    const hoy = new Date().toISOString().slice(0, 10); // fecha de hoy AAAA-MM-DD
    console.log("ðŸ“© Paciente dice:", textoPaciente);

    // 1) Recuperamos el historial de este paciente (MEMORIA) y montamos el contexto
    const historial = await leerHistorial(numeroPaciente);
    const messages = [
      { role: "system", content: PERSONALIDAD + `\nHoy es ${hoy}.` },
      ...historial,
      { role: "user", content: textoPaciente }
    ];
    // Guardamos ya el mensaje del paciente
    await guardarMensaje(numeroPaciente, "user", textoPaciente);

    // 2) Primera llamada a la IA: decide si responde o si quiere usar una herramienta
    let respuesta = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: TOOLS
    });
    let msg = respuesta.choices[0].message;

    // 3) Bucle: mientras la IA pida herramientas, las ejecutamos y le devolvemos el resultado
    //    (puede encadenar: primero consultar huecos, luego reservar)
    let vueltas = 0;
    while (msg.tool_calls && vueltas < 3) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        const resultado = await ejecutarHerramienta(call.function.name, args, numeroPaciente);
        console.log("ðŸ”§ Herramienta:", call.function.name, args, "->", resultado);
        messages.push({ role: "tool", tool_call_id: call.id, content: resultado });
      }
      respuesta = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        tools: TOOLS
      });
      msg = respuesta.choices[0].message;
      vueltas++;
    }

    const textoRespuesta = msg.content || "Perdona, Â¿me lo repites? ðŸ™‚";
    console.log("ðŸ¤– IA responde:", textoRespuesta);

    // 4) Guardamos la respuesta de LucÃ­a en la memoria
    await guardarMensaje(numeroPaciente, "assistant", textoRespuesta);

    // 5) Enviamos la respuesta al paciente por WhatsApp
    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to: numeroPaciente, text: { body: textoRespuesta } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    console.log("âœ… Respuesta enviada al paciente");

  } catch (error) {
    console.error("âŒ Error:", error.response?.data || error.message);
  }
});

app.listen(3000, () => console.log("Servidor despierto en el puerto 3000"));