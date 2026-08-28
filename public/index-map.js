if (localStorage.ob_mapa !== "done") document.getElementById("hint").hidden = false;
document.getElementById("hint-dismiss")?.addEventListener("click", (e) => {
  localStorage.ob_mapa = "done";
  e.target.closest("#hint").remove();
});

const COLORS = { agua:"#1976d2", alimentos:"#f9a825", medico:"#d32f2f", rescate:"#7b1fa2", techo:"#5d4037", higiene:"#00838f", infancia:"#c2185b", otro:"#616161" };
const LABELS = { agua:"Agua", alimentos:"Alimentos", medico:"Médica", rescate:"Rescate", techo:"Techo", higiene:"Higiene", infancia:"Niños", otro:"Otras" };
document.getElementById("legend").innerHTML = Object.entries(LABELS)
  .map(([k,v]) => `<span style="color:${COLORS[k]}">${v}</span>`).join("");

const map = new maplibregl.Map({
  container: "map",
  center: [-76.4, 4.9], zoom: 7,
  style: { version: 8, sources: { osm: {
    type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256, attribution: "© OpenStreetMap"
  }}, layers: [{ id: "osm", type: "raster", source: "osm" }] },
});
map.addControl(new maplibregl.NavigationControl());
let markers = [];

async function load() {
  const need = document.getElementById("need").value;
  const status = document.getElementById("resolved").checked ? "verified,attending,resolved" : "verified,attending";
  const qs = new URLSearchParams({ status });
  if (need) qs.set("need", need);
  const { rows } = await (await fetch("/api/feed?" + qs)).json();
  markers.forEach(m => m.remove());
  markers = rows.filter(r => r.lat != null).map(r => {
    const size = Math.min(60, 14 + Math.sqrt(r.reportes) * 8);
    const el = document.createElement("div");
    el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${COLORS[r.need_type]}CC;border:2px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.75rem;cursor:pointer;` + (r.status === "resolved" ? "opacity:.35;" : "");
    el.textContent = r.reportes;
    return new maplibregl.Marker({ element: el })
      .setLngLat([r.lon, r.lat])
      .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(
        `<strong>${esc(r.muni_name)}</strong> (${esc(r.dept)})<br>` +
        `${LABELS[r.need_type]} · ${r.status === "resolved" ? "resuelta" : r.status === "attending" ? "en atención" : "verificada"}<br>` +
        `${r.reportes} reportes · ${r.households ?? "?"} hogares` +
        (r.has_critical ? "<br>⚠ incluye casos críticos" : "")
      ))
      .addTo(map);
  });
}
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
document.getElementById("need").onchange = load;
document.getElementById("resolved").onchange = load;
load();
setInterval(load, 60_000);
