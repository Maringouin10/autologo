import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const PRODUCT_ID = document.body.dataset.productId;

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
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.35 });
const previewMaterial = new THREE.MeshStandardMaterial({
  color: 0x36d17a, metalness: 0.1, roughness: 0.5, transparent: true, opacity: 0.9,
});

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

const gltfLoader = new GLTFLoader();
function loadAssembly(url, bounds) {
  gltfLoader.load(url, (gltf) => {
    let mesh = null;
    gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
    if (!mesh) return;
    mesh.material = modelMaterial;
    scene.add(mesh);
    scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial));
    fitCameraTo(bounds);
    hintEl.textContent = "Glissez votre logo dans la zone en surbrillance.";
  }, undefined, (err) => { hintEl.textContent = "échec du chargement du modèle: " + err.message; });
}

// --- shape-picker helpers (svg thumbnails) --------------------------------------
function ringsToPathD(rings) {
  return rings.map((ring) => {
    const [first, ...rest] = ring;
    return `M${first[0]},${first[1]} ` + rest.map((p) => `L${p[0]},${p[1]}`).join(" ") + " Z";
  }).join(" ");
}
function shapeSvg(shapes, cssClass) {
  if (!shapes.length) return "";
  const minx = Math.min(...shapes.map((s) => s.bbox[0]));
  const miny = Math.min(...shapes.map((s) => s.bbox[1]));
  const maxx = Math.max(...shapes.map((s) => s.bbox[2]));
  const maxy = Math.max(...shapes.map((s) => s.bbox[3]));
  const w = Math.max(maxx - minx, 1e-3), h = Math.max(maxy - miny, 1e-3);
  const pad = Math.max(w, h) * 0.08;
  const vb = `${minx - pad} ${miny - pad} ${w + 2 * pad} ${h + 2 * pad}`;
  const path = shapes.map((s) => ringsToPathD(s.rings)).join(" ");
  return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">` +
    `<path class="${cssClass}" fill-rule="evenodd" d="${path}"/></svg>`;
}

// --- drag registry: any zone's preview mesh can be grabbed ----------------------
const dragRegistry = new Map(); // THREE.Mesh -> zone controller
const raycaster = new THREE.Raycaster();
function ndcFromEvent(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

let dragging = null; // the zone controller currently being dragged, or null
renderer.domElement.addEventListener("pointerdown", (ev) => {
  const objs = [...dragRegistry.keys()];
  if (!objs.length) return;
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const hits = raycaster.intersectObjects(objs, false);
  if (!hits.length) return;
  const zone = dragRegistry.get(hits[0].object);
  if (!zone) return;
  dragging = zone;
  controls.enabled = false;
  hintEl.textContent = "Glissez pour positionner le logo…";
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
});

function onDragMove(ev) {
  if (!dragging) return;
  raycaster.setFromCamera(ndcFromEvent(ev), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(dragging.plane, hit)) return;
  const rel = hit.sub(dragging.origin);
  dragging.applyDragOffset(rel.dot(dragging.u), rel.dot(dragging.v));
}
function onDragEnd() {
  window.removeEventListener("pointermove", onDragMove);
  if (!dragging) return;
  dragging = null;
  controls.enabled = true;
  hintEl.textContent = "Glissez le logo pour l'ajuster.";
}

// --- one controller per zone -----------------------------------------------
function makeZoneController(z) {
  const origin = new THREE.Vector3(...z.origin);
  const normal = new THREE.Vector3(...z.normal);
  const u = new THREE.Vector3(...z.u);
  const v = new THREE.Vector3(...z.v);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);

  const el = document.createElement("div");
  el.className = "zone-block";
  el.innerHTML = `
    <h2>${z.label}</h2>
    <p class="zone-status">Aucun logo importé.</p>
    <label class="dropzone zone-drop">
      <input type="file" accept=".svg" hidden class="zone-file-input">
      <span class="zone-drop-label">Fichier .svg — cliquez ou déposez</span>
    </label>
    <div class="zone-edit hidden">
      <p class="hint">Décochez une forme pour l'exclure.</p>
      <div class="shape-list zone-shape-list"></div>
      <div class="flip-row">
        <button type="button" class="toggle-btn zone-flip-h">⇋ Miroir horizontal</button>
        <button type="button" class="toggle-btn zone-flip-v">⇵ Miroir vertical</button>
      </div>
      <div class="combined-preview zone-combined-wrap"><svg></svg></div>
    </div>
    <div class="zone-placement hidden">
      <button type="button" class="zone-fit-btn">⤢ Ajuster à la plaque (max)</button>
      <div class="field">
        <label>Largeur (mm) <span class="zone-width-val"></span></label>
        <input type="range" class="zone-width" min="1" max="${Math.max(z.width, z.height) * 1.5}" step="0.5" value="${z.suggested_width_mm}">
      </div>
      <div class="field">
        <label>Rotation (°) <span class="zone-rot-val"></span></label>
        <input type="range" class="zone-rot" min="0" max="360" step="1" value="0">
      </div>
      <div class="field">
        <label>Décalage X (mm) <span class="zone-dx-val"></span></label>
        <input type="range" class="zone-dx" min="${-z.width}" max="${z.width}" step="0.2" value="0">
      </div>
      <div class="field">
        <label>Décalage Y (mm) <span class="zone-dy-val"></span></label>
        <input type="range" class="zone-dy" min="${-z.height}" max="${z.height}" step="0.2" value="0">
      </div>
    </div>
  `;

  const ctl = {
    id: z.id, el, origin, normal, u, v, plane,
    hasLogo: false, shapes: [], excluded: new Set(), flipH: false, flipV: false,
    previewObject: null, previewBaseOffset: { x: 0, y: 0 },
  };

  const status = el.querySelector(".zone-status");
  const sliders = {
    width: el.querySelector(".zone-width"), rot: el.querySelector(".zone-rot"),
    dx: el.querySelector(".zone-dx"), dy: el.querySelector(".zone-dy"),
  };
  function updateReadout() {
    el.querySelector(".zone-width-val").textContent = `${parseFloat(sliders.width.value).toFixed(1)} mm`;
    el.querySelector(".zone-rot-val").textContent = `${sliders.rot.value}°`;
    el.querySelector(".zone-dx-val").textContent = `${parseFloat(sliders.dx.value).toFixed(1)} mm`;
    el.querySelector(".zone-dy-val").textContent = `${parseFloat(sliders.dy.value).toFixed(1)} mm`;
  }
  updateReadout();

  function currentParams() {
    return {
      width_mm: parseFloat(sliders.width.value), rotation_deg: parseFloat(sliders.rot.value),
      offset_x_mm: parseFloat(sliders.dx.value), offset_y_mm: parseFloat(sliders.dy.value),
    };
  }

  function loadPreviewGlb(buf) {
    const loader = new GLTFLoader();
    loader.parse(buf, "", (gltf) => {
      if (ctl.previewObject) { scene.remove(ctl.previewObject); dragRegistry.delete(ctl.previewObject); }
      let mesh = null;
      gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
      if (!mesh) return;
      mesh.material = previewMaterial;
      scene.add(mesh);
      ctl.previewObject = mesh;
      dragRegistry.set(mesh, ctl);
    });
  }

  let previewTimer = null;
  function schedulePreview() {
    updateReadout();
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(requestPreview, 120);
  }

  async function requestPreview() {
    if (!ctl.hasLogo) return;
    const placement = currentParams();
    try {
      const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(placement),
      });
      if (!res.ok) { const d = await readJson(res); throw new Error(d.error || "échec de l'aperçu"); }
      const buf = await res.arrayBuffer();
      loadPreviewGlb(buf);
      ctl.previewBaseOffset = { x: placement.offset_x_mm, y: placement.offset_y_mm };
      updateSubmitState();
    } catch (err) {
      setGlobalError(err.message);
    }
  }
  ctl.requestPreview = requestPreview;

  ctl.applyDragOffset = (offX, offY) => {
    const dx = Math.max(Number(sliders.dx.min), Math.min(Number(sliders.dx.max), offX));
    const dy = Math.max(Number(sliders.dy.min), Math.min(Number(sliders.dy.max), offY));
    sliders.dx.value = dx;
    sliders.dy.value = dy;
    updateReadout();
    if (ctl.previewObject) {
      ctl.previewObject.position
        .copy(u).multiplyScalar(dx - ctl.previewBaseOffset.x)
        .addScaledVector(v, dy - ctl.previewBaseOffset.y);
    }
    schedulePreview();
  };

  [sliders.width, sliders.rot, sliders.dx, sliders.dy].forEach((s) => s.addEventListener("input", schedulePreview));

  // --- logo upload ---
  const drop = el.querySelector(".zone-drop");
  const fileInput = el.querySelector(".zone-file-input");
  drop.addEventListener("click", () => fileInput.click());
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  async function handleFile(file) {
    setGlobalError("");
    status.textContent = "Import en cours…";
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/logo`, { method: "POST", body: fd });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "échec de l'import");
      el.querySelector(".zone-drop-label").textContent = file.name;
      ctl.hasLogo = true;
      ctl.shapes = data.shapes;
      ctl.excluded = new Set();
      ctl.flipH = false;
      ctl.flipV = false;
      el.querySelector(".zone-flip-h").classList.remove("active");
      el.querySelector(".zone-flip-v").classList.remove("active");
      renderShapeList();
      renderCombinedPreview();
      el.querySelector(".zone-edit").classList.remove("hidden");
      el.querySelector(".zone-placement").classList.remove("hidden");
      status.textContent = "Logo importé.";
      status.classList.add("ready");
      requestPreview();
    } catch (err) {
      status.textContent = "";
      setGlobalError(err.message);
    }
  }
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  // --- shape edit / flip ---
  function renderShapeList() {
    const list = el.querySelector(".zone-shape-list");
    list.innerHTML = "";
    for (const shape of ctl.shapes) {
      const card = document.createElement("label");
      card.className = "shape-card" + (ctl.excluded.has(shape.index) ? " excluded" : "");
      card.innerHTML = `<input type="checkbox" ${ctl.excluded.has(shape.index) ? "" : "checked"}>` + shapeSvg([shape], "shape-fill");
      card.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) ctl.excluded.delete(shape.index); else ctl.excluded.add(shape.index);
        card.classList.toggle("excluded", !e.target.checked);
        renderCombinedPreview();
        syncEdit();
      });
      list.appendChild(card);
    }
  }
  function renderCombinedPreview() {
    const active = ctl.shapes.filter((s) => !ctl.excluded.has(s.index));
    const wrap = el.querySelector(".zone-combined-wrap");
    wrap.innerHTML = active.length ? shapeSvg(active, "shape-fill") : '<p class="hint">(aucune forme incluse)</p>';
    const svg = wrap.querySelector("svg");
    if (svg) svg.style.transform = `scale(${ctl.flipH ? -1 : 1}, ${ctl.flipV ? -1 : 1})`;
  }
  let editTimer = null;
  function syncEdit() {
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/edit`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ excluded: [...ctl.excluded], flip_h: ctl.flipH, flip_v: ctl.flipV }),
        });
        const data = await readJson(res);
        if (!res.ok) throw new Error(data.error || "échec de la mise à jour");
        setGlobalError("");
        requestPreview();
      } catch (err) {
        setGlobalError(err.message);
      }
    }, 150);
  }
  el.querySelector(".zone-flip-h").addEventListener("click", (e) => {
    ctl.flipH = !ctl.flipH;
    e.currentTarget.classList.toggle("active", ctl.flipH);
    renderCombinedPreview();
    syncEdit();
  });
  el.querySelector(".zone-flip-v").addEventListener("click", (e) => {
    ctl.flipV = !ctl.flipV;
    e.currentTarget.classList.toggle("active", ctl.flipV);
    renderCombinedPreview();
    syncEdit();
  });

  // --- fit to plate ---
  el.querySelector(".zone-fit-btn").addEventListener("click", async () => {
    if (!ctl.hasLogo) return;
    setGlobalError("");
    try {
      const res = await fetch(`/api/order/session/${SESSION_ID}/zone/${z.id}/fit`, { method: "POST" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "échec de l'ajustement");
      if (data.width_mm > Number(sliders.width.max)) sliders.width.max = data.width_mm;
      sliders.width.value = data.width_mm;
      sliders.rot.value = data.rotation_deg;
      sliders.dx.value = 0;
      sliders.dy.value = 0;
      schedulePreview();
    } catch (err) {
      setGlobalError(err.message);
    }
  });

  return ctl;
}

// --- boot --------------------------------------------------------------------
let SESSION_ID = null;
const zoneControllers = [];

function setGlobalError(msg) {
  document.getElementById("submit-error").textContent = msg || "";
}

function updateSubmitState() {
  const allReady = zoneControllers.length > 0 && zoneControllers.every((z) => z.hasLogo && z.previewObject);
  document.getElementById("submit-btn").disabled = !allReady;
}

async function boot() {
  const container = document.getElementById("zones-container");
  try {
    const res = await fetch(`/api/product/${PRODUCT_ID}`);
    const product = await readJson(res);
    if (!res.ok) throw new Error(product.error || "produit introuvable");
    loadAssembly(product.glb_url, product.bounds);

    const startRes = await fetch(`/api/order/${PRODUCT_ID}/start`, { method: "POST" });
    const startData = await readJson(startRes);
    if (!startRes.ok) throw new Error(startData.error || "impossible de démarrer la commande");
    SESSION_ID = startData.order_session_id;

    container.innerHTML = "";
    for (const z of product.zones) {
      const ctl = makeZoneController(z);
      zoneControllers.push(ctl);
      container.appendChild(ctl.el);
    }
    document.getElementById("submit-bar").classList.remove("hidden");
    updateSubmitState();
  } catch (err) {
    container.innerHTML = `<p class="hint error">${err.message}</p>`;
  }
}
boot();

document.getElementById("submit-btn").addEventListener("click", async () => {
  setGlobalError("");
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "Envoi en cours…";
  try {
    const res = await fetch(`/api/order/session/${SESSION_ID}/submit`, { method: "POST" });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "échec de l'envoi");
    document.getElementById("order-code").textContent = data.order_code;
    document.getElementById("result-overlay").classList.remove("hidden");
  } catch (err) {
    setGlobalError(err.message);
    btn.disabled = false;
    btn.textContent = "Envoyer ma commande";
  }
});
