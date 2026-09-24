import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  readJson, markDropzoneFilled, setBusy, toastError, wireCopyButtons,
  wireRotationPresets,
} from "./ui.js";
import { renderLogoEditor } from "./logo-editor.js";

const PRODUCT_ID = document.body.dataset.productId;

// --- three.js scene setup ----------------------------------------------------
const viewerEl = document.getElementById("viewer");
const hintEl = document.getElementById("viewer-hint");

const scene = new THREE.Scene();
// Transparent canvas: the viewer's CSS gradient shows through (see style.css).
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
camera.position.set(80, 80, 80);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewerEl.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Bright, evenly-lit rig: renderer tone-mapping keeps the highlights from
// blowing out even with the much stronger lights below.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
scene.add(new THREE.AmbientLight(0xffffff, 1.1));
scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 2.0));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
keyLight.position.set(100, 200, 150);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xcfe0ff, 1.5);
fillLight.position.set(-120, 60, -100);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 1.2);
rimLight.position.set(0, -150, 50);
scene.add(rimLight);
scene.add(new THREE.GridHelper(400, 40, 0x2a2f3a, 0x1c2029));

function resize() {
  const w = viewerEl.clientWidth, h = viewerEl.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

const modelMaterial = new THREE.MeshStandardMaterial({ color: 0x8fa6c9, metalness: 0.05, roughness: 0.55 });
// A 3MF that carries real per-part color (extracted server-side, baked
// into the GLB as vertex colors) should show it, not the flat default.
const coloredModelMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff, metalness: 0.05, roughness: 0.55, vertexColors: true,
});
function pickModelMaterial(mesh) {
  return mesh.geometry.attributes.color ? coloredModelMaterial : modelMaterial;
}
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.35 });
const previewMaterial = new THREE.MeshStandardMaterial({
  color: 0x36d17a, metalness: 0.1, roughness: 0.5,
  transparent: true, opacity: 0.9, depthTest: true,
});
// The preview GLB carries each color group's real fill as vertex colors —
// show them (white base, or it would tint what's baked in) so a multi-color
// logo previews in its actual colors instead of one flat green.
const coloredPreviewMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff, metalness: 0.1, roughness: 0.5,
  transparent: true, opacity: 0.95, depthTest: true, vertexColors: true,
});
function pickPreviewMaterial(mesh) {
  return mesh.geometry.attributes.color ? coloredPreviewMaterial : previewMaterial;
}

let lastBounds = null;
function fitCameraTo(bounds) {
  if (bounds) lastBounds = bounds;
  const min = new THREE.Vector3(...bounds.min), max = new THREE.Vector3(...bounds.max);
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const radius = Math.max(size.length() / 2, 1);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

const gltfLoader = new GLTFLoader();
let assemblyMesh = null;

function loadAssembly(url, bounds) {
  gltfLoader.load(url, (gltf) => {
    let mesh = null;
    gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
    if (!mesh) return;
    mesh.material = pickModelMaterial(mesh);
    scene.add(mesh);
    scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial));
    assemblyMesh = mesh;
    applyModelColor();
    fitCameraTo(bounds);
    hintEl.textContent = "Déposez votre logo à gauche, puis glissez-le sur l'objet.";
  }, undefined, (err) => {
    hintEl.textContent = "Échec du chargement du modèle.";
    toastError("Échec du chargement du modèle 3D : " + err.message);
  });
}

// Picking a filament for the object repaints it in the viewer: the customer
// sees the actual combination they are ordering, not a gray placeholder.
const chosenModelMaterial = new THREE.MeshStandardMaterial({ metalness: 0.05, roughness: 0.55 });
function applyModelColor() {
  if (!assemblyMesh) return;
  if (state.modelColor) {
    chosenModelMaterial.color.set(state.modelColor);
    assemblyMesh.material = chosenModelMaterial;
  } else {
    assemblyMesh.material = pickModelMaterial(assemblyMesh);
  }
}

// --- order-wide state ----------------------------------------------------------
const state = {
  palette: [],
  maxColors: 4,
  modelColor: null,
  defaultModelColor: null,
  // {svg color -> chosen filament}, shared by every zone: two zones printing
  // the same source color in different filaments would silently blow the
  // color budget, and nobody asked for that.
  colorMap: {},
};

function printedColor(sourceColor) {
  return state.colorMap[sourceColor] || sourceColor;
}

/** Distinct filaments this order needs right now. */
function usedColors() {
  const used = [];
  const push = (c) => { if (c && !used.includes(c)) used.push(c); };
  push(state.modelColor);
  for (const engine of engines) {
    if (!engine.hasLogo) continue;
    for (const shape of engine.shapes) {
      if (engine.excluded.has(shape.index)) continue;
      push(printedColor(shape.color));
    }
  }
  return used;
}

/** Source colors still in use across the order, in first-seen order. */
function sourceColors() {
  const seen = [];
  for (const engine of engines) {
    if (!engine.hasLogo) continue;
    for (const shape of engine.shapes) {
      if (engine.excluded.has(shape.index)) continue;
      if (!seen.includes(shape.color)) seen.push(shape.color);
    }
  }
  return seen;
}

// --- drag registry: any zone's preview mesh can be grabbed ----------------------
const dragRegistry = new Map(); // THREE.Mesh -> the control set that owns it
const raycaster = new THREE.Raycaster();
function ndcFromEvent(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

let dragging = null;
renderer.domElement.addEventListener("pointerdown", (ev) => {
  const objs = [...dragRegistry.keys()];
  if (!objs.length) return;
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const hits = raycaster.intersectObjects(objs, false);
  if (!hits.length) return;
  const target = dragRegistry.get(hits[0].object);
  if (!target) return;
  dragging = { controls: target.controls, engine: target.engine };
  controls.enabled = false;
  hintEl.textContent = "Glissez pour positionner le logo…";
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
});

function onDragMove(ev) {
  if (!dragging) return;
  const engine = dragging.engine;
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(engine.plane, hit)) return;
  const rel = hit.sub(engine.origin);
  dragging.controls.applyDragOffset(rel.dot(engine.u), rel.dot(engine.v));
}
function onDragEnd() {
  window.removeEventListener("pointermove", onDragMove);
  if (!dragging) return;
  dragging = null;
  controls.enabled = true;
  hintEl.textContent = "Glissez le logo pour l'ajuster.";
}

// --- zone engine: one per customizable face, no DOM of its own -----------------
// It owns the face geometry, the server-side zone state and the preview mesh.
// A control set (below) drives one engine (a face on its own) or several at
// once (faces the vendor grouped, printed with the same logo).
/** Shapes still printing for this engine — zero means nothing to place. */
function includedCount(engine) {
  return engine.hasLogo
    ? engine.shapes.filter((s) => !engine.excluded.has(s.index)).length
    : 0;
}

function makeEngine(z) {
  const engine = {
    id: z.id,
    label: z.label,
    groupKey: z.group_key || "",
    width: z.width,
    height: z.height,
    suggestedWidth: z.suggested_width_mm,
    center: z.center || null,   // middle of the piece itself, not of its bbox
    origin: new THREE.Vector3(...z.origin),
    normal: new THREE.Vector3(...z.normal),
    u: new THREE.Vector3(...z.u),
    v: new THREE.Vector3(...z.v),
    plane: new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(...z.normal), new THREE.Vector3(...z.origin)),
    hasLogo: false,
    file: null,           // kept so "same logo everywhere" can re-send it
    shapes: [],
    excluded: new Set(),
    flipH: false,
    flipV: false,
    placement: { width_mm: z.suggested_width_mm, rotation_deg: 0, offset_x_mm: 0, offset_y_mm: 0 },
    previewObject: null,
    previewBaseOffset: { x: 0, y: 0 },
    owner: null,          // the control set currently driving this engine
  };

  engine.upload = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/logo`, {
      method: "POST", body: fd,
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'import");
    engine.hasLogo = true;
    engine.file = file;
    engine.shapes = data.shapes;
    engine.excluded = new Set();
    engine.flipH = false;
    engine.flipV = false;
    return data;
  };

  engine.pushEdit = async () => {
    const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        excluded: [...engine.excluded], flip_h: engine.flipH, flip_v: engine.flipV,
        colors: state.colorMap,
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de la mise à jour");
    return data;
  };

  engine.fit = async (rotationDeg = null) => {
    const body = {
      offset_x_mm: engine.placement.offset_x_mm,
      offset_y_mm: engine.placement.offset_y_mm,
    };
    if (rotationDeg !== null) body.rotation_deg = rotationDeg;
    const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/fit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'ajustement");
    return data;
  };

  engine.refreshPreview = async () => {
    if (!engine.hasLogo) return;
    const placement = { ...engine.placement };
    const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(placement),
    });
    if (!res.ok) { const d = await readJson(res); throw new Error(d.error || "échec de l'aperçu"); }
    const buf = await res.arrayBuffer();
    await new Promise((resolve) => {
      new GLTFLoader().parse(buf, "", (gltf) => {
        if (engine.previewObject) {
          scene.remove(engine.previewObject);
          dragRegistry.delete(engine.previewObject);
        }
        let mesh = null;
        gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
        if (mesh) {
          mesh.material = pickPreviewMaterial(mesh);
          scene.add(mesh);
          engine.previewObject = mesh;
          if (engine.owner) dragRegistry.set(mesh, { engine, controls: engine.owner });
        }
        // The freshly loaded mesh bakes in this exact offset, so instant
        // drag feedback measures its delta from here, not from (0,0).
        engine.previewBaseOffset = { x: placement.offset_x_mm, y: placement.offset_y_mm };
        resolve();
      }, resolve);
    });
  };

  engine.clearPreview = () => {
    if (!engine.previewObject) return;
    scene.remove(engine.previewObject);
    dragRegistry.delete(engine.previewObject);
    engine.previewObject = null;
  };

  return engine;
}

// --- control set: the panel UI driving one or more engines ---------------------
function makeControls(groupEngines, { title, compact = false }) {
  const el = document.createElement("div");
  el.className = compact ? "sub-zone" : "zone-controls";
  el.innerHTML = `
    ${compact ? '<h3 class="sub-zone-title"></h3>' : ""}
    <p class="zone-status">En attente de votre logo</p>
    <label class="dropzone zone-drop">
      <input type="file" accept=".svg" hidden class="zone-file-input">
      <span class="dz-icon">🎨</span>
      <span class="dz-main">Cliquez ou déposez votre logo</span>
      <span class="dz-sub">Fichier .svg</span>
    </label>
    <div class="zone-edit hidden">
      <p class="hint">Décochez une forme — ou cliquez-la dans l'aperçu — pour l'exclure.</p>
      <div class="zone-shape-list"></div>
      <div class="flip-row">
        <button type="button" class="toggle-btn zone-flip-h">⇋ Miroir H</button>
        <button type="button" class="toggle-btn zone-flip-v">⇵ Miroir V</button>
      </div>
      <div class="combined-preview zone-combined-wrap"><svg></svg></div>
    </div>
    <div class="zone-placement hidden">
      <p class="hint" style="margin-bottom:10px">
        <b>Glissez le logo</b> directement sur l'objet en 3D, ou utilisez les curseurs.
      </p>
      <div class="fit-row">
        <button type="button" class="btn btn-ghost zone-fit-btn">⤢ Agrandir au max</button>
        <button type="button" class="btn btn-ghost zone-fit-keep-btn"
                title="La plus grande taille possible sans changer l'orientation actuelle">
          ⤢ Max sans tourner
        </button>
      </div>
      <button type="button" class="btn btn-soft btn-block zone-center-btn" style="margin-bottom:14px"
              title="Place le logo au centre de la partie large, sans tenir compte d'une attache ou d'un ergot">
        ⊙ Centrer sur la pièce
      </button>
      <div class="field">
        <label>Taille <span class="zone-width-val val"></span></label>
        <input type="range" class="zone-width" min="1" step="0.5">
      </div>
      <div class="field">
        <label>Rotation <span class="zone-rot-val val"></span></label>
        <div class="rot-presets zone-rot-presets">
          <button type="button" data-deg="0">0°</button>
          <button type="button" data-deg="90">90°</button>
          <button type="button" data-deg="180">180°</button>
          <button type="button" data-deg="270">270°</button>
        </div>
        <input type="range" class="zone-rot" min="0" max="360" step="1" value="0">
      </div>
      <div class="field">
        <label>Décalage horizontal <span class="zone-dx-val val"></span></label>
        <input type="range" class="zone-dx" step="0.2" value="0">
      </div>
      <div class="field">
        <label>Décalage vertical <span class="zone-dy-val val"></span></label>
        <input type="range" class="zone-dy" step="0.2" value="0">
      </div>
    </div>
  `;
  if (compact) el.querySelector(".sub-zone-title").textContent = title;

  const lead = groupEngines[0];
  const status = el.querySelector(".zone-status");
  const sliders = {
    width: el.querySelector(".zone-width"), rot: el.querySelector(".zone-rot"),
    dx: el.querySelector(".zone-dx"), dy: el.querySelector(".zone-dy"),
  };
  // Grouped faces are identical by construction, so the lead face's limits
  // apply to all of them.
  sliders.width.max = Math.max(lead.width, lead.height) * 1.5;
  sliders.width.value = lead.placement.width_mm;
  sliders.rot.value = lead.placement.rotation_deg;
  sliders.dx.min = -lead.width; sliders.dx.max = lead.width;
  sliders.dy.min = -lead.height; sliders.dy.max = lead.height;
  sliders.dx.value = lead.placement.offset_x_mm;
  sliders.dy.value = lead.placement.offset_y_mm;

  const ctl = { el, engines: groupEngines };
  groupEngines.forEach((engine) => {
    engine.owner = ctl;
    if (engine.previewObject) dragRegistry.set(engine.previewObject, { engine, controls: ctl });
  });

  function updateReadout() {
    el.querySelector(".zone-width-val").textContent = `${parseFloat(sliders.width.value).toFixed(1)} mm`;
    el.querySelector(".zone-rot-val").textContent = `${sliders.rot.value}°`;
    el.querySelector(".zone-dx-val").textContent = `${parseFloat(sliders.dx.value).toFixed(1)} mm`;
    el.querySelector(".zone-dy-val").textContent = `${parseFloat(sliders.dy.value).toFixed(1)} mm`;
  }
  updateReadout();

  function currentPlacement() {
    return {
      width_mm: parseFloat(sliders.width.value),
      rotation_deg: parseFloat(sliders.rot.value),
      offset_x_mm: parseFloat(sliders.dx.value),
      offset_y_mm: parseFloat(sliders.dy.value),
    };
  }

  let previewTimer = null;
  function schedulePreview() {
    updateReadout();
    const placement = currentPlacement();
    ctl.engines.forEach((engine) => { engine.placement = { ...placement }; });
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => refreshAll(), 120);
  }

  async function refreshAll() {
    try {
      for (const engine of ctl.engines) await engine.refreshPreview();
    } catch (err) {
      toastError(err.message);
    }
    updateSubmitState();
  }
  ctl.refreshAll = refreshAll;

  ctl.applyDragOffset = (offX, offY) => {
    const dx = Math.max(Number(sliders.dx.min), Math.min(Number(sliders.dx.max), offX));
    const dy = Math.max(Number(sliders.dy.min), Math.min(Number(sliders.dy.max), offY));
    sliders.dx.value = dx;
    sliders.dy.value = dy;
    updateReadout();
    // Instant, purely client-side feedback while the authoritative mesh is
    // re-extruded server-side.
    for (const engine of ctl.engines) {
      if (!engine.previewObject) continue;
      engine.previewObject.position
        .copy(engine.u).multiplyScalar(dx - engine.previewBaseOffset.x)
        .addScaledVector(engine.v, dy - engine.previewBaseOffset.y);
    }
    schedulePreview();
  };

  Object.values(sliders).forEach((s) => s.addEventListener("input", schedulePreview));

  // --- logo upload ---
  const drop = el.querySelector(".zone-drop");
  const fileInput = el.querySelector(".zone-file-input");
  drop.addEventListener("click", () => fileInput.click());
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));

  async function handleFile(file) {
    status.textContent = "Import en cours…";
    setBusy(true, "Lecture de votre logo…");
    try {
      let data = null;
      for (const engine of ctl.engines) data = await engine.upload(file);
      markDropzoneFilled(drop, file.name, `${data.shapes.length} forme(s) — cliquez pour changer`);
      // A new logo brings its own colors: keep the customer's picks for the
      // colors that are still there, drop the ones that are gone.
      editHistory.length = 0;
      pruneColorMap();
      adoptDefaultColors();
      renderEditor();
      el.querySelector(".zone-edit").classList.remove("hidden");
      el.querySelector(".zone-placement").classList.remove("hidden");
      status.textContent = "✓ Logo placé — ajustez-le à votre goût";
      status.classList.add("ready");
      await pushEditAll();
      await refreshAll();
      renderColorPanel();
    } catch (err) {
      status.textContent = "En attente de votre logo";
      toastError(err.message);
    } finally {
      setBusy(false);
    }
  }
  ctl.loadFile = handleFile;
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  // --- shape picker / mirror ---
  // Every engine this control set drives carries the same logo, so the lead
  // engine's shapes are what gets drawn and each change is mirrored to all.
  function setExcluded(mutate) {
    for (const engine of ctl.engines) mutate(engine);
  }

  const editHistory = [];

  function applyEdit(mutate) {
    editHistory.push(new Set(lead.excluded));
    if (editHistory.length > 30) editHistory.shift();
    setExcluded(mutate);
    renderEditor();
    syncEdit();
  }

  function renderEditor() {
    renderLogoEditor({
      listHost: el.querySelector(".zone-shape-list"),
      previewHost: el.querySelector(".zone-combined-wrap"),
      shapes: lead.shapes,
      excluded: lead.excluded,
      flipH: lead.flipH,
      flipV: lead.flipV,
      canUndo: editHistory.length > 0,
      // The customer picks the filament each SVG color prints in — the
      // cards and the preview show that, not the original artwork color.
      colorOf: (shape) => printedColor(shape.color),
      onToggle: (index, included) => applyEdit((engine) => {
        if (included) engine.excluded.delete(index);
        else engine.excluded.add(index);
      }),
      onSetAll: (included) => applyEdit((engine) => {
        engine.excluded = included ? new Set() : new Set(lead.shapes.map((s) => s.index));
      }),
      onSetMany: (indices, included) => applyEdit((engine) => {
        for (const index of indices) {
          if (included) engine.excluded.delete(index);
          else engine.excluded.add(index);
        }
      }),
      onUndo: () => {
        const previous = editHistory.pop();
        if (!previous) return;
        setExcluded((engine) => { engine.excluded = new Set(previous); });
        renderEditor();
        syncEdit();
      },
    });
  }
  ctl.renderEditor = renderEditor;

  async function pushEditAll() {
    let last = null;
    for (const engine of ctl.engines) {
      if (engine.hasLogo) last = await engine.pushEdit();
    }
    return last;
  }
  ctl.pushEditAll = pushEditAll;

  let editTimer = null;
  function syncEdit() {
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
      // A logo with every shape excluded has nothing to extrude: the server
      // rightly refuses it, so say so here instead of firing a request that
      // can only come back as an error.
      if (lead.hasLogo && includedCount(lead) === 0) {
        status.textContent = "Aucune forme incluse — rétablissez-en au moins une";
        status.classList.remove("ready");
        updateSubmitState();
        return;
      }
      try {
        await pushEditAll();
        await refreshAll();
        status.textContent = "✓ Logo placé — ajustez-le à votre goût";
        status.classList.add("ready");
        renderColorPanel();
      } catch (err) {
        toastError(err.message);
      }
    }, 150);
  }

  el.querySelector(".zone-flip-h").addEventListener("click", (e) => {
    const on = !lead.flipH;
    ctl.engines.forEach((engine) => { engine.flipH = on; });
    e.currentTarget.classList.toggle("active", on);
    renderEditor();
    syncEdit();
  });
  el.querySelector(".zone-flip-v").addEventListener("click", (e) => {
    const on = !lead.flipV;
    ctl.engines.forEach((engine) => { engine.flipV = on; });
    e.currentTarget.classList.toggle("active", on);
    renderEditor();
    syncEdit();
  });

  // --- fit to plate ---
  // "au max" may tilt the logo to gain size; "sans tourner" keeps the
  // orientation the customer set, which is what text and badges need.
  async function fitToPlate(keepRotation) {
    if (!lead.hasLogo) return;
    try {
      const data = await lead.fit(keepRotation ? parseFloat(sliders.rot.value) : null);
      if (data.width_mm > Number(sliders.width.max)) sliders.width.max = data.width_mm;
      sliders.width.value = data.width_mm;
      sliders.rot.value = data.rotation_deg;
      sliders.rot.dispatchEvent(new Event("input", { bubbles: true }));
      schedulePreview();
    } catch (err) {
      toastError(err.message);
    }
  }
  el.querySelector(".zone-fit-btn").addEventListener("click", () => fitToPlate(false));
  el.querySelector(".zone-fit-keep-btn").addEventListener("click", () => fitToPlate(true));

  wireRotationPresets(el.querySelector(".zone-rot-presets"), sliders.rot, schedulePreview);

  // Centre on the piece itself: the zone's origin is its bounding box's
  // middle, which on a keyring includes the hanging tab.
  const centerBtn = el.querySelector(".zone-center-btn");
  if (!lead.center || (!lead.center.x && !lead.center.y)) {
    // Nothing to correct on a plain rectangle or disc — don't offer a no-op.
    centerBtn.remove();
  } else {
    centerBtn.addEventListener("click", () => {
      const clamp = (value, slider) =>
        Math.max(Number(slider.min), Math.min(Number(slider.max), value));
      sliders.dx.value = clamp(lead.center.x, sliders.dx);
      sliders.dy.value = clamp(lead.center.y, sliders.dy);
      schedulePreview();
    });
  }

  // --- restore the UI for engines that already carry a logo ---
  if (lead.hasLogo) {
    markDropzoneFilled(drop, lead.file ? lead.file.name : "logo.svg",
                        `${lead.shapes.length} forme(s) — cliquez pour changer`);
    el.querySelector(".zone-flip-h").classList.toggle("active", lead.flipH);
    el.querySelector(".zone-flip-v").classList.toggle("active", lead.flipV);
    renderEditor();
    el.querySelector(".zone-edit").classList.remove("hidden");
    el.querySelector(".zone-placement").classList.remove("hidden");
    status.textContent = "✓ Logo placé — ajustez-le à votre goût";
    status.classList.add("ready");
  }

  return ctl;
}

// --- group panel: identical faces, together or apart ---------------------------
function makeGroupPanel(groupEngines) {
  const el = document.createElement("section");
  el.className = "zone-block";
  const multi = groupEngines.length > 1;
  el.innerHTML = `
    <h2>
      <span class="zone-title"></span>
      ${multi ? `<span class="badge badge-accent">${groupEngines.length} faces</span>` : ""}
    </h2>
    ${multi ? `
      <p class="group-faces hint" style="margin-bottom:4px"></p>
      <p class="hint" style="margin-bottom:8px">
        Ces faces sont identiques : un seul logo peut les couvrir toutes, ou
        chacune peut avoir le sien.
      </p>
      <div class="flip-row link-toggle">
        <button type="button" class="toggle-btn active" data-mode="linked">Le même partout</button>
        <button type="button" class="toggle-btn" data-mode="split">Un par face</button>
      </div>` : ""}
    <div class="group-body"></div>
  `;
  el.querySelector(".zone-title").textContent = multi
    ? (groupEngines[0].groupKey || "Faces identiques")
    : groupEngines[0].label;
  if (multi) {
    el.querySelector(".group-faces").textContent = groupEngines.map((e) => e.label).join(" · ");
  }

  const body = el.querySelector(".group-body");
  const panel = { el, engines: groupEngines, mode: "linked", controls: [] };

  function build() {
    panel.controls.forEach((c) => c.el.remove());
    panel.controls = [];
    body.innerHTML = "";
    if (panel.mode === "linked") {
      const ctl = makeControls(groupEngines, { title: "" });
      panel.controls = [ctl];
      body.appendChild(ctl.el);
    } else {
      panel.controls = groupEngines.map((engine) => {
        const ctl = makeControls([engine], { title: engine.label, compact: true });
        body.appendChild(ctl.el);
        return ctl;
      });
    }
  }
  build();

  el.querySelectorAll(".link-toggle .toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.mode;
      if (mode === panel.mode) return;
      panel.mode = mode;
      el.querySelectorAll(".link-toggle .toggle-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      build();
      // Going back to one-logo-for-all: re-send the lead face's logo and
      // placement to the others, so what the panel shows is what is stored.
      if (mode === "linked") {
        const source = groupEngines.find((e) => e.hasLogo && e.file);
        if (source) await panel.controls[0].loadFile(source.file);
      }
      updateSubmitState();
    });
  });

  return panel;
}

// --- colors --------------------------------------------------------------------
function swatchRow(selected, onPick) {
  const row = document.createElement("div");
  row.className = "swatches";
  row.setAttribute("role", "radiogroup");
  for (const color of state.palette) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch" + (color.hex === selected ? " is-active" : "");
    btn.style.background = color.hex;
    btn.title = color.name;
    btn.setAttribute("aria-label", color.name);
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", color.hex === selected ? "true" : "false");
    btn.addEventListener("click", () => onPick(color.hex));
    row.appendChild(btn);
  }
  return row;
}

function colorLabel(hex) {
  return state.palette.find((c) => c.hex === hex)?.name || hex;
}

/** Pre-select, for every color the SVG uses, the closest filament offered. */
function adoptDefaultColors() {
  for (const source of sourceColors()) {
    if (state.colorMap[source]) continue;
    state.colorMap[source] = nearestPaletteColor(source);
  }
}

function pruneColorMap() {
  const live = new Set(sourceColors());
  for (const key of Object.keys(state.colorMap)) {
    if (!live.has(key)) delete state.colorMap[key];
  }
}

function nearestPaletteColor(hex) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  let target;
  try { target = rgb(hex); } catch { return state.palette[0]?.hex; }
  let best = state.palette[0]?.hex, bestDist = Infinity;
  for (const color of state.palette) {
    const c = rgb(color.hex);
    const d = c.reduce((acc, v, i) => acc + (v - target[i]) ** 2, 0);
    if (d < bestDist) { bestDist = d; best = color.hex; }
  }
  return best;
}

function renderColorPanel() {
  const host = document.getElementById("colors-panel");
  if (!host) return;
  const sources = sourceColors();
  const used = usedColors();
  const over = used.length > state.maxColors;

  host.innerHTML = `
    <h2><span>Couleurs d'impression</span></h2>
    <p class="hint">Une couleur = un filament. ${state.maxColors} au maximum pour une même pièce.</p>
    <div class="color-block">
      <p class="color-label">L'objet</p>
      <div class="model-swatches"></div>
    </div>
    <div class="logo-colors"></div>
    <p class="color-count ${over ? "is-over" : ""}">
      <span class="color-dots"></span>
      <span class="color-count-text"></span>
    </p>
  `;

  host.querySelector(".model-swatches").appendChild(
    swatchRow(state.modelColor, async (hex) => {
      state.modelColor = hex;
      applyModelColor();
      renderColorPanel();
      try {
        const res = await fetch(`/api/order/session/${SESSION_ID}/colors`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_color: hex }),
        });
        const data = await readJson(res);
        if (!res.ok) throw new Error(data.error || "couleur refusée");
      } catch (err) {
        toastError(err.message);
      }
      updateSubmitState();
    }));

  const logoHost = host.querySelector(".logo-colors");
  if (!sources.length) {
    logoHost.innerHTML = '<p class="hint">Importez un logo pour choisir ses couleurs.</p>';
  } else {
    sources.forEach((source, i) => {
      const block = document.createElement("div");
      block.className = "color-block";
      block.innerHTML = `<p class="color-label">
        Logo — couleur ${i + 1}
        <span class="color-source" style="background:${source}" title="Couleur d'origine du SVG"></span>
      </p>`;
      block.appendChild(swatchRow(state.colorMap[source], async (hex) => {
        state.colorMap[source] = hex;
        renderColorPanel();
        try {
          for (const panel of panels) {
            for (const ctl of panel.controls) {
              ctl.renderEditor();
              await ctl.pushEditAll();
              await ctl.refreshAll();
            }
          }
        } catch (err) {
          toastError(err.message);
        }
        updateSubmitState();
      }));
      logoHost.appendChild(block);
    });
  }

  const dots = host.querySelector(".color-dots");
  used.forEach((hex) => {
    const dot = document.createElement("span");
    dot.className = "color-dot";
    dot.style.background = hex;
    dot.title = colorLabel(hex);
    dots.appendChild(dot);
  });
  host.querySelector(".color-count-text").textContent = over
    ? `${used.length} couleurs sur ${state.maxColors} autorisées — réutilisez une couleur déjà choisie.`
    : `${used.length} / ${state.maxColors} couleurs`;
}

// --- boot ----------------------------------------------------------------------
let SESSION_ID = null;
const engines = [];
const panels = [];

function updateSubmitState() {
  const ready = engines.filter((e) => e.hasLogo && e.previewObject && includedCount(e) > 0).length;
  const total = engines.length;
  const over = usedColors().length > state.maxColors;
  const allReady = total > 0 && ready === total && !over;
  document.getElementById("submit-btn").disabled = !allReady;
  const status = document.getElementById("submit-status");
  if (!status) return;
  if (over) {
    status.textContent = `Trop de couleurs (${usedColors().length}/${state.maxColors})`;
  } else if (allReady) {
    status.textContent = total > 1 ? "Vos logos sont prêts ✓" : "Votre logo est prêt ✓";
  } else {
    status.textContent = total > 1
      ? `${ready}/${total} logos placés`
      : "Importez votre logo pour continuer";
  }
  status.classList.toggle("ready", allReady);
}

/** Zones the vendor marked as identical faces travel together. */
function groupZones(zones) {
  const groups = [];
  const byKey = new Map();
  for (const z of zones) {
    const key = (z.group_key || "").trim();
    if (!key) { groups.push([z]); continue; }
    if (!byKey.has(key)) { const g = []; byKey.set(key, g); groups.push(g); }
    byKey.get(key).push(z);
  }
  return groups;
}

async function boot() {
  const container = document.getElementById("zones-container");
  try {
    const res = await fetch(`/api/product/${PRODUCT_ID}`);
    const product = await readJson(res);
    if (!res.ok) throw new Error(product.error || "produit introuvable");

    state.palette = product.palette || [];
    state.maxColors = product.max_colors || 4;
    state.defaultModelColor = product.default_model_color || null;
    state.modelColor = state.defaultModelColor
      ? nearestPaletteColor(state.defaultModelColor) : (state.palette[0]?.hex || null);

    loadAssembly(product.glb_url, product.bounds);

    const startRes = await fetch(`/api/order/${PRODUCT_ID}/start`, { method: "POST" });
    const startData = await readJson(startRes);
    if (!startRes.ok) throw new Error(startData.error || "impossible de démarrer la commande");
    SESSION_ID = startData.order_session_id;

    container.innerHTML = `
      <div class="order-intro">
        <b>Comment ça marche</b>
        <ol>
          <li>Déposez votre logo au format SVG.</li>
          <li>Glissez-le sur l'objet en 3D et ajustez sa taille.</li>
          <li>Choisissez vos couleurs, puis envoyez.</li>
        </ol>
      </div>`;

    for (const group of groupZones(product.zones)) {
      const groupEngines = group.map(makeEngine);
      engines.push(...groupEngines);
      const panel = makeGroupPanel(groupEngines);
      panels.push(panel);
      container.appendChild(panel.el);
    }

    const colorsPanel = document.createElement("section");
    colorsPanel.className = "zone-block colors-block";
    colorsPanel.id = "colors-panel";
    container.appendChild(colorsPanel);

    // Tell the server about the color the object starts out in, so an order
    // submitted without touching the swatches still records it.
    if (state.modelColor) {
      fetch(`/api/order/session/${SESSION_ID}/colors`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_color: state.modelColor }),
      }).catch(() => {});
    }
    applyModelColor();
    renderColorPanel();

    document.getElementById("submit-bar").classList.remove("hidden");
    updateSubmitState();
  } catch (err) {
    container.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint error";
    p.textContent = err.message;
    container.appendChild(p);
    toastError(err.message);
  }
}
boot();
wireCopyButtons();

// --- viewer toolbar ----------------------------------------------------------
document.getElementById("view-reset")?.addEventListener("click", () => {
  if (lastBounds) fitCameraTo(lastBounds);
});
document.getElementById("view-full")?.addEventListener("click", () => {
  const wrap = document.querySelector(".viewer-wrap");
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap?.requestFullscreen?.().catch(() => toastError("Plein écran refusé par le navigateur."));
});
document.addEventListener("fullscreenchange", () => setTimeout(resize, 60));

document.getElementById("submit-btn").addEventListener("click", async () => {
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "Envoi en cours…";
  setBusy(true, "Préparation de votre fichier 3D…");
  try {
    const res = await fetch(`/api/order/session/${SESSION_ID}/submit`, { method: "POST" });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'envoi");
    document.getElementById("order-code").textContent = data.order_code;
    document.getElementById("result-overlay").classList.remove("hidden");
    document.getElementById("submit-bar").classList.add("hidden");
  } catch (err) {
    toastError(err.message);
    btn.disabled = false;
    btn.textContent = "Envoyer ma commande";
  } finally {
    setBusy(false);
  }
});
