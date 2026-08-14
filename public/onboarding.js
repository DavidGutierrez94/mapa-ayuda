// Onboarding ligero para vistas de equipo: bienvenida + lista de tareas guiada.
// Sin dependencias. El progreso vive en localStorage (ob_<clave> / ob_<clave>_<paso>).
// Los pasos se marcan solos cuando la persona hace la acción real (ob.done("paso")),
// y la guía completa se puede omitir en cualquier momento.
(() => {
  const style = document.createElement("style");
  style.textContent = `
  .ob { border: 1px solid var(--border); border-radius: var(--radius); background: var(--muted); padding: .8rem 1rem; margin: 1rem 0; font-size: .875rem; }
  .ob h2 { margin: 0 0 .15rem; font-size: .9375rem; }
  .ob .ob-intro { color: var(--muted-foreground); margin: 0 0 .5rem; }
  .ob-step { display: flex; gap: .55rem; align-items: baseline; margin: .3rem 0; cursor: pointer; }
  .ob-step .n { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 1.25rem; height: 1.25rem; border-radius: 999px; background: var(--background); border: 1px solid var(--border); font-size: .6875rem; font-weight: 600; transform: translateY(.2rem); }
  .ob-step.done { color: var(--muted-foreground); }
  .ob-step.done .txt { text-decoration: line-through; }
  .ob-step.done .n { background: var(--success, #16a34a); border-color: transparent; color: #fff; }
  .ob-foot { display: flex; gap: .9rem; align-items: center; margin-top: .55rem; }
  .ob-skip { background: none; border: 0; padding: 0; margin: 0; color: var(--muted-foreground); font-size: .8125rem; text-decoration: underline; cursor: pointer; box-shadow: none; }
  .ob-flash { outline: 2px solid var(--ring); outline-offset: 3px; border-radius: calc(var(--radius) - 2px); }
  `;
  document.head.appendChild(style);

  window.onboard = function (cfg) {
    const key = "ob_" + cfg.key;
    const noop = { done() {} };
    if (localStorage[key] === "done") return noop;

    const isDone = (id) => localStorage[key + "_" + id] === "1";
    const box = document.createElement("div");
    box.className = "ob";

    function flash(sel) {
      const el = document.querySelector(sel);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ob-flash");
      setTimeout(() => el.classList.remove("ob-flash"), 2500);
    }

    function render() {
      const doneCount = cfg.steps.filter((s) => isDone(s.id)).length;
      if (doneCount === cfg.steps.length) {
        localStorage[key] = "done";
        box.innerHTML = `<strong>✅ ¡Listo!</strong> Ya conoce lo esencial. Esta guía no volverá a aparecer.`;
        setTimeout(() => box.remove(), 6000);
        return;
      }
      box.innerHTML = `
        <h2>${cfg.title}</h2>
        <p class="ob-intro">${cfg.intro}</p>
        ${cfg.steps.map((s, i) => `
          <div class="ob-step ${isDone(s.id) ? "done" : ""}" data-target="${s.target ?? ""}" title="${s.target ? "Clic para mostrar dónde" : ""}">
            <span class="n">${isDone(s.id) ? "✓" : i + 1}</span><span class="txt">${s.text}</span>
          </div>`).join("")}
        <div class="ob-foot">
          <span class="meta">${doneCount} de ${cfg.steps.length}</span>
          <button class="ob-skip" type="button">Omitir la guía, ya conozco la herramienta</button>
        </div>`;
      box.querySelectorAll(".ob-step").forEach((el) => {
        el.onclick = () => el.dataset.target && flash(el.dataset.target);
      });
      box.querySelector(".ob-skip").onclick = () => { localStorage[key] = "done"; box.remove(); };
    }

    (document.querySelector(cfg.mount ?? "h1") ?? document.body.firstElementChild).after(box);
    render();

    return {
      done(id) {
        if (localStorage[key] === "done" || isDone(id)) return;
        localStorage[key + "_" + id] = "1";
        render();
      },
    };
  };
})();
