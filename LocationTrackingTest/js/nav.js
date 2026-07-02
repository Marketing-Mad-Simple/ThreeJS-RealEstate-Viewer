// ── nav.js — route planner, picker, navigation state ─────────────────────
'use strict';

// ── State ─────────────────────────────────────────────────────────────────
let routeFrom   = null;  // { id, company, x, y, z } or { id:'MY_LOCATION', ... }
let routeTo     = null;
let activePicker = null; // 'from' | 'to'
let navigating   = false;

window.destStall = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function distTo(stall) {
  return Math.sqrt((stall.x - window.aX) ** 2 + (stall.z - window.aZ) ** 2);
}
function etaText(stall) {
  const d = distTo(stall);
  // ~1.2 m/s walking pace, 1 world unit ≈ 5 real metres
  const secs = Math.round(d * 5 / 1.2);
  return secs < 60 ? `~${secs}s` : `~${Math.round(secs/60)}min`;
}

// ── Top bar collapse ───────────────────────────────────────────────────────
window.toggleTopBar = function() {
  document.body.classList.toggle('planner-collapsed');
  document.getElementById('topCollapseBtn').textContent =
    document.body.classList.contains('planner-collapsed') ? '▼' : '▲';
};

// ── Route picker ───────────────────────────────────────────────────────────
window.openRoutePicker = function(which) {
  activePicker = which;
  const picker = document.getElementById('routePicker');
  const myRow  = document.getElementById('myLocationRow');
  myRow.style.display = which === 'from' ? 'flex' : 'none';
  document.getElementById('routePickerSearch').value = '';
  renderPickerList('');
  picker.classList.add('open');
  document.getElementById('routePickerSearch').focus();
};

window.closeRoutePicker = function() {
  document.getElementById('routePicker').classList.remove('open');
  document.getElementById('routePickerSearch').value = '';
  activePicker = null;
};

window.filterRoutePicker = function(q) {
  renderPickerList(q.trim().toLowerCase());
};

function renderPickerList(q) {
  if (!window.STALL_DATA) return;
  const list = document.getElementById('routePickerList');
  const items = window.STALL_DATA
    .filter(s => !q ||
      s.id.toLowerCase().includes(q) ||
      (s.company || '').toLowerCase().includes(q))
    .sort((a, b) => distTo(a) - distTo(b));

  list.innerHTML = '';
  items.forEach(stall => {
    const d   = distTo(stall);
    const div = document.createElement('div');
    div.className = 'picker-item';
    div.innerHTML = `
      <span class="picker-id">${stall.id}</span>
      <span class="picker-name">${stall.company || '—'}</span>
      <span class="picker-dist">${d < 0.1 ? 'here' : Math.round(d*5)+'m'}</span>`;
    div.addEventListener('click', () => pickStall(stall));
    list.appendChild(div);
  });
}

function pickStall(stall) {
  if (activePicker === 'from') setFrom(stall);
  else                          setTo(stall);
  window.closeRoutePicker();
}

window.pickMyLocation = function() {
  setFrom({ id: 'MY_LOCATION', company: 'My current position', x: window.aX, y: window.aY, z: window.aZ });
  window.closeRoutePicker();
};

// ── Set from / to ──────────────────────────────────────────────────────────
function setFrom(stall) {
  routeFrom = stall;
  const inp = document.getElementById('fromInput');
  inp.value = stall.id === 'MY_LOCATION' ? '📍 My position' : `${stall.id} — ${stall.company||''}`;
  inp.classList.add('filled');
  document.getElementById('fromClear').style.display = 'block';
  updateStartBtn();
}
function setTo(stall) {
  routeTo = stall;
  const inp = document.getElementById('toInput');
  inp.value = `${stall.id} — ${stall.company||''}`;
  inp.classList.add('filled');
  document.getElementById('toClear').style.display = 'block';
  updateStartBtn();
}

window.clearRoutePoint = function(which) {
  if (which === 'from') {
    routeFrom = null;
    const inp = document.getElementById('fromInput');
    inp.value = ''; inp.classList.remove('filled');
    document.getElementById('fromClear').style.display = 'none';
  } else {
    routeTo = null;
    const inp = document.getElementById('toInput');
    inp.value = ''; inp.classList.remove('filled');
    document.getElementById('toClear').style.display = 'none';
  }
  updateStartBtn();
};

window.swapRoutePoints = function() {
  // Can't swap if from is MY_LOCATION (can't teleport to it)
  if (!routeFrom || !routeTo) return;
  if (routeFrom.id === 'MY_LOCATION') return;
  const tmp = routeFrom; routeFrom = routeTo; routeTo = tmp;
  setFrom(routeFrom); setTo(routeTo);
};

function updateStartBtn() {
  const btn = document.getElementById('startNavBtn');
  const ready = routeFrom && routeTo;
  btn.disabled = !ready;
  if (ready && routeTo) {
    const eta = etaText(routeTo);
    document.getElementById('navEta').textContent = eta;
    document.getElementById('navEta').style.display = 'inline';
    // Show route preview with zoomed-out camera
    showRoutePreview(routeFrom, routeTo);
  } else {
    document.getElementById('navEta').style.display = 'none';
    // Clear path and preview markers
    if (window.clearPath) window.clearPath();
    window._previewFrom = null;
    window._previewTo   = null;
    // Exit preview mode and zoom back to close-up follow
    if (window.setCamPreview) window.setCamPreview(false);
    if (window.animateCamera) {
      window.animateCamera(
        { x: window.aX || 0, y: 2.2, z: (window.aZ || 0) + 0.6 },
        { x: window.aX || 0, y: 0.02, z: window.aZ || 0 },
        0.7
      );
    }
  }
}

function showRoutePreview(from, to) {
  if (!window.computePath || !window.animateCamera) return;

  // Get the from position (snap to navmesh if it's a stall)
  let fx = from.x, fz = from.z;
  if (from.id !== 'MY_LOCATION') {
    const snap = snapToNavmesh(from.x, from.z);
    fx = snap.x; fz = snap.z;
  } else {
    fx = window.aX; fz = window.aZ;
  }

  // Set preview endpoint markers
  window._previewFrom = { x: fx, y: 0.02, z: fz, id: from.id };
  window._previewTo   = { x: to.x, y: 0.02, z: to.z, id: to.id };

  // Draw the preview path
  const previewDest = { ...to };
  const savedAX = window.aX, savedAZ = window.aZ;
  window.aX = fx; window.aZ = fz;
  window.computePath(previewDest);
  window.aX = savedAX; window.aZ = savedAZ;

  // Compute bounding box of from + to to frame the camera
  const midX = (fx + to.x) / 2;
  const midZ = (fz + to.z) / 2;
  const spanX = Math.abs(to.x - fx);
  const spanZ = Math.abs(to.z - fz);
  const span  = Math.max(spanX, spanZ, 1.0);

  // Camera height to frame both points with padding
  const camH = span * 1.6 + 2.5;
  const camZ = span * 0.5 + 1.0;

  // Pass plain objects — animateCamera accepts {x,y,z} or Vector3
  window.animateCamera(
    { x: midX, y: camH, z: midZ + camZ },
    { x: midX, y: 0.02, z: midZ },
    1.0,
    () => { if (window.setCamPreview) window.setCamPreview(true); }
  );
}

function midH(h) { return h; } // helper — just returns h for readability

// ── Start navigation ────────────────────────────────────────────────────────
window.startNavigation = async function() {
  if (!routeFrom || !routeTo) return;

  // 1. Request sensor permissions if not yet started
  if (typeof window._sensorsStarted === 'undefined' || !window._sensorsStarted) {
    await window.requestAndStart();
  }

  // 2. Teleport avatar to from-stall aisle position (nearest navmesh point)
  if (routeFrom.id !== 'MY_LOCATION') {
    const snap = snapToNavmesh(routeFrom.x, routeFrom.z);
    window.placeAvatarImmediate(snap.x, snap.y, snap.z);
    if (window.resetHeading) window.resetHeading();
  } else {
    // Use current live position
    routeFrom.x = window.aX; routeFrom.y = window.aY; routeFrom.z = window.aZ;
    // Update the From input label to reflect actual position
    document.getElementById('fromInput').value = '📍 My position';
  }

  // 3. Set destination
  window.destStall = routeTo;

  // 4. Compute path
  if (window.computePath) window.computePath(routeTo);

  // 5. Switch to first-person view
  if (window.enterFirstPerson) window.enterFirstPerson();
  const _tvBtn = document.getElementById('navViewToggle');
  if (_tvBtn) _tvBtn.textContent = '🗺 Top View';

  // Clear preview markers, exit preview mode, set navigating flag
  window._previewFrom = null;
  window._previewTo   = null;
  window._navigating  = true;
  if (window.setCamPreview) window.setCamPreview(false);

  window.isMoving = true;
  window._sensorsStarted = true;

  // 6. Switch UI to navigating state
  navigating = true;
  document.body.classList.add('navigating');
  document.body.classList.remove('planner-collapsed');

  document.getElementById('navActiveName').textContent =
    `→ ${routeTo.id}: ${routeTo.company || ''}`;
  updateNavActiveDist();

  // Hide sensor start button if visible (sensors already started)
  const _sb = document.getElementById('startBtn');
  if (_sb) _sb.style.display = 'none';
  const _gb = document.getElementById('gpsBtn');
  if (_gb) _gb.style.display = '';
  const _rb = document.getElementById('resetBtn');
  if (_rb) _rb.style.display = '';

};

window.stopNavigation = function() {
  navigating = false;
  window._navigating = false;
  document.body.classList.remove('navigating');
  window.isMoving = true; // keep tracking after stop
  window.destStall = null;
  if (window.highlightStall) window.highlightStall(null);

  const afterExit = () => {
    if (routeFrom && routeTo) {
      showRoutePreview(routeFrom, routeTo);
    } else {
      window._previewFrom = null;
      window._previewTo   = null;
      if (window.clearPath) window.clearPath();
      if (window.stopCamAnim) window.stopCamAnim();
    }
  };

  if (window.exitFirstPerson) {
    window.exitFirstPerson(afterExit);
  } else {
    afterExit();
  }
};

// ── Snap to nearest navmesh walkable point ─────────────────────────────────
function snapToNavmesh(wx, wz) {
  // Use pathfinder's snapToWalkable if available
  if (window.NAV_GRID) {
    const { gx, gz } = snapToWalkable(wx, wz);
    const w = gridToWorld(gx, gz);
    // Get Y from navmesh
    const tri = window.findTri ? window.findTri(w.x, w.z) : null;
    const y   = tri ? window.triY(w.x, w.z, tri.a, tri.b, tri.c) : 0.02;
    return { x: w.x, y, z: w.z };
  }
  return { x: wx, y: 0.02, z: wz };
}

// ── Live distance update (called from scene animate loop) ──────────────────
window.updateNavActiveDist = function() {
  if (!navigating || !window.destStall) return;
  const d = distTo(window.destStall);
  const realMetres = Math.round(d * 5);

  document.getElementById('navActiveDist').textContent =
    d < 0.15 ? '🎯 Arrived!' : `~${realMetres} m remaining`;

  // Check arrival
  if (d < 0.15 && navigating) {
    navigating = false;
    if (window.clearPath) window.clearPath();
    showArrival(window.destStall);
  }
};

// ── Arrival ────────────────────────────────────────────────────────────────
function showArrival(stall) {
  window.isMoving = false; // pause on arrival
  document.body.classList.remove('navigating');

  const displayOverlay = () => {
    document.getElementById('arrivalStall').textContent =
      `${stall.id}${stall.company ? '\n' + stall.company : ''}`;
    document.getElementById('arrivalOverlay').classList.add('show');
  };

  if (window.exitFirstPerson) {
    window.exitFirstPerson(displayOverlay);
  } else {
    displayOverlay();
  }
}

window.dismissArrival = function() {
  document.getElementById('arrivalOverlay').classList.remove('show');
  window.destStall = null;
  window._navigating = false;
  document.body.classList.remove('navigating');
  // Reset route inputs for next navigation
  window.clearRoutePoint('from');
  window.clearRoutePoint('to');
  routeFrom = null; routeTo = null;
  window._previewFrom = null;
  window._previewTo   = null;
  if (window.clearPath) window.clearPath();
  if (window.stopCamAnim) window.stopCamAnim();
  window.isMoving = true; // resume tracking after dismissal
  updateStartBtn();
};

// ── Nav panel (stall list — accessed via From/To picker now, kept for compat) ─
const navPanel  = document.getElementById('navPanel');
const navContent= document.getElementById('navContent');

function renderNavList() {
  if (!window.STALL_DATA) return;
  const sorted = [...window.STALL_DATA]
    .filter(s => s.company && !['EMPTY','RESERVED','RESERV','BOOKED'].includes(s.company.trim().toUpperCase()))
    .sort((a, b) => distTo(a) - distTo(b));
  navContent.innerHTML = '<p style="color:#888;font-size:11px;margin-bottom:10px">Tap a stall to navigate</p>';
  sorted.forEach(stall => {
    const d   = distTo(stall);
    const btn = document.createElement('button');
    btn.className = 'nav-stall-btn';
    btn.innerHTML = `
      <span class="ns-id">${stall.id}</span>
      <span class="ns-name">${stall.company}</span>
      <span class="ns-dist">${d < 0.08 ? 'here' : Math.round(d*5)+'m'}</span>`;
    btn.addEventListener('click', () => {
      setTo(stall);
      navPanel.classList.remove('open');
    });
    navContent.appendChild(btn);
  });
}

// ── Wire setDestination for backward compat (used by search) ──────────────
window.setDestination = function(stall) { setTo(stall); };
window.setRouteFrom  = function(stall) { setFrom(stall); };

// ── Auto-populate "From = My Location" on load ────────────────────────────
window.addEventListener('load', () => {
  setTimeout(() => {
    if (!routeFrom) {
      setFrom({ id: 'MY_LOCATION', company: 'My current position', x: aX, y: aY, z: aZ });
    }
  }, 600);
});

// ── View toggle (first-person ↔ top-down) during active navigation ───────────
window.toggleNavView = function() {
  const btn = document.getElementById('navViewToggle');
  if (window._firstPersonMode) {
    // Switch to top-down follow view
    if (window.exitFirstPerson) window.exitFirstPerson(null);
    if (btn) btn.textContent = '👁 First Person';
  } else {
    // Switch to first-person
    if (window.enterFirstPerson) window.enterFirstPerson();
    if (btn) btn.textContent = '🗺 Top View';
  }
};

// ── AI assistant helper — sets from=current pos, to=stall, starts navigation ──
window.aiNavigateTo = function (stall) {
  setFrom({ id: 'MY_LOCATION', company: 'My current position',
    x: window.aX || 0, y: window.aY || 0.006, z: window.aZ || 0 });
  setTo(stall);
  window.startNavigation();
};
