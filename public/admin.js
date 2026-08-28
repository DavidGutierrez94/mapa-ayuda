const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

window.ob = onboard({
  key: "admin",
  title: "Bienvenida al panel de administración",
  intro: "Desde aquí controla quién accede a la plataforma y qué hace cada quien. Cuatro pasos; se marcan solos cuando los hace:",
  steps: [
    { id: "token", text: "Entre con el token de administrador.", target: "#token" },
    { id: "usuario", text: "Cree su primer usuario (moderador u organización) y entregue el token: se muestra una sola vez.", target: "#u_name" },
    { id: "lider", text: "Registre un líder comunitario y compártale su enlace personal.", target: "#ld_name" },
    { id: "bitacora", text: "Use los filtros de la bitácora: toda acción de todo usuario queda registrada aquí.", target: "#l_actor" },
  ],
});

function save() { localStorage.adminToken = $("#token").value; loadAll(); }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", authorization: "Bearer " + (localStorage.adminToken ?? ""), ...opts.headers } });
  if (res.status === 401 || res.status === 403) { $("#users").innerHTML = "<p>Token inválido o sin permisos de administrador.</p>"; throw new Error("auth"); }
  ob.done("token");
  return res.json();
}
async function createUser() {
  const name = $("#u_name").value.trim();
  if (!name) return;
  const r = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ name, role: $("#u_role").value }) });
  $("#u_name").value = "";
  $("#newtoken").innerHTML = `<div class="token-box"><strong>Token de ${esc(name)}</strong> (cópielo ahora, no se volverá a mostrar):<br>${esc(r.token)}</div>`;
  ob.done("usuario");
  loadUsers();
}
async function revoke(id, name) {
  if (!confirm(`¿Revocar el acceso de ${name}?`)) return;
  await api("/api/admin/users/revoke", { method: "POST", body: JSON.stringify({ id }) });
  loadUsers();
}
const ROLES = { admin: "Administrador", mod: "Moderador", responder: "Organización" };
async function loadUsers() {
  const rows = await api("/api/admin/users");
  $("#users").innerHTML = rows.length === 0 ? "<p class='meta'>Sin usuarios aún. El token de administrador inicial sigue activo.</p>" : `
    <table><tr><th>#</th><th>Nombre</th><th>Rol</th><th>Creado por</th><th>Fecha</th><th></th></tr>
    ${rows.map((u) => `<tr class="${u.active ? "" : "off"}">
      <td>${u.id}</td><td>${esc(u.name)}</td><td>${ROLES[u.role] ?? esc(u.role)}</td>
      <td>${esc(u.created_by)}</td><td>${esc(u.created_at)}</td>
      <td>${u.active ? `<button class="btn btn-destructive" style="margin:0;padding:.25rem .6rem" data-action="revoke-user" data-id="${u.id}" data-name="${esc(u.name)}">Revocar</button>` : "revocado"}</td>
    </tr>`).join("")}</table>`;
}
async function loadLog() {
  const qs = new URLSearchParams();
  if ($("#l_actor").value.trim()) qs.set("actor", $("#l_actor").value.trim());
  if ($("#l_req").value.trim()) qs.set("request_id", $("#l_req").value.trim());
  const rows = await api("/api/admin/log?" + qs);
  $("#log").innerHTML = rows.length === 0 ? "<p class='meta'>Sin actividad registrada.</p>" : `
    <table><tr><th>Fecha</th><th>Actor</th><th>Rol</th><th>Acción</th><th>Caso</th><th>Detalle</th></tr>
    ${rows.map((l) => `<tr>
      <td>${esc(l.created_at)}</td><td>${esc(l.actor)}</td><td>${esc(l.role)}</td><td>${esc(l.action)}</td>
      <td>${l.request_id ? "#" + l.request_id : ""}</td><td class="meta">${esc(l.detail ?? "")}</td>
    </tr>`).join("")}</table>`;
}
async function createLeader() {
  const name = $("#ld_name").value.trim(), cedula = $("#ld_cedula").value.trim();
  if (!name || !cedula) return;
  const r = await api("/api/admin/leaders", { method: "POST", body: JSON.stringify({ name, cedula, phone: $("#ld_phone").value.trim() || undefined, muni_code: $("#ld_muni").value.trim() || undefined }) });
  if (r.error) { alert(r.error); return; }
  $("#ld_name").value = ""; $("#ld_cedula").value = ""; $("#ld_phone").value = ""; $("#ld_muni").value = "";
  const link = location.origin + "/ayuda?lider=" + r.link_token;
  $("#newlink").innerHTML = `<div class="token-box"><strong>Enlace de ${esc(name)}</strong> (compártalo solo con esta persona):<br><a href="${esc(link)}">${esc(link)}</a></div>`;
  ob.done("lider");
  loadLeaders();
}
async function revokeLeader(id, name) {
  if (!confirm(`¿Revocar el enlace de ${name}?`)) return;
  await api("/api/admin/leaders/revoke", { method: "POST", body: JSON.stringify({ id }) });
  loadLeaders();
}
async function loadLeaders() {
  const rows = await api("/api/admin/leaders");
  $("#leaders").innerHTML = rows.length === 0 ? "<p class='meta'>Sin líderes registrados. Registre el primero con el formulario de arriba: recibirá un enlace personal para compartirle y sus reportes llegarán marcados como verificados por identidad.</p>" : `
    <table><tr><th>#</th><th>Nombre</th><th>Cédula</th><th>Teléfono</th><th>Municipio</th><th>Enlace</th><th></th></tr>
    ${rows.map((l) => `<tr class="${l.active ? "" : "off"}">
      <td>${l.id}</td><td>${esc(l.name)}</td><td>CC …${esc(l.cedula_last3)}</td><td>${esc(l.phone)}</td><td>${esc(l.muni_code)}</td>
      <td><button class="btn" style="margin:0;padding:.25rem .6rem" data-action="copy-link" data-token="${esc(l.link_token)}">Copiar enlace</button></td>
      <td>${l.active ? `<button class="btn btn-destructive" style="margin:0;padding:.25rem .6rem" data-action="revoke-leader" data-id="${l.id}" data-name="${esc(l.name)}">Revocar</button>` : "revocado"}</td>
    </tr>`).join("")}</table>`;
}
function loadAll() { if (localStorage.adminToken) { loadUsers(); loadLeaders(); loadLog(); } }

// Static controls
$("#enter").addEventListener("click", save);
$("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
$("#createUser").addEventListener("click", createUser);
$("#createLeader").addEventListener("click", createLeader);
$("#filterLog").addEventListener("click", () => { ob.done("bitacora"); loadLog(); });

// Delegated actions for dynamically rendered rows (no inline handlers → CSP-safe, no XSS sink).
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const { action, id, name, token } = b.dataset;
  if (action === "revoke-user") revoke(+id, name);
  else if (action === "revoke-leader") revokeLeader(+id, name);
  else if (action === "copy-link") {
    navigator.clipboard.writeText(location.origin + "/ayuda?lider=" + token);
    b.textContent = "Copiado ✓";
  }
});

loadAll();
