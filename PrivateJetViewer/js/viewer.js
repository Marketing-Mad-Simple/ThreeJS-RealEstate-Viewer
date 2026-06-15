/**
 * AETHER — Private Jet Configurator
 * viewer.js
 *
 * Handles:
 *  - Three.js scene, renderer, camera, lighting
 *  - GLB model loading (exterior + interior)
 *  - Procedural demo geometry when no models are present
 *  - View switching (exterior ↔ interior) with animated camera transitions
 *  - Material configurator: paint, finish, seat color/material, wood trim, lighting
 *  - Responsive layout (desktop side panel + mobile bottom sheet)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const MODEL_PATHS = {
  exterior: './models/exterior.glb',
  interior: './models/interior.glb',
};

// Mesh name prefixes (adjust to match your Blender naming convention)
const MESH_TAGS = {
  fuselage:  'Body_',
  wings:     'Wing_',
  engines:   'Engine_',
  seats:     'Seat_',
  trim:      'Trim_',
  carpet:    'Carpet_',
};

// Paint presets
const PAINT_COLORS = {
  pearl_white:   { color: 0xF0EEE9, label: 'Pearl White' },
  midnight_black:{ color: 0x1A1A1E, label: 'Midnight Black' },
  champagne_gold:{ color: 0xC8A96E, label: 'Champagne Gold' },
  navy_eclipse:  { color: 0x1C2B4A, label: 'Navy Eclipse' },
  silver_mist:   { color: 0xA8AEBA, label: 'Silver Mist' },
  obsidian_red:  { color: 0x6B1E22, label: 'Obsidian Red' },
};

const STRIPE_COLORS = {
  none:   null,
  gold:   0xC8A96E,
  silver: 0xC0C4CC,
  carbon: 0x2A2A2A,
};

const SEAT_COLORS = {
  ivory:   { color: 0xE8E0D0, label: 'Ivory' },
  cognac:  { color: 0x8B5E3C, label: 'Cognac' },
  charcoal:{ color: 0x3A3A3A, label: 'Charcoal' },
  cream:   { color: 0xF5EDD8, label: 'Warm Cream' },
  navy:    { color: 0x1C2B4A, label: 'Deep Navy' },
};

const WOOD_COLORS = {
  walnut: { color: 0x5C3D1E, label: 'Walnut' },
  maple:  { color: 0xC8A882, label: 'Maple Burl' },
  ebony:  { color: 0x1A1208, label: 'Ebony' },
  carbon: { color: 0x222228, label: 'Carbon Fibre' },
};

const LIGHTING_COLORS = {
  warm: { color: 0xF4C77A, label: 'Warm White' },
  cool: { color: 0xD0E8FF, label: 'Cool White' },
  rose: { color: 0xFFD0D8, label: 'Rose Blush' },
  blue: { color: 0xA0C8FF, label: 'Midnight Blue' },
};

// Camera presets for each view
const CAM_PRESETS = {
  exterior: {
    position: new THREE.Vector3(8, 3, 14),
    target:   new THREE.Vector3(0, 0.5, 0),
  },
  interior: {
    position: new THREE.Vector3(0, 1.2, 4),
    target:   new THREE.Vector3(0, 1.0, 0),
  },
};

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let currentView = 'exterior';
let config = {
  paint:          'pearl_white',
  stripe:         'none',
  finish:         'gloss',
  seat_material:  'leather',
  seat_color:     'ivory',
  wood:           'walnut',
  lighting:       'warm',
  interior_style: 'classic',
};
let models = { exterior: null, interior: null };
let ambientLight, interiorSpotLight;
let isAnimatingCamera = false;

// ─────────────────────────────────────────────────────────────
// Scene bootstrap
// ─────────────────────────────────────────────────────────────
const canvas   = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace  = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0C0C0E);
scene.fog = new THREE.Fog(0x0C0C0E, 40, 100);

// PMREM environment
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTexture;

// Camera
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.copy(CAM_PRESETS.exterior.position);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CAM_PRESETS.exterior.target);
controls.enableDamping   = true;
controls.dampingFactor   = 0.06;
controls.minDistance     = 2;
controls.maxDistance     = 60;
controls.maxPolarAngle   = Math.PI * 0.88;
controls.update();

// ─────────────────────────────────────────────────────────────
// Lighting
// ─────────────────────────────────────────────────────────────
function setupLighting() {
  ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambientLight);

  // Key light
  const keyLight = new THREE.DirectionalLight(0xfff8f0, 2.2);
  keyLight.position.set(10, 18, 10);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far  = 60;
  keyLight.shadow.camera.left = -20;
  keyLight.shadow.camera.right = 20;
  keyLight.shadow.camera.top  = 20;
  keyLight.shadow.camera.bottom = -20;
  keyLight.shadow.bias = -0.0004;
  scene.add(keyLight);

  // Fill
  const fillLight = new THREE.DirectionalLight(0xd0e8ff, 0.7);
  fillLight.position.set(-10, 5, -8);
  scene.add(fillLight);

  // Rim
  const rimLight = new THREE.DirectionalLight(0xC8A96E, 0.45);
  rimLight.position.set(0, 10, -15);
  scene.add(rimLight);

  // Interior accent (cabin ambient glow)
  interiorSpotLight = new THREE.PointLight(0xF4C77A, 0, 8, 1.5);
  interiorSpotLight.position.set(0, 2.5, 0);
  scene.add(interiorSpotLight);

  // Ground fill
  const groundFill = new THREE.HemisphereLight(0x111118, 0x080810, 0.5);
  scene.add(groundFill);
}
setupLighting();

// ─────────────────────────────────────────────────────────────
// Ground plane
// ─────────────────────────────────────────────────────────────
function buildGround() {
  const geo  = new THREE.PlaneGeometry(120, 120);
  const mat  = new THREE.MeshStandardMaterial({
    color: 0x080810,
    roughness: 0.15,
    metalness: 0.6,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.01;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Reflection ring
  const ringGeo = new THREE.RingGeometry(3.5, 14, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xC8A96E,
    transparent: true,
    opacity: 0.04,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  scene.add(ring);
}
buildGround();

// ─────────────────────────────────────────────────────────────
// Procedural demo models (used when no GLB files are present)
// ─────────────────────────────────────────────────────────────
function buildDemoExterior() {
  const group = new THREE.Group();
  group.name = 'demo_exterior';

  // Materials
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xF0EEE9,
    roughness: 0.12,
    metalness: 0.7,
    name: 'Body_Paint',
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x2A3850,
    roughness: 0.0,
    metalness: 0.1,
    transparent: true,
    opacity: 0.55,
    name: 'Glass',
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1A1A1E,
    roughness: 0.3,
    metalness: 0.8,
    name: 'Dark_Accent',
  });
  const engineMat = new THREE.MeshStandardMaterial({
    color: 0x888890,
    roughness: 0.2,
    metalness: 0.9,
    name: 'Engine_Metal',
  });

  // Fuselage (tapered cylinder)
  const fuselageGeo = new THREE.CylinderGeometry(0.85, 0.6, 12, 32, 1);
  const fuselage = new THREE.Mesh(fuselageGeo, bodyMat);
  fuselage.name = 'Body_Fuselage';
  fuselage.rotation.z = Math.PI / 2;
  fuselage.castShadow = true;
  fuselage.receiveShadow = true;
  group.add(fuselage);

  // Nose cone
  const noseConeGeo = new THREE.ConeGeometry(0.6, 3.5, 24);
  const noseCone = new THREE.Mesh(noseConeGeo, bodyMat);
  noseCone.name = 'Body_Nose';
  noseCone.rotation.z = -Math.PI / 2;
  noseCone.position.set(7.7, 0, 0);
  noseCone.castShadow = true;
  group.add(noseCone);

  // Tail cone
  const tailConeGeo = new THREE.ConeGeometry(0.85, 2.5, 24);
  const tailCone = new THREE.Mesh(tailConeGeo, bodyMat);
  tailCone.name = 'Body_Tail';
  tailCone.rotation.z = Math.PI / 2;
  tailCone.position.set(-7.2, 0, 0);
  tailCone.castShadow = true;
  group.add(tailCone);

  // Main wings
  const wingGeo = new THREE.BoxGeometry(7, 0.12, 1.6);
  const wingL = new THREE.Mesh(wingGeo, bodyMat);
  wingL.name = 'Wing_Left';
  wingL.position.set(-1.5, -0.15, 3.5);
  wingL.rotation.z = -0.06;
  wingL.castShadow = true;
  group.add(wingL);

  const wingR = wingL.clone();
  wingR.name = 'Wing_Right';
  wingR.position.set(-1.5, -0.15, -3.5);
  wingR.rotation.z = 0.06;
  group.add(wingR);

  // Winglets
  const wingletGeo = new THREE.BoxGeometry(0.08, 0.7, 0.4);
  const wingletL = new THREE.Mesh(wingletGeo, bodyMat);
  wingletL.name = 'Wing_WingletL';
  wingletL.position.set(-4.9, 0.35, 3.8);
  wingletL.rotation.x = 0.15;
  group.add(wingletL);
  const wingletR = wingletL.clone();
  wingletR.name = 'Wing_WingletR';
  wingletR.position.set(-4.9, 0.35, -3.8);
  wingletR.rotation.x = -0.15;
  group.add(wingletR);

  // Horizontal stabilizers
  const hStabGeo = new THREE.BoxGeometry(3.5, 0.1, 0.9);
  const hStabL = new THREE.Mesh(hStabGeo, bodyMat);
  hStabL.name = 'Wing_HStabL';
  hStabL.position.set(-7.8, 0.3, 1.8);
  group.add(hStabL);
  const hStabR = hStabL.clone();
  hStabR.name = 'Wing_HStabR';
  hStabR.position.set(-7.8, 0.3, -1.8);
  group.add(hStabR);

  // Vertical stabilizer
  const vStabGeo = new THREE.BoxGeometry(2.2, 1.5, 0.1);
  const vStab = new THREE.Mesh(vStabGeo, bodyMat);
  vStab.name = 'Wing_VStab';
  vStab.position.set(-7.2, 1.35, 0);
  group.add(vStab);

  // Engines (pod style on tail)
  const engineOuterGeo = new THREE.CylinderGeometry(0.38, 0.3, 3.0, 20);
  const engineInnerGeo = new THREE.CylinderGeometry(0.25, 0.18, 3.0, 20);

  function makeEngine(posZ) {
    const pod = new THREE.Group();
    const outer = new THREE.Mesh(engineOuterGeo, engineMat);
    outer.name = 'Engine_Outer';
    outer.rotation.z = Math.PI / 2;
    outer.castShadow = true;
    const inner = new THREE.Mesh(engineInnerGeo, darkMat);
    inner.name = 'Engine_Inner';
    inner.rotation.z = Math.PI / 2;
    pod.add(outer, inner);
    pod.position.set(-6.5, 0.7, posZ);
    return pod;
  }
  group.add(makeEngine(1.2));
  group.add(makeEngine(-1.2));

  // Windows strip
  const windowGeo = new THREE.BoxGeometry(0.35, 0.32, 0.06);
  for (let i = -3; i <= 3; i++) {
    const win = new THREE.Mesh(windowGeo, glassMat);
    win.name = 'Glass_Window_' + i;
    win.position.set(i * 1.2, 0.45, 0.86);
    group.add(win);
    const winR = win.clone();
    winR.position.set(i * 1.2, 0.45, -0.86);
    group.add(winR);
  }

  // Door outline
  const doorGeo = new THREE.BoxGeometry(0.8, 1.3, 0.06);
  const door = new THREE.Mesh(doorGeo, glassMat);
  door.name = 'Body_Door';
  door.position.set(4.2, -0.05, 0.86);
  group.add(door);

  // Landing gear (simple stubs)
  const gearGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.8, 8);
  const wheelGeo = new THREE.TorusGeometry(0.2, 0.08, 8, 16);
  function makeGear(x, z) {
    const g = new THREE.Group();
    const strut = new THREE.Mesh(gearGeo, darkMat);
    strut.position.y = -0.5;
    const wheel = new THREE.Mesh(wheelGeo, new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.y = -0.95;
    g.add(strut, wheel);
    g.position.set(x, -0.65, z);
    return g;
  }
  group.add(makeGear(3.5, 0.6), makeGear(3.5, -0.6), makeGear(-3, 0));

  group.position.y = 1.2;
  return group;
}

function buildDemoInterior() {
  const group = new THREE.Group();
  group.name = 'demo_interior';

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xE8E0D0, roughness: 0.7, metalness: 0.0, name: 'Wall_Panel' });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x3A2E1A, roughness: 0.9, metalness: 0.0, name: 'Carpet_Floor' });
  const ceilingMat = new THREE.MeshStandardMaterial({ color: 0xDDD5C5, roughness: 0.8, metalness: 0.0, name: 'Ceiling_Panel' });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x5C3D1E, roughness: 0.4, metalness: 0.2, name: 'Trim_Wood' });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0xE8E0D0, roughness: 0.5, metalness: 0.05, name: 'Seat_Leather' });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0xC8A96E, roughness: 0.2, metalness: 0.9, name: 'Metal_Gold' });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x2A3850, transparent: true, opacity: 0.4, roughness: 0.0 });

  // Cabin shell
  const floorGeo = new THREE.BoxGeometry(8, 0.06, 2.6);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.receiveShadow = true;
  floor.position.y = 0;
  group.add(floor);

  const ceilGeo = new THREE.BoxGeometry(8, 0.06, 2.6);
  const ceil = new THREE.Mesh(ceilGeo, ceilingMat);
  ceil.position.y = 1.85;
  group.add(ceil);

  // Side walls
  const wallGeo = new THREE.BoxGeometry(8, 1.85, 0.08);
  const wallL = new THREE.Mesh(wallGeo, wallMat);
  wallL.position.set(0, 0.925, -1.3);
  group.add(wallL);
  const wallR = new THREE.Mesh(wallGeo, wallMat);
  wallR.position.set(0, 0.925, 1.3);
  group.add(wallR);

  // Wood trim rails
  const railGeo = new THREE.BoxGeometry(8, 0.06, 0.06);
  const railTop = new THREE.Mesh(railGeo, trimMat);
  railTop.name = 'Trim_Rail_Top';
  railTop.position.set(0, 1.5, -1.26);
  group.add(railTop);
  const railTopR = railTop.clone();
  railTopR.position.set(0, 1.5, 1.26);
  group.add(railTopR);
  const railBot = new THREE.Mesh(railGeo, trimMat);
  railBot.name = 'Trim_Rail_Bot';
  railBot.position.set(0, 0.32, -1.26);
  group.add(railBot);
  const railBotR = railBot.clone();
  railBotR.position.set(0, 0.32, 1.26);
  group.add(railBotR);

  // Windows
  for (let i = -2; i <= 2; i++) {
    const winGeo = new THREE.BoxGeometry(0.05, 0.52, 0.68);
    const winL = new THREE.Mesh(winGeo, glassMat);
    winL.name = 'Glass_Win_' + i;
    winL.position.set(i * 1.4, 0.95, -1.26);
    group.add(winL);
    const winR = winL.clone();
    winR.position.set(i * 1.4, 0.95, 1.26);
    group.add(winR);

    // Window frame trim
    const frameGeo = new THREE.BoxGeometry(0.06, 0.58, 0.04);
    const frameL1 = new THREE.Mesh(frameGeo, trimMat);
    frameL1.name = 'Trim_Frame_' + i;
    frameL1.position.set(i * 1.4, 0.95, -1.28);
    group.add(frameL1);
  }

  // Seats — 4 club seats
  function makeSeat(x, z, facingFwd = true) {
    const seatGroup = new THREE.Group();
    seatGroup.name = 'Seat_Club';

    // Base / leg
    const baseGeo = new THREE.BoxGeometry(0.62, 0.1, 0.62);
    const base = new THREE.Mesh(baseGeo, metalMat);
    base.position.y = 0.1;
    base.castShadow = true;
    seatGroup.add(base);

    // Cushion
    const cushGeo = new THREE.BoxGeometry(0.58, 0.14, 0.58);
    const cush = new THREE.Mesh(cushGeo, seatMat);
    cush.name = 'Seat_Cushion';
    cush.position.y = 0.22;
    cush.castShadow = true;
    seatGroup.add(cush);

    // Back
    const backGeo = new THREE.BoxGeometry(0.58, 0.7, 0.1);
    const back = new THREE.Mesh(backGeo, seatMat);
    back.name = 'Seat_Back';
    back.position.set(0, 0.64, facingFwd ? -0.26 : 0.26);
    back.castShadow = true;
    seatGroup.add(back);

    // Headrest
    const headGeo = new THREE.BoxGeometry(0.4, 0.22, 0.12);
    const head = new THREE.Mesh(headGeo, seatMat);
    head.name = 'Seat_Headrest';
    head.position.set(0, 1.06, facingFwd ? -0.28 : 0.28);
    seatGroup.add(head);

    // Armrests
    const armGeo = new THREE.BoxGeometry(0.08, 0.08, 0.52);
    const armL = new THREE.Mesh(armGeo, trimMat);
    armL.name = 'Trim_Armrest_L';
    armL.position.set(-0.33, 0.42, 0);
    seatGroup.add(armL);
    const armR = armL.clone();
    armR.name = 'Trim_Armrest_R';
    armR.position.set(0.33, 0.42, 0);
    seatGroup.add(armR);

    seatGroup.position.set(x, 0, z);
    if (!facingFwd) seatGroup.rotation.y = Math.PI;
    return seatGroup;
  }

  // Four club seats in pairs
  group.add(makeSeat(-2.5, -0.7, true));
  group.add(makeSeat(-2.5,  0.7, true));
  group.add(makeSeat(-1.0, -0.7, false));
  group.add(makeSeat(-1.0,  0.7, false));

  // Forward seats
  group.add(makeSeat(1.8, -0.7, true));
  group.add(makeSeat(1.8,  0.7, true));

  // Centre table
  const tableGeo = new THREE.BoxGeometry(0.9, 0.04, 1.0);
  const table = new THREE.Mesh(tableGeo, trimMat);
  table.name = 'Trim_Table';
  table.position.set(-1.75, 0.55, 0);
  group.add(table);
  const tableLegGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.45, 8);
  const tableLeg = new THREE.Mesh(tableLegGeo, metalMat);
  tableLeg.position.set(-1.75, 0.3, 0);
  group.add(tableLeg);

  // Forward console / galley hint
  const consolGeo = new THREE.BoxGeometry(0.7, 1.2, 2.2);
  const consol = new THREE.Mesh(consolGeo, wallMat);
  consol.position.set(3.7, 0.6, 0);
  group.add(consol);
  const consolFaceGeo = new THREE.BoxGeometry(0.08, 0.8, 1.4);
  const consolFace = new THREE.Mesh(consolFaceGeo, trimMat);
  consolFace.name = 'Trim_Galley';
  consolFace.position.set(3.36, 0.7, 0);
  group.add(consolFace);

  // Cabin lighting strip (visual only)
  const stripGeo = new THREE.BoxGeometry(7, 0.03, 0.15);
  const stripMat = new THREE.MeshStandardMaterial({
    color: 0xF4C77A,
    emissive: 0xF4C77A,
    emissiveIntensity: 1.5,
    roughness: 1,
  });
  const stripL = new THREE.Mesh(stripGeo, stripMat);
  stripL.name = 'Light_Strip_L';
  stripL.position.set(0, 1.78, -0.9);
  group.add(stripL);
  const stripR = stripL.clone();
  stripR.name = 'Light_Strip_R';
  stripR.position.set(0, 1.78, 0.9);
  group.add(stripR);

  group.position.y = 0.06;
  return group;
}

// ─────────────────────────────────────────────────────────────
// Model loading
// ─────────────────────────────────────────────────────────────
const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/');
loader.setDRACOLoader(dracoLoader);

const overlay = document.getElementById('loading-overlay');
const progressBar = document.getElementById('progress-bar');
const loadingText = document.getElementById('loading-text');

function setProgress(pct, label) {
  progressBar.style.width = pct + '%';
  if (label) loadingText.textContent = label;
}

async function loadModels() {
  setProgress(10, 'Loading exterior model…');

  // Try to load GLB files; fall back to procedural demo if missing
  let exteriorLoaded = false;
  let interiorLoaded = false;

  try {
    const gltf = await new Promise((res, rej) => {
      loader.load(MODEL_PATHS.exterior, res, (e) => setProgress(10 + e.loaded / e.total * 35, 'Loading exterior…'), rej);
    });
    models.exterior = gltf.scene;
    autoScaleModel(models.exterior);
    scene.add(models.exterior);
    exteriorLoaded = true;
  } catch {
    // Use procedural demo
    models.exterior = buildDemoExterior();
    scene.add(models.exterior);
  }

  setProgress(50, 'Loading interior model…');

  try {
    const gltf = await new Promise((res, rej) => {
      loader.load(MODEL_PATHS.interior, res, (e) => setProgress(50 + e.loaded / e.total * 40, 'Loading interior…'), rej);
    });
    models.interior = gltf.scene;
    autoScaleModel(models.interior);
    models.interior.visible = false;
    scene.add(models.interior);
    interiorLoaded = true;
  } catch {
    models.interior = buildDemoInterior();
    models.interior.visible = false;
    scene.add(models.interior);
  }

  setProgress(100, 'Ready');

  // Enable shadows on all meshes
  [models.exterior, models.interior].forEach(m => {
    m.traverse(node => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) node.material.envMapIntensity = 0.8;
      }
    });
  });

  // Apply initial config
  applyAllConfig();

  // Hide overlay
  setTimeout(() => {
    overlay.classList.add('hidden');
    // Fade hint after 5s
    setTimeout(() => document.getElementById('hint-bar').classList.add('fade'), 5000);
  }, 600);

  if (!exteriorLoaded || !interiorLoaded) {
    showToast('Demo mode: drop GLB files into /models/ to load your aircraft.');
  }
}

function autoScaleModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const scale = 14 / maxDim;
    model.scale.setScalar(scale);
  }
  // Re-center after scale
  const box2 = new THREE.Box3().setFromObject(model);
  const center = box2.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.position.y += box2.getSize(new THREE.Vector3()).y / 2;
}

// ─────────────────────────────────────────────────────────────
// View switching
// ─────────────────────────────────────────────────────────────
function switchView(view) {
  if (view === currentView || isAnimatingCamera) return;
  currentView = view;

  // Toggle model visibility
  models.exterior.visible = (view === 'exterior');
  models.interior.visible = (view === 'interior');

  // Interior lighting intensity
  interiorSpotLight.intensity = (view === 'interior') ? 2.5 : 0;

  // Animate camera
  animateCamera(CAM_PRESETS[view].position, CAM_PRESETS[view].target);

  // Update configurator sections
  document.getElementById('section-exterior').classList.toggle('hidden', view !== 'exterior');
  document.getElementById('section-interior').classList.toggle('hidden', view !== 'interior');

  // Update toggle buttons
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  showToast(view === 'exterior' ? 'Viewing Exterior' : 'Viewing Interior');
}

function animateCamera(targetPos, targetLookAt, duration = 1200) {
  isAnimatingCamera = true;
  const startPos    = camera.position.clone();
  const startTarget = controls.target.clone();
  const startTime   = performance.now();

  function tick(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out quad

    camera.position.lerpVectors(startPos, targetPos, ease);
    controls.target.lerpVectors(startTarget, targetLookAt, ease);
    controls.update();

    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      isAnimatingCamera = false;
    }
  }
  requestAnimationFrame(tick);
}

// ─────────────────────────────────────────────────────────────
// Material application
// ─────────────────────────────────────────────────────────────
function getRoughnessByFinish(finish) {
  return finish === 'gloss' ? 0.08 : finish === 'satin' ? 0.35 : 0.72;
}

function applyExteriorConfig() {
  const paintColor  = PAINT_COLORS[config.paint]?.color ?? 0xF0EEE9;
  const stripeColor = STRIPE_COLORS[config.stripe];
  const roughness   = getRoughnessByFinish(config.finish);

  models.exterior.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const name = node.name || '';

    if (name.startsWith('Body_') || name.startsWith('Wing_')) {
      node.material.color.setHex(paintColor);
      node.material.roughness = roughness;
      node.material.metalness = 0.65;
      node.material.needsUpdate = true;
    }

    if (name.startsWith('Engine_') && name.includes('Outer')) {
      // Engines get a slightly darker variant of the body color
      const c = new THREE.Color(paintColor);
      c.multiplyScalar(0.85);
      node.material.color.copy(c);
      node.material.roughness = roughness + 0.1;
      node.material.needsUpdate = true;
    }
  });
}

function applyInteriorConfig() {
  const seatColor = SEAT_COLORS[config.seat_color]?.color ?? 0xE8E0D0;
  const woodColor = WOOD_COLORS[config.wood]?.color ?? 0x5C3D1E;
  const lightColor = LIGHTING_COLORS[config.lighting]?.color ?? 0xF4C77A;

  // Seat roughness by material
  const seatRoughness = config.seat_material === 'leather' ? 0.45
    : config.seat_material === 'alcantara' ? 0.78 : 0.65;
  const seatMetalness = config.seat_material === 'leather' ? 0.05 : 0.0;

  // Interior style brightness modifier
  const styleMult = config.interior_style === 'sport' ? 0.82
    : config.interior_style === 'modern' ? 1.05 : 1.0;

  // Update cabin light
  interiorSpotLight.color.setHex(lightColor);
  if (currentView === 'interior') interiorSpotLight.intensity = 2.5;

  models.interior.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const name = node.name || '';

    if (name.startsWith('Seat_')) {
      const c = new THREE.Color(seatColor);
      c.multiplyScalar(styleMult);
      node.material.color.copy(c);
      node.material.roughness = seatRoughness;
      node.material.metalness = seatMetalness;
      node.material.needsUpdate = true;
    }

    if (name.startsWith('Trim_')) {
      node.material.color.setHex(woodColor);
      node.material.roughness = config.wood === 'carbon' ? 0.2 : 0.38;
      node.material.metalness = config.wood === 'carbon' ? 0.5 : 0.05;
      node.material.needsUpdate = true;
    }

    if (name.startsWith('Light_Strip_')) {
      node.material.color.setHex(lightColor);
      node.material.emissive.setHex(lightColor);
      node.material.emissiveIntensity = 1.4;
      node.material.needsUpdate = true;
    }

    if (name.startsWith('Carpet_') || name.startsWith('Floor_')) {
      const carpetStyle = config.interior_style === 'sport' ? 0x1A1A1E
        : config.interior_style === 'modern' ? 0x2A2520 : 0x3A2E1A;
      node.material.color.setHex(carpetStyle);
      node.material.needsUpdate = true;
    }
  });
}

function applyAllConfig() {
  if (models.exterior) applyExteriorConfig();
  if (models.interior) applyInteriorConfig();
}

// ─────────────────────────────────────────────────────────────
// UI — swatch & pill listeners
// ─────────────────────────────────────────────────────────────
const SWATCH_LABELS = {
  paint: PAINT_COLORS,
  seat_color: SEAT_COLORS,
  wood: WOOD_COLORS,
  lighting: LIGHTING_COLORS,
};

const STRIPE_LABELS = {
  none: 'None', gold: 'Gold', silver: 'Silver', carbon: 'Carbon',
};

document.querySelectorAll('.swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = btn.dataset.group;
    const value = btn.dataset.value;

    // Deactivate siblings
    document.querySelectorAll(`.swatch[data-group="${group}"]`).forEach(s => s.classList.remove('active'));
    btn.classList.add('active');

    config[group] = value;

    // Update label
    if (group === 'stripe') {
      const el = document.getElementById('label-stripe');
      if (el) el.textContent = STRIPE_LABELS[value] ?? value;
    } else if (SWATCH_LABELS[group]) {
      const labelId = 'label-' + group.replace('_', '-');
      const el = document.getElementById(labelId);
      if (el) el.textContent = SWATCH_LABELS[group][value]?.label ?? value;
    }

    applyAllConfig();
  });
});

document.querySelectorAll('.option-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = btn.dataset.group;
    document.querySelectorAll(`.option-pill[data-group="${group}"]`).forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    config[group] = btn.dataset.value;
    applyAllConfig();
  });
});

// View toggle
document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Camera reset
document.getElementById('btn-reset').addEventListener('click', () => {
  animateCamera(CAM_PRESETS[currentView].position, CAM_PRESETS[currentView].target, 800);
});

// Fullscreen
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

// Panel collapse (desktop: slide right; mobile: slide down)
const configPanel = document.getElementById('config-panel');
document.getElementById('panel-toggle-btn').addEventListener('click', () => {
  configPanel.classList.toggle('collapsed');
});

// Quote button
document.getElementById('btn-request').addEventListener('click', () => {
  const summary = [
    `Paint: ${PAINT_COLORS[config.paint]?.label ?? config.paint}`,
    `Finish: ${config.finish}`,
    `Seats: ${config.seat_material} / ${SEAT_COLORS[config.seat_color]?.label ?? config.seat_color}`,
    `Wood: ${WOOD_COLORS[config.wood]?.label ?? config.wood}`,
    `Lighting: ${LIGHTING_COLORS[config.lighting]?.label ?? config.lighting}`,
    `Style: ${config.interior_style}`,
  ].join(' · ');
  showToast('Quote requested — ' + summary);
});

// ─────────────────────────────────────────────────────────────
// Toast helper
// ─────────────────────────────────────────────────────────────
let toastTimeout;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ─────────────────────────────────────────────────────────────
// Resize handler
// ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// ─────────────────────────────────────────────────────────────
// Render loop
// ─────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  if (!isAnimatingCamera) controls.update();
  renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
loadModels();
animate();
