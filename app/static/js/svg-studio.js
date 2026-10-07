/* The logo editor, full screen.

   Cleaning up an SVG (dropping a background, the specks a trace leaves,
   mirroring it) is fiddly work on a detailed logo, and it used to happen in
   a 348 px sidebar next to a 3D view that had nothing to do with it yet.
   So it is now its own page: the logo first, full screen, then on to the
   3D preview.

   The editor's own DOM is *moved* into the overlay and back, never copied:
   every listener the page wired on it keeps working, and whatever the page
   re-renders into it shows up wherever it currently is. Back in the
   sidebar it collapses to its thumbnail and a button to reopen it. */

let overlay = null;
let current = null;   // the studio currently open, if any

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "studio-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <header class="studio-bar">
      <ol class="studio-steps">
        <li class="is-current"><span class="studio-step-num">1</span> Votre logo</li>
        <li class="studio-step-sep" aria-hidden="true">›</li>
        <li><span class="studio-step-num">2</span> Aperçu 3D</li>
      </ol>
      <h2 class="studio-title"></h2>
      <button type="button" class="btn btn-primary studio-continue">Continuer vers l'aperçu 3D →</button>
    </header>
    <div class="studio-body"></div>
  `;
  overlay.querySelector(".studio-continue").addEventListener("click", () => current?.close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current) current.close();
  });
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Turn `contentEl` (a logo editor block) into a full-screen-able studio.
 * Its children marked `.studio-only` are hidden while it sits in the
 * sidebar; `.combined-preview` stays visible there as a thumbnail.
 *
 *   onClose() — called when the customer moves on to the 3D preview
 */
export function makeStudio(contentEl, { title = "Votre logo", onClose } = {}) {
  contentEl.classList.add("studio-content", "studio-collapsed");

  const reopen = document.createElement("button");
  reopen.type = "button";
  reopen.className = "btn btn-soft btn-block studio-reopen";
  reopen.textContent = "✎ Retoucher le logo en plein écran";
  contentEl.appendChild(reopen);

  const placeholder = document.createComment("logo studio");
  const studio = {
    isOpen: false,
    title,
    open() {
      if (studio.isOpen) return;
      if (current) current.close();
      const ov = ensureOverlay();
      ov.querySelector(".studio-title").textContent = studio.title;
      contentEl.replaceWith(placeholder);
      ov.querySelector(".studio-body").appendChild(contentEl);
      contentEl.classList.remove("studio-collapsed");
      contentEl.classList.add("in-studio");
      ov.classList.remove("hidden");
      document.body.classList.add("studio-open");
      studio.isOpen = true;
      current = studio;
      ov.querySelector(".studio-continue").focus();
    },
    close() {
      if (!studio.isOpen) return;
      // The sidebar may have been rebuilt meanwhile; then there is nowhere
      // to go back to.
      if (placeholder.isConnected) placeholder.replaceWith(contentEl);
      else contentEl.remove();
      contentEl.classList.remove("in-studio");
      contentEl.classList.add("studio-collapsed");
      overlay.classList.add("hidden");
      document.body.classList.remove("studio-open");
      studio.isOpen = false;
      current = null;
      onClose?.();
    },
  };
  reopen.addEventListener("click", () => studio.open());
  return studio;
}
