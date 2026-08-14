const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

window.ob = onboard({
  key: "mod",
  title: "Bienvenida al panel de moderación",
  intro: "Usted es la puerta entre los reportes que llegan y el mapa público: nada se publica sin su verificación. Cinco pasos para empezar; se marcan solos cuando los hace (toque un paso para ver dónde):",
  steps: [
    { id: "token", text: "Entre con el token que le entregó el administrador.", target: "#token" },
    { id: "guia", text: "Abra la guía de validación y lea el ejemplo.", target: ".guide" },
    { id: "verificar", text: "Verifique o rechace su primer caso en Pendientes.", target: "#list" },
    { id: "tablero", text: "Pruebe la vista de tablero: arrastre una tarjeta entre columnas.", target: "#viewToggle" },
    { id: "informes", text: "Abra 📊 Informes para ver las métricas de la operación.", target: "a[href='/informes']" },
  ],
});

// Searchable municipality picker: type a name, we resolve it to its DANE code.
let MUNIS = [];
const mnorm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
fetch("/api/municipios").then((r) => r.json()).then((list) => {
  MUNIS = list;
  $("#munis").innerHTML = list.map((m) => `<option value="${esc(m.name)} (${esc(m.dept)})"></option>`).join("");
});
function resolveMuni(v) {
  v = (v ?? "").trim();
  if (!v) return "";
  if (/^\d{5}$/.test(v)) return v;
  const n = mnorm(v);
  const hit = MUNIS.find((m) => mnorm(`${m.name} (${m.dept})`) === n) ?? MUNIS.find((m) => mnorm(m.name) === n);
  return hit?.code ?? "";
}
const TABS = [["pending", "Pendientes"], ["verified", "Verificadas"], ["attending", "En atención"], ["resolved", "Resueltas"], ["rejected", "Rechazadas"]];
let status = "pending";

function save() { localStorage.modToken = $("#token").value; load(); }
function toggleCreate() { $("#create").hidden = !$("#create").hidden; }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + (localStorage.modToken ?? ""), ...opts.headers } });
  if (res.status === 401) { $("#list").innerHTML = "<p>Token inválido.</p>"; throw new Error("401"); }
  ob.done("token");
  return res.json();
}
async function act(id, action, extra = {}) {
  if (action === "delete" && !confirm(`¿Eliminar definitivamente el caso #${id}? Esta acción no se puede deshacer.`)) return;
  await api("/api/mod/action", { method: "POST", body: JSON.stringify({ id, action, ...extra }) });
  if (action === "verify" || action === "reject") ob.done("verificar");
  load();
}
function verifyWithMuni(id) {
  const muni_code = resolveMuni($("#m" + id)?.value);
  act(id, "verify", muni_code ? { muni_code } : {});
}
async function saveEdit(id) {
  const g = (f) => $(`#e${id} [name=${f}]`).value;
  const mergeId = g("merge").trim();
  if (mergeId) { await act(id, "merge", { target_id: +mergeId }); return; }
  await act(id, "update", {
    need_type: g("need_type"), urgency: +g("urgency"),
    description: g("description"), households: +g("households") || 1,
    contact: g("contact"), location_detail: g("location_detail"), quantity: g("quantity"),
    ...(resolveMuni(g("muni_code")) && { muni_code: resolveMuni(g("muni_code")) }),
  });
}
async function createReq() {
  const need_types = [...document.querySelectorAll("#c_needs input:checked")].map((i) => i.value);
  if (need_types.length === 0) { $("#c_err").textContent = "Marque al menos una necesidad."; return; }
  const muni = $("#c_muni").value.trim();
  const code = resolveMuni(muni);
  const body = {
    need_types, urgency: +$("#c_urgency").value,
    description: $("#c_desc").value, households: +$("#c_households").value || 1,
    contact: $("#c_contact").value, location_detail: $("#c_detail").value, quantity: $("#c_quantity").value,
    ...(code ? { muni_code: code } : { muni_name: muni }),
  };
  const res = await api("/api/mod/create", { method: "POST", body: JSON.stringify(body) });
  if (res.error) { $("#c_err").textContent = res.error; return; }
  $("#create").hidden = true; $("#c_desc").value = ""; $("#c_muni").value = ""; $("#c_contact").value = ""; $("#c_detail").value = "";
  document.querySelectorAll("#c_needs input:checked").forEach((i) => (i.checked = false));
  status = "pending"; load();
}

// Action buttons carry data-act/data-id (no inline handlers → CSP-safe); a delegated
// listener dispatches them. `verify-muni`, `edit-toggle` and `save-edit` are special;
// everything else maps straight to act(id, action).
const ACTIONS = {
  pending: (r) => `<input class="input muni" id="m${r.id}" list="munis" placeholder="Municipio (escriba para buscar)" value="${esc(r.muni_code)}" />
    <button class="btn btn-success" data-act="verify-muni" data-id="${r.id}">Verificar</button>
    <button class="btn btn-destructive" data-act="reject" data-id="${r.id}">Rechazar</button>`,
  verified: (r) => `<button class="btn btn-warning" data-act="attend" data-id="${r.id}">Atender</button>
    <button class="btn" data-act="resolve" data-id="${r.id}">Resuelta</button>
    <button class="btn btn-destructive" data-act="reject" data-id="${r.id}">Rechazar</button>`,
  attending: (r) => `<button class="btn btn-success" data-act="resolve" data-id="${r.id}">Resuelta</button>`,
  resolved: (r) => `<button class="btn" data-act="verify" data-id="${r.id}">Reabrir</button>`,
  rejected: (r) => `<button class="btn" data-act="verify" data-id="${r.id}">Restaurar y verificar</button>
    <button class="btn btn-destructive" data-act="delete" data-id="${r.id}">Eliminar</button>`,
};

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
  <div class="card">
    <strong>#${r.id} · ${esc(r.need_type)} · urgencia ${r.urgency}</strong>
    <span class="meta"> · ${esc(r.channel)}${r.source_org ? " (" + esc(r.source_org) + ")" : ""} · ${esc(r.created_at)}</span>
    ${r.leader_name ? `<span class="badge badge-success">✓ Líder: ${esc(r.leader_name)} · CC …${esc(r.leader_cc)}</span>` : ""}<br>
    ${esc(r.description)}<br>
    <span class="meta">📍 ${esc(r.muni_name) || "⚠ sin municipio"} ${r.location_raw ? "· dijo: “" + esc(r.location_raw) + "”" : ""} ${r.location_detail ? "· detalle: " + esc(r.location_detail) : ""}
    · 👥 ${r.households} hogares · +${r.confirmations} confirmaciones · ☎ ${esc(r.contact) || "sin contacto"}</span><br>
    ${v2meta(r)}
    ${ACTIONS[r.status]?.(r) ?? ""}
    <button class="btn" data-act="edit-toggle" data-id="${r.id}">Editar</button>
    <div class="panel" id="e${r.id}" hidden>
      <div class="row">
        <select class="input" name="need_type">
          ${["agua", "alimentos", "medico", "rescate", "techo", "higiene", "infancia", "otro"].map((n) => `<option ${n === r.need_type ? "selected" : ""}>${n}</option>`).join("")}
        </select>
        <select class="input" name="urgency">
          ${[1, 2, 3].map((u) => `<option value="${u}" ${u === r.urgency ? "selected" : ""}>Urgencia ${u}</option>`).join("")}
        </select>
        <input class="input" name="households" type="number" min="1" value="${r.households}" title="Hogares" />
        <input class="input" name="muni_code" list="munis" placeholder="Municipio (escriba para buscar)" value="${esc(r.muni_code)}" />
      </div>
      <div class="row" style="margin-top:.5rem">
        <input class="input" name="quantity" placeholder="Cantidad (ej: 20 mercados)" value="${esc(r.quantity)}" />
        <input class="input" name="contact" placeholder="Teléfono (privado)" value="${esc(r.contact)}" />
        <input class="input" name="location_detail" placeholder="Detalle de ubicación (privado)" value="${esc(r.location_detail)}" />
      </div>
      <textarea class="input" name="description" rows="2" style="margin-top:.5rem">${esc(r.description)}</textarea>
      <input class="input mergeid" name="merge" placeholder="Fusionar con #" />
      <button class="btn btn-primary" data-act="save-edit" data-id="${r.id}">Guardar</button>
    </div>
  </div>`;

function renderTabs() {
  $("#tabs").innerHTML = TABS.map(([s, label]) =>
    `<button class="tab ${s === status ? "active" : ""}" data-tab="${s}">${label}</button>`).join("");
}

// ── Kanban board ──
let view = localStorage.modView ?? "list";
let dragging = false;
function toggleView() { view = view === "list" ? "board" : "list"; if (view === "board") ob.done("tablero"); localStorage.modView = view; load(); }
const DROP_ACTION = { verified: "verify", rejected: "reject", attending: "attend", resolved: "resolve" };
const UCOLOR = { 1: "var(--destructive)", 2: "var(--warning)", 3: "var(--info)" };
const kcard = (r) => `
  <div class="kcard" draggable="true" data-id="${r.id}" title="${esc(r.description)}">
    <strong>#${r.id}</strong> · ${esc(r.need_type)} <span style="color:${UCOLOR[r.urgency]}">●</span>${r.leader_name ? ` <span class="badge badge-success" style="padding:.1rem .4rem">✓ líder</span>` : ""}<br>
    <span class="meta">📍 ${esc(r.muni_name) || "sin municipio"} · 👥 ${r.households} · +${r.confirmations}</span><br>
    <span class="meta">${esc((r.description ?? "").slice(0, 70))}${(r.description ?? "").length > 70 ? "…" : ""}</span>
  </div>`;
async function dropCard(e, col) {
  e.preventDefault();
  col.classList.remove("over");
  const id = +e.dataTransfer.getData("text/plain");
  const action = DROP_ACTION[col.dataset.status];
  if (!id || !action) { load(); return; } // "Pendientes" is not a drop target: nothing un-publishes back to pending
  await api("/api/mod/action", { method: "POST", body: JSON.stringify({ id, action }) });
  load();
}
function filterParams(s) {
  const qs = new URLSearchParams({ status: s });
  if ($("#q").value.trim()) qs.set("q", $("#q").value.trim());
  if ($("#f_need").value) qs.set("need", $("#f_need").value);
  if ($("#f_urgency").value) qs.set("urgency", $("#f_urgency").value);
  return qs;
}
async function loadBoard() {
  const lists = await Promise.all(TABS.map(([s]) => api("/api/mod/requests?" + filterParams(s))));
  $("#list").innerHTML = `<div class="board">` + TABS.map(([s, label], i) => `
    <div class="col" data-status="${s}">
      <h2>${label} <span class="count">(${lists[i].length})</span></h2>
      ${lists[i].length === 0 && DROP_ACTION[s] ? `<p class="meta" style="margin:.4rem .25rem">Arrastre una tarjeta aquí</p>` : ""}
      ${lists[i].map(kcard).join("")}
    </div>`).join("") + `</div>`;
}

async function load() {
  document.body.classList.toggle("wide", view === "board");
  $("#viewToggle").textContent = view === "list" ? "Tablero" : "Lista";
  if (!localStorage.modToken) { renderTabs(); return; }
  if (view === "board") { $("#tabs").innerHTML = ""; return loadBoard(); }
  renderTabs();
  const rows = await api("/api/mod/requests?" + filterParams(status));
  const EMPTY = {
    pending: "No hay casos pendientes por revisar. Los reportes de WhatsApp, SMS y el formulario web llegan aquí solos (la lista se actualiza cada 30 segundos). ¿Recibió una solicitud por llamada o radio? Regístrela con «+ Nueva solicitud».",
    verified: "Aún no hay casos verificados. Cuando verifique un caso en Pendientes aparecerá aquí y en el mapa público.",
  };
  $("#list").innerHTML = rows.length === 0 ? `<p class='meta'>${EMPTY[status] ?? "Sin casos en esta vista."}</p>` : rows.map(card).join("");
}

// Static controls
$("#enter").addEventListener("click", save);
$("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
$("#newReq").addEventListener("click", toggleCreate);
$("#c_save").addEventListener("click", createReq);
$("#viewToggle").addEventListener("click", toggleView);
$("#informesLink").addEventListener("click", () => ob.done("informes"));
document.querySelector(".guide").addEventListener("toggle", (e) => { if (e.target.open) ob.done("guia"); });

// Delegated actions for dynamically rendered tabs and cards.
document.addEventListener("click", (e) => {
  const tab = e.target.closest("button[data-tab]");
  if (tab) { status = tab.dataset.tab; load(); return; }
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = +b.dataset.id;
  const a = b.dataset.act;
  if (a === "verify-muni") verifyWithMuni(id);
  else if (a === "edit-toggle") { const p = document.getElementById("e" + id); p.hidden = !p.hidden; }
  else if (a === "save-edit") saveEdit(id);
  else act(id, a);
});

// Delegated kanban drag-and-drop (events bubble to #list).
const listEl = $("#list");
listEl.addEventListener("dragstart", (e) => { const k = e.target.closest(".kcard"); if (k) { dragging = true; e.dataTransfer.setData("text/plain", k.dataset.id); } });
listEl.addEventListener("dragend", () => { dragging = false; });
listEl.addEventListener("dragover", (e) => { const col = e.target.closest(".col"); if (col) { e.preventDefault(); col.classList.add("over"); } });
listEl.addEventListener("dragleave", (e) => { const col = e.target.closest(".col"); if (col && !col.contains(e.relatedTarget)) col.classList.remove("over"); });
listEl.addEventListener("drop", (e) => { const col = e.target.closest(".col"); if (col) dropCard(e, col); });

$("#q").oninput = () => { clearTimeout(window._t); window._t = setTimeout(load, 300); };
$("#f_need").onchange = load;
$("#f_urgency").onchange = load;
load();
setInterval(() => { if (!dragging && document.querySelector(".panel:not([hidden])") === null) load(); }, 30_000);
