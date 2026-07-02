// ── stallclick.js — tap a stall mesh to set it as start or destination ───
'use strict';

let _popupStall    = null;
let _clickMeshes   = null; // built lazily on first tap
let _ptDownX = 0, _ptDownY = 0;
const _ray = new THREE.Raycaster();

// ── Glow state ────────────────────────────────────────────────────────────
// Each selected mesh gets its own cloned material so shared materials don't
// accidentally glow other stalls.  We also copy onBeforeCompile (which
// .clone() skips) — missing it was the root cause of the earlier crash
// because GLTF extension uniforms weren't set up on the clone.
let _glowSaved = []; // { mesh, origMat }
let _glowTime  = 0;

function _cloneMat(m) {
  const c = m.clone();
  // Preserve any shader hooks the GLTF loader attached (extensions, etc.)
  c.onBeforeCompile    = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  c.needsUpdate = true;
  return c;
}

function _glowMesh(child) {
  const origMat = child.material;
  const srcArr  = Array.isArray(origMat) ? origMat : [origMat];
  const newArr  = srcArr.map(m => {
    if (!m) return m;
    const c = _cloneMat(m);
    if (c.emissive) {
      // MeshStandardMaterial / MeshPhongMaterial
      c.emissive.setHex(0xFFFFFF);
      c.emissiveIntensity = 0;
    } else {
      // MeshBasicMaterial (KHR_materials_unlit) — save color for pulse
      c.userData._origColor = c.color ? c.color.clone() : new THREE.Color(1, 1, 1);
    }
    return c;
  });
  _glowSaved.push({ mesh: child, origMat });
  child.material = Array.isArray(origMat) ? newArr : newArr[0];
}

function _applyGlow(stall, hitObj) {
  _clearGlow();
  if (!hitObj) return;

  // Walk up from the hit mesh to find the node named after the stall.
  // Flat stalls: the mesh itself carries the stall ID (depth 0).
  // Grouped stalls: the parent Group carries the stall ID (depth 1+).
  let root = hitObj;
  let node = hitObj;
  for (let i = 0; i < 4; i++) {
    if (node.name === stall.id) { root = node; break; }
    if (!node.parent || node.parent.type === 'Scene') break;
    node = node.parent;
  }

  root.traverse(child => { if (child.isMesh) _glowMesh(child); });
}

function _clearGlow() {
  _glowSaved.forEach(({ mesh, origMat }) => { mesh.material = origMat; });
  _glowSaved = [];
  _glowTime  = 0;
}

const _pulseTarget = new THREE.Color(0xFF6B2B); // orange pulse target for BasicMaterial
// Called every frame by scene.js animate loop
window.updateStallGlow = function(dt) {
  if (!_glowSaved.length) return;
  _glowTime += dt;
  // t: 0→1→0 sine wave at ~2 Hz
  const t = 0.5 + 0.5 * Math.sin(_glowTime * 4);
  const emissiveIntensity = 0.4 + 1.2 * t;   // 0.4 – 1.6
  const colorT            = 0.3 + 0.7 * t;    // 0.3 – 1.0  (never fully original)
  _glowSaved.forEach(({ mesh }) => {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach(m => {
      if (!m) return;
      if (m.emissive) {
        m.emissiveIntensity = emissiveIntensity;
      } else if (m.color && m.userData._origColor) {
        // Pulse between original colour and orange — visible on any base colour
        m.color.lerpColors(m.userData._origColor, _pulseTarget, colorT);
      }
    });
  });
};

// ── Mesh cache ────────────────────────────────────────────────────────────
function _buildClickMeshes() {
  _clickMeshes = [];
  if (!window.scene) return;
  window.scene.traverse(obj => {
    if (!obj.isMesh) return;
    if (obj.name === 'NAV_MESH' || obj.name === 'Floor') return;
    if (obj.userData.isNavPath) return;
    if (obj === window.destMarker) return;
    _clickMeshes.push(obj);
  });
}

// Expose so bootstrap can invalidate if the scene is rebuilt
window.invalidateStallClickCache = function() { _clickMeshes = null; };

// ── Stall lookup ──────────────────────────────────────────────────────────
function _findStall(hitObject, hitPoint) {
  // Walk ancestor chain first — handles grouped meshes where the Group is named
  let node = hitObject;
  while (node) {
    const s = window.STALL_DATA && window.STALL_DATA.find(s => s.id === node.name);
    if (s) return s;
    node = node.parent;
  }
  // Fallback: nearest stall centre in XZ within 0.6 world units of the hit point
  if (window.STALL_DATA) {
    let best = null, bestDist = 0.6;
    window.STALL_DATA.forEach(s => {
      const dx = s.x - hitPoint.x, dz = s.z - hitPoint.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) { bestDist = d; best = s; }
    });
    return best;
  }
  return null;
}

// ── Popup control ─────────────────────────────────────────────────────────
function _showPopup(stall, hitObj) {
  _popupStall = stall;

  document.getElementById('stallPopupId').textContent = stall.id;

  const nameEl  = document.getElementById('stallPopupName');
  const rawName = (stall.company || '').trim();
  const skip    = !rawName ||
    ['EMPTY', 'RESERVED', 'RESERV', 'BOOKED'].includes(rawName.toUpperCase());
  nameEl.textContent   = skip ? '' : rawName;
  nameEl.style.display = skip ? 'none' : 'block';

  _applyGlow(stall, hitObj);
  document.getElementById('stallPopup').classList.add('open');
}

window.closeStallPopup = function() {
  _popupStall = null;
  _clearGlow();
  document.getElementById('stallPopup').classList.remove('open');
};

window.stallPopupSetFrom = function() {
  if (!_popupStall || !window.setRouteFrom) return;
  window.setRouteFrom(_popupStall);
  window.closeStallPopup();
};

window.stallPopupSetTo = function() {
  if (!_popupStall || !window.setDestination) return;
  window.setDestination(_popupStall);
  window.closeStallPopup();
};

// ── Tap detection ─────────────────────────────────────────────────────────
const _canvas = document.getElementById('three-canvas');

_canvas.addEventListener('pointerdown', e => {
  _ptDownX = e.clientX;
  _ptDownY = e.clientY;
});

_canvas.addEventListener('pointerup', e => {
  const dx = e.clientX - _ptDownX;
  const dy = e.clientY - _ptDownY;
  // Ignore if pointer moved more than 8px — it was a pan, not a tap
  if (dx * dx + dy * dy > 64) return;
  // Don't intercept in first-person nav mode
  if (window._firstPersonMode) return;

  if (!_clickMeshes) _buildClickMeshes();

  _ray.setFromCamera(
    new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    ),
    window.camera
  );

  const hits = _ray.intersectObjects(_clickMeshes, true);
  if (!hits.length) { window.closeStallPopup(); return; }

  const hit   = hits[0];
  const stall = _findStall(hit.object, hit.point);
  if (stall) {
    _showPopup(stall, hit.object);
  } else {
    window.closeStallPopup();
  }
});
