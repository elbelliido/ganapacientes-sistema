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