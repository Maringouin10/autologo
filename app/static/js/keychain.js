/* The keychain page (/keychain): an SVG logo, a plate cut around it with a
   ring tab, exported as a multi-object 3MF. No model to upload — the server
   builds the whole piece, so the viewer only ever shows its preview GLB. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  readJson, wireDropzone, markDropzoneFilled, enableStep, markStepDone,
  setBusy, toastError, toastOk, wireRotationPresets,
} from "./ui.js";
import { renderLogoEditor } from "./logo-editor.js";

// --- three.js scene ------------------------------------------------------------
const viewerEl = document.getElementById("viewer");
const hintEl = document.getElementById("viewer-hint");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
camera.position.set(0, 80, 60);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
viewerEl.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 1.1));
scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 2.0));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
keyLight.position.set(100, 200, 150);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xcfe0ff, 1.5);
fillLight.position.set(-120, 60, -100);
scene.add(fillLight);
scene.add(new THREE.GridHelper(400, 40, 0x2a2f3a, 0x1c2029));

function resize() {
  const w = viewerEl.clientWidth, h = viewerEl.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// The preview GLB carries no normals: flat shading derives them per facet,
// which is exactly right for a piece made of flat faces.
const material = new THREE.MeshStandardMaterial({
  color: 0xffffff, metalness: 0.05, roughness: 0.55, vertexColors: true, flatShading: true,
});
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.35 });
const gltfLoader = new GLTFLoader();
let shown = null;
let lastBox = null;

function fitCamera(box) {
  lastBox = box;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
  controls.target.copy(center);
  // From above and slightly in front: a keychain is read from its top.
  camera.position.copy(center).add(new THREE.Vector3(0, radius * 2.4, radius * 1.5));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function showGlb(buffer) {
  gltfLoader.parse(buffer, "", (gltf) => {
    let mesh = null;
    gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) return;
    mesh.material = material;
    const group = new THREE.Group();
    group.add(mesh);
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial));
    const first = !shown;
    if (shown) scene.remove(shown);
    scene.add(group);
    shown = group;
    if (first) fitCamera(new THREE.Box3().setFromObject(group));
    hintEl.classList.add("hidden");
  });
}

// --- state ------------------------------------------------------------------------
const state = {
  sessionId: null,
  logoName: "",
  shapes: [],
  excluded: new Set(),
  flipH: false,
  flipV: false,
};

const sliders = {
  width: ["kc-width", " mm"],
  border: ["kc-border", " mm"],
  base: ["kc-base", " mm"],
  relief: ["kc-relief", " mm"],
  angle: ["kc-angle", "°"],
  hole: ["kc-hole", " mm"],
  wall: ["kc-wall", " mm"],
};
const el = (id) => document.getElementById(id);
const value = (key) => parseFloat(el(sliders[key][0]).value);

function syncLabels() {
  for (const [id, unit] of Object.values(sliders)) {
    el(`${id}-val`).textContent = el(id).value + unit;
  }
  el("ring-fields").classList.toggle("hidden", !el("kc-ring").checked);
}

function params() {
  return {
    width_mm: value("width"),
    border_mm: value("border"),
    base_mm: value("base"),
    relief_mm: value("relief"),
    ring: el("kc-ring").checked,
    ring_angle_deg: value("angle"),
    hole_mm: value("hole"),
    ring_wall_mm: value("wall"),
    fill_holes: el("kc-fill").checked,
    base_color: el("kc-color").value,
  };
}

// --- preview -------------------------------------------------------------------
// Debounced, and only the latest answer is drawn: a slider drag fires many
// requests and an older, slower one must not overwrite a newer preview.
let previewTimer = null;
let previewSeq = 0;
function requestPreview() {
  if (!state.sessionId) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const seq = ++previewSeq;
    try {
      const res = await fetch(`/api/keychain/${state.sessionId}/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params()),
      });
      if (!res.ok) throw new Error((await readJson(res)).error || "échec de l'aperçu");
      const size = res.headers.get("X-Keychain-Size");
      const buffer = await res.arrayBuffer();
      if (seq !== previewSeq) return;
      if (size) {
        const [w, h] = size.split("x");
        el("kc-size").textContent = `Taille finale : ${w} × ${h} mm`;
      }
      showGlb(buffer);
    } catch (err) {
      if (seq === previewSeq) toastError(err.message);
    }
  }, 120);
}

syncLabels();
for (const [id] of Object.values(sliders)) {
  el(id).addEventListener("input", () => { syncLabels(); requestPreview(); });
}
for (const id of ["kc-ring", "kc-fill", "kc-color"]) {
  el(id).addEventListener("input", () => { syncLabels(); requestPreview(); });
}
wireRotationPresets(el("ring-presets"), el("kc-angle"), () => { syncLabels(); requestPreview(); });

// --- logo upload -----------------------------------------------------------------
const logoDrop = el("logo-drop");
wireDropzone(logoDrop, el("logo-input"), async (file) => {
  setBusy(true, "Lecture du logo…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/keychain/logo", { method: "POST", body: fd });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'import du logo");
    Object.assign(state, {
      sessionId: data.session_id, logoName: file.name, shapes: data.shapes,
      excluded: new Set(), flipH: false, flipV: false,
    });
    editHistory.length = 0;
    el("flip-h-btn").classList.remove("active");
    el("flip-v-btn").classList.remove("active");
    if (shown) { scene.remove(shown); shown = null; }
    markDropzoneFilled(logoDrop, file.name, `${data.shapes.length} forme(s) · cliquez pour remplacer`);
    markStepDone("step-logo");
    for (const id of ["step-logo-edit", "step-shape", "step-export"]) enableStep(id, true);
    renderEditor();
    requestPreview();
  } catch (err) {
    toastError(err.message);
  } finally {
    setBusy(false);
  }
});

// --- logo edit ---------------------------------------------------------------------
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
    listHost: el("shape-list"),
    previewHost: el("combined-preview-wrap"),
    shapes: state.shapes,
    excluded: state.excluded,
    flipH: state.flipH,
    flipV: state.flipV,
    canUndo: editHistory.length > 0,
    onToggle: (index, included) => applyEdit(() => {
      if (included) state.excluded.delete(index);
      else state.excluded.add(index);
    }),
    onSetAll: (included) => applyEdit(() => {
      state.excluded = included ? new Set() : new Set(state.shapes.map((s) => s.index));
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

let editTimer = null;
function syncLogoEdit() {
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    const empty = state.shapes.every((s) => state.excluded.has(s.index));
    el("export-btn").disabled = empty;
    if (empty) {
      toastError("Aucune forme incluse — rétablissez-en au moins une.");
      return;
    }
    try {
      const res = await fetch(`/api/session/${state.sessionId}/logo/edit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excluded: [...state.excluded], flip_h: state.flipH, flip_v: state.flipV,
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "échec de la mise à jour du logo");
      requestPreview();
    } catch (err) {
      toastError(err.message);
    }
  }, 150);
}

for (const [id, key] of [["flip-h-btn", "flipH"], ["flip-v-btn", "flipV"]]) {
  el(id).addEventListener("click", (e) => {
    state[key] = !state[key];
    e.currentTarget.classList.toggle("active", state[key]);
    renderEditor();
    syncLogoEdit();
  });
}

// --- export ----------------------------------------------------------------------
el("export-btn").addEventListener("click", async () => {
  if (!state.sessionId) return;
  const btn = el("export-btn");
  btn.disabled = true;
  btn.textContent = "Export en cours…";
  setBusy(true, "Génération du 3MF…");
  try {
    const res = await fetch(`/api/keychain/${state.sessionId}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params()),
    });
    if (!res.ok) throw new Error((await readJson(res)).error || "échec de l'export");
    const blob = await res.blob();
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") || "");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = match ? decodeURIComponent(match[1]) : "porte-cle.3mf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    markStepDone("step-export");
    toastOk("3MF exporté — ouvrez-le dans votre trancheur.");
  } catch (err) {
    toastError(err.message);
  } finally {
    setBusy(false);
    btn.disabled = false;
    btn.textContent = "⬇ Exporter en 3MF";
  }
});

// --- viewer toolbar ----------------------------------------------------------------
el("view-reset").addEventListener("click", () => { if (lastBox) fitCamera(lastBox); });
el("view-full").addEventListener("click", () => {
  const wrap = document.querySelector(".viewer-wrap");
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap?.requestFullscreen?.().catch(() => toastError("Plein écran refusé par le navigateur."));
});
document.addEventListener("fullscreenchange", () => setTimeout(resize, 60));
