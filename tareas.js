// ============================================================
//  GANAPACIENTES · tareas.js · VERSIÓN MEJORADA (Modelo B)
//  Render Cron Job · schedule: 0 9 * * * · comando: node tareas.js
//
//  Cada mañana a las 9:00, para CADA clínica activa:
//   1. RECORDATORIOS  → citas de MAÑANA (plantilla recordatorio_cita)
//   2. REACTIVACIÓN   → dormidos en estado "pendiente"
//                       (plantilla reactivacion_presupuesto)
//   3. RESEÑAS        → citas de AYER sin reseña pedida
//                       (plantilla gracias_visita, solo si la clínica
//                        tiene link_resenas configurado)
//
//  MEJORAS DE ESTA VERSIÓN:
//   - Aislamiento de errores: si una clínica falla (token caducado,
//     lo que sea), las demás siguen. Antes un error paraba todo.
//   - Anti-duplicados en recordatorios: columna recordatorio_enviado.
//     Antes, si el cron corría dos veces, el paciente recibía dos.
//   - Respeto RGPD en todo: los "baja" no reciben NADA, tampoco
//     recordatorios ni reseñas.
//   - Techo de seguridad en reactivación (máx. 100/día por clínica):
//     protege el límite de mensajería de Meta y reparte campañas
//     grandes en varios días automáticamente.
//   - Fechas calculadas en zona Europe/Madrid (no la del servidor).
//   - Pausa entre envíos (300 ms) para no saturar la API de Meta.
//   - Resumen final por consola: lo que verás en los logs de Render.
//
//  SQL NECESARIO EN SUPABASE (una sola vez, SQL Editor):
//    ALTER TABLE citas ADD COLUMN IF NOT EXISTS recordatorio_enviado boolean DEFAULT false;
//    ALTER TABLE citas ADD COLUMN IF NOT EXISTS resena_enviada boolean DEFAULT false;
//    ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS link_resenas text;
//
//  ⚠️ VARIABLES DE PLANTILLA: revisa que el número de parámetros de
//  cada envío coincida con los {{n}} de TU plantilla aprobada en Meta.
//  Están marcados con "// ⚠️" más abajo. Si tu recordatorio_cita
//  tiene 2 variables y aquí se mandan 3, Meta devuelve error.
// ============================================================

require("dotenv").config();
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ------------------------------------------------------------
//  UTILIDADES DE FECHA (zona Europe/Madrid)
// ------------------------------------------------------------
function fechaMadrid(desplazamientoDias = 0) {
  return new Date(Date.now() + desplazamientoDias * 24 * 60 * 60 * 1000)
    .toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" }); // AAAA-MM-DD
}
function diaBonito(fecha) {
  return new Date(fecha + "T12:00:00").toLocaleDateString("es-ES", {
    timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long"
  });
}
const pausa = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------
//  ENVÍO DE PLANTILLAS DE WHATSAPP (con parámetros)
// ------------------------------------------------------------
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
    // Si la plantilla no existe en "es", reintentamos una vez con "es_ES"
    if (err?.code === 132001 && idioma === "es") {
      return enviarPlantilla(clinica, telefono, nombrePlantilla, parametros, "es_ES");
    }
    console.error(`   ❌ Plantilla ${nombrePlantilla} [${idioma}] → ${telefono}:`, JSON.stringify(err?.message || e.message));
    return false;
  }
}

// ------------------------------------------------------------
//  RGPD: ¿este teléfono pidió la baja en esta clínica?
// ------------------------------------------------------------
async function estaEnBaja(telefono, clinicaId) {
  const { data } = await supabase
    .from("dormidos").select("id")
    .eq("telefono", telefono).eq("clinica_id", clinicaId)
    .eq("estado", "baja").limit(1);
  return (data || []).length > 0;
}

// ------------------------------------------------------------
//  1) RECORDATORIOS · citas de MAÑANA
// ------------------------------------------------------------
async function enviarRecordatorios(clinica, resumen) {
  const manana = fechaMadrid(1);

  const { data: citas } = await supabase
    .from("citas").select("*")
    .eq("clinica_id", clinica.id)
    .eq("fecha", manana)
    .eq("recordatorio_enviado", false);

  for (const cita of citas || []) {
    if (await estaEnBaja(cita.telefono, clinica.id)) {
      await supabase.from("citas").update({ recordatorio_enviado: true }).eq("id", cita.id);
      continue;
    }

    // ⚠️ AJUSTA los parámetros a TU plantilla recordatorio_cita:
    // aquí se asume: {{1}} nombre · {{2}} clínica · {{3}} día · {{4}} hora
    const ok = await enviarPlantilla(clinica, cita.telefono, "recordatorio_cita", [
      (cita.nombre || "").split(" ")[0] || "paciente",
      clinica.nombre_clinica,
      cita.hora || ""
    ]);

    if (ok) {
      await supabase.from("citas").update({ recordatorio_enviado: true }).eq("id", cita.id);
      resumen.recordatorios++;
      console.log(`   🔔 Recordatorio → ${cita.nombre || cita.telefono} (${cita.hora})`);
    }
    await pausa(300);
  }
}

// ------------------------------------------------------------
//  2) REACTIVACIÓN · dormidos en "pendiente"
//     Techo de 100/día por clínica: campañas grandes se reparten
//     solas en varios días, protegiendo el límite de Meta.
// ------------------------------------------------------------
const MAX_REACTIVACIONES_DIA = 100;

async function reactivarDormidos(clinica, resumen) {
  const { data: dormidos } = await supabase
    .from("dormidos").select("*")
    .eq("clinica_id", clinica.id)
    .eq("estado", "pendiente")          // solo pendientes: bajas y demás quedan fuera
    .limit(MAX_REACTIVACIONES_DIA);

  for (const d of dormidos || []) {
    // ⚠️ AJUSTA los parámetros a TU plantilla reactivacion_presupuesto:
    // aquí se asume: {{1}} nombre · {{2}} tratamiento
    const ok = await enviarPlantilla(clinica, d.telefono, "reactivacion_presupuesto", [
      (d.nombre || "").split(" ")[0] || "paciente",
      clinica.nombre_clinica,
      d.tratamiento || "tu tratamiento"
    ]);

    if (ok) {
      await supabase.from("dormidos").update({ estado: "contactado" }).eq("id", d.id);
      resumen.reactivados++;
      console.log(`   💤→📲 Reactivado → ${d.nombre || d.telefono} (${d.tratamiento || "—"})`);
    } else {
      resumen.fallidos++;
    }
    await pausa(300);
  }
}

// ------------------------------------------------------------
//  3) RESEÑAS · citas de AYER sin reseña pedida
//     Solo si la clínica tiene link_resenas (servicio activable
//     clínica a clínica: es parte del plan Sistema Completo).
// ------------------------------------------------------------
async function enviarResenas(clinica, resumen) {
  if (!clinica.link_resenas) return;

  const ayer = fechaMadrid(-1);

  const { data: citas } = await supabase
    .from("citas").select("*")
    .eq("clinica_id", clinica.id)
    .eq("fecha", ayer)
    .eq("resena_enviada", false);

  for (const cita of citas || []) {
    if (await estaEnBaja(cita.telefono, clinica.id)) {
      await supabase.from("citas").update({ resena_enviada: true }).eq("id", cita.id);
      continue;
    }

    // ⚠️ Parámetros de gracias_visita: {{1}} nombre · {{2}} clínica · {{3}} enlace
    const ok = await enviarPlantilla(clinica, cita.telefono, "gracias_visita", [
      (cita.nombre || "").split(" ")[0] || "paciente",
      clinica.nombre_clinica,
      clinica.link_resenas
    ]);

    if (ok) {
      await supabase.from("citas").update({ resena_enviada: true }).eq("id", cita.id);
      resumen.resenas++;
      console.log(`   ⭐ Reseña pedida → ${cita.nombre || cita.telefono}`);
    }
    await pausa(300);
  }
}

// ------------------------------------------------------------
//  PRINCIPAL: recorre todas las clínicas activas.
//  Cada clínica va en su propio try/catch: si una falla,
//  las demás siguen funcionando.
// ------------------------------------------------------------
async function main() {
  const inicio = Date.now();
  console.log("═".repeat(50));
  console.log(`🌅 GanaPacientes · tareas diarias · ${fechaMadrid()} `);
  console.log("═".repeat(50));

  const { data: clinicas, error } = await supabase
    .from("clinicas").select("*").eq("activa", true);

  if (error || !clinicas || clinicas.length === 0) {
    console.error("⚠️ No se pudieron cargar clínicas activas:", error?.message || "lista vacía");
    process.exit(1);
  }

  const total = { recordatorios: 0, reactivados: 0, resenas: 0, fallidos: 0 };

  for (const clinica of clinicas) {
    console.log(`\n🏥 ${clinica.nombre_clinica} (id ${clinica.id})`);

    // Sanidad mínima de configuración antes de intentar nada
    if (!clinica.phone_number_id || !clinica.whatsapp_token) {
      console.error("   ⚠️ Clínica sin phone_number_id o token — saltada.");
      continue;
    }

    const resumen = { recordatorios: 0, reactivados: 0, resenas: 0, fallidos: 0 };
    try {
      await enviarRecordatorios(clinica, resumen);
      await reactivarDormidos(clinica, resumen);
      await enviarResenas(clinica, resumen);
      console.log(`   ✔ ${resumen.recordatorios} recordatorios · ${resumen.reactivados} reactivados · ${resumen.resenas} reseñas · ${resumen.fallidos} fallidos`);
    } catch (e) {
      console.error(`   ❌ Error en esta clínica (las demás continúan):`, e.message);
    }

    total.recordatorios += resumen.recordatorios;
    total.reactivados += resumen.reactivados;
    total.resenas += resumen.resenas;
    total.fallidos += resumen.fallidos;
  }

  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log("\n" + "═".repeat(50));
  console.log(`✅ FIN · ${clinicas.length} clínica(s) · ${total.recordatorios} recordatorios · ${total.reactivados} reactivados · ${total.resenas} reseñas · ${total.fallidos} fallidos · ${segundos}s`);
  console.log("═".repeat(50));
  process.exit(0);
}

main().catch(e => {
  console.error("❌ Error fatal en tareas.js:", e.message);
  process.exit(1);
});