const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const token = () => localStorage.informesToken || localStorage.modToken || localStorage.adminToken || localStorage.responderToken || "";
function save() { localStorage.informesToken = $("#token").value; load(); }
const NEEDS = { agua: "Agua", alimentos: "Alimentos", medico: "Atención médica", rescate: "Rescate", techo: "Techo / albergue", higiene: "Higiene / aseo", infancia: "Niños y bebés", otro: "Otras" };
const STATUS = { pending: "Pendientes", verified: "Verificadas", attending: "En atención", resolved: "Resueltas", rejected: "Rechazadas" };
const fmtH = (h) => (h == null ? "—" : h < 1 ? Math.round(h * 60) + " min" : h.toFixed(1) + " h");

function tile(v, l) { return `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`; }

function hbars(rows, labelKey, max) {
  return rows.map((r) => `
    <div class="hbar-row">
      <span class="lbl" title="${esc(r[labelKey])}">${esc(r[labelKey])}</span>
      <div><div class="bar" style="width:${Math.max(2, (r.n / max) * 100)}%"></div></div>
      <span class="val">${r.n}</span>
    </div>`).join("");
}

function dayChart(rows) {
  if (!rows.length) return "<p class='meta'>Sin datos en el rango.</p>";
  const W = 720, H = 180, P = 28;
  const max = Math.max(...rows.map((r) => r.n));
  const bw = Math.min(40, (W - P * 2) / rows.length - 2);
  const x = (i) => P + (i + 0.5) * ((W - P * 2) / rows.length);
  const y = (v) => H - P - (v * (H - P * 2)) / max;
  const grid = [max, Math.round(max / 2)].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  const maxIdx = rows.findIndex((r) => r.n === max);
  return `
  <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Solicitudes por día">
    ${grid.map((v) => `<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" stroke-width="1" />
      <text x="${P - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="var(--muted-foreground)">${v}</text>`).join("")}
    <line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="var(--border)" stroke-width="1" />
    ${rows.map((r, i) => `
      <rect x="${x(i) - bw / 2}" y="${y(r.n)}" width="${bw}" height="${H - P - y(r.n)}" rx="4" fill="#2563eb">
        <title>${esc(r.d)}: ${r.n} solicitudes (${r.verified} verificadas)</title>
      </rect>
      ${i === maxIdx ? `<text x="${x(i)}" y="${y(r.n) - 5}" text-anchor="middle" font-size="10" fill="var(--foreground)">${r.n}</text>` : ""}
      ${rows.length <= 15 || i % Math.ceil(rows.length / 10) === 0 ? `<text x="${x(i)}" y="${H - P + 13}" text-anchor="middle" font-size="9" fill="var(--muted-foreground)">${esc(r.d.slice(5))}</text>` : ""}
    `).join("")}
  </svg>
  <details><summary>Ver datos en tabla</summary>
    <table><tr><th>Día</th><th>Solicitudes</th><th>Verificadas</th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.d)}</td><td>${r.n}</td><td>${r.verified}</td></tr>`).join("")}</table>
  </details>`;
}

async function load() {
  if (!token()) return;
  const res = await fetch("/api/mod/stats?days=" + $("#days").value, { headers: { authorization: "Bearer " + token() } });
  if (res.status === 401) { $("#report").innerHTML = "<p>Token inválido.</p>"; return; }
  const s = await res.json();
  $("#generated").textContent = `Generado ${new Date().toLocaleString("es-CO")} · rango: últimos ${s.days} días`;
  const st = Object.fromEntries(s.by_status.map((r) => [r.status, r.n]));
  const needMax = Math.max(1, ...s.by_need.map((r) => r.n));
  const muniMax = Math.max(1, ...s.by_muni.map((r) => r.n));
  $("#report").innerHTML = `
    <div class="tiles">
      ${tile(s.totals.requests, "solicitudes recibidas")}
      ${tile(st.verified ?? 0, "verificadas activas")}
      ${tile(st.attending ?? 0, "en atención")}
      ${tile(st.resolved ?? 0, "resueltas")}
      ${tile(s.totals.households, "hogares reportados")}
      ${tile(s.totals.confirmations, "confirmaciones (sumarse)")}
      ${tile(fmtH(s.median_hours_to_verify), "mediana hasta verificación")}
      ${tile(fmtH(s.median_hours_to_resolve), "mediana hasta resolución")}
    </div>
    <div class="chart-card"><h2>Solicitudes por día</h2>${dayChart(s.by_day)}</div>
    <div class="chart-card"><h2>Por tipo de necesidad</h2>
      ${s.by_need.length ? hbars(s.by_need.map((r) => ({ ...r, label: NEEDS[r.need_type] ?? r.need_type })), "label", needMax) : "<p class='meta'>Sin datos.</p>"}
    </div>
    <div class="chart-card"><h2>Municipios con más solicitudes</h2>
      ${s.by_muni.length ? hbars(s.by_muni.map((r) => ({ ...r, label: r.muni_name })), "label", muniMax) : "<p class='meta'>Sin datos.</p>"}
      <p class="meta" style="margin-top:.5rem">Los datos agregados públicos están disponibles en <a href="/api/feed?format=csv">CSV</a> y <a href="/api/feed?format=geojson">GeoJSON</a>.</p>
    </div>
    <div class="chart-card"><h2>Estado del total recibido</h2>
      ${hbars(Object.entries(STATUS).filter(([k]) => st[k]).map(([k, l]) => ({ label: l, n: st[k] })), "label", Math.max(1, ...Object.values(st)))}
    </div>`;
}

$("#enter").addEventListener("click", save);
$("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
$("#days").addEventListener("change", load);
$("#print").addEventListener("click", () => window.print());
load();
