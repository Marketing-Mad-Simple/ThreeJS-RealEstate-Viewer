/**
 * MMS Experience — Building Viewer
 * viewer.js
 *
 * Two-mode 3D viewer:
 *   1. EXTERIOR — shows building + parking lot GLB.
 *      Clicking the building (named "Building") transitions to interior.
 *   2. INTERIOR — shows floor plan GLB with four flats.
 *      Clicking any FLAT_X mesh shows its property popup.
 *
 * Robust to both structures coming out of Blender:
 *   (a) Named mesh sitting at top level with no parent group
 *   (b) Named Object3D/group that contains child meshes
 *
 * Naming conventions:
 *   exterior.glb → "Building"  (everything else is non-interactive)
 *   interior.glb → "FLAT_1", "FLAT_2", "FLAT_3", "FLAT_4"
 */

import * as THREE from 'three';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ─────────────────────────────────────────────────────────────
   CONFIG
───────────────────────────────────────────────────────────── */
const EXTERIOR_MODEL = './models/exterior.glb';
const INTERIOR_MODEL = './models/interior.glb';
const FLATS_DATA_URL = './data/flats.json';

const HOVER_BUILDING_COLOR   = 0xf0c866;
const DEFAULT_BUILDING_COLOR = 0xd4b896;

const STATUS_COLORS = {
  available: 0x4ade80,
  reserved:  0xfbbf24,
  sold:      0x3b82f6,
};
const STATUS_HOVER = {
  available: 0x86efac,
  reserved:  0xfde68a,
  sold:      0x93c5fd,
};

// Emissive intensity multipliers — lower = more original texture shows through
const EMISSIVE_FLAT_DEFAULT  = 0.05;   // resting state
const EMISSIVE_FLAT_HOVER    = 0.10;   // hover
const EMISSIVE_FLAT_SELECTED = 0.18;   // selected

// Tint alpha — how strongly the status colour overrides the original material colour.
// 0.0 = fully original material, 1.0 = fully status colour.
// Can be changed at runtime via the UI slider; applyColor always reads this variable.
let TINT_ALPHA = 0.5;

/* ─────────────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────────────── */
let mode = 'exterior';
let flatsData = {};
let exteriorScene = null;
let interiorScene = null;

// buildingRoot — the Object3D named "Building" (may be a group OR a mesh)
// flatRoots    — { "FLAT_1": Object3D, … }  same deal
let buildingRoot = null;
let flatRoots    = {};

let hoveredObject = null;  // always a root (buildingRoot or a flatRoot)
let selectedFlat  = null;  // { key, root }
let activeFilter  = 'all';

// WeakMap keyed by ROOT; value = array of { mesh, mats }
// so we save/restore ALL child meshes in one call
const savedMaterials = new WeakMap();

/* camera defaults */
const EXT_CAM_POS    = new THREE.Vector3(0, 12, 28);
const EXT_CAM_TARGET = new THREE.Vector3(0, 2, 0);
const INT_CAM_POS    = new THREE.Vector3(0, 10, 18);
const INT_CAM_TARGET = new THREE.Vector3(0, 0, 0);

/* ─────────────────────────────────────────────────────────────
   RENDERER / SCENE / CAMERA
───────────────────────────────────────────────────────────── */
const canvas   = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
renderer.outputColorSpace    = THREE.SRGBColorSpace;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1117);
scene.fog = new THREE.FogExp2(0x0f1117, 0.012);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.copy(EXT_CAM_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxPolarAngle = Math.PI / 2.05;
controls.minDistance   = 4;
controls.maxDistance   = 80;
controls.target.copy(EXT_CAM_TARGET);
controls.update();

/* ─────────────────────────────────────────────────────────────
   LIGHTING
───────────────────────────────────────────────────────────── */
scene.add(new THREE.AmbientLight(0xfdf4e3, 1.0));

const sun = new THREE.DirectionalLight(0xfff8f0, 6.8);
sun.position.set(30, 50, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near  = 0.5;
sun.shadow.camera.far   = 200;
sun.shadow.camera.left  = sun.shadow.camera.bottom = -40;
sun.shadow.camera.right = sun.shadow.camera.top    =  40;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xc8e0ff, 0.4);
fill.position.set(-15, 20, -10);
scene.add(fill);

scene.add(new THREE.HemisphereLight(0x88aacc, 0x443322, 0.5));

/* ─────────────────────────────────────────────────────────────
   MATERIAL HELPERS
   All functions accept a ROOT Object3D and operate on every
   isMesh descendant — so they work for groups AND bare meshes.
───────────────────────────────────────────────────────────── */

function getMeshes(root) {
  const meshes = [];
  root.traverse(c => { if (c.isMesh) meshes.push(c); });
  return meshes;
}

function saveMaterials(root) {
  if (savedMaterials.has(root)) return;
  const entries = getMeshes(root).map(mesh => ({
    mesh,
    mats: Array.isArray(mesh.material)
      ? mesh.material.map(m => m.clone())
      : mesh.material.clone(),
  }));
  savedMaterials.set(root, entries);
}

function restoreMaterials(root) {
  const entries = savedMaterials.get(root);
  if (!entries) return;
  entries.forEach(({ mesh, mats }) => {
    mesh.material = Array.isArray(mats)
      ? mats.map(m => m.clone())
      : mats.clone();
  });
}

function applyColor(root, hex, emissiveFactor = 0.12) {
  const statusColor = new THREE.Color(hex);
  // Scale emissive by TINT_ALPHA so glow also softens when tint is reduced
  const emissive    = new THREE.Color(hex).multiplyScalar(emissiveFactor * TINT_ALPHA);

  // We need the saved originals to blend from — saveMaterials must have been called first.
  const saved = savedMaterials.get(root);

  getMeshes(root).forEach((mesh, i) => {
    const tint = (m, origM) => {
      m = m.clone();
      // Blend: lerp from original colour toward the status colour by TINT_ALPHA
      const blended = origM ? origM.color.clone().lerp(statusColor, TINT_ALPHA) : statusColor.clone();
      m.color    = blended;
      m.emissive = emissive;
      return m;
    };

    // Look up original material for this mesh from saved snapshot
    const savedEntry = saved ? saved.find(e => e.mesh === mesh) : null;

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m, mi) => {
        const origM = savedEntry && Array.isArray(savedEntry.mats) ? savedEntry.mats[mi] : null;
        return tint(m, origM);
      });
    } else {
      const origM = savedEntry && !Array.isArray(savedEntry.mats) ? savedEntry.mats : null;
      mesh.material = tint(mesh.material, origM);
    }
  });
}

// Re-apply all current flat colours using the latest TINT_ALPHA value.
// Called whenever the slider changes.
function reapplyAllTints() {
  if (!flatRoots || Object.keys(flatRoots).length === 0) return;
  // Restore originals first, then re-tint
  Object.entries(flatRoots).forEach(([key, root]) => {
    restoreMaterials(root);
    const status = flatsData[key]?.status ?? 'available';
    // Determine emissive factor: use selected level if currently selected, default otherwise
    const isSelected = selectedFlat && selectedFlat.key === key;
    const emissive   = isSelected ? EMISSIVE_FLAT_SELECTED : EMISSIVE_FLAT_DEFAULT;
    applyColor(root, STATUS_COLORS[status] ?? STATUS_COLORS.available, emissive);
  });
}

/* ─────────────────────────────────────────────────────────────
   RAYCASTER
───────────────────────────────────────────────────────────── */
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

function setPointerFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  let clientX, clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else if (e.changedTouches && e.changedTouches.length > 0) {
    clientX = e.changedTouches[0].clientX;
    clientY = e.changedTouches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  pointer.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
}

/** All mesh targets for raycasting this frame */
function getInteractableMeshes() {
  const candidates = mode === 'exterior'
    ? (buildingRoot ? [buildingRoot] : [])
    : Object.values(flatRoots);
  return candidates.flatMap(getMeshes);
}

/**
 * Walk from a hit mesh up its ancestor chain to find
 * which registered root (buildingRoot / flatRoot) it belongs to.
 */
function findRoot(hitObject) {
  const candidates = mode === 'exterior'
    ? (buildingRoot ? [buildingRoot] : [])
    : Object.values(flatRoots);

  let obj = hitObject;
  while (obj) {
    if (candidates.includes(obj)) return obj;
    obj = obj.parent;
  }
  return null;
}

function getKeyForRoot(root) {
  return Object.keys(flatRoots).find(k => flatRoots[k] === root) ?? null;
}

/* ─────────────────────────────────────────────────────────────
   MODEL LOADING
───────────────────────────────────────────────────────────── */
const loader = new GLTFLoader();

function updateProgress(pct, text) {
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('loading-text').textContent  = text;
}

function fitModelToView(model) {
  const box  = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxD = Math.max(size.x, size.y, size.z);
  model.scale.setScalar(10 / maxD);
  const box2 = new THREE.Box3().setFromObject(model);
  const ctr  = box2.getCenter(new THREE.Vector3());
  model.position.sub(ctr);
  model.position.y = 0;
}

function loadExterior() {
  return new Promise((resolve, reject) => {
    loader.load(
      EXTERIOR_MODEL,
      (gltf) => {
        exteriorScene = gltf.scene;

        exteriorScene.traverse(child => {
          if (child.isMesh) {
            child.castShadow    = true;
            child.receiveShadow = true;
          }
        });

        // Works whether "Building" is a top-level mesh or a parent group
        buildingRoot = exteriorScene.getObjectByName('Building') ?? null;

        if (buildingRoot) {
          const hasTexture = getMeshes(buildingRoot).some(m =>
            (Array.isArray(m.material) ? m.material : [m.material]).some(mat => mat.map)
          );
          // Apply warm tint only when no Blender texture is present.
          // Delete this block if you want to keep your GLB materials untouched.
          if (!hasTexture) {
            applyColor(buildingRoot, DEFAULT_BUILDING_COLOR);
          }
          // Save AFTER tint so "restore" brings back the tinted baseline
          saveMaterials(buildingRoot);
        } else {
          console.warn('[viewer] exterior.glb: no object named "Building" found.');
        }

        fitModelToView(exteriorScene);
        scene.add(exteriorScene);
        resolve();
      },
      xhr => { if (xhr.total) updateProgress(xhr.loaded / xhr.total * 60, 'Loading exterior…'); },
      reject
    );
  });
}

function loadInterior() {
  return new Promise((resolve, reject) => {
    loader.load(
      INTERIOR_MODEL,
      (gltf) => {
        interiorScene = gltf.scene;

        interiorScene.traverse(child => {
          if (child.isMesh) {
            child.castShadow    = true;
            child.receiveShadow = true;
          }
        });

        // Match FLAT_1 … FLAT_N — case-insensitive, works on groups OR bare meshes.
        // Avoid registering both a parent group and its children if both happen to match.
        interiorScene.traverse(child => {
          if (!/^FLAT_\d+$/i.test(child.name)) return;
          const key = child.name.toUpperCase();
          if (!flatRoots[key]) flatRoots[key] = child;
        });

        for (const [key, root] of Object.entries(flatRoots)) {
          saveMaterials(root);   // ← save originals FIRST, before any tint is applied
          const status = flatsData[key]?.status ?? 'available';
          applyColor(root, STATUS_COLORS[status] ?? STATUS_COLORS.available, EMISSIVE_FLAT_DEFAULT);
        }

        if (!Object.keys(flatRoots).length) {
          console.warn('[viewer] interior.glb: no objects matching FLAT_N found.');
        }

        fitModelToView(interiorScene);
        interiorScene.visible = false;
        scene.add(interiorScene);
        resolve();
      },
      xhr => { if (xhr.total) updateProgress(60 + xhr.loaded / xhr.total * 40, 'Loading interior…'); },
      reject
    );
  });
}

/* ─────────────────────────────────────────────────────────────
   DATA
───────────────────────────────────────────────────────────── */
async function loadData() {
  flatsData = await (await fetch(FLATS_DATA_URL)).json();
}

/* ─────────────────────────────────────────────────────────────
   STATS
───────────────────────────────────────────────────────────── */
function updateStats() {
  const c = { available: 0, reserved: 0, sold: 0 };
  Object.values(flatsData).forEach(d => { if (c[d.status] !== undefined) c[d.status]++; });
  document.getElementById('stat-available').textContent = c.available;
  document.getElementById('stat-reserved').textContent  = c.reserved;
  document.getElementById('stat-sold').textContent      = c.sold;
  document.getElementById('stat-total').textContent     = Object.keys(flatsData).length;
}

/* ─────────────────────────────────────────────────────────────
   MODE SWITCH  exterior ↔ interior
───────────────────────────────────────────────────────────── */
const transitionOverlay = document.getElementById('transition-overlay');

function fadeOverlay(inOut, duration = 500) {
  return new Promise(resolve => {
    transitionOverlay.classList.toggle('fade-in', inOut === 'in');
    setTimeout(resolve, duration);
  });
}

async function switchToInterior() {
  if (mode === 'interior') return;
  hidePopup();
  setHint(null);
  await fadeOverlay('in');
  exteriorScene.visible = false;
  interiorScene.visible = true;
  mode = 'interior';
  animateCamera(INT_CAM_POS, INT_CAM_TARGET, 0.05);
  updateUI();
  updateStats();
  await fadeOverlay('out');
}

async function switchToExterior() {
  if (mode === 'exterior') return;
  hidePopup();
  closeFlat();
  await fadeOverlay('in');
  interiorScene.visible = false;
  exteriorScene.visible = true;
  mode = 'exterior';
  activeFilter = 'all';
  animateCamera(EXT_CAM_POS, EXT_CAM_TARGET, 0.05);
  updateUI();
  await fadeOverlay('out');
  setHint('Click the building to explore inside');
}

function updateUI() {
  const isInt = mode === 'interior';
  document.getElementById('stats-bar').classList.toggle('hidden', !isInt);
  document.getElementById('legend').classList.toggle('hidden', !isInt);
  document.getElementById('filter-panel').classList.toggle('hidden', !isInt);
  document.getElementById('back-btn').classList.toggle('visible', isInt);
  document.getElementById('crumb-active').textContent = isInt ? 'Floor Plan' : 'Site';
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.filter-btn.f-all').classList.add('active');
}



/* ─────────────────────────────────────────────────────────────
   CAMERA ANIMATION
───────────────────────────────────────────────────────────── */
let camPos_anim    = null;
let camTarget_anim = null;
let camLerpSpeed   = 0.05;

function animateCamera(pos, target, speed = 0.05) {
  camPos_anim    = pos.clone();
  camTarget_anim = target.clone();
  camLerpSpeed   = speed;
}

/* ─────────────────────────────────────────────────────────────
   HOVER & TOOLTIP  (desktop only)
───────────────────────────────────────────────────────────── */
const tooltip = document.getElementById('tooltip');

function showTooltip(text, x, y) {
  tooltip.textContent = text;
  tooltip.style.left  = (x + 14) + 'px';
  tooltip.style.top   = (y - 30) + 'px';
  tooltip.classList.add('visible');
}
function hideTooltip() { tooltip.classList.remove('visible'); }

canvas.addEventListener('mousemove', e => {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(getInteractableMeshes(), false);
  const root = hits.length ? findRoot(hits[0].object) : null;

  if (root === hoveredObject) return;

  if (hoveredObject) {
    const prev = hoveredObject;
    restoreMaterials(prev);
    // In interior mode, restore brings back raw GLB colours — re-apply the status tint
    if (mode === 'interior') {
      const key    = getKeyForRoot(prev);
      const status = flatsData[key]?.status ?? 'available';
      const isSelected = selectedFlat && selectedFlat.root === prev;
      applyColor(prev, STATUS_COLORS[status] ?? STATUS_COLORS.available,
                 isSelected ? EMISSIVE_FLAT_SELECTED : EMISSIVE_FLAT_DEFAULT);
    }
    hoveredObject = null;
    hideTooltip();
    canvas.style.cursor = 'default';
  }

  if (root) {
    hoveredObject = root;
    if (mode === 'exterior') {
      applyColor(root, HOVER_BUILDING_COLOR, 0.3);
      showTooltip('Click to enter building', e.clientX, e.clientY);
    } else {
      const key    = getKeyForRoot(root);
      const status = flatsData[key]?.status ?? 'available';
      applyColor(root, STATUS_HOVER[status], EMISSIVE_FLAT_HOVER);
      showTooltip(flatsData[key]?.label ?? key, e.clientX, e.clientY);
    }
    canvas.style.cursor = 'pointer';
  }
});

/* ─────────────────────────────────────────────────────────────
   CLICK / TAP
───────────────────────────────────────────────────────────── */
let touchStartPos = null;
let touchMoved    = false;

canvas.addEventListener('touchstart', e => {
  touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  touchMoved = false;
}, { passive: true });

canvas.addEventListener('touchmove', e => {
  if (!touchStartPos) return;
  const dx = e.touches[0].clientX - touchStartPos.x;
  const dy = e.touches[0].clientY - touchStartPos.y;
  if (Math.sqrt(dx * dx + dy * dy) > 8) touchMoved = true;
}, { passive: true });

canvas.addEventListener('touchend', e => {
  if (!touchMoved) handleTap(e);
  touchStartPos = null;
}, { passive: false });

canvas.addEventListener('click', e => {
  if (e.pointerType === 'touch') return;
  handleTap(e);
});

function handleTap(e) {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(getInteractableMeshes(), false);

  if (!hits.length) { hidePopup(); closeFlat(); return; }

  const root = findRoot(hits[0].object);
  if (!root) return;

  if (mode === 'exterior') {
    switchToInterior();
  } else {
    const key = getKeyForRoot(root);
    if (key) showFlatPopup(key, root);
  }
}

/* ─────────────────────────────────────────────────────────────
   FLAT POPUP
───────────────────────────────────────────────────────────── */
const popup = document.getElementById('plot-popup');

function showFlatPopup(key, root) {
  const d = flatsData[key];
  if (!d) return;
  closeFlat(false);
  selectedFlat = { key, root };
  // Selection: stronger emissive on the status colour
  applyColor(root, STATUS_COLORS[d.status] ?? STATUS_COLORS.available, EMISSIVE_FLAT_SELECTED);
  popup.innerHTML = buildPopupHTML(d);
  popup.classList.add('visible');
  popup.querySelector('.popup-close').addEventListener('click', ev => {
    ev.stopPropagation();
    hidePopup();
    closeFlat();
  });
  // Dummy 360° button — wire up a real handler here when the viewer is ready
  popup.querySelector('.btn-360').addEventListener('click', ev => {
    ev.stopPropagation();
    // TODO: launch 360° viewer for selectedFlat.key
    console.log('[360] Open panorama for', key);
  });
  popup.querySelector('.btn-enquire')?.addEventListener('click', ev => {
    ev.stopPropagation();
    openEnquiryModal(d);
  });
}

function closeFlat(restoreColor = true) {
  if (!selectedFlat) return;
  if (restoreColor) {
    const root   = selectedFlat.root;
    const key    = selectedFlat.key;
    restoreMaterials(root);
    // Re-apply status tint (restore returns raw GLB colours)
    const status = flatsData[key]?.status ?? 'available';
    applyColor(root, STATUS_COLORS[status] ?? STATUS_COLORS.available, EMISSIVE_FLAT_DEFAULT);
  }
  selectedFlat = null;
}

function hidePopup() { popup.classList.remove('visible'); }

/* ─────────────────────────────────────────────────────────────
   ENQUIRY MODAL
───────────────────────────────────────────────────────────── */
const enquiryOverlay = document.getElementById('enquiry-overlay');

function openEnquiryModal(flatData) {
  document.getElementById('enq-flat-label').textContent = flatData.label ?? '';
  // Clear previous state
  ['enq-name','enq-phone','enq-email','enq-message'].forEach(id => {
    const el = document.getElementById(id);
    el.value = '';
    el.closest('.enq-field')?.classList.remove('error', 'valid');
  });
  document.getElementById('enq-submit').disabled = true;
  document.getElementById('enq-toast').className = 'enq-toast';
  enquiryOverlay.classList.add('visible');
}

function closeEnquiryModal() {
  enquiryOverlay.classList.remove('visible');
}

// Validation helpers
const validators = {
  'enq-name':    v => v.trim().length >= 2,
  'enq-phone':   v => /^[+\d\s\-()]{7,15}$/.test(v.trim()),
  'enq-email':   v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  'enq-message': v => v.trim().length >= 5,
};

function validateEnquiryField(id) {
  const el    = document.getElementById(id);
  const field = el.closest('.enq-field');
  const ok    = validators[id](el.value);
  field.classList.toggle('error', !ok && el.value.length > 0);
  field.classList.toggle('valid', ok);
  return ok;
}

function checkEnquiryForm() {
  const allOk = Object.keys(validators).every(id => validators[id](document.getElementById(id).value));
  document.getElementById('enq-submit').disabled = !allOk;
}

// Wire up live validation
document.querySelectorAll('#enquiry-modal input, #enquiry-modal textarea').forEach(el => {
  el.addEventListener('input', () => {
    validateEnquiryField(el.id);
    checkEnquiryForm();
  });
  el.addEventListener('blur', () => validateEnquiryField(el.id));
});

// Close on overlay backdrop click
enquiryOverlay.addEventListener('click', e => {
  if (e.target === enquiryOverlay) closeEnquiryModal();
});

document.getElementById('enq-close').addEventListener('click', closeEnquiryModal);

document.getElementById('enq-submit').addEventListener('click', () => {
  const submitBtn = document.getElementById('enq-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';

  // TODO: Replace with real API call
  const success = true; // stub

  setTimeout(() => {
    const toast = document.getElementById('enq-toast');
    if (success) {
      toast.textContent  = '✓  Enquiry sent! We\'ll be in touch soon.';
      toast.className    = 'enq-toast success visible';
    } else {
      toast.textContent  = '✕  Something went wrong. Please try again.';
      toast.className    = 'enq-toast error visible';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Enquiry';
      return;
    }
    // Success: close everything and return to interior scene
    setTimeout(() => {
      closeEnquiryModal();
      hidePopup();
      closeFlat();
    }, 1800);
  }, 1000); // simulate network delay
});

function buildPopupHTML(d) {
  const label = d.status.charAt(0).toUpperCase() + d.status.slice(1);
  return `
    <div class="popup-header">
      <div class="popup-title">${d.label}</div>
      <button class="popup-close" aria-label="Close">✕</button>
    </div>
    <div class="popup-status ${d.status}">
      <div class="popup-status-dot"></div>${label}
    </div>
    <div class="popup-grid">
      <div class="popup-field">
        <div class="popup-field-label">Area</div>
        <div class="popup-field-value">${d.area}</div>
      </div>
      <div class="popup-field">
        <div class="popup-field-label">Type</div>
        <div class="popup-field-value">${d.type}</div>
      </div>
      <div class="popup-field">
        <div class="popup-field-label">Floor</div>
        <div class="popup-field-value">${d.floor}</div>
      </div>
      <div class="popup-field">
        <div class="popup-field-label">Facing</div>
        <div class="popup-field-value">${d.facing}</div>
      </div>
      <div class="popup-field">
        <div class="popup-field-label">Balconies</div>
        <div class="popup-field-value">${d.balconies}</div>
      </div>
      <div class="popup-field">
        <div class="popup-field-label">Parking</div>
        <div class="popup-field-value">${d.parking}</div>
      </div>
    </div>
    <div class="popup-price">
      <div class="popup-price-label">Price</div>
      <div class="popup-price-value">${d.price}</div>
    </div>
    <div class="popup-actions">
      <button class="btn-360" aria-label="View 360° tour">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a10 10 0 1 0 10 10"/>
          <path d="M12 8v4l3 3"/>
          <path d="M18 2v4h4"/>
        </svg>
        360° View
      </button>
      ${d.status === 'available' ? `
      <button class="btn-enquire" aria-label="Enquire about this flat">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        Enquire Now
      </button>` : ''}
    </div>`;
}

/* ─────────────────────────────────────────────────────────────
   FILTER
───────────────────────────────────────────────────────────── */
window.filterStatus = function(status) {
  activeFilter  = status;
  hoveredObject = null;
  hidePopup(); closeFlat(); hideTooltip();
  canvas.style.cursor = 'default';

  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  const cls = { all: 'f-all', available: 'f-avail', reserved: 'f-res', sold: 'f-sold' }[status];
  document.querySelector(`.filter-btn.${cls}`)?.classList.add('active');

  for (const [key, root] of Object.entries(flatRoots)) {
    const show = status === 'all' || flatsData[key]?.status === status;
    root.visible = show;
    if (show) {
      restoreMaterials(root);
      // Re-apply status tint (restore returns raw GLB colours)
      const flatStatus = flatsData[key]?.status ?? 'available';
      applyColor(root, STATUS_COLORS[flatStatus] ?? STATUS_COLORS.available, EMISSIVE_FLAT_DEFAULT);
    }
  }
};

/* ─────────────────────────────────────────────────────────────
   CAMERA RESET
───────────────────────────────────────────────────────────── */
window.resetCamera = function() {
  animateCamera(
    mode === 'exterior' ? EXT_CAM_POS : INT_CAM_POS,
    mode === 'exterior' ? EXT_CAM_TARGET : INT_CAM_TARGET
  );
};

/* ─────────────────────────────────────────────────────────────
   BACK BUTTON
───────────────────────────────────────────────────────────── */
document.getElementById('back-btn').addEventListener('click', () => switchToExterior());

/* ─────────────────────────────────────────────────────────────
   MODE HINT
───────────────────────────────────────────────────────────── */
function setHint(text) {
  const el = document.getElementById('mode-hint');
  el.classList.toggle('hidden', !text);
  if (text) el.textContent = text;
}

/* ─────────────────────────────────────────────────────────────
   RESIZE
───────────────────────────────────────────────────────────── */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/* ─────────────────────────────────────────────────────────────
   RENDER LOOP
───────────────────────────────────────────────────────────── */
function animate() {
  requestAnimationFrame(animate);
  controls.update();

  if (camPos_anim) {
    camera.position.lerp(camPos_anim, camLerpSpeed);
    controls.target.lerp(camTarget_anim, camLerpSpeed);
    if (camera.position.distanceTo(camPos_anim) < 0.05) {
      camera.position.copy(camPos_anim);
      controls.target.copy(camTarget_anim);
      camPos_anim = camTarget_anim = null;
    }
    controls.update();
  }

  renderer.render(scene, camera);
}
animate();

/* ─────────────────────────────────────────────────────────────
   BOOT
───────────────────────────────────────────────────────────── */
async function init() {
  try {
    updateProgress(5,  'Fetching flat data…');
    await loadData();

    updateProgress(10, 'Loading exterior model…');
    await loadExterior();

    updateProgress(65, 'Loading interior model…');
    await loadInterior();

    updateProgress(100, 'Ready');
    updateStats();

    await new Promise(r => setTimeout(r, 300));
    const lo = document.getElementById('loading-overlay');
    lo.classList.add('hidden');
    setTimeout(() => lo.remove(), 700);

    updateUI();
    setHint('Click the building to explore inside');

  } catch (err) {
    console.error('[viewer] Init error:', err);
    document.getElementById('loading-text').textContent =
      'Error loading models — check the browser console.';
  }
}

init();
