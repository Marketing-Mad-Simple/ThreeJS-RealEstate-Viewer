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

import * as THREE from 'three';
import { loadAll }                               from './textureRegistry.js';
import { initScene, loadModels, switchView,
         resetCamera, getModels, getInteriorLight,
         getCabinLights, getCurrentView, updateSunDirection,
         setStripGlowColor, injectStripGlowShaders } from './scene.js';
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
    resolveOpt('stripe', config.stripe),
  );
}

function applyInterior() {
  const lightOpt = resolveOpt('lighting', config.lighting);
  applyInteriorConfig(
    getModels().interior,
    {
      seatOpt:  resolveOpt('seat',  config.seat),
      woodOpt:  resolveOpt('wood',  config.wood),
      lightOpt,
      styleOpt: resolveOpt('style', config.style),
    },
    getCurrentView(),
    getInteriorLight(),
    getCabinLights(),
  );
  // Keep shader glow planes colour in sync with the lighting option
  setStripGlowColor(lightOpt.color);
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

  // 5. Inject strip glow shaders into interior model materials (once, before first render)
  injectStripGlowShaders(getModels().interior);

  // 6. Apply initial material config (textures are now ready)
  applyAllConfig();

  // 7. Build UI
  initUI(config, onConfigChange);

  // 8. Done
  setProgress(1.0, 'Ready');
  setTimeout(() => {
    overlay.classList.add('hidden');
    setTimeout(() => document.getElementById('hint-bar').classList.add('fade'), 5000);
  }, 500);

  if (usedDemo) {
    showToast('Demo mode — drop GLBs into /models/ to load your aircraft');
  }
}

// ── Dev helpers (browser console) ──
// setSun(10.5, 12)                     → reposition sun
// setCabinLight(0, 0, 1.9, 6, 3.2)    → move cabin light 0 and set intensity
// cabinInfo()                          → dump cabin bounding box + light positions
window.setSun = updateSunDirection;
window.setCabinLight = (i, x, y, z, intensity) => {
  const lights = getCabinLights();
  if (!lights[i]) { console.warn('No cabin light at index', i); return; }
  lights[i].position.set(x, y, z);
  if (intensity !== undefined) lights[i].intensity = intensity;
  console.log(`Cabin light ${i} → (${x}, ${y}, ${z}) intensity=${lights[i].intensity}`);
};
window.cabinInfo = () => {
  const m = getModels().interior;
  if (m) {
    const box = new THREE.Box3().setFromObject(m);
    const sz  = box.getSize(new THREE.Vector3());
    console.log('Interior bbox min:', box.min, 'max:', box.max, 'size:', sz);
  }
  getCabinLights().forEach((l, i) =>
    console.log(`Light ${i}: pos=(${l.position.x.toFixed(2)}, ${l.position.y.toFixed(2)}, ${l.position.z.toFixed(2)}) intensity=${l.intensity}`)
  );
};
window.listInteriorMeshes = () => {
  const m = getModels().interior;
  if (!m) { console.warn('Interior model not loaded'); return; }
  const names = [];
  m.traverse(n => { if (n.isMesh) names.push(n.name); });
  console.log('Interior mesh names:\n' + names.join('\n'));
};

boot();
