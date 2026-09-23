/* Admin-side look at a finished order: the exported 3MF, rebuilt server-side
   as a GLB with each object painted in the filament the customer picked. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { toastError } from "./ui.js";

const CODE = document.body.dataset.orderCode;
const viewerEl = document.getElementById("viewer");
const hintEl = document.getElementById("viewer-hint");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
viewerEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 1.1));
scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 2.0));
const key = new THREE.DirectionalLight(0xffffff, 3.0);
key.position.set(100, 200, 150);
scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe0ff, 1.5);
fill.position.set(-120, 60, -100);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.2);
rim.position.set(0, -150, 50);
scene.add(rim);
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

let framing = null;
function frame(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const radius = Math.max(size.length() / 2, 1);
  framing = { center, radius };
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

// The GLB carries the order's colors as vertex colors; a white base keeps
// them exactly as baked instead of tinting them.
const material = new THREE.MeshStandardMaterial({
  color: 0xffffff, metalness: 0.05, roughness: 0.55, vertexColors: true,
});
const plainMaterial = new THREE.MeshStandardMaterial({
  color: 0x8fa6c9, metalness: 0.05, roughness: 0.55,
});
const edgeMaterial = new THREE.LineBasicMaterial({
  color: 0x0a0c10, transparent: true, opacity: 0.35,
});

new GLTFLoader().load(`/admin/orders/${CODE}/preview.glb`, (gltf) => {
  let mesh = null;
  gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
  if (!mesh) {
    hintEl.textContent = "Cet aperçu ne contient aucune géométrie.";
    return;
  }
  mesh.material = mesh.geometry.attributes.color ? material : plainMaterial;
  scene.add(mesh);
  scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMaterial));
  frame(mesh);
  hintEl.textContent = "Glissez pour tourner · molette pour zoomer";
}, undefined, (err) => {
  hintEl.textContent = "Aperçu indisponible.";
  toastError("Impossible de charger l'aperçu : " + (err?.message || "erreur inconnue"));
});

document.getElementById("view-reset")?.addEventListener("click", () => {
  if (!framing) return;
  controls.target.copy(framing.center);
  camera.position.copy(framing.center)
    .add(new THREE.Vector3(framing.radius, framing.radius * 0.8, framing.radius));
  controls.update();
});
document.getElementById("view-full")?.addEventListener("click", () => {
  const wrap = document.querySelector(".viewer-wrap");
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap?.requestFullscreen?.().catch(() => toastError("Plein écran refusé par le navigateur."));
});
document.addEventListener("fullscreenchange", () => setTimeout(resize, 60));
