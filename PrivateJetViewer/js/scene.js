/**
 * scene.js
 *
 * Everything Three.js:
 *   - Renderer, camera, controls, environment
 *   - Lighting rig
 *   - Ground plane
 *   - GLB loading with procedural fallback
 *   - Camera animation
 *   - Render loop
 *
 * PUBLIC API
 * ──────────
 *   initScene()          → sets up renderer + scene, starts render loop
 *   loadModels(onProgress) → loads GLBs (or builds demo), returns Promise
 *   switchView(view)     → animates camera, toggles model visibility
 *   resetCamera()        → snaps back to current view preset
 *   getModels()          → { exterior, interior }
 *   getInteriorLight()   → THREE.PointLight (used by materials.js)
 */

import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }     from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ─────────────────────────────────────────────────────────────────
   CAMERA PRESETS  — tweak these to frame your actual GLB models
───────────────────────────────────────────────────────────────── */
export const CAM_PRESETS = {
  exterior: {
    position: new THREE.Vector3(8, 3, 14),
    target:   new THREE.Vector3(0, 0.5, 0),
  },
  interior: {
    position: new THREE.Vector3(0, 1.2, 4),
    target:   new THREE.Vector3(0, 1.0, 0),
  },
};

/* ─────────────────────────────────────────────────────────────────
   MODULE-LEVEL SINGLETONS
───────────────────────────────────────────────────────────────── */
let renderer, scene, camera, controls;
let interiorLight;
let currentView   = 'exterior';
let isAnimating   = false;
const models      = { exterior: null, interior: null };

const gltfLoader  = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/');
gltfLoader.setDRACOLoader(dracoLoader);

/* ─────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────── */
export function initScene() {
  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('canvas'), antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled      = true;
  renderer.shadowMap.type         = THREE.PCFSoftShadowMap;
  renderer.toneMapping            = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure    = 1.1;
  renderer.outputColorSpace       = THREE.SRGBColorSpace;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0C0C0E);
  scene.fog = new THREE.Fog(0x0C0C0E, 40, 100);

  // Environment map (IBL)
  const pmrem  = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Camera
  camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.copy(CAM_PRESETS.exterior.position);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAM_PRESETS.exterior.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance   = 2;
  controls.maxDistance   = 60;
  controls.maxPolarAngle = Math.PI * 0.88;
  controls.update();

  _setupLighting();
  _buildGround();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  });

  _renderLoop();
}

/* ─────────────────────────────────────────────────────────────────
   LIGHTING RIG
───────────────────────────────────────────────────────────────── */
function _setupLighting() {
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // Key light (casts shadows)
  const key = new THREE.DirectionalLight(0xfff8f0, 2.2);
  key.position.set(10, 18, 10);
  key.castShadow                  = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near          = 1;
  key.shadow.camera.far           = 60;
  key.shadow.camera.left          = -20;
  key.shadow.camera.right         = 20;
  key.shadow.camera.top           = 20;
  key.shadow.camera.bottom        = -20;
  key.shadow.bias                 = -0.0004;
  scene.add(key);

  // Fill (cool, from opposite side)
  const fill = new THREE.DirectionalLight(0xD0E8FF, 0.70);
  fill.position.set(-10, 5, -8);
  scene.add(fill);

  // Rim (gold, from behind — gives exterior a premium edge glow)
  const rim = new THREE.DirectionalLight(0xC8A96E, 0.45);
  rim.position.set(0, 10, -15);
  scene.add(rim);

  // Interior cabin point light (starts off, enabled when interior is shown)
  interiorLight = new THREE.PointLight(0xF4C77A, 0, 8, 1.5);
  interiorLight.position.set(0, 2.5, 0);
  scene.add(interiorLight);

  // Sky / ground hemisphere
  scene.add(new THREE.HemisphereLight(0x111118, 0x080810, 0.50));
}

/* ─────────────────────────────────────────────────────────────────
   GROUND
───────────────────────────────────────────────────────────────── */
function _buildGround() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x080810, roughness: 0.15, metalness: 0.6 }),
  );
  ground.rotation.x   = -Math.PI / 2;
  ground.position.y   = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  // Subtle gold halo ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.5, 14, 64),
    new THREE.MeshBasicMaterial({ color: 0xC8A96E, transparent: true, opacity: 0.04, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  scene.add(ring);
}

/* ─────────────────────────────────────────────────────────────────
   MODEL LOADING
───────────────────────────────────────────────────────────────── */

/** Try to load a GLB; on any error returns null silently. */
function _tryLoad(path, onProgress) {
  return new Promise(resolve => {
    gltfLoader.load(
      path,
      gltf => resolve(gltf.scene),
      e    => { if (onProgress && e.total) onProgress(e.loaded / e.total); },
      ()   => resolve(null),
    );
  });
}

function _autoScale(model) {
  const box = new THREE.Box3().setFromObject(model);
  const sz  = box.getSize(new THREE.Vector3());
  const max = Math.max(sz.x, sz.y, sz.z);
  if (max > 0) model.scale.setScalar(14 / max);
  // Re-centre after scale
  const box2 = new THREE.Box3().setFromObject(model);
  model.position.sub(box2.getCenter(new THREE.Vector3()));
  model.position.y += box2.getSize(new THREE.Vector3()).y / 2;
}

function _enableShadows(model) {
  model.traverse(n => {
    if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
  });
}

/**
 * loadModels(onProgress)
 * onProgress(pct 0–1, label) — use to drive the loading bar
 */
export async function loadModels(onProgress) {
  const prog = (p, label) => onProgress && onProgress(p, label);

  prog(0.05, 'Loading exterior…');
  const extGLB = await _tryLoad('./models/exterior.glb', p => prog(0.05 + p * 0.35, 'Loading exterior…'));
  models.exterior = extGLB ?? _buildDemoExterior();
  if (!extGLB) prog(0.40, 'Building demo exterior…');
  _autoScale(models.exterior);
  _enableShadows(models.exterior);
  scene.add(models.exterior);

  prog(0.45, 'Loading interior…');
  const intGLB = await _tryLoad('./models/interior.glb', p => prog(0.45 + p * 0.45, 'Loading interior…'));
  models.interior = intGLB ?? _buildDemoInterior();
  if (!intGLB) prog(0.90, 'Building demo interior…');
  _autoScale(models.interior);
  _enableShadows(models.interior);
  models.interior.visible = false;
  scene.add(models.interior);

  prog(1.0, 'Ready');
  return { usedDemo: !extGLB || !intGLB };
}

export function getModels()       { return models; }
export function getInteriorLight(){ return interiorLight; }
export function getCurrentView()  { return currentView; }

/* ─────────────────────────────────────────────────────────────────
   VIEW SWITCHING + CAMERA ANIMATION
───────────────────────────────────────────────────────────────── */
export function switchView(view) {
  if (view === currentView || isAnimating) return false;
  currentView = view;
  models.exterior.visible = (view === 'exterior');
  models.interior.visible = (view === 'interior');
  interiorLight.intensity = (view === 'interior') ? 2.5 : 0;
  _animateCam(CAM_PRESETS[view].position, CAM_PRESETS[view].target, 1200);
  return true;
}

export function resetCamera(duration = 800) {
  _animateCam(CAM_PRESETS[currentView].position, CAM_PRESETS[currentView].target, duration);
}

function _animateCam(toPos, toTarget, dur) {
  isAnimating = true;
  const fromPos = camera.position.clone();
  const fromTgt = controls.target.clone();
  const t0      = performance.now();

  function tick(now) {
    const t    = Math.min((now - t0) / dur, 1);
    const ease = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;   // ease-in-out quad
    camera.position.lerpVectors(fromPos, toPos, ease);
    controls.target.lerpVectors(fromTgt, toTarget, ease);
    controls.update();
    if (t < 1) requestAnimationFrame(tick);
    else isAnimating = false;
  }
  requestAnimationFrame(tick);
}

/* ─────────────────────────────────────────────────────────────────
   RENDER LOOP
───────────────────────────────────────────────────────────────── */
function _renderLoop() {
  requestAnimationFrame(_renderLoop);
  if (!isAnimating) controls.update();
  renderer.render(scene, camera);
}

/* ─────────────────────────────────────────────────────────────────
   PROCEDURAL DEMO GEOMETRY
   Used when no GLB files are provided. Mesh names use the same
   prefixes as the real models so materials.js applies correctly.
───────────────────────────────────────────────────────────────── */
function _buildDemoExterior() {
  const g       = new THREE.Group();
  g.name        = 'demo_exterior';
  const bodyMat = new THREE.MeshStandardMaterial({ color:0xF0EEE9, roughness:0.12, metalness:0.7, name:'Body_Paint' });
  const glassMat= new THREE.MeshStandardMaterial({ color:0x2A3850, roughness:0.0, metalness:0.1, transparent:true, opacity:0.55 });
  const darkMat = new THREE.MeshStandardMaterial({ color:0x1A1A1E, roughness:0.3, metalness:0.8 });
  const engMat  = new THREE.MeshStandardMaterial({ color:0x888890, roughness:0.2, metalness:0.9, name:'Engine_Metal' });

  // Fuselage
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.85,0.6,12,32), bodyMat);
  fus.name='Body_Fuselage'; fus.rotation.z=Math.PI/2; fus.castShadow=true; g.add(fus);
  // Nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.6,3.5,24), bodyMat);
  nose.name='Body_Nose'; nose.rotation.z=-Math.PI/2; nose.position.set(7.7,0,0); nose.castShadow=true; g.add(nose);
  // Tail
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.85,2.5,24), bodyMat);
  tail.name='Body_Tail'; tail.rotation.z=Math.PI/2; tail.position.set(-7.2,0,0); g.add(tail);

  // Wings
  [['Wing_Left', 3.5], ['Wing_Right', -3.5]].forEach(([nm, z]) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(7,0.12,1.6), bodyMat);
    w.name=nm; w.position.set(-1.5,-0.15,z); g.add(w);
  });
  // Winglets
  [['Wing_WingletL', 3.8], ['Wing_WingletR', -3.8]].forEach(([nm, z]) => {
    const wl = new THREE.Mesh(new THREE.BoxGeometry(0.08,0.7,0.4), bodyMat);
    wl.name=nm; wl.position.set(-4.9,0.35,z); g.add(wl);
  });
  // Horizontal stabilisers
  [['Wing_HStabL', 1.8], ['Wing_HStabR', -1.8]].forEach(([nm, z]) => {
    const hs = new THREE.Mesh(new THREE.BoxGeometry(3.5,0.1,0.9), bodyMat);
    hs.name=nm; hs.position.set(-7.8,0.3,z); g.add(hs);
  });
  // Vertical stab
  const vs = new THREE.Mesh(new THREE.BoxGeometry(2.2,1.5,0.1), bodyMat);
  vs.name='Wing_VStab'; vs.position.set(-7.2,1.35,0); g.add(vs);

  // Engines
  [1.2, -1.2].forEach(z => {
    const pod = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.38,0.3,3.0,20), engMat);
    outer.name='Engine_Outer'; outer.rotation.z=Math.PI/2; outer.castShadow=true;
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.18,3.0,20), darkMat);
    inner.name='Engine_Inner'; inner.rotation.z=Math.PI/2;
    pod.add(outer, inner); pod.position.set(-6.5,0.7,z); g.add(pod);
  });

  // Windows
  const winGeo = new THREE.BoxGeometry(0.35,0.32,0.06);
  for (let i = -3; i <= 3; i++) {
    [0.86, -0.86].forEach(z => {
      const w = new THREE.Mesh(winGeo, glassMat); w.name='Glass_Win'; w.position.set(i*1.2,0.45,z); g.add(w);
    });
  }

  g.position.y = 1.2;
  return g;
}

function _buildDemoInterior() {
  const g = new THREE.Group();
  g.name  = 'demo_interior';

  const wallMat  = new THREE.MeshStandardMaterial({ color:0xE8E0D0, roughness:0.7, name:'Wall_Panel' });
  const floorMat = new THREE.MeshStandardMaterial({ color:0x3A2E1A, roughness:0.9, name:'Carpet_Floor' });
  const ceilMat  = new THREE.MeshStandardMaterial({ color:0xDDD5C5, roughness:0.8 });
  const trimMat  = new THREE.MeshStandardMaterial({ color:0x5C3D1E, roughness:0.4, metalness:0.05, name:'Trim_Wood' });
  const seatMat  = new THREE.MeshStandardMaterial({ color:0xE8E0D0, roughness:0.5, metalness:0.02, name:'Seat_Leather' });
  const metalMat = new THREE.MeshStandardMaterial({ color:0xC8A96E, roughness:0.2, metalness:0.9 });
  const glassMat = new THREE.MeshStandardMaterial({ color:0x2A3850, transparent:true, opacity:0.4 });
  const stripMat = new THREE.MeshStandardMaterial({ color:0xF4C77A, emissive:new THREE.Color(0xF4C77A), emissiveIntensity:1.5, roughness:1, name:'Light_Strip_' });

  // Shell
  const floor = new THREE.Mesh(new THREE.BoxGeometry(8,0.06,2.6), floorMat); floor.receiveShadow=true; g.add(floor);
  const ceil  = new THREE.Mesh(new THREE.BoxGeometry(8,0.06,2.6), ceilMat);  ceil.position.y=1.85; g.add(ceil);
  [-1.3, 1.3].forEach(z => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(8,1.85,0.08), wallMat); w.position.set(0,0.925,z); g.add(w);
  });

  // Wood rails
  const railGeo = new THREE.BoxGeometry(8,0.06,0.06);
  [[1.5,-1.26],[1.5,1.26],[0.32,-1.26],[0.32,1.26]].forEach(([y,z]) => {
    const r = new THREE.Mesh(railGeo, trimMat); r.name='Trim_Rail'; r.position.set(0,y,z); g.add(r);
  });

  // Windows
  const wGeo = new THREE.BoxGeometry(0.05,0.52,0.68);
  for (let i = -2; i <= 2; i++) {
    [-1.26, 1.26].forEach(z => {
      const w = new THREE.Mesh(wGeo, glassMat); w.position.set(i*1.4,0.95,z); g.add(w);
    });
  }

  // Club seats
  function makeSeat(x, z, fwd = true) {
    const sg = new THREE.Group(); sg.name = 'Seat_Club';
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.62,0.1,0.62), metalMat);
    base.position.y=0.1; base.castShadow=true; sg.add(base);
    const cush = new THREE.Mesh(new THREE.BoxGeometry(0.58,0.14,0.58), seatMat);
    cush.name='Seat_Cushion'; cush.position.y=0.22; cush.castShadow=true; sg.add(cush);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.58,0.70,0.10), seatMat);
    back.name='Seat_Back'; back.position.set(0,0.64,fwd?-0.26:0.26); sg.add(back);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.40,0.22,0.12), seatMat);
    head.name='Seat_Headrest'; head.position.set(0,1.06,fwd?-0.28:0.28); sg.add(head);
    [[-0.33,'Trim_Armrest_L'],[0.33,'Trim_Armrest_R']].forEach(([ax,nm]) => {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.08,0.08,0.52), trimMat);
      a.name=nm; a.position.set(ax,0.42,0); sg.add(a);
    });
    sg.position.set(x,0,z); if (!fwd) sg.rotation.y=Math.PI;
    return sg;
  }
  [[-2.5,-0.7,true],[-2.5,0.7,true],[-1.0,-0.7,false],[-1.0,0.7,false],[1.8,-0.7,true],[1.8,0.7,true]]
    .forEach(([x,z,f]) => g.add(makeSeat(x,z,f)));

  // Table
  const tbl = new THREE.Mesh(new THREE.BoxGeometry(0.9,0.04,1.0), trimMat);
  tbl.name='Trim_Table'; tbl.position.set(-1.75,0.55,0); g.add(tbl);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.45,8), metalMat);
  leg.position.set(-1.75,0.3,0); g.add(leg);

  // Emissive light strips
  const sGeo = new THREE.BoxGeometry(7,0.03,0.15);
  [-0.9, 0.9].forEach(z => {
    const s = new THREE.Mesh(sGeo, stripMat); s.name='Light_Strip_'; s.position.set(0,1.78,z); g.add(s);
  });

  g.position.y = 0.06;
  return g;
}
