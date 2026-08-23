import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// The backend always answers JSON, even on error (see main.py's error
// handler) — but if something ever slips through (a proxy's own error
// page, a network failure), don't let `res.json()`'s SyntaxError surface
// as a cryptic "Unexpected token '<'"; show a real message instead.
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text ? text.slice(0, 200) : `erreur HTTP ${res.status}` };
  }
}

// --- three.js scene setup ----------------------------------------------------
const viewerEl = document.getElementById("viewer");
const hintEl = document.getElementById("viewer-hint");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
camera.position.set(80, 80, 80);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewerEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.0));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(100, 200, 150);
scene.add(keyLight);
// A single key light flattens relief into a silhouette — a dimmer light
// from the opposite side gives every facet its own shade instead of one
// flat tone, which is what actually makes bumps/engraving readable.
const fillLight = new THREE.DirectionalLight(0xaac4ff, 0.6);
fillLight.position.set(-120, 60, -100);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.4);
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
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.35 });
const previewMaterial = new THREE.MeshStandardMaterial({
  color: 0x36d17a, metalness: 0.1, roughness: 0.5,
  transparent: true, opacity: 0.9, depthTest: true,
});

let modelObject = null;   // THREE.Mesh of the loaded base model
let modelEdges = null;    // THREE.LineSegments outlining modelObject's facets
let previewObject = null; // THREE.Mesh of the live logo placement preview
const gltfLoader = new GLTFLoader();

function fitCameraTo(bounds) {
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
    mesh.material = modelMaterial;
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
    mesh.material = previewMaterial;
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
};

function setError(msg) {
  document.getElementById("export-error").textContent = msg || "";
}

function enableStep(id, on) {
  const el = document.getElementById(id);
  if (on) el.removeAttribute("disabled"); else el.setAttribute("disabled", "");
}

// --- upload: model --------------------------------------------------------------
const modelInput = document.getElementById("model-input");
const modelDrop = document.getElementById("model-drop");
const modelInfo = document.getElementById("model-info");

function wireDropzone(dropEl, inputEl, onFile) {
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

wireDropzone(modelDrop, modelInput, async (file) => {
  setError("");
  modelInfo.textContent = "Import en cours…";
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload/model", { method: "POST", body: fd });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'import");
    state.sessionId = data.session_id;
    document.getElementById("model-drop-label").textContent = file.name;
    modelInfo.textContent = `${data.face_count} faces, échelle ~${data.scale_mm} mm`;
    loadModelGlb(data.glb_url, data.bounds);
    enableStep("step-logo", true);
  } catch (err) {
    modelInfo.textContent = "";
    setError(err.message);
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
  const fd = new FormData();
  fd.append("file", file);
  fd.append("session_id", state.sessionId);
  try {
    const res = await fetch("/api/upload/logo", { method: "POST", body: fd });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'import");
    document.getElementById("logo-drop-label").textContent = file.name;
    logoInfo.textContent = `${data.logo_bounds.width} × ${data.logo_bounds.height} (unités SVG)`;
    state.hasLogo = true;
    enableStep("step-face", true);
  } catch (err) {
    logoInfo.textContent = "";
    setError(err.message);
  }
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
document.querySelectorAll('input[name=mode]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const deboss = document.querySelector('input[name=mode]:checked').value === "deboss";
    document.getElementById("field-sink").classList.toggle("hidden", deboss);
    document.getElementById("field-fill").classList.toggle("hidden", !deboss);
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
  try {
    const res = await fetch(`/api/session/${state.sessionId}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await readJson(res);
      throw new Error(data.error || "échec de l'export");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "autologo.3mf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Exporter en 3MF";
  }
});
