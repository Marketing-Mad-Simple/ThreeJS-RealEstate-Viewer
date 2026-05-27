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
    // Compute approximate ETA using destination
    const eta = etaText(routeTo);
    document.getElementById('navEta').textContent = eta;
    document.getElementById('navEta').style.display = 'inline';
  } else {
    document.getElementById('navEta').style.display = 'none';
  }
}

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
    if (typeof resetHeading !== 'undefined') resetHeading();
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

  // 5. Auto-start walking
  window.isMoving = true;
  window._sensorsStarted = true;
  document.getElementById('moveBtn').textContent = 'Walking: ON';
  document.getElementById('moveBtn').className   = 'btn btn-active';

  // 6. Switch UI to navigating state
  navigating = true;
  document.body.classList.add('navigating');
  document.body.classList.remove('planner-collapsed');

  document.getElementById('navActiveName').textContent =
    `→ ${routeTo.id}: ${routeTo.company || ''}`;
  updateNavActiveDist();

  // Hide sensor start button if visible (sensors already started)
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('moveBtn').style.display  = '';
  document.getElementById('gpsBtn').style.display   = '';
  document.getElementById('resetBtn').style.display = '';

};

window.stopNavigation = function() {
  navigating = false;
  document.body.classList.remove('navigating');
  window.isMoving = false;
  window.destStall = null;
  if (window.clearPath) window.clearPath();
  if (window.highlightStall) window.highlightStall(null);
  document.getElementById('moveBtn').textContent = 'Walking: OFF';
  document.getElementById('moveBtn').className   = 'btn btn-primary';
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
  window.isMoving = false;
  document.getElementById('moveBtn').textContent = 'Walking: OFF';
  document.getElementById('moveBtn').className   = 'btn btn-primary';
  document.body.classList.remove('navigating');

  document.getElementById('arrivalStall').textContent =
    `${stall.id}${stall.company ? '\n' + stall.company : ''}`;
  document.getElementById('arrivalOverlay').classList.add('show');
}

window.dismissArrival = function() {
  document.getElementById('arrivalOverlay').classList.remove('show');
  window.destStall = null;
  // Reset route inputs for next navigation
  window.clearRoutePoint('from');
  window.clearRoutePoint('to');
  routeFrom = null; routeTo = null;
  document.body.classList.remove('navigating');
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
window.setDestination = function(stall) {
  setTo(stall);
};

// ── Auto-populate "From = My Location" on load ────────────────────────────
window.addEventListener('load', () => {
  setTimeout(() => {
    if (!routeFrom) {
      setFrom({ id: 'MY_LOCATION', company: 'My current position', x: aX, y: aY, z: aZ });
    }
  }, 600);
});
