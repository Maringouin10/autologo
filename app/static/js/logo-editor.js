/* The logo edit step, shared by the vendor tool (/tool) and the customer
   order page. Both used to carry their own copy of a thumbnail grid whose
   cards were each scaled to their own bounding box — which made a piece
   sitting in the wrong place look perfectly normal in its thumbnail, and
   left no way to tell which card was which piece of the logo.

   Everything here draws in ONE frame: the whole logo's bounding box. A
   card therefore shows its piece where it actually is, with the rest of
   the logo ghosted behind it, and the big preview shows excluded pieces
   ghosted too so they can be clicked back in. */

function ringsToPathD(rings) {
  return rings.map((ring) => {
    const [first, ...rest] = ring;
    return `M${first[0]},${first[1]} ` + rest.map((p) => `L${p[0]},${p[1]}`).join(" ") + " Z";
  }).join(" ");
}

/** Union bounding box of every shape, padded — the common drawing frame. */
function logoFrame(shapes) {
  const minx = Math.min(...shapes.map((s) => s.bbox[0]));
  const miny = Math.min(...shapes.map((s) => s.bbox[1]));
  const maxx = Math.max(...shapes.map((s) => s.bbox[2]));
  const maxy = Math.max(...shapes.map((s) => s.bbox[3]));
  const w = Math.max(maxx - minx, 1e-3);
  const h = Math.max(maxy - miny, 1e-3);
  const pad = Math.max(w, h) * 0.06;
  return {
    minx, miny, maxx, maxy, w, h,
    viewBox: `${minx - pad} ${miny - pad} ${w + 2 * pad} ${h + 2 * pad}`,
  };
}

function escapeAttr(value) {
  return String(value).replace(/"/g, "&quot;");
}

/**
 * A shape that covers almost the whole logo is nearly always a background
 * plate the designer left in — the single most common thing people need to
 * remove, and the hardest to notice once it is extruded.
 */
export function looksLikeBackground(shape, shapes) {
  if (shapes.length < 2) return false;
  const frame = logoFrame(shapes);
  const [x0, y0, x1, y1] = shape.bbox;
  const coversWidth = (x1 - x0) >= frame.w * 0.92;
  const coversHeight = (y1 - y0) >= frame.h * 0.92;
  if (!coversWidth || !coversHeight) return false;
  // A frame/outline ring covers the same box but only fills its border, so
  // require it to be solid before calling it a background.
  const boxArea = Math.max((x1 - x0) * (y1 - y0), 1e-9);
  return (shape.area ?? 0) >= boxArea * 0.75;
}

/** The whole logo as one <svg>, every shape a clickable path. */
function logoSvg(shapes, { excluded, colorOf, interactive = false }) {
  if (!shapes.length) return "";
  const frame = logoFrame(shapes);
  const paths = shapes.map((s) => {
    const off = excluded.has(s.index);
    return `<path data-index="${s.index}" class="${off ? "shape-path is-off" : "shape-path"}"` +
      ` fill="${escapeAttr(colorOf(s))}" fill-rule="evenodd"` +
      ` d="${ringsToPathD(s.rings)}"/>`;
  }).join("");
  return `<svg viewBox="${frame.viewBox}" preserveAspectRatio="xMidYMid meet"` +
    `${interactive ? ' class="is-interactive"' : ""}>${paths}</svg>`;
}

/** One card's thumbnail: this piece in place, the rest of the logo ghosted. */
function cardSvg(shape, shapes, colorOf) {
  const frame = logoFrame(shapes);
  const others = shapes
    .filter((s) => s.index !== shape.index)
    .map((s) => `<path class="ghost" fill="${escapeAttr(colorOf(s))}" fill-rule="evenodd"` +
                 ` d="${ringsToPathD(s.rings)}"/>`)
    .join("");
  return `<svg viewBox="${frame.viewBox}" preserveAspectRatio="xMidYMid meet">${others}` +
    `<path fill="${escapeAttr(colorOf(shape))}" fill-rule="evenodd" d="${ringsToPathD(shape.rings)}"/></svg>`;
}

function highlight(previewHost, index) {
  previewHost?.querySelectorAll(".shape-path").forEach((p) => {
    p.classList.toggle("is-highlight", index != null && Number(p.dataset.index) === index);
  });
}

/**
 * Render the whole edit step.
 *
 * The caller owns the state (`excluded`) and re-renders after changing it:
 *   onToggle(index, included) — one piece switched
 *   onSetAll(included)        — the "all / none" buttons
 */
export function renderLogoEditor({
  listHost, previewHost, shapes, excluded, flipH = false, flipV = false,
  colorOf = (s) => s.color || "#36d17a", onToggle, onSetAll,
}) {
  if (!listHost) return;
  if (!shapes.length) {
    listHost.innerHTML = '<p class="hint">Aucune forme détectée.</p>';
    if (previewHost) previewHost.innerHTML = "";
    return;
  }

  const kept = shapes.filter((s) => !excluded.has(s.index)).length;

  // --- the card grid, with its own little toolbar ---
  listHost.innerHTML = `
    <div class="shape-tools">
      <span class="shape-count"></span>
      <span class="spacer"></span>
      <button type="button" class="shape-tool" data-all="1">Tout inclure</button>
      <button type="button" class="shape-tool" data-all="0">Tout exclure</button>
    </div>
    <div class="shape-list"></div>
  `;
  listHost.querySelector(".shape-count").textContent = shapes.length > 1
    ? `${kept}/${shapes.length} formes incluses`
    : `${kept}/1 forme incluse`;
  listHost.querySelectorAll(".shape-tool").forEach((btn) => {
    btn.addEventListener("click", () => onSetAll?.(btn.dataset.all === "1"));
  });

  const grid = listHost.querySelector(".shape-list");
  for (const shape of shapes) {
    const off = excluded.has(shape.index);
    const card = document.createElement("label");
    card.className = "shape-card" + (off ? " excluded" : "");
    card.innerHTML =
      `<span class="shape-card-head">` +
      `<input type="checkbox" ${off ? "" : "checked"}>` +
      (looksLikeBackground(shape, shapes)
        ? '<span class="shape-flag" title="Cette forme couvre tout le logo — souvent un fond à exclure.">fond&nbsp;?</span>'
        : "") +
      `</span>` + cardSvg(shape, shapes, colorOf);
    card.querySelector("input").addEventListener("change", (e) => {
      onToggle?.(shape.index, e.target.checked);
    });
    card.addEventListener("mouseenter", () => highlight(previewHost, shape.index));
    card.addEventListener("mouseleave", () => highlight(previewHost, null));
    grid.appendChild(card);
  }

  // --- the big preview: the editing surface, not just a picture ---
  if (!previewHost) return;
  previewHost.innerHTML = logoSvg(shapes, { excluded, colorOf, interactive: true }) +
    '<span class="preview-tip">Cliquez une forme pour l\'exclure</span>';
  const svg = previewHost.querySelector("svg");
  if (!svg) return;
  svg.style.transform = `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`;
  svg.querySelectorAll(".shape-path").forEach((path) => {
    const index = Number(path.dataset.index);
    path.addEventListener("click", () => onToggle?.(index, excluded.has(index)));
    path.addEventListener("mouseenter", () => {
      highlight(previewHost, index);
      const card = grid.children[shapes.findIndex((s) => s.index === index)];
      card?.classList.add("is-highlight");
    });
    path.addEventListener("mouseleave", () => {
      highlight(previewHost, null);
      grid.querySelectorAll(".is-highlight").forEach((c) => c.classList.remove("is-highlight"));
    });
  });
}
