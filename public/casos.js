const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

window.ob = onboard({
  key: "casos",
  title: "Bienvenida, organización de respuesta",
  intro: "Aquí están los casos ya verificados por moderadores, con contacto y ubicación para llegar. Tres pasos; se marcan solos cuando los hace:",
  steps: [
    { id: "token", text: "Entre con el token de su organización.", target: "#token" },
    { id: "atender", text: "Pulse «Tomar el caso» en el que van a atender: así las demás organizaciones ven que ya está en camino.", target: "#list" },
    { id: "resolver", text: "Al entregar la ayuda, pulse «Marcar resuelto»: el mapa público se actualiza al instante.", target: "#list" },
  ],
});

function save() { localStorage.responderToken = $("#token").value; load(); }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + (localStorage.responderToken ?? ""), ...opts.headers } });
  if (res.status === 401) { $("#list").innerHTML = "<p>Token inválido.</p>"; throw new Error("401"); }
  ob.done("token");
  return res.json();
}
async function act(id, action) {
  await api("/api/responder/action", { method: "POST", body: JSON.stringify({ id, action }) });
  ob.done(action === "attend" ? "atender" : "resolver");
  load();
}
const VULN = { ninos: "niños", mayores: "adultos mayores", embarazadas: "embarazadas", discapacidad: "discapacidad" };
const v2meta = (r) => {
  const parts = [];
  if (r.reporter_name) parts.push("Reporta: " + esc(r.reporter_name));
  if (r.people_count) parts.push("~" + r.people_count + " personas");
  if (r.quantity) parts.push("cantidad: " + esc(r.quantity));
  try { const v = JSON.parse(r.vulnerable ?? "null"); if (v?.length) parts.push("⚠ " + v.map((k) => esc(VULN[k] ?? k)).join(", ")); } catch {}
  if (r.access_note) parts.push("acceso: " + esc(r.access_note));
  if (r.precise_lat != null) parts.push(`<a href="https://www.openstreetmap.org/?mlat=${esc(r.precise_lat)}&mlon=${esc(r.precise_lon)}#map=16/${esc(r.precise_lat)}/${esc(r.precise_lon)}" target="_blank">📍 GPS exacto</a>`);
  if (r.ip_match === 1) parts.push(`<span style="color:#15803d">señal IP ✓ coincide con municipio</span>`);
  else if (r.ip_match === 0) parts.push(`<span style="color:#b45309">señal IP ✗ (${esc(r.ip_city)})</span>`);
  return parts.length ? `<span class="meta">${parts.join(" · ")}</span><br>` : "";
};
const card = (r) => `
  <div class="card u${r.urgency}">
    <strong>#${r.id} · ${esc(r.need_type)} · urgencia ${r.urgency}</strong>
    <span class="meta"> · ${esc(r.channel)}${r.source_org ? " (" + esc(r.source_org) + ")" : ""} · ${esc(r.created_at)}</span>
    ${r.leader_name ? `<span class="badge badge-success">✓ Líder: ${esc(r.leader_name)} · CC …${esc(r.leader_cc)}</span>` : ""}<br>
    ${esc(r.description)}<br>
    <span class="meta">📍 ${esc(r.muni_name) || "sin municipio"}${r.location_detail ? " · " + esc(r.location_detail) : ""}${r.location_raw ? " · dijo: “" + esc(r.location_raw) + "”" : ""}
    · 👥 ${r.households} hogares · +${r.confirmations} confirmaciones</span><br>
    ${v2meta(r)}
    ${r.contact ? `☎ <a class="contact" href="tel:${esc(r.contact)}">${esc(r.contact)}</a><a class="contact" href="https://wa.me/${String(r.contact).replace(/\D/g, "")}" target="_blank">WhatsApp</a>` : `<span class="meta">sin contacto</span>`}
    ${r.status === "verified"
      ? `<button class="btn btn-warning" data-action="attend" data-id="${r.id}">Tomar el caso</button>`
      : `<button class="btn btn-success" data-action="resolve" data-id="${r.id}">Marcar resuelto</button>`}
  </div>`;
async function load() {
  if (!localStorage.responderToken) return;
  const rows = await api("/api/responder/requests");
  const attending = rows.filter((r) => r.status === "attending");
  const verified = rows.filter((r) => r.status === "verified");
  $("#list").innerHTML =
    (rows.length === 0 ? "<p class='meta'>No hay casos activos por ahora. Cuando los moderadores verifiquen nuevas solicitudes aparecerán aquí automáticamente (la lista se actualiza cada 30 segundos).</p>" : "") +
    (attending.length ? `<h2>En atención <span class="count">(${attending.length})</span></h2>` + attending.map(card).join("") : "") +
    (verified.length ? `<h2>Por atender <span class="count">(${verified.length})</span></h2>` + verified.map(card).join("") : "");
}

$("#enter").addEventListener("click", save);
$("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
$("#list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-action]");
  if (b) act(+b.dataset.id, b.dataset.action);
});
load();
setInterval(load, 30_000);
