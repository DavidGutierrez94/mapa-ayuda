const escAttr = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const leaderToken = new URLSearchParams(location.search).get("lider");
if (leaderToken) {
  fetch("/api/leader-check?token=" + encodeURIComponent(leaderToken)).then(r => r.json()).then(d => {
    if (d.ok) {
      document.getElementById("leaderBox").hidden = false;
      document.getElementById("leaderName").textContent = "Enlace de líder verificado. Sus reportes llegarán marcados como reporte de líder verificado.";
    }
  });
}
fetch("/api/municipios").then(r => r.json()).then(list => {
  document.getElementById("munis").innerHTML = list.map(m => `<option value="${escAttr(m.name)} (${escAttr(m.dept)})"></option>`).join("");
});
let gps = null;
function getGps() {
  const st = document.getElementById("gpsStatus");
  if (!navigator.geolocation) { st.textContent = "Tu navegador no permite obtener la ubicación."; return; }
  st.textContent = "Obteniendo ubicación…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gps = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      st.innerHTML = `<span class="gps-ok">✓ Ubicación capturada (precisión ±${Math.round(pos.coords.accuracy)} m)</span>`;
      document.getElementById("gpsBtn").disabled = true;
    },
    () => { st.textContent = "No se pudo obtener la ubicación. Puedes enviar sin ella."; },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}
document.getElementById("gpsBtn").addEventListener("click", getGps);

let sitekey = null;
fetch("/api/config").then(r => r.json()).then(c => {
  sitekey = c.turnstile_sitekey;
  if (sitekey && window.turnstile) turnstile.render("#ts", { sitekey });
  else if (sitekey) window.onloadTurnstileCallback = () => turnstile.render("#ts", { sitekey });
});
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.need_types = [...e.target.querySelectorAll('input[name="need_types"]:checked')].map((i) => i.value);
  if (body.need_types.length === 0) {
    document.getElementById("err").textContent = "Marca al menos una necesidad.";
    return;
  }
  body.vulnerable = [...e.target.querySelectorAll('input[name="vulnerable"]:checked')].map((i) => i.value);
  body.urgency = +body.urgency; body.households = +body.households;
  body.people_count = body.people_count ? +body.people_count : undefined;
  if (gps) { body.precise_lat = gps.lat; body.precise_lon = gps.lon; }
  if (leaderToken && !document.getElementById("leaderBox").hidden) {
    body.leader_token = leaderToken;
    body.cedula = document.getElementById("cedula").value.trim();
    if (!body.cedula) { document.getElementById("err").textContent = "Escribe tu cédula para confirmar identidad."; return; }
  }
  if (sitekey) body.turnstile_token = e.target.querySelector('[name="cf-turnstile-response"]')?.value;
  const res = await fetch("/api/web-intake", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.ok) {
    e.target.hidden = true;
    const ok = document.getElementById("ok");
    ok.hidden = false;
    const many = (data.ids?.length ?? 1) > 1;
    const ids = (data.ids ?? [data.id]).map((i) => "#" + i).join(", ");
    ok.innerHTML = `<strong>✔ ${many ? "Solicitudes" : "Solicitud"} ${ids} registrada${many ? "s" : ""}.</strong><br>Un moderador ${many ? "las" : "la"} verificará y aparecerá${many ? "n" : ""} en el <a href="/">mapa público</a>. Comparte esta página con quien lo necesite.`;
  } else {
    document.getElementById("err").textContent = data.error ?? "Error, intenta de nuevo.";
  }
};
