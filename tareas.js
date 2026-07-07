// tareas.js — se ejecuta solo (por el cron), no es el servidor
require("dotenv").config();
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Envía una plantilla de WhatsApp
async function enviarPlantilla(telefono, plantilla, params) {
  await axios.post(
    `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp", to: telefono, type: "template",
      template: {
        name: plantilla, language: { code: "es" },
        components: [{ type: "body", parameters: params.map(t => ({ type: "text", text: t })) }]
      }
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
}

// 1) RECORDATORIOS: cita de mañana -> avisar
async function recordatorios() {
  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // fecha de mañana
  const { data } = await supabase.from("citas").select("*").eq("fecha", manana).eq("estado", "reservada");
  for (const c of (data || [])) {
    try {
      await enviarPlantilla(c.telefono, "recordatorio_cita", [c.nombre || "", c.hora || ""]);
      console.log("⏰ Recordatorio a", c.nombre);
    } catch (e) { console.error("Error recordatorio:", e.response?.data || e.message); }
  }
}

// 2) DORMIDOS: automatiza la campaña (los pendientes)
async function dormidos() {
  const { data } = await supabase.from("dormidos").select("*").eq("estado", "pendiente");
  for (const p of (data || [])) {
    try {
      await enviarPlantilla(p.telefono, "reactivacion_presupuesto", [p.nombre || "", p.tratamiento || "tu tratamiento"]);
      await supabase.from("dormidos").update({ estado: "contactado" }).eq("id", p.id);
      console.log("📤 Reactivación a", p.nombre);
    } catch (e) { console.error("Error dormidos:", e.response?.data || e.message); }
  }
}

// Ejecuta las dos y termina
(async () => {
  await recordatorios();
  await dormidos();
  console.log("✅ Tareas del día completadas");
  process.exit(0);
})();