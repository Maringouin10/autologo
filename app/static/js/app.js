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

// --- face picking ---------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("click", async (ev) => {
  if (!modelObject) return;
  if (!state.hasLogo) {
    setError("importez d'abord un logo SVG avant de sélectionner une face.");
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
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
    document.getElementById("face-info").textContent =
      `Face plate: ${data.width.toFixed(1)} × ${data.height.toFixed(1)} mm ` +
      `(${data.face_count} triangles)`;
    const widthSlider = document.getElementById("width");
    widthSlider.max = Math.max(data.width, data.height) * 1.5;
    widthSlider.value = data.suggested_width_mm;
    enableStep("step-placement", true);
    enableStep("step-mode", true);
    enableStep("step-export", true);
    document.getElementById("export-btn").removeAttribute("disabled");
    updateReadout();
    requestPreview();
  } catch (err) {
    document.getElementById("face-info").textContent = "Aucune face sélectionnée.";
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
  try {
    const res = await fetch(`/api/session/${state.sessionId}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentPlacement()),
    });
    if (!res.ok) {
      const data = await readJson(res);
      throw new Error(data.error || "échec de l'aperçu");
    }
    const buf = await res.arrayBuffer();
    loadPreviewGlb(buf);
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
