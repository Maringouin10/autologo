/* Small shared UI kit used by every page's module: toasts, dropzone wiring,
   copy-to-clipboard feedback, the viewer's busy veil and the step checkmarks.
   Kept dependency-free (no build step) — the pages import it directly. */

// --- toasts ------------------------------------------------------------------
// Errors used to land in a small red line at the bottom of a scrollable panel,
// which is easy to miss entirely. A toast is impossible to miss and doesn't
// shift the layout.
const ICONS = { error: "⚠", ok: "✓", info: "ℹ" };
let stackEl = null;

function stack() {
  if (!stackEl) {
    stackEl = document.createElement("div");
    stackEl.className = "toast-stack";
    stackEl.setAttribute("role", "status");
    stackEl.setAttribute("aria-live", "polite");
    document.body.appendChild(stackEl);
  }
  return stackEl;
}

export function toast(message, type = "info", ttl = 6000) {
  if (!message) return null;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.innerHTML =
    `<span class="toast-icon">${ICONS[type] || ICONS.info}</span>` +
    `<span class="toast-msg"></span>` +
    `<button type="button" class="toast-close" aria-label="Fermer">✕</button>`;
  el.querySelector(".toast-msg").textContent = message;

  const dismiss = () => {
    if (!el.isConnected || el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector(".toast-close").addEventListener("click", dismiss);
  stack().appendChild(el);
  if (ttl) setTimeout(dismiss, ttl);
  return el;
}

export const toastError = (m) => toast(m, "error", 9000);
export const toastOk = (m) => toast(m, "ok", 4000);
export const toastInfo = (m) => toast(m, "info", 5000);

// --- fetch helper ------------------------------------------------------------
// The backend always answers JSON, even on error — but if something ever slips
// through (a proxy error page, a dropped connection), don't let res.json()'s
// SyntaxError surface as a cryptic "Unexpected token '<'".
export async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { error: text ? text.slice(0, 200) : `erreur HTTP ${res.status}` }; }
}

// --- dropzones ---------------------------------------------------------------
export function wireDropzone(dropEl, inputEl, onFile) {
  if (!dropEl || !inputEl) return;
  dropEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", () => { if (inputEl.files[0]) onFile(inputEl.files[0]); });
  ["dragover", "dragenter"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.remove("drag"); }));
  dropEl.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

/** Turn a dropzone into its "file loaded" state, keeping its sub-line. */
export function markDropzoneFilled(dropEl, fileName, subText = "Cliquez pour remplacer") {
  if (!dropEl) return;
  dropEl.classList.add("has-file");
  const main = dropEl.querySelector(".dz-main");
  const sub = dropEl.querySelector(".dz-sub");
  const icon = dropEl.querySelector(".dz-icon");
  if (icon) icon.textContent = "✓";
  if (main) main.textContent = fileName;
  if (sub) sub.textContent = subText;
}

// --- steps -------------------------------------------------------------------
export function enableStep(id, on = true) {
  const el = document.getElementById(id);
  if (!el) return;
  if (on) el.removeAttribute("disabled");
  else el.setAttribute("disabled", "");
}

export function markStepDone(id, done = true) {
  document.getElementById(id)?.classList.toggle("is-done", done);
}

// --- viewer busy veil --------------------------------------------------------
export function setBusy(on, label = "Traitement en cours…") {
  const wrap = document.querySelector(".viewer-wrap");
  if (!wrap) return;
  let veil = wrap.querySelector(".viewer-busy");
  if (!on) { veil?.remove(); return; }
  if (!veil) {
    veil = document.createElement("div");
    veil.className = "viewer-busy";
    veil.innerHTML = `<div class="spinner"></div><p class="busy-label"></p>`;
    wrap.appendChild(veil);
  }
  veil.querySelector(".busy-label").textContent = label;
}

// --- clipboard ---------------------------------------------------------------
export async function copyText(text, button) {
  let ok = true;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error("no clipboard api");
  } catch {
    // http:// origins (a LAN deployment) have no navigator.clipboard at all —
    // fall back to the old selection trick rather than silently doing nothing.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  if (button) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = ok ? "Copié ✓" : "Échec";
    setTimeout(() => { button.textContent = original; }, 1800);
  }
  if (ok) toastOk("Copié dans le presse-papiers.");
  else toastError("Impossible de copier — sélectionnez le texte manuellement.");
  return ok;
}

/** Wire every [data-copy="<selector of an input>"] button on the page. */
export function wireCopyButtons(root = document) {
  root.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.querySelector(btn.dataset.copy);
      if (!input) return;
      input.select?.();
      copyText(input.value ?? input.textContent, btn);
    });
  });
}
