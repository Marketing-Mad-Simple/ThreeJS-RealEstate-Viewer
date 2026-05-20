import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  available: 0x4ade80,   // green
  reserved:  0xfbbf24,   // amber
  sold:      0x3b82f6,   // blue
};

const HOVER_EMISSIVE   = new THREE.Color(0xffffff);
const HOVER_INTENSITY  = 0.25;
const SELECTED_EMISSIVE = new THREE.Color(0xffffff);
const SELECTED_INTENSITY = 0.45;

// ─── Scene Setup ─────────────────────────────────────────────────────────────
const canvas   = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled  = true;
renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
renderer.outputColorSpace   = THREE.SRGBColorSpace;
renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog        = new THREE.FogExp2(0x0d1117, 0.008);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(60, 60, 60);
camera.lookAt(0, 0, 0);

// ─── Lighting ─────────────────────────────────────────────────────────────────
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff5e0, 1.8);
sun.position.set(50, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far  = 300;
sun.shadow.camera.left = sun.shadow.camera.bottom = -80;
sun.shadow.camera.right = sun.shadow.camera.top    =  80;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xa8d8ea, 0.4);
fill.position.set(-30, 20, -30);
scene.add(fill);

// ─── Controls ─────────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.07;
controls.minDistance      = 10;
controls.maxDistance      = 200;
controls.maxPolarAngle    = Math.PI / 2.1;
controls.target.set(0, 0, 0);
// Touch: one finger = orbit, two fingers = zoom+pan
controls.touches = {
  ONE:  THREE.TOUCH.ROTATE,
  TWO:  THREE.TOUCH.DOLLY_PAN,
};

// ─── State ────────────────────────────────────────────────────────────────────
let plotData      = {};
let plotMeshes    = {};          // plotId → mesh
let hoveredMesh   = null;
let selectedMesh  = null;
const originalMaterials = new Map(); // mesh → { color, emissive, emissiveIntensity }

const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

// ─── Load Plot Data ────────────────────────────────────────────────────────────
async function loadPlotData() {
  const res  = await fetch('./data/plots.json');
  plotData   = await res.json();
}

// ─── Load GLB ─────────────────────────────────────────────────────────────────
function loadModel() {
  const loader   = new GLTFLoader();
  const progress = document.getElementById('progress-bar');
  const overlay  = document.getElementById('loading-overlay');

  loader.load(
    './models/site.glb',
    (gltf) => {
      const model = gltf.scene;

      // Centre the model
      const box    = new THREE.Box3().setFromObject(model);
      const centre = new THREE.Vector3();
      box.getCenter(centre);
      model.position.sub(centre);

      // Fit camera
      const size   = box.getSize(new THREE.Vector3()).length();
      camera.position.set(size, size * 0.8, size);
      controls.target.set(0, 0, 0);
      controls.maxDistance = size * 3;
      controls.minDistance = size * 0.05;
      controls.update();

      // Traverse and tag plot meshes
      model.traverse((node) => {
        if (!node.isMesh) return;

        node.castShadow    = true;
        node.receiveShadow = true;

        const match = node.name.match(/^Plot_(\d+)$/i);
        if (!match) return;

        const id = match[1].padStart(2, '0');   // "1" → "01"
        plotMeshes[id] = node;

        // Clone material so we can tint individually
        node.material = node.material.clone();
        node.material.roughness = 0.7;
        node.material.metalness = 0.0;

        const info   = plotData[id];
        const status = info ? info.status : 'available';

        node.material.color.setHex(STATUS_COLORS[status] ?? STATUS_COLORS.available);
        node.material.emissive    = new THREE.Color(0x000000);
        node.material.emissiveIntensity = 0;

        // Store original appearance
        originalMaterials.set(node, {
          color:             node.material.color.clone(),
          emissive:          node.material.emissive.clone(),
          emissiveIntensity: 0,
        });

        node.userData.plotId = id;
      });

      scene.add(model);
      updateStats();

      // Hide loader
      overlay.style.opacity = '0';
      setTimeout(() => overlay.style.display = 'none', 600);
    },
    (xhr) => {
      if (xhr.total) {
        const pct = (xhr.loaded / xhr.total) * 100;
        progress.style.width = pct + '%';
      }
    },
    (err) => {
      console.error('GLB load error:', err);
      document.getElementById('loading-text').textContent = 'Failed to load model.';
    }
  );
}

// ─── Highlight Helpers ────────────────────────────────────────────────────────
function applyHighlight(mesh, emissive, intensity) {
  mesh.material.emissive.copy(emissive);
  mesh.material.emissiveIntensity = intensity;
}

function restoreOriginal(mesh) {
  if (!mesh) return;
  const orig = originalMaterials.get(mesh);
  if (!orig) return;
  mesh.material.emissive.copy(orig.emissive);
  mesh.material.emissiveIntensity = orig.emissiveIntensity;
}

// ─── Popup ────────────────────────────────────────────────────────────────────
function showPopup(plotId, screenX, screenY) {
  const info   = plotData[plotId];
  const popup  = document.getElementById('plot-popup');
  if (!info) return;

  const statusLabel = { available: 'Available', reserved: 'Reserved', sold: 'Sold' };
  const statusClass = info.status;

  popup.innerHTML = `
    <button class="popup-close" onclick="closePopup()">✕</button>
    <div class="popup-header">
      <span class="popup-id">Plot ${plotId}</span>
      <span class="popup-status ${statusClass}">${statusLabel[info.status]}</span>
    </div>
    <div class="popup-divider"></div>
    <div class="popup-grid">
      <div class="popup-row"><span class="label">Type</span><span class="value">${info.type}</span></div>
      <div class="popup-row"><span class="label">Size</span><span class="value">${info.size}</span></div>
      <div class="popup-row"><span class="label">Area</span><span class="value">${info.area}</span></div>
      <div class="popup-row"><span class="label">Facing</span><span class="value">${info.facing}</span></div>
      <div class="popup-row"><span class="label">Price</span><span class="value price">${info.price}</span></div>
    </div>
    ${info.status === 'available' ? '<button class="popup-enquire" onclick="enquire(\'' + plotId + '\')">Enquire Now</button>' : ''}
  `;

  if (isMobile()) {
    popup.classList.add('bottom-sheet');
    popup.style.left = '';
    popup.style.top  = '';
  } else {
    popup.classList.remove('bottom-sheet');
    const pw = 260, ph = 240;
    let left = screenX + 20;
    let top  = screenY - 20;
    if (left + pw > window.innerWidth  - 20) left = screenX - pw - 20;
    if (top  + ph > window.innerHeight - 20) top  = window.innerHeight - ph - 20;
    if (top < 20) top = 20;
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
  }

  popup.style.display = 'block';
  requestAnimationFrame(() => popup.classList.add('visible'));
}

window.closePopup = function () {
  const popup = document.getElementById('plot-popup');
  popup.classList.remove('visible');
  popup.classList.remove('bottom-sheet');
  setTimeout(() => popup.style.display = 'none', 200);

  if (selectedMesh) {
    restoreOriginal(selectedMesh);
    // Re-apply hover if still hovered
    if (selectedMesh === hoveredMesh) applyHighlight(selectedMesh, HOVER_EMISSIVE, HOVER_INTENSITY);
    selectedMesh = null;
  }
};

window.enquire = function (plotId) {
  alert(`Thank you for your interest in Plot ${plotId}!\nOur team will contact you shortly.`);
};

// ─── Input Helpers ────────────────────────────────────────────────────────────
const isMobile = () => window.matchMedia('(pointer: coarse)').matches;

function getPlotAtPoint(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(Object.values(plotMeshes), false);
  return hits.length ? hits[0].object : null;
}

function selectPlot(mesh, clientX, clientY) {
  if (selectedMesh) restoreOriginal(selectedMesh);
  closePopupSilent();
  selectedMesh = mesh;
  if (mesh) {
    applyHighlight(mesh, SELECTED_EMISSIVE, SELECTED_INTENSITY);
    showPopup(mesh.userData.plotId, clientX, clientY);
  }
}

// ─── Desktop Mouse Events ─────────────────────────────────────────────────────
window.addEventListener('mousemove', (e) => {
  if (isMobile()) return;

  const hit = getPlotAtPoint(e.clientX, e.clientY);
  if (hoveredMesh && hoveredMesh !== selectedMesh) restoreOriginal(hoveredMesh);
  hoveredMesh = hit;
  document.body.style.cursor = hit ? 'pointer' : 'default';
  if (hit && hit !== selectedMesh) applyHighlight(hit, HOVER_EMISSIVE, HOVER_INTENSITY);

  const tooltip = document.getElementById('tooltip');
  if (hit) {
    const id = hit.userData.plotId;
    const info = plotData[id];
    tooltip.textContent   = info ? `Plot ${id} · ${info.type} · ${info.status.toUpperCase()}` : `Plot ${id}`;
    tooltip.style.left    = (e.clientX + 16) + 'px';
    tooltip.style.top     = (e.clientY - 10) + 'px';
    tooltip.style.opacity = '1';
  } else {
    tooltip.style.opacity = '0';
  }
});

window.addEventListener('click', (e) => {
  if (isMobile()) return;
  const hit = getPlotAtPoint(e.clientX, e.clientY);
  selectPlot(hit, e.clientX, e.clientY);
});

// ─── Mobile Touch Events ──────────────────────────────────────────────────────
let touchStartX = 0, touchStartY = 0, touchStartTime = 0, multiTouch = false;
const TAP_DIST_MAX = 14;  // px  — max finger travel to count as a tap
const TAP_TIME_MAX = 300; // ms  — max duration to count as a tap

window.addEventListener('touchstart', (e) => {
  multiTouch = e.touches.length > 1;
  if (multiTouch) return;
  const t = e.touches[0];
  touchStartX    = t.clientX;
  touchStartY    = t.clientY;
  touchStartTime = Date.now();
}, { passive: true });

window.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) multiTouch = true;
}, { passive: true });

window.addEventListener('touchend', (e) => {
  if (multiTouch) { multiTouch = false; return; }

  const t    = e.changedTouches[0];
  const dx   = Math.abs(t.clientX - touchStartX);
  const dy   = Math.abs(t.clientY - touchStartY);
  const dt   = Date.now() - touchStartTime;

  // Must be a short, stationary tap
  if (dx > TAP_DIST_MAX || dy > TAP_DIST_MAX || dt > TAP_TIME_MAX) return;

  // Ignore taps on UI elements — walk up the DOM from the tap target
  // If any ancestor is a UI panel, don't raycast
  let el = document.elementFromPoint(t.clientX, t.clientY);
  while (el && el !== document.body) {
    const id = el.id || '';
    if (id === 'filter-panel' || id === 'controls-panel' ||
        id === 'plot-popup'   || id === 'stats-bar'      ||
        id === 'legend'       || id === 'compass') return;
    el = el.parentElement;
  }

  const hit = getPlotAtPoint(t.clientX, t.clientY);
  selectPlot(hit, t.clientX, t.clientY);
}, { passive: true });

function closePopupSilent() {
  const popup = document.getElementById('plot-popup');
  popup.classList.remove('visible');
  popup.style.display = 'none';
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const counts = { available: 0, reserved: 0, sold: 0 };
  Object.values(plotData).forEach(p => counts[p.status]++);
  document.getElementById('stat-available').textContent = counts.available;
  document.getElementById('stat-reserved').textContent  = counts.reserved;
  document.getElementById('stat-sold').textContent      = counts.sold;
  document.getElementById('stat-total').textContent     = Object.keys(plotData).length;
}

// ─── Filter ───────────────────────────────────────────────────────────────────
window.filterStatus = function (status) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');

  Object.entries(plotMeshes).forEach(([id, mesh]) => {
    const info = plotData[id];
    if (!info) return;
    const visible = (status === 'all') || (info.status === status);
    mesh.visible = visible;
  });
};

// ─── Reset Camera ─────────────────────────────────────────────────────────────
window.resetCamera = function () {
  const box  = new THREE.Box3();
  Object.values(plotMeshes).forEach(m => box.expandByObject(m));
  const size = box.getSize(new THREE.Vector3()).length();
  camera.position.set(size, size * 0.8, size);
  controls.target.set(0, 0, 0);
  controls.update();
};

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Render Loop ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadPlotData();
  loadModel();
  animate();
})();
