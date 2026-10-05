import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  readJson, wireDropzone, markDropzoneFilled, enableStep, markStepDone,
  setBusy, copyText, toastError, toastOk,
} from "./ui.js";

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

let modelObject = null;
const gltfLoader = new GLTFLoader();

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

function addZoneMarker(face, color = 0x36d17a) {
  const geo = new THREE.PlaneGeometry(face.width, face.height);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  const u = new THREE.Vector3(...face.u), v = new THREE.Vector3(...face.v), n = new THREE.Vector3(...face.normal);
  mesh.setRotationFromMatrix(new THREE.Matrix4().makeBasis(u, v, n));
  mesh.position.set(...face.origin).addScaledVector(n, 0.2);
  scene.add(mesh);
  return mesh;
}

// --- state -----------------------------------------------------------------
// One screen serves both "new product" and "edit product". Editing skips the
// upload step — a published product's model is fixed, since its zones are
// pinned to that mesh's face indices — and starts from its stored zones.
const QR_MARKER = 0x5aa9ff;
const EDIT_PRODUCT_ID = document.body.dataset.productId || null;
const state = { sessionId: null, currentFace: null, zones: [], partIsVolume: true };

function setError(msg) {
  document.getElementById("publish-error").textContent = msg || "";
  if (msg) toastError(msg);
}

const modelInfo = document.getElementById("model-info");

// --- upload assembly (new product only) ---------------------------------------
const modelDrop = document.getElementById("model-drop");
if (modelDrop) {
  wireDropzone(modelDrop, document.getElementById("model-input"), async (file) => {
    setError("");
    modelInfo.textContent = "Import en cours…";
    setBusy(true, "Import de l'assemblage 3D…");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/admin/upload/assembly", { method: "POST", body: fd });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "échec de l'import");
      state.sessionId = data.session_id;
      markDropzoneFilled(modelDrop, file.name, `${data.parts.length} pièce(s) détectée(s)`);
      modelInfo.textContent = `${data.parts.length} pièce(s): ${data.parts.map((p) => p.name).join(", ")}`;
      loadModelGlb(data.glb_url, data.bounds);
      markStepDone("step-model");
      enableStep("step-zone", true);
    } catch (err) {
      modelInfo.textContent = "";
      setError(err.message);
    } finally {
      setBusy(false);
    }
  });
}

// --- edit mode: open a session on the product's already-stored model ----------
async function bootEditMode() {
  try {
    const res = await fetch(`/api/admin/products/${EDIT_PRODUCT_ID}/edit-session`, { method: "POST" });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec du chargement du produit");
    state.sessionId = data.session_id;
    modelInfo.textContent = `${data.parts.length} pièce(s): ${data.parts.map((p) => p.name).join(", ")}`;
    loadModelGlb(data.glb_url, data.bounds);

    document.getElementById("export-mode").value = document.body.dataset.exportMode || "assembly";
    for (const z of JSON.parse(document.body.dataset.zones || "[]")) {
      // Existing zones keep their id. The server then reuses their stored
      // face rather than re-resolving it, so renaming a zone or nudging a
      // depth can never move where it actually sits on the model.
      state.zones.push({ ...z, marker: addZoneMarker(z.face, z.kind === "qr" ? QR_MARKER : 0x36d17a) });
    }
    renderZonesList();
    refreshGroupOptions();
    markStepDone("step-model");
    markStepDone("step-zones-list", state.zones.length > 0);
    enableStep("step-zone", true);
    enableStep("step-zones-list", true);
    enableStep("step-publish", true);
  } catch (err) {
    modelInfo.textContent = "";
    setError(err.message);
  }
}

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
    state.partIsVolume = data.part_is_volume !== false;
    updateWatertightHint();
    document.getElementById("face-info").textContent =
      `Pièce "${data.part_name}" — face ${data.width.toFixed(1)} × ${data.height.toFixed(1)} mm`;
    document.getElementById("zone-form").classList.remove("hidden");
    resetLabel();
    refreshGroupOptions(groupSelect.value);
    initQrPlacement(data);
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

// A part that isn't watertight can still be engraved — the export repairs
// it — but the vendor should know before committing the zone to that mode.
function updateWatertightHint() {
  const hint = document.getElementById("watertight-hint");
  if (!hint) return;
  const deboss = document.querySelector('input[name=zone-mode]:checked')?.value === "deboss";
  hint.classList.toggle("hidden", !(deboss && state.partIsVolume === false));
}

document.querySelectorAll('input[name=zone-mode]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const deboss = document.querySelector('input[name=zone-mode]:checked').value === "deboss";
    document.getElementById("zone-field-sink").classList.toggle("hidden", deboss);
    document.getElementById("zone-field-fill").classList.toggle("hidden", !deboss);
    updateWatertightHint();
  });
});

// --- QR codes (vendor-placed) --------------------------------------------------
// A QR zone is a zone the vendor fills in completely: what it encodes, how big
// it is, where it sits. The customer never sees it; every order carries it.
const kindRadios = document.querySelectorAll('input[name=zone-kind]');
const qrEl = {
  text: document.getElementById("qr-text"),
  width: document.getElementById("qr-width"),
  x: document.getElementById("qr-x"),
  y: document.getElementById("qr-y"),
};
let qrRotation = 0;
let qrPreview = null;

const zoneKind = () => document.querySelector('input[name=zone-kind]:checked').value;

function resetLabel() {
  const qr = zoneKind() === "qr";
  const n = state.zones.filter((z) => (z.kind === "qr") === qr).length + 1;
  document.getElementById("zone-label").value = qr ? `QR code ${n}` : `Zone ${n}`;
}

function clearQrPreview() {
  if (qrPreview) { scene.remove(qrPreview); qrPreview = null; }
}

function updateQrReadout() {
  document.getElementById("qr-width-val").textContent = `${parseFloat(qrEl.width.value).toFixed(1)} mm`;
  document.getElementById("qr-x-val").textContent = `${parseFloat(qrEl.x.value).toFixed(1)} mm`;
  document.getElementById("qr-y-val").textContent = `${parseFloat(qrEl.y.value).toFixed(1)} mm`;
  document.querySelectorAll("#qr-rotations button").forEach((b) =>
    b.classList.toggle("btn-primary", parseFloat(b.dataset.rot) === qrRotation));
}

function setQrPlacement({ width, x, y, rotation }) {
  if (width != null) qrEl.width.value = width;
  if (x != null) qrEl.x.value = x;
  if (y != null) qrEl.y.value = y;
  if (rotation != null) qrRotation = rotation;
  updateQrReadout();
  scheduleQrPreview();
}

// The sliders span the picked face, so a QR can be dragged anywhere on it.
function initQrPlacement(face) {
  const reach = Math.ceil(Math.max(face.width, face.height) / 2) + 5;
  for (const el of [qrEl.x, qrEl.y]) { el.min = -reach; el.max = reach; }
  qrEl.width.max = Math.ceil(Math.max(face.width, face.height));
  const c = face.center || { x: 0, y: 0 };
  setQrPlacement({
    width: Math.max(5, Math.round(Math.min(face.width, face.height) * 0.6)),
    x: c.x, y: c.y, rotation: 0,
  });
}

function qrBody() {
  return {
    face_index: state.currentFace.face_index,
    text: qrEl.text.value,
    width_mm: parseFloat(qrEl.width.value),
    rotation_deg: qrRotation,
    offset_x_mm: parseFloat(qrEl.x.value),
    offset_y_mm: parseFloat(qrEl.y.value),
  };
}

let qrPreviewTimer = null;
let qrPreviewSeq = 0;
function scheduleQrPreview() {
  clearTimeout(qrPreviewTimer);
  qrPreviewTimer = setTimeout(refreshQrPreview, 150);
}

async function refreshQrPreview() {
  if (zoneKind() !== "qr" || !state.currentFace || !qrEl.text.value.trim()) { clearQrPreview(); return; }
  const seq = ++qrPreviewSeq;
  try {
    const res = await fetch(`/api/admin/session/${state.sessionId}/qr/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(qrBody()),
    });
    if (!res.ok) throw new Error((await readJson(res)).error || "aperçu impossible");
    const buf = await res.arrayBuffer();
    if (seq !== qrPreviewSeq) return;   // a newer request superseded this one
    gltfLoader.parse(buf, "", (gltf) => {
      if (seq !== qrPreviewSeq) return;
      clearQrPreview();
      gltf.scene.traverse((o) => {
        if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
      });
      qrPreview = gltf.scene;
      scene.add(qrPreview);
    }, (err) => toastError("aperçu du QR code illisible : " + err.message));
  } catch (err) {
    clearQrPreview();
    setError(err.message);
  }
}

function applyKind() {
  const qr = zoneKind() === "qr";
  document.getElementById("qr-fields").classList.toggle("hidden", !qr);
  document.getElementById("logo-fields").classList.toggle("hidden", qr);
  document.getElementById("add-zone-btn").textContent = qr ? "＋ Ajouter ce QR code" : "＋ Ajouter cette zone";
  document.getElementById("step-zone").querySelector("h2").lastChild.textContent =
    qr ? " Ajouter un QR code" : " Ajouter une zone";
  resetLabel();
  if (qr && state.currentFace) initQrPlacement(state.currentFace);
  if (!qr) clearQrPreview();
}
kindRadios.forEach((r) => r.addEventListener("change", applyKind));
[qrEl.text, qrEl.width, qrEl.x, qrEl.y].forEach((el) => el.addEventListener("input", () => {
  updateQrReadout();
  scheduleQrPreview();
}));
document.querySelectorAll("#qr-rotations button").forEach((b) =>
  b.addEventListener("click", () => setQrPlacement({ rotation: parseFloat(b.dataset.rot) })));
document.getElementById("qr-center").addEventListener("click", () => {
  const c = state.currentFace?.center;
  if (c) setQrPlacement({ x: c.x, y: c.y });
});
document.getElementById("qr-fit").addEventListener("click", async () => {
  if (!state.currentFace || !qrEl.text.value.trim()) { toastError("Saisissez d'abord le contenu du QR code."); return; }
  try {
    const res = await fetch(`/api/admin/session/${state.sessionId}/qr/fit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(qrBody()),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "ajustement impossible");
    setQrPlacement({ width: Math.max(5, Math.floor(data.width_mm * 2) / 2) });
  } catch (err) { setError(err.message); }
});
updateQrReadout();

// --- groups of identical faces ------------------------------------------------
// A group key is just its display label ("Groupe 1"): zones carrying the same
// one are the same face repeated, which is what lets the customer choose
// between one logo for all of them and one per face.
const groupSelect = document.getElementById("zone-group");

function existingGroups() {
  const keys = [];
  for (const z of state.zones) {
    if (z.group_key && !keys.includes(z.group_key)) keys.push(z.group_key);
  }
  return keys;
}

function refreshGroupOptions(selected = "") {
  const keys = existingGroups();
  groupSelect.innerHTML =
    '<option value="">Face indépendante</option>' +
    keys.map((k) => `<option value="${k}">${k}</option>`).join("") +
    '<option value="__new__">＋ Nouveau groupe de faces identiques</option>';
  groupSelect.value = keys.includes(selected) ? selected : "";
}

groupSelect.addEventListener("change", () => {
  if (groupSelect.value !== "__new__") return;
  const keys = existingGroups();
  let n = keys.length + 1;
  while (keys.includes(`Groupe ${n}`)) n += 1;
  const key = `Groupe ${n}`;
  refreshGroupOptions(key);
  // The new group has no zone yet, so refreshGroupOptions can't list it —
  // add it by hand and keep it selected for the zone about to be added.
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = key;
  groupSelect.insertBefore(opt, groupSelect.lastElementChild);
  groupSelect.value = key;
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderZonesList() {
  const list = document.getElementById("zones-list");
  list.innerHTML = "";
  state.zones.forEach((z, i) => {
    const card = document.createElement("div");
    card.className = "zone-card";
    const qrBadge = z.kind === "qr"
      ? ` <span class="badge badge-accent">QR · ${escapeHtml(z.qr_text.length > 28 ? z.qr_text.slice(0, 28) + "…" : z.qr_text)}</span>`
      : "";
    card.innerHTML =
      `<span>${escapeHtml(z.label)} — ${z.part_name} — ${z.mode === "emboss" ? "relief" : "gravé"}, ${z.depth_mm} mm` +
      qrBadge +
      (z.group_key ? ` <span class="badge badge-accent">${z.group_key}</span>` : "") +
      `</span><button type="button" class="zone-remove" title="Retirer">✕</button>`;
    card.querySelector(".zone-remove").addEventListener("click", () => {
      scene.remove(z.marker);
      state.zones.splice(i, 1);
      renderZonesList();
      markStepDone("step-zones-list", state.zones.length > 0);
      enableStep("step-publish", state.zones.length > 0);
      resetLabel();
    });
    list.appendChild(card);
  });
}

document.getElementById("add-zone-btn").addEventListener("click", () => {
  if (!state.currentFace) return;
  const mode = document.querySelector('input[name=zone-mode]:checked').value;
  const isQr = zoneKind() === "qr";
  if (isQr && !qrEl.text.value.trim()) { setError("Saisissez l'adresse ou le texte du QR code."); return; }
  const zone = {
    kind: isQr ? "qr" : "logo",
    ...(isQr ? {
      qr_text: qrEl.text.value.trim(),
      qr_width_mm: parseFloat(qrEl.width.value),
      qr_rotation_deg: qrRotation,
      qr_offset_x_mm: parseFloat(qrEl.x.value),
      qr_offset_y_mm: parseFloat(qrEl.y.value),
    } : {}),
    label: document.getElementById("zone-label").value.trim() || `Zone ${state.zones.length + 1}`,
    part_name: state.currentFace.part_name,
    group_key: isQr || groupSelect.value === "__new__" ? "" : groupSelect.value,
    mode,
    depth_mm: parseFloat(zoneSliders.depth.value),
    sink_mm: parseFloat(zoneSliders.sink.value),
    fill_extra_mm: parseFloat(zoneSliders.fill.value),
    // Only the index goes to the server — it re-resolves the face itself, so
    // the stored zone can't be missing anything the client didn't echo back.
    face_index: state.currentFace.face_index,
    // kept locally just to draw the zone marker in the viewer
    face: {
      origin: state.currentFace.origin, normal: state.currentFace.normal,
      u: state.currentFace.u, v: state.currentFace.v,
      width: state.currentFace.width, height: state.currentFace.height,
    },
  };
  zone.marker = addZoneMarker(zone.face, isQr ? QR_MARKER : 0x36d17a);
  state.zones.push(zone);
  renderZonesList();
  markStepDone("step-zone");
  markStepDone("step-zones-list");
  enableStep("step-zones-list", true);
  enableStep("step-publish", true);

  state.currentFace = null;
  clearQrPreview();
  qrEl.text.value = "";
  document.getElementById("zone-form").classList.add("hidden");
  document.getElementById("face-info").textContent = "Aucune face sélectionnée.";
  // Adding the other faces of the same group is the common next step, so the
  // picker stays on the group that was just used.
  refreshGroupOptions(zone.group_key);
});

// --- publish / save -----------------------------------------------------------
document.getElementById("publish-btn").addEventListener("click", async () => {
  if (!state.sessionId || !state.zones.length) return;
  if (!state.zones.some((z) => z.kind !== "qr")) {
    setError("Ajoutez au moins une zone de logo : un QR code seul ne suffit pas.");
    return;
  }
  setError("");
  const btn = document.getElementById("publish-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = EDIT_PRODUCT_ID ? "Enregistrement…" : "Publication en cours…";
  setBusy(true, EDIT_PRODUCT_ID ? "Enregistrement du produit…" : "Publication du produit…");
  try {
    const url = EDIT_PRODUCT_ID ? `/api/admin/products/${EDIT_PRODUCT_ID}` : "/api/admin/products";
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: state.sessionId,
        name: document.getElementById("product-name").value.trim(),
        export_mode: document.getElementById("export-mode").value,
        // `id` marks a zone that already exists: the server keeps its stored
        // face and only updates the editable fields. `face_index` marks a
        // newly picked one, which the server resolves itself.
        zones: state.zones.map(({ id, label, mode, depth_mm, sink_mm, fill_extra_mm,
                                  face_index, group_key, kind, qr_text, qr_width_mm,
                                  qr_rotation_deg, qr_offset_x_mm, qr_offset_y_mm }) =>
          ({ id, label, mode, depth_mm, sink_mm, fill_extra_mm, face_index, group_key, kind,
             qr_text, qr_width_mm, qr_rotation_deg, qr_offset_x_mm, qr_offset_y_mm })),
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'enregistrement");
    document.getElementById("result-url").value = data.customer_url;
    document.getElementById("result-admin-link").href = `/admin/products/${data.product_id}`;
    document.getElementById("publish-result").classList.remove("hidden");
    btn.textContent = EDIT_PRODUCT_ID ? "Modifications enregistrées ✓" : "Produit publié ✓";
    markStepDone("step-publish");
    toastOk(EDIT_PRODUCT_ID ? "Modifications enregistrées."
                             : "Produit publié — le lien client est prêt à partager.");
  } catch (err) {
    setError(err.message);
    btn.disabled = false;
    btn.textContent = originalLabel;
  } finally {
    setBusy(false);
  }
});

document.getElementById("result-copy-btn").addEventListener("click", (ev) => {
  const input = document.getElementById("result-url");
  input.select();
  copyText(input.value, ev.currentTarget);
});

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

if (EDIT_PRODUCT_ID) bootEditMode();
