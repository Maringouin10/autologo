import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  readJson, wireDropzone, markDropzoneFilled, enableStep, markStepDone,
  setBusy, toastError, toastOk, wireRotationPresets,
} from "./ui.js";
import { renderLogoEditor } from "./logo-editor.js";

// --- three.js scene setup ----------------------------------------------------
const viewerEl = document.getElementById("viewer");
const hintEl = document.getElementById("viewer-hint");

const scene = new THREE.Scene();
// No opaque scene background: the canvas is transparent so the viewer's CSS
// gradient shows through, which reads as depth instead of a flat block.

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
// A single key light flattens relief into a silhouette — a dimmer light
// from the opposite side gives every facet its own shade instead of one
// flat tone, which is what actually makes bumps/engraving readable.
const fillLight = new THREE.DirectionalLight(0xcfe0ff, 1.5);
fillLight.position.set(-120, 60, -100);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 1.2);
rimLight.position.set(0, -150, 50);
scene.add(rimLight);
const grid = new THREE.GridHelper(400, 40, 0x2a2f3a, 0x1c2029);
scene.add(grid);

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
// A 3MF that carries real per-part color (extracted server-side, baked into
// the GLB as vertex colors) should show it instead of the flat default —
// vertexColors needs a white base color or it tints/darkens what's baked in.
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

let modelObject = null;   // THREE.Mesh of the loaded base model
let modelEdges = null;    // THREE.LineSegments outlining modelObject's facets
let previewObject = null; // THREE.Mesh of the live logo placement preview
const gltfLoader = new GLTFLoader();

let lastBounds = null;
function fitCameraTo(bounds) {
  if (bounds) lastBounds = bounds;
  const min = new THREE.Vector3(...bounds.min);
  const max = new THREE.Vector3(...bounds.max);
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

function loadModelGlb(url, bounds) {
  gltfLoader.load(url, (gltf) => {
    if (modelObject) scene.remove(modelObject);
    if (modelEdges) scene.remove(modelEdges);
    let mesh = null;
    gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
    if (!mesh) { setError("le modèle chargé ne contient aucun maillage."); return; }
    mesh.material = pickModelMaterial(mesh);
    scene.add(mesh);
    modelObject = mesh;
    // A flat material under simple lighting reads as a silhouette on a
    // low-poly/faceted model — tracing facet edges is what actually lets
    // relief and curvature be seen at a glance.
    modelEdges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial);
    modelEdges.position.copy(mesh.position);
    modelEdges.rotation.copy(mesh.rotation);
    modelEdges.scale.copy(mesh.scale);
    scene.add(modelEdges);
    fitCameraTo(bounds);
    hintEl.textContent = "Cliquez sur une face plate du modèle pour y placer le logo.";
  }, undefined, (err) => setError("échec du chargement du modèle 3D: " + err.message));
}

function loadPreviewGlb(arrayBuffer) {
  gltfLoader.parse(arrayBuffer, "", (gltf) => {
    if (previewObject) scene.remove(previewObject);
    let mesh = null;
    gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
    if (!mesh) return;
    mesh.material = pickPreviewMaterial(mesh);
    scene.add(mesh);
    previewObject = mesh;
  });
}

// --- app state ----------------------------------------------------------------
const state = {
  sessionId: null,
  faceIndex: null,
  hasLogo: false,
  faceInfo: null,
  logoShapes: [],
  isVolume: true,
  excluded: new Set(),
  flipH: false,
  flipV: false,
};

function setError(msg) {
  document.getElementById("export-error").textContent = msg || "";
  if (msg) toastError(msg);
}

// --- upload: model --------------------------------------------------------------
const modelInput = document.getElementById("model-input");
const modelDrop = document.getElementById("model-drop");
const modelInfo = document.getElementById("model-info");

wireDropzone(modelDrop, modelInput, async (file) => {
  setError("");
  modelInfo.textContent = "Import en cours…";
  setBusy(true, "Import du modèle 3D…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload/model", { method: "POST", body: fd });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'import");
    state.sessionId = data.session_id;
    state.isVolume = data.is_volume !== false;
    updateWatertightHint();
    markDropzoneFilled(modelDrop, file.name, `${data.face_count} faces · ~${data.scale_mm} mm`);
    modelInfo.textContent = `${data.face_count} faces, échelle ~${data.scale_mm} mm`;
    loadModelGlb(data.glb_url, data.bounds);
    markStepDone("step-model");
    enableStep("step-logo", true);
  } catch (err) {
    modelInfo.textContent = "";
    setError(err.message);
  } finally {
    setBusy(false);
  }
});

// --- upload: logo -----------------------------------------------------------
const logoInput = document.getElementById("logo-input");
const logoDrop = document.getElementById("logo-drop");
const logoInfo = document.getElementById("logo-info");

wireDropzone(logoDrop, logoInput, async (file) => {
  if (!state.sessionId) { setError("importez d'abord un modèle 3D."); return; }
  setError("");
  logoInfo.textContent = "Import en cours…";
  setBusy(true, "Lecture du logo SVG…");
  const fd = new FormData();
  fd.append("file", file);
  fd.append("session_id", state.sessionId);
  try {
    const res = await fetch("/api/upload/logo", { method: "POST", body: fd });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'import");
    markDropzoneFilled(logoDrop, file.name, `${data.shapes.length} forme(s) détectée(s)`);
    logoInfo.textContent = `${data.logo_bounds.width} × ${data.logo_bounds.height} (unités SVG)`;
    state.hasLogo = true;
    state.logoShapes = data.shapes;
    state.excluded = new Set();
    editHistory.length = 0;
    state.flipH = false;
    state.flipV = false;
    document.getElementById("flip-h-btn").classList.remove("active");
    document.getElementById("flip-v-btn").classList.remove("active");
    renderEditor();
    markStepDone("step-logo");
    enableStep("step-logo-edit", true);
    enableStep("step-face", true);
  } catch (err) {
    logoInfo.textContent = "";
    setError(err.message);
  } finally {
    setBusy(false);
  }
});

// --- logo edit: shape picker, mirror ---------------------------------------------
// Cards are drawn in the whole logo's frame (see logo-editor.js), so each
// one shows WHERE its piece sits; the big preview is clickable.
// Every change is snapshotted first, so "Annuler" can put the previous
// selection back — cleaning a logo is trial and error.
const editHistory = [];

function applyEdit(mutate) {
  editHistory.push(new Set(state.excluded));
  if (editHistory.length > 30) editHistory.shift();
  mutate();
  renderEditor();
  syncLogoEdit();
}

function renderEditor() {
  renderLogoEditor({
    listHost: document.getElementById("shape-list"),
    previewHost: document.getElementById("combined-preview-wrap"),
    shapes: state.logoShapes,
    excluded: state.excluded,
    flipH: state.flipH,
    flipV: state.flipV,
    canUndo: editHistory.length > 0,
    onToggle: (index, included) => applyEdit(() => {
      if (included) state.excluded.delete(index);
      else state.excluded.add(index);
    }),
    onSetAll: (included) => applyEdit(() => {
      state.excluded = included ? new Set() : new Set(state.logoShapes.map((s) => s.index));
    }),
    onSetMany: (indices, included) => applyEdit(() => {
      for (const index of indices) {
        if (included) state.excluded.delete(index);
        else state.excluded.add(index);
      }
    }),
    onUndo: () => {
      const previous = editHistory.pop();
      if (!previous) return;
      state.excluded = previous;
      renderEditor();
      syncLogoEdit();
    },
  });
}

function includedShapeCount() {
  return state.logoShapes.filter((s) => !state.excluded.has(s.index)).length;
}

let logoEditTimer = null;
function syncLogoEdit() {
  if (logoEditTimer) clearTimeout(logoEditTimer);
  logoEditTimer = setTimeout(async () => {
    if (!state.sessionId) return;
    // Nothing left to extrude — the server would refuse, so say it here and
    // hold the export rather than letting it fail later.
    const exportBtn = document.getElementById("export-btn");
    if (state.hasLogo && includedShapeCount() === 0) {
      logoInfo.textContent = "Aucune forme incluse — rétablissez-en au moins une.";
      exportBtn.disabled = true;
      return;
    }
    if (state.faceIndex != null) exportBtn.disabled = false;
    try {
      const res = await fetch(`/api/session/${state.sessionId}/logo/edit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excluded: [...state.excluded], flip_h: state.flipH, flip_v: state.flipV,
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "échec de la mise à jour du logo");
      setError("");
      if (state.faceIndex != null) requestPreview();
    } catch (err) {
      setError(err.message);
    }
  }, 150);
}

document.getElementById("flip-h-btn").addEventListener("click", (e) => {
  state.flipH = !state.flipH;
  e.currentTarget.classList.toggle("active", state.flipH);
  renderEditor();
  syncLogoEdit();
});
document.getElementById("flip-v-btn").addEventListener("click", (e) => {
  state.flipV = !state.flipV;
  e.currentTarget.classList.toggle("active", state.flipV);
  renderEditor();
  syncLogoEdit();
});

// --- placement sliders ----------------------------------------------------------
const sliders = {
  width: document.getElementById("width"),
  rot: document.getElementById("rot"),
  dx: document.getElementById("dx"),
  dy: document.getElementById("dy"),
  depth: document.getElementById("depth"),
  sink: document.getElementById("sink"),
  fill: document.getElementById("fill"),
};

function updateReadout() {
  document.getElementById("width-val").textContent = `${parseFloat(sliders.width.value).toFixed(1)} mm`;
  document.getElementById("rot-val").textContent = `${sliders.rot.value}°`;
  document.getElementById("dx-val").textContent = `${parseFloat(sliders.dx.value).toFixed(1)} mm`;
  document.getElementById("dy-val").textContent = `${parseFloat(sliders.dy.value).toFixed(1)} mm`;
  document.getElementById("depth-val").textContent = `${parseFloat(sliders.depth.value).toFixed(1)} mm`;
  document.getElementById("sink-val").textContent = `${parseFloat(sliders.sink.value).toFixed(2)} mm`;
  document.getElementById("fill-val").textContent = `${parseFloat(sliders.fill.value).toFixed(2)} mm`;
}

let previewTimer = null;
function schedulePreview() {
  updateReadout();
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(requestPreview, 120);
}

async function requestPreview() {
  if (!state.sessionId || state.faceIndex == null) return;
  const placement = currentPlacement();
  try {
    const res = await fetch(`/api/session/${state.sessionId}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(placement),
    });
    if (!res.ok) {
      const data = await readJson(res);
      throw new Error(data.error || "échec de l'aperçu");
    }
    const buf = await res.arrayBuffer();
    loadPreviewGlb(buf);
    // The freshly loaded mesh's vertices already bake in this exact offset,
    // so instantaneous drag-feedback (see applyDragOffset) starts measuring
    // its on-screen delta from here, not from (0,0).
    previewBaseOffset = { x: placement.offset_x_mm, y: placement.offset_y_mm };
  } catch (err) {
    setError(err.message);
  }
}

function currentPlacement() {
  return {
    face_index: state.faceIndex,
    width_mm: parseFloat(sliders.width.value),
    rotation_deg: parseFloat(sliders.rot.value),
    offset_x_mm: parseFloat(sliders.dx.value),
    offset_y_mm: parseFloat(sliders.dy.value),
  };
}

[sliders.width, sliders.rot, sliders.dx, sliders.dy].forEach((el) =>
  el.addEventListener("input", schedulePreview));
[sliders.depth, sliders.sink, sliders.fill].forEach((el) =>
  el.addEventListener("input", updateReadout));

// --- fit to plate -------------------------------------------------------------
// Two ways to fill the plate: let the fit pick the best angle, or keep the
// orientation as placed. The second matters for anything with a horizon —
// text, a badge — where a few degrees of tilt reads as a mistake.
async function fitToPlate(btn, keepRotation) {
  if (!state.sessionId || state.faceIndex == null) return;
  setError("");
  btn.disabled = true;
  try {
    const body = { face_index: state.faceIndex };
    if (keepRotation) body.rotation_deg = parseFloat(sliders.rot.value);
    const res = await fetch(`/api/session/${state.sessionId}/logo/fit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'ajustement");
    if (data.width_mm > Number(sliders.width.max)) sliders.width.max = data.width_mm;
    sliders.width.value = data.width_mm;
    sliders.rot.value = data.rotation_deg;
    sliders.dx.value = 0;
    sliders.dy.value = 0;
    sliders.rot.dispatchEvent(new Event("input", { bubbles: true }));
    schedulePreview();
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("fit-btn").addEventListener("click", (ev) =>
  fitToPlate(ev.currentTarget, false));
document.getElementById("fit-keep-btn").addEventListener("click", (ev) =>
  fitToPlate(ev.currentTarget, true));

wireRotationPresets(document.getElementById("rot-presets"), sliders.rot, schedulePreview);

// --- face picking & drag-to-position ---------------------------------------------
// Clicking an unpicked area of the model selects the flat face under the
// cursor (as before). Once a logo preview sits on that face, grabbing the
// preview itself and dragging repositions it in real time — far more
// precise by eye than typing/nudging the offset sliders, which stay in
// sync (and still work) for exact numeric entry.
const raycaster = new THREE.Raycaster();
const CLICK_MOVE_THRESHOLD = 5; // px of pointer travel beyond which a press counts as a drag, not a click

let facePlane = null;                        // THREE.Plane of the selected flat region, world space
let faceOrigin = null, faceU = null, faceV = null; // THREE.Vector3
let dragging = false;
let pointerDownAt = { x: 0, y: 0 };
let previewBaseOffset = { x: 0, y: 0 };       // offset the CURRENT previewObject's geometry was built at

function ndcFromEvent(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function faceOffsetFromPointer(ev) {
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(facePlane, hit)) return null;
  const rel = hit.sub(faceOrigin);
  return { x: rel.dot(faceU), y: rel.dot(faceV) };
}

function applyDragOffset(off) {
  const dx = Math.max(Number(sliders.dx.min), Math.min(Number(sliders.dx.max), off.x));
  const dy = Math.max(Number(sliders.dy.min), Math.min(Number(sliders.dy.max), off.y));
  sliders.dx.value = dx;
  sliders.dy.value = dy;
  updateReadout();
  // Instant, purely client-side feedback: slide the already-loaded preview
  // mesh by the delta from where its geometry was actually baked, so it
  // tracks the cursor with zero latency. schedulePreview() (below) fetches
  // the authoritative re-extruded mesh shortly after movement settles.
  if (previewObject) {
    previewObject.position
      .copy(faceU).multiplyScalar(dx - previewBaseOffset.x)
      .addScaledVector(faceV, dy - previewBaseOffset.y);
  }
  schedulePreview();
}

function onDragMove(ev) {
  const off = faceOffsetFromPointer(ev);
  if (off) applyDragOffset(off);
}

function onDragEnd() {
  window.removeEventListener("pointermove", onDragMove);
  if (!dragging) return;
  dragging = false;
  controls.enabled = true;
  hintEl.textContent = "Glissez le logo pour l'ajuster, ou cliquez ailleurs pour changer de face.";
}

// A drag that barely moves (a precise nudge) still ends with a native
// 'click' firing right after 'pointerup' — by then `dragging` is already
// back to false, so the click's own movement check can't tell it apart
// from a real click. Flag it explicitly at drag-start instead, and
// consume the flag once, so even a 2px nudge can't be mistaken for a
// request to re-pick the face (which would silently discard it).
let suppressNextClick = false;

renderer.domElement.addEventListener("pointerdown", (ev) => {
  pointerDownAt = { x: ev.clientX, y: ev.clientY };
  if (!modelObject || !previewObject || !facePlane) return;
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  if (!raycaster.intersectObject(previewObject, false).length) return;

  dragging = true;
  suppressNextClick = true;
  controls.enabled = false;
  hintEl.textContent = "Glissez pour positionner le logo…";
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
});

renderer.domElement.addEventListener("click", async (ev) => {
  if (suppressNextClick) { suppressNextClick = false; return; }
  if (!modelObject) return;
  if (Math.hypot(ev.clientX - pointerDownAt.x, ev.clientY - pointerDownAt.y) > CLICK_MOVE_THRESHOLD) return;
  if (!state.hasLogo) {
    setError("importez d'abord un logo SVG avant de sélectionner une face.");
    return;
  }
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const hits = raycaster.intersectObject(modelObject, false);
  if (!hits.length || hits[0].faceIndex == null) {
    setError("aucune surface touchée à cet endroit — cliquez directement sur le modèle.");
    return;
  }

  setError("");
  document.getElementById("face-info").textContent = "Analyse de la face…";
  try {
    const res = await fetch(`/api/session/${state.sessionId}/face`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_index: hits[0].faceIndex }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de la sélection de face");
    state.faceIndex = data.face_index;
    state.faceInfo = data;
    faceOrigin = new THREE.Vector3(...data.origin);
    faceU = new THREE.Vector3(...data.u);
    faceV = new THREE.Vector3(...data.v);
    facePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(...data.normal), faceOrigin);
    document.getElementById("face-info").textContent =
      `Face plate: ${data.width.toFixed(1)} × ${data.height.toFixed(1)} mm ` +
      `(${data.face_count} triangles)`;
    const span = Math.max(data.width, data.height);
    const widthSlider = document.getElementById("width");
    widthSlider.max = span * 1.5;
    widthSlider.value = data.suggested_width_mm;
    sliders.dx.min = -span; sliders.dx.max = span; sliders.dx.value = 0;
    sliders.dy.min = -span; sliders.dy.max = span; sliders.dy.value = 0;
    markStepDone("step-logo-edit");
    markStepDone("step-face");
    enableStep("step-placement", true);
    enableStep("step-mode", true);
    enableStep("step-export", true);
    document.getElementById("export-btn").removeAttribute("disabled");
    updateReadout();
    requestPreview();
    hintEl.textContent = "Glissez le logo pour l'ajuster, ou cliquez ailleurs pour changer de face.";
  } catch (err) {
    document.getElementById("face-info").textContent = "Aucune face sélectionnée.";
    setError(err.message);
  }
});

// --- mode toggle ------------------------------------------------------------
// Gravé repairs a non-watertight mesh by itself at export time; say so up
// front, so a model that a slicer calls "broken" isn't a dead end here.
function updateWatertightHint() {
  const hint = document.getElementById("watertight-hint");
  if (!hint) return;
  const deboss = document.querySelector('input[name=mode]:checked')?.value === "deboss";
  hint.classList.toggle("hidden", !(deboss && !state.isVolume));
}

document.querySelectorAll('input[name=mode]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const deboss = document.querySelector('input[name=mode]:checked').value === "deboss";
    document.getElementById("field-sink").classList.toggle("hidden", deboss);
    document.getElementById("field-fill").classList.toggle("hidden", !deboss);
    updateWatertightHint();
  });
});

// --- export -------------------------------------------------------------------
document.getElementById("export-btn").addEventListener("click", async () => {
  if (!state.sessionId || state.faceIndex == null) return;
  setError("");
  const btn = document.getElementById("export-btn");
  btn.disabled = true;
  btn.textContent = "Export en cours…";
  const mode = document.querySelector('input[name=mode]:checked').value;
  const payload = {
    ...currentPlacement(),
    mode,
    depth_mm: parseFloat(sliders.depth.value),
    sink_mm: parseFloat(sliders.sink.value),
    fill_extra_mm: parseFloat(sliders.fill.value),
  };
  setBusy(true, mode === "deboss" ? "Découpe booléenne en cours…" : "Génération du 3MF…");
  try {
    const res = await fetch(`/api/session/${state.sessionId}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await readJson(res);
      throw new Error(data.error || "échec de l'export");
    }
    const repaired = res.headers.get("X-Autologo-Repairs");
    if (repaired) toastOk(`Maillage réparé automatiquement avant la découpe (${repaired}).`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "autologo.3mf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toastOk("3MF exporté — ouvrez-le dans votre trancheur.");
  } catch (err) {
    setError(err.message);
  } finally {
    setBusy(false);
    btn.disabled = false;
    btn.textContent = "⬇ Exporter en 3MF";
  }
});

// --- viewer toolbar ----------------------------------------------------------
// Orbiting past the model (easy to do on a trackpad) used to mean reloading
// the page to find it again.
document.getElementById("view-reset")?.addEventListener("click", () => {
  if (lastBounds) fitCameraTo(lastBounds);
});
document.getElementById("view-full")?.addEventListener("click", () => {
  const wrap = document.querySelector(".viewer-wrap");
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap?.requestFullscreen?.().catch(() => toastError("Plein écran refusé par le navigateur."));
});
document.addEventListener("fullscreenchange", () => setTimeout(resize, 60));
