/**
 * ui.js
 *
 * Builds the configurator panel DOM and wires all user interactions.
 * Completely decoupled from Three.js — communicates only via callbacks.
 *
 * PUBLIC API
 * ──────────
 *   initUI(config, onConfigChange)
 *     config         — the live config state object (mutated in place)
 *     onConfigChange — called with (group, newId) after every selection
 */

import { OPTIONS } from './options.js';

/* ─────────────────────────────────────────────────────────────────
   THUMBNAIL RENDERER
   Paints each option's thumb fn onto a hidden <canvas> and returns
   a data URL. Called once per option at init time.
───────────────────────────────────────────────────────────────── */
function renderThumb(paintFn) {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 96;
  paintFn(c.getContext('2d'), 96, 96);
  return c.toDataURL('image/jpeg', 0.92);
}

/* ─────────────────────────────────────────────────────────────────
   BUILD A SINGLE MATERIAL CARD
───────────────────────────────────────────────────────────────── */
function makeCard(opt, isActive) {
  const card = document.createElement('button');
  card.className  = 'mat-card' + (isActive ? ' active' : '');
  card.dataset.id = opt.id;
  card.type       = 'button';

  // ── Thumbnail ──
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'mat-thumb';
  if (opt.thumb) {
    const img     = document.createElement('img');
    img.src       = renderThumb(opt.thumb);
    img.alt       = opt.name;
    img.draggable = false;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;border-radius:5px;';
    thumbWrap.appendChild(img);
  }

  // ── Text ──
  const info = document.createElement('div');
  info.className = 'mat-info';

  const name = document.createElement('div');
  name.className   = 'mat-name';
  name.textContent = opt.name;

  const desc = document.createElement('div');
  desc.className   = 'mat-desc';
  desc.textContent = opt.desc;

  info.appendChild(name);
  info.appendChild(desc);

  // ── Check badge ──
  const check = document.createElement('div');
  check.className = 'mat-check';
  check.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
    stroke="#0C0C0E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="2,6 5,9 10,3"/>
  </svg>`;

  card.appendChild(thumbWrap);
  card.appendChild(info);
  card.appendChild(check);
  return card;
}

/* ─────────────────────────────────────────────────────────────────
   BUILD A CARD LIST FOR ONE CONFIG GROUP
───────────────────────────────────────────────────────────────── */
function buildList(containerId, group, activeId, config, onConfigChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  OPTIONS[group].forEach(opt => {
    const card = makeCard(opt, opt.id === activeId);

    card.addEventListener('click', () => {
      // Deactivate siblings
      container.querySelectorAll('.mat-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      // Update state
      config[group] = opt.id;

      // Update the header "selected" label
      const sel = document.getElementById(`sel-${group}`);
      if (sel) sel.textContent = opt.name;

      // Notify viewer
      onConfigChange(group, opt.id);
    });

    container.appendChild(card);
  });
}

/* ─────────────────────────────────────────────────────────────────
   PUBLIC INIT
───────────────────────────────────────────────────────────────── */
export function initUI(config, onConfigChange) {
  // Map: listId → { group, selId }
  const lists = [
    { listId: 'list-paint',    group: 'paint',    selId: 'sel-paint'    },
    { listId: 'list-stripe',   group: 'stripe',   selId: 'sel-stripe'   },
    { listId: 'list-finish',   group: 'finish',   selId: 'sel-finish'   },
    { listId: 'list-seat',     group: 'seat',     selId: 'sel-seat'     },
    { listId: 'list-wood',     group: 'wood',     selId: 'sel-wood'     },
    { listId: 'list-floor',    group: 'floor',    selId: 'sel-floor'    },
    { listId: 'list-metal',    group: 'metal',    selId: 'sel-metal'    },
    { listId: 'list-plastic',  group: 'plastic',  selId: 'sel-plastic'  },
    { listId: 'list-lighting', group: 'lighting', selId: 'sel-lighting' },
  ];

  lists.forEach(({ listId, group, selId }) => {
    buildList(listId, group, config[group], config, onConfigChange);

    // Populate initial selected label
    const opt = OPTIONS[group].find(o => o.id === config[group]);
    const sel = document.getElementById(selId);
    if (sel && opt) sel.textContent = opt.name;
  });

  // ── View toggle ──
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => onConfigChange('__view__', btn.dataset.view));
  });

  // ── Panel collapse ──
  const panel = document.getElementById('config-panel');
  document.getElementById('panel-toggle-btn').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  // ── Camera reset ──
  document.getElementById('btn-reset').addEventListener('click', () => {
    onConfigChange('__resetCamera__', null);
  });

  // ── Fullscreen ──
  document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });

  // ── Quote button ──
  document.getElementById('btn-request').addEventListener('click', () => {
    onConfigChange('__quote__', null);
  });
}

/* ─────────────────────────────────────────────────────────────────
   VIEW SECTION SWITCHER  (called by viewer when view changes)
───────────────────────────────────────────────────────────────── */
export function setViewSection(view) {
  document.getElementById('section-exterior').classList.toggle('hidden', view !== 'exterior');
  document.getElementById('section-interior').classList.toggle('hidden', view !== 'interior');
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

/* ─────────────────────────────────────────────────────────────────
   TOAST
───────────────────────────────────────────────────────────────── */
let _toastTimeout;
export function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => el.classList.remove('show'), 3000);
}
