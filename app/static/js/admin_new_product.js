import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { error: text ? text.slice(0, 200) : `erreur HTTP ${res.status}` }; }
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
const fillLight = new THREE.DirectionalLight(0xaac4ff, 0.6);
fillLight.position.set(-120, 60, -100);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.4);
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

let modelObject = null;
const gltfLoader = new GLTFLoader();

function fitCameraTo(bounds) {
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

function loadModelGlb(url, bounds) {
  gltfLoader.load(url, (gltf) => {
    if (modelObject) scene.remove(modelObject);
    let mesh = null;
    gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
    if (!mesh) { setError("l'assemblage chargé ne contient aucun maillage."); return; }
    mesh.material = pickModelMaterial(mesh);
    scene.add(mesh);
    modelObject = mesh;
    scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial));
    fitCameraTo(bounds);
    hintEl.textContent = "Cliquez sur une face plate pour ajouter une zone.";
  }, undefined, (err) => setError("échec du chargement de l'assemblage: " + err.message));
}

function addZoneMarker(face) {
  const geo = new THREE.PlaneGeometry(face.width, face.height);
  const mat = new THREE.MeshBasicMaterial({ color: 0x36d17a, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  const u = new THREE.Vector3(...face.u), v = new THREE.Vector3(...face.v), n = new THREE.Vector3(...face.normal);
  mesh.setRotationFromMatrix(new THREE.Matrix4().makeBasis(u, v, n));
  mesh.position.set(...face.origin).addScaledVector(n, 0.2);
  scene.add(mesh);
  return mesh;
}

// --- state -----------------------------------------------------------------
const state = { sessionId: null, currentFace: null, zones: [] };

function setError(msg) {
  document.getElementById("publish-error").textContent = msg || "";
}
function enableStep(id, on) {
  const el = document.getElementById(id);
  if (on) el.removeAttribute("disabled"); else el.setAttribute("disabled", "");
}

// --- upload assembly ---------------------------------------------------------
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
  dropEl.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
}

wireDropzone(modelDrop, modelInput, async (file) => {
  setError("");
  modelInfo.textContent = "Import en cours…";
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/admin/upload/assembly", { method: "POST", body: fd });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'import");
    state.sessionId = data.session_id;
    document.getElementById("model-drop-label").textContent = file.name;
    modelInfo.textContent = `${data.parts.length} pièce(s): ${data.parts.map((p) => p.name).join(", ")}`;
    loadModelGlb(data.glb_url, data.bounds);
    enableStep("step-zone", true);
  } catch (err) {
    modelInfo.textContent = "";
    setError(err.message);
  }
});

// --- face picking --------------------------------------------------------------
const raycaster = new THREE.Raycaster();

function ndcFromEvent(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

renderer.domElement.addEventListener("click", async (ev) => {
  if (!modelObject) return;
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const hits = raycaster.intersectObject(modelObject, false);
  if (!hits.length || hits[0].faceIndex == null) return;

  setError("");
  document.getElementById("face-info").textContent = "Analyse de la face…";
  try {
    const res = await fetch(`/api/admin/session/${state.sessionId}/face`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ face_index: hits[0].faceIndex }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de la sélection de face");
    state.currentFace = data;
    document.getElementById("face-info").textContent =
      `Pièce "${data.part_name}" — face ${data.width.toFixed(1)} × ${data.height.toFixed(1)} mm`;
    document.getElementById("zone-form").classList.remove("hidden");
    document.getElementById("zone-label").value = `Zone ${state.zones.length + 1}`;
  } catch (err) {
    document.getElementById("face-info").textContent = "Aucune face sélectionnée.";
    setError(err.message);
  }
});

// --- zone form -----------------------------------------------------------------
const zoneSliders = {
  depth: document.getElementById("zone-depth"),
  sink: document.getElementById("zone-sink"),
  fill: document.getElementById("zone-fill"),
};
function updateZoneReadout() {
  document.getElementById("zone-depth-val").textContent = `${parseFloat(zoneSliders.depth.value).toFixed(1)} mm`;
  document.getElementById("zone-sink-val").textContent = `${parseFloat(zoneSliders.sink.value).toFixed(2)} mm`;
  document.getElementById("zone-fill-val").textContent = `${parseFloat(zoneSliders.fill.value).toFixed(2)} mm`;
}
Object.values(zoneSliders).forEach((el) => el.addEventListener("input", updateZoneReadout));
updateZoneReadout();

document.querySelectorAll('input[name=zone-mode]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const deboss = document.querySelector('input[name=zone-mode]:checked').value === "deboss";
    document.getElementById("zone-field-sink").classList.toggle("hidden", deboss);
    document.getElementById("zone-field-fill").classList.toggle("hidden", !deboss);
  });
});

function renderZonesList() {
  const list = document.getElementById("zones-list");
  list.innerHTML = "";
  state.zones.forEach((z, i) => {
    const card = document.createElement("div");
    card.className = "zone-card";
    card.innerHTML =
      `<span>${z.label} — ${z.part_name} — ${z.mode === "emboss" ? "relief" : "gravé"}, ${z.depth_mm} mm</span>` +
      `<button type="button" class="zone-remove" title="Supprimer">✕</button>`;
    card.querySelector(".zone-remove").addEventListener("click", () => {
      scene.remove(z.marker);
      state.zones.splice(i, 1);
      renderZonesList();
      enableStep("step-publish", state.zones.length > 0);
    });
    list.appendChild(card);
  });
}

document.getElementById("add-zone-btn").addEventListener("click", () => {
  if (!state.currentFace) return;
  const mode = document.querySelector('input[name=zone-mode]:checked').value;
  const zone = {
    label: document.getElementById("zone-label").value.trim() || `Zone ${state.zones.length + 1}`,
    part_name: state.currentFace.part_name,
    mode,
    depth_mm: parseFloat(zoneSliders.depth.value),
    sink_mm: parseFloat(zoneSliders.sink.value),
    fill_extra_mm: parseFloat(zoneSliders.fill.value),
    face: {
      origin: state.currentFace.origin, normal: state.currentFace.normal,
      u: state.currentFace.u, v: state.currentFace.v,
      width: state.currentFace.width, height: state.currentFace.height,
    },
  };
  zone.marker = addZoneMarker(zone.face);
  state.zones.push(zone);
  renderZonesList();
  enableStep("step-zones-list", true);
  enableStep("step-publish", true);

  state.currentFace = null;
  document.getElementById("zone-form").classList.add("hidden");
  document.getElementById("face-info").textContent = "Aucune face sélectionnée.";
});

// --- publish -----------------------------------------------------------------
document.getElementById("publish-btn").addEventListener("click", async () => {
  if (!state.sessionId || !state.zones.length) return;
  setError("");
  const btn = document.getElementById("publish-btn");
  btn.disabled = true;
  btn.textContent = "Publication en cours…";
  try {
    const res = await fetch("/api/admin/products", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: state.sessionId,
        name: document.getElementById("product-name").value.trim(),
        export_mode: document.getElementById("export-mode").value,
        zones: state.zones.map(({ label, part_name, mode, depth_mm, sink_mm, fill_extra_mm, face }) =>
          ({ label, part_name, mode, depth_mm, sink_mm, fill_extra_mm, face })),
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de la publication");
    document.getElementById("result-url").value = data.customer_url;
    document.getElementById("result-admin-link").href = `/admin/products/${data.product_id}`;
    document.getElementById("publish-result").classList.remove("hidden");
    btn.textContent = "Produit publié ✓";
  } catch (err) {
    setError(err.message);
    btn.disabled = false;
    btn.textContent = "Publier le produit";
  }
});

document.getElementById("result-copy-btn").addEventListener("click", () => {
  const input = document.getElementById("result-url");
  input.select();
  navigator.clipboard?.writeText(input.value);
});
