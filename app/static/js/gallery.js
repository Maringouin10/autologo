/* Thumbnails for the product cards.
 *
 * A flat color swatch tells a customer nothing about what they are about to
 * customize. There is no server-side renderer here (no GPU, and the image
 * stack this container carries can't rasterize a mesh), so the cards are
 * rendered in the browser — but NOT one live viewer each: a page of eight
 * products would open eight WebGL contexts, and browsers cap them at about
 * sixteen before they start killing the oldest.
 *
 * Instead: one renderer, used once per product, each render captured to a
 * PNG and dropped into the card as an image. The colored swatch stays
 * underneath as the placeholder, so a slow (or failed) load degrades to
 * exactly what the page looked like before.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const cards = [...document.querySelectorAll("[data-glb]")];
if (cards.length && window.WebGLRenderingContext) {
  renderAll().catch(() => { /* a missing thumbnail is not worth a toast */ });
}

async function renderAll() {
  const SIZE = 420;
  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);          // the card shows it at ~200px; 420 is plenty
  renderer.setSize(SIZE, SIZE);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
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

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  const loader = new GLTFLoader();
  const colored = new THREE.MeshStandardMaterial({
    color: 0xffffff, metalness: 0.05, roughness: 0.55, vertexColors: true,
  });
  const plain = new THREE.MeshStandardMaterial({
    color: 0x9fb2d0, metalness: 0.05, roughness: 0.55,
  });

  for (const card of cards) {
    try {
      const url = card.dataset.glb;
      const shot = cached(url) || await renderOne(url);
      if (!shot) continue;
      card.style.backgroundImage = `url(${shot})`;
      card.classList.add("has-shot");
      remember(url, shot);
    } catch {
      // leave the swatch as it was
    }
  }
  renderer.dispose();

  // Coming back to the storefront shouldn't re-render everything. The cache
  // is per-tab and best-effort: a private window, a full quota or a blocked
  // store just means rendering again, never a broken page.
  function cached(url) {
    try { return sessionStorage.getItem("shot:" + url); } catch { return null; }
  }
  function remember(url, shot) {
    try { sessionStorage.setItem("shot:" + url, shot); } catch { /* quota */ }
  }

  function renderOne(url) {
    return new Promise((resolve, reject) => {
      // Anything thrown in here happens after the executor returned, so it
      // would escape as an uncaught error AND leave this promise pending
      // forever — stalling every remaining card behind it.
      loader.load(url, (gltf) => {
        try {
          resolve(shoot(gltf));
        } catch (err) {
          reject(err);
        }
      }, undefined, reject);
    });
  }

  function shoot(gltf) {
    let mesh = null;
    gltf.scene.traverse((obj) => { if (!mesh && obj.isMesh) mesh = obj; });
    if (!mesh) return null;
    mesh.material = mesh.geometry.attributes.color ? colored : plain;

    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const radius = Math.max(size.length() / 2, 1);
    // Three-quarter view: shows the face a logo goes on and enough of
    // the side to read the object's thickness.
    camera.position.copy(center).add(
      new THREE.Vector3(radius * 1.35, radius * 1.5, radius * 2.1));
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    scene.add(mesh);
    renderer.render(scene, camera);
    const data = renderer.domElement.toDataURL("image/png");
    scene.remove(mesh);
    mesh.geometry.dispose?.();
    return data;
  }
}
