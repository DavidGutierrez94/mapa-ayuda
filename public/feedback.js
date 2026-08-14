// Floating feedback widget for team pages (mod/admin): reports become GitHub issues.
(() => {
  const token = () => localStorage.modToken || localStorage.adminToken || localStorage.responderToken || "";
  const el = document.createElement("div");
  el.innerHTML = `
  <button id="fbBtn" class="btn" style="position:fixed;bottom:1rem;right:1rem;z-index:50;box-shadow:0 2px 8px rgb(0 0 0 / .12)">💬 Reportar</button>
  <div id="fbPanel" hidden style="position:fixed;bottom:4rem;right:1rem;z-index:50;width:min(22rem,90vw);background:var(--background);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;box-shadow:0 8px 24px rgb(0 0 0 / .15)">
    <strong style="font-size:.9375rem">Reportar al equipo de desarrollo</strong>
    <select id="fbType" class="input" style="margin-top:.5rem">
      <option value="bug">🐛 Error de la plataforma</option>
      <option value="feature">💡 Sugerencia / nueva función</option>
    </select>
    <textarea id="fbMsg" class="input" rows="4" style="margin-top:.5rem" placeholder="Describa qué pasó o qué necesita. La IA lo convertirá en un reporte estructurado."></textarea>
    <label style="display:flex;gap:.4rem;align-items:center;margin-top:.5rem;font-size:.8125rem;color:var(--muted-foreground)">
      <input type="checkbox" id="fbDevice" checked style="accent-color:var(--primary)" /> Incluir información del dispositivo (útil para errores)
    </label>
    <button id="fbSend" class="btn btn-primary" style="margin-top:.6rem">Enviar</button>
    <span id="fbStatus" class="meta" style="display:block;margin-top:.5rem"></span>
  </div>`;
  document.body.appendChild(el);
  const $ = (id) => document.getElementById(id);
  $("fbBtn").onclick = () => ($("fbPanel").hidden = !$("fbPanel").hidden);
  $("fbSend").onclick = async () => {
    const message = $("fbMsg").value.trim();
    if (!message) return;
    $("fbStatus").textContent = "Enviando…";
    const device = $("fbDevice").checked
      ? {
          ua: navigator.userAgent,
          pantalla: `${screen.width}x${screen.height}`,
          ventana: `${innerWidth}x${innerHeight}`,
          idioma: navigator.language,
          conexion: navigator.onLine ? "online" : "offline",
        }
      : null;
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token() },
        body: JSON.stringify({ type: $("fbType").value, message, page: location.pathname, device }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      $("fbMsg").value = "";
      $("fbStatus").innerHTML = d.issue_url
        ? `✓ Reporte creado: <a href="${d.issue_url}" target="_blank">ver en GitHub</a>`
        : "✓ Reporte registrado en la bandeja del equipo.";
    } catch (e) {
      $("fbStatus").textContent = "No se pudo enviar: " + e.message;
    }
  };
})();
