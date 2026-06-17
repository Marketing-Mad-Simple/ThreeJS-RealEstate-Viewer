/**
 * viewer.js  —  Orchestrator
 *
 * Boot sequence:
 *   1. initScene()         — renderer, camera, lights, ground, render loop
 *   2. loadAll()           — texture registry: fetch all textures (graceful null on miss)
 *   3. loadModels()        — GLBs or procedural demo geometry
 *   4. applyAllConfig()    — apply initial material state to freshly loaded models
 *   5. initUI()            — build card lists, wire all interactions
 *   6. hide loading overlay
 *
 * All Three.js lives in scene.js.
 * All material mutation lives in materials.js.
 * All option data + thumbnail painters live in options.js.
 * All texture paths + loading live in textureRegistry.js.
 * All DOM building lives in ui.js.
 */

import { loadAll }                               from './textureRegistry.js';
import { initScene, loadModels, switchView,
         resetCamera, getModels, getInteriorLight,
         getCurrentView }                        from './scene.js';
import { applyExteriorConfig, applyInteriorConfig } from './materials.js';
import { OPTIONS, DEFAULT_CONFIG, resolveOpt }   from './options.js';
import { initUI, setViewSection, showToast }     from './ui.js';

/* ── Live config state ── */
const config = { ...DEFAULT_CONFIG };

/* ── Apply helpers ── */
function applyExterior() {
  applyExteriorConfig(
    getModels().exterior,
    resolveOpt('paint',  config.paint),
    resolveOpt('finish', config.finish),
  );
}

function applyInterior() {
  applyInteriorConfig(
    getModels().interior,
    {
      seatOpt:  resolveOpt('seat',     config.seat),
      woodOpt:  resolveOpt('wood',     config.wood),
      lightOpt: resolveOpt('lighting', config.lighting),
      styleOpt: resolveOpt('style',    config.style),
    },
    getCurrentView(),
    getInteriorLight(),
  );
}

function applyAllConfig() {
  applyExterior();
  applyInterior();
}

/* ── Config change dispatcher (called by ui.js) ── */
function onConfigChange(group, id) {
  switch (group) {

    case 'paint':
    case 'finish':
    case 'stripe':
      applyExterior();
      break;

    case 'seat':
    case 'wood':
    case 'lighting':
    case 'style':
      applyInterior();
      break;

    case '__view__': {
      const changed = switchView(id);
      if (changed) {
        setViewSection(id);
        showToast(id === 'exterior' ? 'Viewing Exterior' : 'Viewing Interior');
        // Re-apply interior config so lighting intensity updates
        applyInterior();
      }
      break;
    }

    case '__resetCamera__':
      resetCamera();
      break;

    case '__quote__': {
      const p = resolveOpt('paint',  config.paint);
      const f = resolveOpt('finish', config.finish);
      const s = resolveOpt('seat',   config.seat);
      const w = resolveOpt('wood',   config.wood);
      showToast(`Quote: ${p.name} · ${f.name} · ${s.name} · ${w.name}`);
      break;
    }
  }
}

/* ── Boot ── */
async function boot() {
  // 1. Scene (starts render loop immediately so we see the bg while loading)
  initScene();

  // 2. Loading overlay progress helper
  const progressBar = document.getElementById('progress-bar');
  const loadingText = document.getElementById('loading-text');
  const overlay     = document.getElementById('loading-overlay');

  function setProgress(pct, label) {
    progressBar.style.width = (pct * 100).toFixed(1) + '%';
    if (label) loadingText.textContent = label;
  }

  // 3. Textures (0% → 40%)
  setProgress(0, 'Loading textures…');
  const TEXTURE_JOB_COUNT = 11;   // rough known total from manifest
  let texLoaded = 0;
  await loadAll((loaded, total) => {
    texLoaded = loaded;
    setProgress((loaded / (total || TEXTURE_JOB_COUNT)) * 0.40, 'Loading textures…');
  });

  // 4. Models (40% → 95%)
  const { usedDemo } = await loadModels((pct, label) => {
    setProgress(0.40 + pct * 0.55, label);
  });

  // 5. Apply initial material config (textures are now ready)
  applyAllConfig();

  // 6. Build UI
  initUI(config, onConfigChange);

  // 7. Done
  setProgress(1.0, 'Ready');
  setTimeout(() => {
    overlay.classList.add('hidden');
    setTimeout(() => document.getElementById('hint-bar').classList.add('fade'), 5000);
  }, 500);

  if (usedDemo) {
    showToast('Demo mode — drop GLBs into /models/ to load your aircraft');
  }
}

boot();
