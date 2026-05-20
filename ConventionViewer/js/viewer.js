import * as THREE from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }     from 'three/addons/loaders/GLTFLoader.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const GLB_PATH = './models/site.glb';
const CSV_PATH = './data/stalls.csv';

// Regex that stall mesh names must match — adjust if your naming differs
// Matches: A1, B12, AA3, Z99, etc.
const STALL_NAME_RE = /^[A-Z]+\d+$/i;



// Visual accent colours (original GLB materials are never modified permanently)
const COL = {
  hover:    0xfbbf24,
  start:    0x22c55e,
  end:      0xef4444,
  path:     0xfde047,
  arrow:    0xff6b35,
  pathNode: 0xfde047,
};

// ─── Runtime state ────────────────────────────────────────────────────────────
let scene, camera, renderer, controls;
let worldGroup; // all scene content lives here; rotated in nav mode

const stallMeshes   = {};   // meshName  → THREE.Mesh
const stallInfo     = {};   // meshName  → { meshName, company, category, extra[] }
const origMaterials = {};   // meshName  → cloned material | material[]

let hoveredId = null;
let startId   = null;
let endId     = null;
let routeMode = false;

const pathObjects = [];

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  setupRenderer();
  setupScene();
  setupLights();
  setupInteraction();

  progress(10, 'Loading stall data…');
  const csv = await loadCSV(CSV_PATH);
  buildStallInfo(csv);

  progress(30, 'Loading 3D model…');
  const gltf = await loadGLB(GLB_PATH);

  progress(70, 'Preparing scene…');
  worldGroup.add(gltf.scene);
  collectStallMeshes(gltf.scene);
  fitCameraToScene(gltf.scene);

  progress(85, 'Building navigation graph…');
  buildCentroids();
  buildStallLabels();
  await buildNavGraph();

  progress(95, 'Finishing up…');
  buildUI();
  buildStallList();
  updateStats();

  progress(100, 'Done');
  animate();

  if (window.onSceneReady) window.onSceneReady();
}

// ─── Renderer / Scene / Lights ───────────────────────────────────────────────
function setupRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('canvas'), antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled    = true;
  renderer.shadowMap.type       = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace      = THREE.SRGBColorSpace;
  renderer.toneMapping           = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure   = 1.1;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function setupScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.FogExp2(0x0d1117, 0.012);

  // All world content lives in worldGroup so we can rotate it in nav mode
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 30, 50);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance   = 0.5;
  controls.maxDistance   = 200;
  controls.maxPolarAngle = Math.PI / 2.05;
}

function setupLights() {
  worldGroup.add(new THREE.AmbientLight(0xffffff, 1.4));

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(40, 80, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near   = 1;
  sun.shadow.camera.far    = 300;
  sun.shadow.camera.left   = -120;
  sun.shadow.camera.right  = 120;
  sun.shadow.camera.top    = 120;
  sun.shadow.camera.bottom = -120;
  worldGroup.add(sun);

  worldGroup.add(new THREE.HemisphereLight(0x8899cc, 0x334455, 0.5));
}

// ─── CSV Loader ───────────────────────────────────────────────────────────────
async function loadCSV(path) {
  const text = await fetch(path).then(r => {
    if (!r.ok) throw new Error(`CSV not found at ${path} (${r.status})`);
    return r.text();
  });
  return text
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.split(/[,;]/).map(p => p.trim().replace(/^["']|["']$/g, '')));
}

function buildStallInfo(rows) {
  // Auto-detect header: if first cell matches stall name pattern, no header
  const start = STALL_NAME_RE.test(rows[0]?.[0] ?? '') ? 0 : 1;
  for (let i = start; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols[0]) continue;
    const meshName = cols[0];
    stallInfo[meshName] = {
      meshName,
      company:  cols[1] ?? meshName,
      category: cols[2] ?? '',
      extra:    cols.slice(3),
    };
  }
}

// ─── GLB Loader ───────────────────────────────────────────────────────────────
function loadGLB(path) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      path,
      resolve,
      xhr => {
        if (xhr.lengthComputable)
          progress(30 + Math.round((xhr.loaded / xhr.total) * 40), 'Loading 3D model…');
      },
      reject,
    );
  });
}

function collectStallMeshes(root) {
  root.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    const name = obj.name.trim();
    if (!STALL_NAME_RE.test(name)) return;

    obj.castShadow    = true;
    obj.receiveShadow = true;
    stallMeshes[name] = obj;

    if (!stallInfo[name])
      stallInfo[name] = { meshName: name, company: name, category: '', extra: [] };

    // Clone AND assign the material so this mesh owns its own instance.
    // Without the assignment, obj.material is still the shared GLB material —
    // mutating it (on hover) would affect every other mesh sharing it.
    if (Array.isArray(obj.material)) {
      obj.material     = obj.material.map(m => m.clone());
      origMaterials[name] = obj.material.map(m => m.clone());
    } else {
      obj.material        = obj.material.clone();
      origMaterials[name] = obj.material.clone();
    }
  });

  console.info(`[viewer] ${Object.keys(stallMeshes).length} stall meshes found`);
}

// ─── Camera Fit ───────────────────────────────────────────────────────────────
function fitCameraToScene(root) {
  const box    = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist   = (maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * 1.5;

  // Start at the same distance as LABEL_HIDE_BEYOND so labels are just
  // barely visible on load — this also becomes the max zoom-out cap.
  // We keep the same viewing angle (0.6/0.8/1.0 ratio) but scale to LABEL_HIDE_BEYOND.
  const startDist  = LABEL_HIDE_BEYOND;
  const angleScale = startDist / Math.sqrt(0.6**2 + 0.8**2 + 1.0**2);

  camera.position.set(
    center.x + 0.6 * angleScale,
    center.y + 0.8 * angleScale,
    center.z + 1.0 * angleScale,
  );
  camera.lookAt(center);
  controls.target.copy(center);

  // Cap zoom-out to the startup distance
  controls.maxDistance = startDist * 1.05;  // tiny extra margin so the camera isn't hard-locked
  controls.update();

  window._defaultCamPos    = camera.position.clone();
  window._defaultCamTarget = controls.target.clone();
}

// ─── Aisle Waypoint Navigation ───────────────────────────────────────────────
//
// Strategy: instead of routing stall-to-stall (which causes diagonal shortcuts
// ─── Navigation — three-pathfinding + artist NAV_MESH ────────────────────────
// The GLB contains a mesh named NAV_MESH built by the artist in Blender.
// three-pathfinding handles all A* on navmesh geometry — no custom grid code.

const ZONE = 'convention';
let   pathfinder  = null;
let   navMeshMesh = null;
const centroids   = {};  // stallName → THREE.Vector3
const stallBoxes  = {};  // stallName → THREE.Box3
let   pathY       = 0;

function buildCentroids() {
  const box = new THREE.Box3();
  Object.entries(stallMeshes).forEach(([name, mesh]) => {
    box.setFromObject(mesh);
    stallBoxes[name] = box.clone();
    centroids[name]  = box.getCenter(new THREE.Vector3());
  });
}

// ─── Stall Labels (GPU Sprites) ──────────────────────────────────────────────
// Bake each label into a CanvasTexture once at startup, render as THREE.Sprite.
// Zero DOM/CSS overhead — labels are just textured quads drawn by the GPU.

const LABEL_HIDE_BEYOND = 10;   // hide sprites beyond this camera distance
const LABEL_FADE_FULL   = 4;    // fully opaque below this distance
// Sprite world-unit size (height). Tweak if labels appear too big/small.
const LABEL_SPRITE_H    = 0.12;

const stallLabelSprites = [];   // [{ sprite, pos }]

function buildStallLabels() {
  Object.entries(centroids).forEach(([name, pos]) => {
    const info   = stallInfo[name] ?? { company: name };
    const top    = stallBoxes[name]?.max.y ?? pos.y;
    const sprite = makeTextSprite(name, info.company ?? name);
    sprite.position.set(pos.x, top + LABEL_SPRITE_H * 0.6, pos.z);
    sprite.visible = false;
    worldGroup.add(sprite);
    stallLabelSprites.push({ sprite, pos });
  });
}

function makeTextSprite(id, company) {
  const W = 256, H = 64;
  const canvas  = document.createElement('canvas');
  canvas.width  = W; canvas.height = H;
  const ctx     = canvas.getContext('2d');

  // Background pill
  ctx.clearRect(0, 0, W, H);
  roundRect(ctx, 2, 2, W - 4, H - 4, 8);
  ctx.fillStyle = 'rgba(13,17,23,0.88)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(249,115,22,0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Stall ID
  ctx.font = 'bold 28px Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(id, W / 2, 20);

  // Company name (truncated)
  const maxLen = 22;
  const label  = company.length > maxLen ? company.slice(0, maxLen - 1) + '…' : company;
  ctx.font = '19px Inter, sans-serif';
  ctx.fillStyle = 'rgba(230,237,243,0.9)';
  ctx.fillText(label, W / 2, 46);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,   // always draw on top — no z-fighting with stalls
    sizeAttenuation: true,
  });

  const sprite = new THREE.Sprite(mat);
  // Aspect ratio: W/H = 4, height = LABEL_SPRITE_H world units
  sprite.scale.set(LABEL_SPRITE_H * (W / H), LABEL_SPRITE_H, 1);
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Throttled — runs every 8 frames. Only sets sprite.visible + material.opacity.
// No DOM, no layout — pure JS property writes.
let labelFrameCount = 0;
function updateLabelVisibility() {
  if (++labelFrameCount % 8 !== 0) return;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  for (let i = 0; i < stallLabelSprites.length; i++) {
    const { sprite, pos } = stallLabelSprites[i];
    const dx = cx - pos.x, dy = cy - pos.y, dz = cz - pos.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist > LABEL_HIDE_BEYOND) {
      sprite.visible = false;
    } else {
      sprite.visible = true;
      sprite.material.opacity = Math.min(1,
        (LABEL_HIDE_BEYOND - dist) / (LABEL_HIDE_BEYOND - LABEL_FADE_FULL)
      );
    }
  }
}

async function buildNavGraph() {
  progress(86, 'Loading pathfinding library…');

  const pfMod = await import('https://cdn.jsdelivr.net/npm/three-pathfinding@1.3.0/dist/three-pathfinding.module.js');
  const { Pathfinding } = pfMod;

  scene.traverse(obj => {
    if (obj.isMesh && obj.name === 'NAV_MESH') navMeshMesh = obj;
  });

  if (!navMeshMesh) {
    console.error('[nav] NAV_MESH not found in scene');
    return;
  }

  navMeshMesh.visible = false;
  navMeshMesh.updateWorldMatrix(true, false);

  // ── Debug: press N to toggle navmesh overlay ──
  let navDebugMesh = null;
  window.addEventListener('keydown', e => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (!navDebugMesh) {
      const geomClone = navMeshMesh.geometry.clone();
      geomClone.applyMatrix4(navMeshMesh.matrixWorld);
      navDebugMesh = new THREE.Mesh(
        geomClone,
        new THREE.MeshBasicMaterial({
          color: 0x00ff88, transparent: true, opacity: 0.45,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      // Also draw wireframe on top so polygon edges are visible
      const wire = new THREE.Mesh(
        geomClone,
        new THREE.MeshBasicMaterial({
          color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.9,
        }),
      );
      navDebugMesh.add(wire);
      worldGroup.add(navDebugMesh);
      console.info('[nav-debug] navmesh ON — green = walkable');
    } else {
      navDebugMesh.visible = !navDebugMesh.visible;
      console.info('[nav-debug] navmesh', navDebugMesh.visible ? 'ON' : 'OFF');
    }
  });

  const geom = navMeshMesh.geometry.clone();
  geom.applyMatrix4(navMeshMesh.matrixWorld);

  // Derive pathY from the navmesh geometry itself — most reliable source
  geom.computeBoundingBox();
  pathY = geom.boundingBox.max.y;
  console.info('[nav] navmesh world Y:', pathY);

  pathfinder = new Pathfinding();
  pathfinder.setZoneData(ZONE, Pathfinding.createZone(geom));

  console.info('[nav] three-pathfinding ready');
}

// ─── Pathfinding ─────────────────────────────────────────────────────────────
// Clearance must exceed RIBBON_HALF_W (0.026) so the ribbon never clips stalls.
const PATH_CLEARANCE = 0.05;

function nudgeAwayFromStalls(pts) {
  const boxes = Object.values(stallBoxes);
  return pts.map(p => {
    let nx = p.x, nz = p.z;
    // Iterate up to 3× in case nudging one stall overlaps another
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const b of boxes) {
        const minX = b.min.x - PATH_CLEARANCE, maxX = b.max.x + PATH_CLEARANCE;
        const minZ = b.min.z - PATH_CLEARANCE, maxZ = b.max.z + PATH_CLEARANCE;
        if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
        const dL = nx - minX, dR = maxX - nx, dF = nz - minZ, dB = maxZ - nz;
        const m  = Math.min(dL, dR, dF, dB);
        if      (m === dL) nx = minX;
        else if (m === dR) nx = maxX;
        else if (m === dF) nz = minZ;
        else               nz = maxZ;
        moved = true;
      }
      if (!moved) break;
    }
    return new THREE.Vector3(nx, p.y, nz);
  });
}

function aStar(fromStall, toStall) {
  if (!pathfinder) { console.warn('[nav] pathfinder not ready'); return null; }

  const startPos = centroids[fromStall]?.clone().setY(pathY);
  const endPos   = centroids[toStall  ]?.clone().setY(pathY);
  if (!startPos || !endPos) return null;

  // Snap each point to the nearest node ON the navmesh.
  // Stall centroids sit inside stall geometry (off the navmesh) so findPath
  // returns null unless we first move to the nearest walkable point.
  const startNode = pathfinder.getClosestNode(startPos, ZONE, 0);
  const endNode   = pathfinder.getClosestNode(endPos,   ZONE, 0);

  if (!startNode || !endNode) {
    console.warn('[nav] could not snap to navmesh', fromStall, toStall);
    return null;
  }

  const snappedStart = startNode.centroid.clone().setY(pathY);
  const snappedEnd   = endNode.centroid.clone().setY(pathY);

  const groupID = pathfinder.getGroup(ZONE, snappedStart);
  const path    = pathfinder.findPath(snappedStart, snappedEnd, ZONE, groupID);

  if (!path || path.length === 0) return null;
  const nudged = nudgeAwayFromStalls([snappedStart, ...path, snappedEnd]);
  return { stallStart: fromStall, stallEnd: toStall, path: nudged };
}

// ─── Route Visualisation ─────────────────────────────────────────────────────
let activeCurve   = null;
let pulseOrb      = null;
let pulseT        = 0;

function clearPathObjects() {
  pathObjects.forEach(o => worldGroup.remove(o));
  pathObjects.length = 0;
  if (pulseOrb) { worldGroup.remove(pulseOrb); pulseOrb = null; }
  activeCurve = null;
}

const RIBBON_HALF_W  = 0.026;   // wider ribbon
const RIBBON_Y_OFFSET = 0.003;

function drawRoute(result) {
  clearPathObjects();
  if (!result) return;

  const rawPts = simplifyPath(result.path.map(p => p.clone().setY(pathY + RIBBON_Y_OFFSET)));
  if (rawPts.length < 2) return;

  activeCurve = new THREE.CatmullRomCurve3(rawPts);

  // Resample the curve at fine uniform intervals so miter joins are computed
  // at every actual bend, not just the original sparse waypoints
  const RESAMPLE = 120;
  const pts = [];
  for (let i = 0; i <= RESAMPLE; i++) pts.push(activeCurve.getPoint(i / RESAMPLE));

  // ── Build ribbon with miter joins ──
  const ribbonGeo = buildMiterRibbon(pts, RIBBON_HALF_W);
  const glowGeo   = buildMiterRibbon(pts, RIBBON_HALF_W * 2.0);

  // Glow — unlit so scene lighting can't wash it out
  const glowMesh = new THREE.Mesh(glowGeo,
    new THREE.MeshBasicMaterial({
      color: 0xfde68a,
      transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  worldGroup.add(glowMesh); pathObjects.push(glowMesh);

  // Main ribbon — pure unlit orange, always full saturation
  const mainMesh = new THREE.Mesh(ribbonGeo,
    new THREE.MeshBasicMaterial({
      color: 0xf97316, side: THREE.DoubleSide,
    }),
  );
  worldGroup.add(mainMesh); pathObjects.push(mainMesh);

  // ── Chevrons ──
  const aW = RIBBON_HALF_W * 1.4, aH = RIBBON_HALF_W * 3.2;
  const arrowCount = Math.max(4, Math.round(activeCurve.getLength() / 0.22));
  for (let i = 1; i <= arrowCount; i++) {
    const t0  = i / (arrowCount + 1);
    const t1  = Math.min(t0 + 0.005, 1);
    const pos = activeCurve.getPoint(t0);
    const dir = activeCurve.getPoint(t1).clone().sub(pos).normalize();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(aW, aH, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    cone.position.copy(pos);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    worldGroup.add(cone); pathObjects.push(cone);
  }

  // ── Pins ──
  const pinR = RIBBON_HALF_W * 2;
  const startPin = new THREE.Mesh(new THREE.SphereGeometry(pinR, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  startPin.position.copy(rawPts[0]); worldGroup.add(startPin); pathObjects.push(startPin);

  const endPin = new THREE.Mesh(new THREE.SphereGeometry(pinR, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xef4444 }));
  endPin.position.copy(rawPts[rawPts.length - 1]); worldGroup.add(endPin); pathObjects.push(endPin);

  // ── Pulse orb ──
  pulseT = 0;
  pulseOrb = new THREE.Mesh(new THREE.SphereGeometry(RIBBON_HALF_W * 1.6, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  pulseOrb.position.copy(rawPts[0]);
  worldGroup.add(pulseOrb);
}

// Build a flat ribbon with correct miter joins at every corner.
// At each point we compute the miter direction — the bisector of the two
// adjacent segment directions — and offset left/right along it.
// The miter length is clamped to 2× halfW so sharp corners don't overshoot.
function buildMiterRibbon(pts, halfW) {
  const up  = new THREE.Vector3(0, 1, 0);
  const verts = [], uvs = [], idx = [];
  const n = pts.length;

  for (let i = 0; i < n; i++) {
    // Direction of previous and next segments
    const prev = i > 0     ? pts[i].clone().sub(pts[i-1]).normalize() : null;
    const next = i < n - 1 ? pts[i+1].clone().sub(pts[i]).normalize() : null;
    const fwd  = next ?? prev;

    let miter;
    if (prev && next) {
      // Miter = average of the two perpendiculars, scaled so the ribbon edge
      // meets the outer corner correctly
      const rP = new THREE.Vector3().crossVectors(up, prev).normalize();
      const rN = new THREE.Vector3().crossVectors(up, next).normalize();
      miter = rP.clone().add(rN).normalize();
      // Miter length = halfW / cos(half-angle); clamp to 2×halfW
      const cosA = Math.max(0.5, rP.dot(miter));
      const miterLen = Math.min(halfW / cosA, halfW * 1.2);
      miter.multiplyScalar(miterLen);
    } else {
      // Endpoint — plain perpendicular
      miter = new THREE.Vector3().crossVectors(up, fwd).normalize().multiplyScalar(halfW);
    }

    const p = pts[i];
    verts.push(p.x - miter.x, p.y, p.z - miter.z);  // left
    verts.push(p.x + miter.x, p.y, p.z + miter.z);  // right
    const t = i / (n - 1);
    uvs.push(0, t,  1, t);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i*2, b = a+1, c = a+2, d = a+3;
    idx.push(a, b, c,  b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function simplifyPath(pts) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const ab = pts[i].clone().sub(pts[i-1]).normalize();
    const bc = pts[i+1].clone().sub(pts[i]).normalize();
    if (ab.dot(bc) < 0.9999) out.push(pts[i]);
  }
  out.push(pts[pts.length-1]);
  return out;
}


// ─── Stall Highlight Helpers ─────────────────────────────────────────────────
function applyHighlight(name, hex, emissiveIntensity = 0.7) {
  const mesh = stallMeshes[name];
  if (!mesh) return;
  const apply = mat => {
    mat.color.setHex(hex);
    if (mat.emissive) { mat.emissive.setHex(hex); mat.emissiveIntensity = emissiveIntensity; }
  };
  Array.isArray(mesh.material) ? mesh.material.forEach(apply) : apply(mesh.material);
}

function restoreHighlight(name) {
  const mesh = stallMeshes[name];
  if (!mesh) return;
  const orig = origMaterials[name];
  if (!orig)  return;
  mesh.material = Array.isArray(orig) ? orig.map(m => m.clone()) : orig.clone();
}

// ─── Mouse Interaction ────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();
const tooltip   = document.getElementById('tooltip');

function setupInteraction() {
  renderer.domElement.addEventListener('mousemove', onMouseMove);
  renderer.domElement.addEventListener('click',     onClick);
  renderer.domElement.addEventListener('mouseleave', () => {
    if (hoveredId && hoveredId !== startId && hoveredId !== endId) restoreHighlight(hoveredId);
    hoveredId = null;
    tooltip.style.display = 'none';
  });
}

function getHit(e) {
  mouse.x = (e.clientX / window.innerWidth)  *  2 - 1;
  mouse.y = (e.clientY / window.innerHeight) * -2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(Object.values(stallMeshes), false);
  return hits[0] ?? null;
}

function onMouseMove(e) {
  if (hoveredId && hoveredId !== startId && hoveredId !== endId) restoreHighlight(hoveredId);
  hoveredId = null;
  tooltip.style.display = 'none';

  const hit = getHit(e);
  if (!hit) return;

  const name = hit.object.name;
  hoveredId  = name;
  if (name !== startId && name !== endId) applyHighlight(name, COL.hover, 0.5);

  const info = stallInfo[name] ?? { company: name, category: '' };
  tooltip.innerHTML    = `<strong>${name}</strong> · ${info.company}${info.category ? `<br><em>${info.category}</em>` : ''}`;
  tooltip.style.display = 'block';
  tooltip.style.left    = (e.clientX + 14) + 'px';
  tooltip.style.top     = (e.clientY - 10) + 'px';
}

function onClick(e) {
  const hit = getHit(e);
  if (!hit) { document.getElementById('stall-popup').style.display = 'none'; return; }
  const name = hit.object.name;
  routeMode ? handleRouteClick(name) : showPopup(name, e.clientX, e.clientY);
}

// ─── Route Click Logic ────────────────────────────────────────────────────────
function handleRouteClick(name) {
  if (name === startId)      { clearStart(); return; }
  if (name === endId)        { clearEnd();   return; }
  if (!startId)              { setStart(name); return; }
  setEnd(name);
}

// ─── Popup ────────────────────────────────────────────────────────────────────
function showPopup(name, px, py) {
  const info = stallInfo[name] ?? { company: name, category: '', extra: [] };
  const pop  = document.getElementById('stall-popup');
  pop.style.display = 'block';
  pop.style.left    = Math.min(px + 12, window.innerWidth  - 250) + 'px';
  pop.style.top     = Math.min(py + 12, window.innerHeight - 200) + 'px';
  pop.innerHTML = `
    <button class="popup-close" onclick="document.getElementById('stall-popup').style.display='none'">✕</button>
    <div class="popup-id">${name}</div>
    <div class="popup-company">${info.company}</div>
    ${info.category ? `<div class="popup-cat">${info.category}</div>` : ''}
    ${info.extra?.length ? `<div class="popup-meta">${info.extra.join(' · ')}</div>` : ''}
    <button class="popup-btn route-from" onclick="window._setStart('${name}')">📍 Set as Start</button>
    <button class="popup-btn route-to"   onclick="window._setEnd('${name}')">🎯 Set as End</button>
  `;
}

window._setStart = name => {
  document.getElementById('stall-popup').style.display = 'none';
  document.getElementById('route-tab')?.click();
  setStart(name);
};

window._setEnd = name => {
  document.getElementById('stall-popup').style.display = 'none';
  document.getElementById('route-tab')?.click();
  setEnd(name);
};

// ─── Sidebar UI ───────────────────────────────────────────────────────────────
function buildUI() {
  // ── Desktop tabs ──
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
      routeMode = btn.dataset.tab === 'route-pane';
    });
  });

  // ── Desktop clear route ──
  document.getElementById('btn-clear-route').addEventListener('click', clearRoute);

  // ── Camera reset ──
  document.getElementById('btn-reset-cam').addEventListener('click', () => {
    if (window._defaultCamPos) {
      camera.position.copy(window._defaultCamPos);
      controls.target.copy(window._defaultCamTarget);
    }
  });

  // ── Desktop browse search ──
  document.getElementById('search-input').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#stall-list .stall-item').forEach(el => {
      const info = stallInfo[el.dataset.id] ?? { company: el.dataset.id, category: '' };
      el.style.display = (!q
        || el.dataset.id.toLowerCase().includes(q)
        || info.company.toLowerCase().includes(q)) ? '' : 'none';
    });
  });

  // ── Desktop route search inputs ──
  initSearchField({
    input:    document.getElementById('ds-from-input'),
    dropdown: document.getElementById('ds-from-dropdown'),
    clearBtn: document.getElementById('ds-from-clear'),
    onSelect: name => setStart(name),
  });
  initSearchField({
    input:    document.getElementById('ds-to-input'),
    dropdown: document.getElementById('ds-to-dropdown'),
    clearBtn: document.getElementById('ds-to-clear'),
    onSelect: name => setEnd(name),
  });

  // ── Mobile route search inputs ──
  initSearchField({
    input:    document.getElementById('ms-from-input'),
    dropdown: document.getElementById('ms-from-dropdown'),
    clearBtn: document.getElementById('ms-from-clear'),
    onSelect: name => { setStart(name); expandSheet('mid'); },
  });
  initSearchField({
    input:    document.getElementById('ms-to-input'),
    dropdown: document.getElementById('ms-to-dropdown'),
    clearBtn: document.getElementById('ms-to-clear'),
    onSelect: name => { setEnd(name); expandSheet('mid'); },
  });

  // ── Mobile top bar height → push canvas down ──
  const measureTopBar = () => {
    const top = document.getElementById('mobile-top');
    if (top && window.innerWidth <= 768) {
      const h = top.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--mob-top', h + 'px');
    }
  };
  // Measure after fonts/layout settle
  setTimeout(measureTopBar, 300);
  window.addEventListener('resize', measureTopBar);

  // ── Mobile browse search ──
  const msBrowse = document.getElementById('ms-browse-input');
  if (msBrowse) {
    msBrowse.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('#ms-stall-list .stall-item').forEach(el => {
        const info = stallInfo[el.dataset.id] ?? { company: el.dataset.id };
        el.style.display = (!q
          || el.dataset.id.toLowerCase().includes(q)
          || info.company.toLowerCase().includes(q)) ? '' : 'none';
      });
    });
  }

  // expose clearRoute globally for mobile clear button
  window.clearRoute = clearRoute;

  // ── Top view ──
  window._topView = () => {
    const box = new THREE.Box3();
    Object.values(stallMeshes).forEach(m => box.expandByObject(m));
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    camera.position.set(c.x, c.y + Math.max(s.x, s.z) * 1.2, c.z);
    controls.target.copy(c);
  };
}

// ── Search field with autocomplete dropdown ───────────────────────────────────
function initSearchField({ input, dropdown, clearBtn, onSelect }) {
  let focusIdx = -1;

  const getItems  = () => [...dropdown.querySelectorAll('.dd-item')];
  const closeDD   = () => { dropdown.classList.remove('open'); focusIdx = -1; };
  const showClear = v => clearBtn?.classList.toggle('visible', v);

  const renderDropdown = q => {
    const lower = q.toLowerCase().trim();
    const matches = Object.keys(stallInfo)
      .filter(id => !lower
        || id.toLowerCase().includes(lower)
        || (stallInfo[id].company || '').toLowerCase().includes(lower))
      .slice(0, 30);

    if (!matches.length) {
      dropdown.innerHTML = `<div class="dd-empty">No stalls found</div>`;
    } else {
      dropdown.innerHTML = matches.map(id => {
        const info = stallInfo[id];
        return `<div class="dd-item" data-id="${id}">
          <span class="dd-badge">${id}</span>
          <div class="dd-texts">
            <div class="dd-name">${info.company || id}</div>
            ${info.category ? `<div class="dd-sub">${info.category}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    }

    dropdown.querySelectorAll('.dd-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        const id = item.dataset.id;
        input.value = `${id} — ${stallInfo[id]?.company ?? id}`;
        showClear(true);
        closeDD();
        onSelect(id);
      });
    });

    focusIdx = -1;
    dropdown.classList.add('open');
  };

  input.addEventListener('focus', () => {
    if (input.value) renderDropdown(input.value);
    else             renderDropdown('');
  });

  input.addEventListener('input', () => {
    showClear(!!input.value);
    renderDropdown(input.value);
  });

  input.addEventListener('keydown', e => {
    const items = getItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusIdx = Math.min(focusIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('focused', i === focusIdx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusIdx = Math.max(focusIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('focused', i === focusIdx));
    } else if (e.key === 'Enter' && focusIdx >= 0) {
      items[focusIdx]?.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      closeDD();
    }
  });

  input.addEventListener('blur', () => setTimeout(closeDD, 150));

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    showClear(false);
    closeDD();
    // Clear whichever slot this belongs to
    if (input.id.includes('from')) clearStart();
    else clearEnd();
  });
}

// ── Mobile sheet drag behaviour ───────────────────────────────────────────────
const SHEET_HEIGHTS = { peek: 'var(--sheet-peek)', mid: '52vh', full: '92vh' };
let sheetState = 'peek';

function expandSheet(state) {
  sheetState = state;
  const sheet = document.getElementById('mobile-sheet');
  sheet.style.height = SHEET_HEIGHTS[state] ?? SHEET_HEIGHTS.peek;
}

function initMobileSheet() {
  const sheet  = document.getElementById('mobile-sheet');
  const handle = document.getElementById('sheet-handle-bar');
  let startY = 0, startH = 0, dragging = false;

  const onStart = e => {
    dragging = true;
    startY = (e.touches?.[0] ?? e).clientY;
    startH = sheet.getBoundingClientRect().height;
    sheet.style.transition = 'none';
  };
  const onMove = e => {
    if (!dragging) return;
    const dy = startY - (e.touches?.[0] ?? e).clientY;
    const newH = Math.max(80, Math.min(window.innerHeight * 0.95, startH + dy));
    sheet.style.height = newH + 'px';
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    const h = sheet.getBoundingClientRect().height;
    const wh = window.innerHeight;
    if (h < wh * 0.25)      expandSheet('peek');
    else if (h < wh * 0.65) expandSheet('mid');
    else                     expandSheet('full');
  };

  handle.addEventListener('touchstart', onStart, { passive: true });
  handle.addEventListener('touchmove',  onMove,  { passive: true });
  handle.addEventListener('touchend',   onEnd);
  handle.addEventListener('mousedown',  onStart);
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('mouseup',    onEnd);

  // Tap on sheet-search expands to mid
  document.getElementById('sheet-search').addEventListener('click', () => {
    if (sheetState === 'peek') expandSheet('mid');
  });
}

function buildStallList() {
  const ids = Object.keys(stallMeshes).sort();
  const html = ids.map(name => {
    const info = stallInfo[name] ?? { company: name, category: '' };
    return `<div class="stall-item" data-id="${name}" onclick="window._focusStall('${name}')">
      <span class="stall-badge">${name}</span>
      <div>
        <div class="stall-name">${info.company}</div>
        ${info.category ? `<div class="stall-cat">${info.category}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const desktopList = document.getElementById('stall-list');
  if (desktopList) desktopList.innerHTML = html;

  const mobileList = document.getElementById('ms-stall-list');
  if (mobileList) mobileList.innerHTML = html;
}

window._focusStall = name => {
  const mesh = stallMeshes[name];
  if (!mesh) return;
  const box  = new THREE.Box3().setFromObject(mesh);
  const c    = box.getCenter(new THREE.Vector3());
  const s    = box.getSize(new THREE.Vector3());
  const dist = Math.max(s.x, s.y, s.z) * 4;
  controls.target.copy(c);
  camera.position.set(c.x + dist, c.y + dist * 0.8, c.z + dist);
  if (sheetState !== 'peek') expandSheet('peek');
};

// ─── Route state helpers ──────────────────────────────────────────────────────
function setStart(name) {
  if (startId && startId !== name) restoreHighlight(startId);
  startId = name;
  applyHighlight(name, COL.start, 0.8);
  routeMode = true;
  syncRouteUI();
  if (startId && endId) computeAndDraw();
}

function setEnd(name) {
  if (endId && endId !== name) restoreHighlight(endId);
  endId = name;
  applyHighlight(name, COL.end, 0.8);
  routeMode = true;
  syncRouteUI();
  if (startId && endId) computeAndDraw();
}

function clearStart() {
  if (startId) restoreHighlight(startId);
  startId = null;
  clearPathObjects();
  syncRouteUI();
}

function clearEnd() {
  if (endId) restoreHighlight(endId);
  endId = null;
  clearPathObjects();
  syncRouteUI();
}

function clearRoute() {
  if (startId) restoreHighlight(startId);
  if (endId)   restoreHighlight(endId);
  startId = null; endId = null;
  clearPathObjects();
  // Clear all inputs
  ['ds-from-input','ds-to-input','ms-from-input','ms-to-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['ds-from-clear','ds-to-clear','ms-from-clear','ms-to-clear'].forEach(id => {
    document.getElementById(id)?.classList.remove('visible');
  });
  syncRouteUI();
}

function computeAndDraw() {
  setRouteHint('Calculating…');
  const result = aStar(startId, endId);
  if (result) {
    drawRoute(result);
    setRouteHint(`✓ Route found — ${result.path.length} waypoints`);
    setRouteSteps([startId, endId]);
  } else {
    clearPathObjects();
    setRouteHint('⚠ No route found — try different stalls');
    setRouteSteps([]);
  }
}

function syncRouteUI() {
  // Sync input values to reflect selected stalls
  const fromLabel = startId ? `${startId} — ${stallInfo[startId]?.company ?? startId}` : '';
  const toLabel   = endId   ? `${endId} — ${stallInfo[endId]?.company   ?? endId}`   : '';

  ['ds-from-input','ms-from-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = fromLabel;
  });
  ['ds-to-input','ms-to-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = toLabel;
  });
  ['ds-from-clear','ms-from-clear'].forEach(id => {
    document.getElementById(id)?.classList.toggle('visible', !!startId);
  });
  ['ds-to-clear','ms-to-clear'].forEach(id => {
    document.getElementById(id)?.classList.toggle('visible', !!endId);
  });

  if (!startId && !endId) setRouteHint('Search or tap a stall to begin');
  else if (!startId)      setRouteHint('Now choose a start stall');
  else if (!endId)        setRouteHint('Now choose a destination');
}

function setRouteUI(which, name) {
  // Legacy — kept for handleRouteClick (3D tap) compat
  if (which === 'start') {
    ['ds-from-input','ms-from-input'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = name ? `${name} — ${stallInfo[name]?.company ?? name}` : '';
    });
    ['ds-from-clear','ms-from-clear'].forEach(id => {
      document.getElementById(id)?.classList.toggle('visible', !!name);
    });
  } else {
    ['ds-to-input','ms-to-input'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = name ? `${name} — ${stallInfo[name]?.company ?? name}` : '';
    });
    ['ds-to-clear','ms-to-clear'].forEach(id => {
      document.getElementById(id)?.classList.toggle('visible', !!name);
    });
  }
}

function setRouteHint(msg) {
  ['route-hint','ms-route-hint','mobile-route-hint'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = msg;
  });
}

function setRouteSteps(path) {
  const html = path.map((id, i) => {
    const cls  = i === 0 ? 'step-start' : i === path.length - 1 ? 'step-end' : '';
    const info = stallInfo[id] ?? { company: id };
    return `<div class="step ${cls}"><span class="step-num">${i + 1}</span><span>${id} · ${info.company}</span></div>`;
  }).join('');
  ['route-steps','ms-route-steps','mobile-route-steps'].forEach(id => {
    const el = document.getElementById(id); if (el) el.innerHTML = html;
  });
  // Show mobile chip if route found
  const chip = document.getElementById('mobile-route-chip');
  if (chip) chip.style.display = path.length ? '' : 'none';
}

function updateStats() {
  const total  = Object.keys(stallMeshes).length;
  const mapped = Object.values(stallInfo).filter(s => s.company !== s.meshName).length;
  const elTotal  = document.getElementById('stat-total');
  const elMapped = document.getElementById('stat-mapped');
  if (elTotal)  elTotal.textContent  = `${total} stalls`;
  if (elMapped) elMapped.textContent = `${mapped} mapped`;
}

// ─── Progress overlay ────────────────────────────────────────────────────────
function progress(pct, msg) {
  const bar  = document.getElementById('progress-bar');
  const text = document.getElementById('loading-text');
  if (bar)  bar.style.width  = pct + '%';
  if (text) text.textContent = msg;
}

// ─── Animation Loop ───────────────────────────────────────────────────────────
const clock = new THREE.Clock();
const PULSE_SPEED = 0.18;  // fraction of path traversed per second

function animate() {
  requestAnimationFrame(animate);
  const t   = clock.getElapsedTime();
  const dt  = clock.getDelta ? 0.016 : 0.016;

  // Gentle breathe on static path objects (scale only — MeshBasicMaterial has no emissive)
  pathObjects.forEach((o, i) => {
    if (o.material?.transparent && o.material?.opacity !== undefined) {
      o.material.opacity = 0.25 + 0.1 * Math.sin(t * 1.8 + i * 0.5);
    }
  });

  // Travelling pulse orb
  if (pulseOrb && activeCurve) {
    pulseT = (pulseT + PULSE_SPEED * 0.016) % 1;
    pulseOrb.position.copy(activeCurve.getPoint(pulseT));
    const s = 1 + 0.4 * Math.sin(t * 6);
    pulseOrb.scale.setScalar(s);
  }

  controls.update();
  updateLabelVisibility();
  pdrTick(t);
  renderer.render(scene, camera);
}

// ─── PDR Navigation System ────────────────────────────────────────────────────
//
// Free movement: player moves in actual compass heading direction each step.
// worldGroup rotates so map always faces direction of travel (Google Maps style).
// Reroute: if player drifts > REROUTE_THRESHOLD from nearest path waypoint,
// A* is re-run from their current position to the destination.

const PDR = {
  active:        false,
  pos:           null,      // THREE.Vector3 — real estimated world position
  heading:       0,         // smoothed heading in radians
  smoothHeading: 0,         // low-pass filtered compass degrees
  rawSamples:    [],        // last N raw compass readings for median filter
  headingAlpha:  0.10,      // low-pass factor (higher = more responsive)
  stepLength:    0,
  worldScale:    0,
  destination:   null,
  currentPath:   null,      // current planned path as Vector3[]
  stepCount:     0,
  lastAccelMag:  0,
  stepCooldown:  0,
  stepThresh:    1.18,
  playerMesh:    null,
  posHistory:    [],        // [{x,z,step}] for future analytics/reroute
};

const savedCam = { pos:null, target:null };
// Overhead nav camera: fixed position looking straight down at player
const NAV_CAM_HEIGHT  = 0.45;
// Reroute if player is this far from nearest planned waypoint (world units)
const REROUTE_THRESHOLD = 0.15;

let driftWarningShown = false;
let lastRerouteStep   = -50;  // prevent rerouting every step

// ── Scale ─────────────────────────────────────────────────────────────────────
function initPDRScale() {
  const box = new THREE.Box3();
  Object.values(stallBoxes).forEach(b => box.union(b));
  PDR.worldScale = (box.max.x - box.min.x) / 170;
  PDR.stepLength = 0.72 * PDR.worldScale;
  console.info(`[PDR] scale=${PDR.worldScale.toFixed(5)} wu/m  step=${PDR.stepLength.toFixed(5)} wu`);
}

// ── Player mesh ───────────────────────────────────────────────────────────────
function buildPlayerMesh() {
  if (PDR.playerMesh) { worldGroup.remove(PDR.playerMesh); PDR.playerMesh = null; }
  const g = new THREE.Group();

  // Pulsing disc
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.04, 32),
    new THREE.MeshBasicMaterial({ color:0x3b82f6, transparent:true, opacity:0.28, side:THREE.DoubleSide, depthWrite:false }),
  );
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.001;
  g.add(disc);

  // Body cylinder
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.012,0.015,0.06,12), new THREE.MeshBasicMaterial({color:0x3b82f6}));
  body.position.y = 0.03; g.add(body);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.018,12,12), new THREE.MeshBasicMaterial({color:0xffffff}));
  head.position.y = 0.072; g.add(head);

  // Direction arrow
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.016,0.045,8), new THREE.MeshBasicMaterial({color:0xf97316}));
  arrow.rotation.x = Math.PI/2; arrow.position.set(0,0.035,-0.038); g.add(arrow);

  g.visible = false;
  worldGroup.add(g);
  PDR.playerMesh = g;
}

// ── Step detection ────────────────────────────────────────────────────────────
function onDeviceMotion(e) {
  if (!PDR.active) return;
  if (PDR.stepCooldown > 0) { PDR.stepCooldown--; return; }
  const ag = e.accelerationIncludingGravity; if (!ag) return;
  const mag = Math.sqrt((ag.x||0)**2+(ag.y||0)**2+(ag.z||0)**2)/9.81;
  if (PDR.lastAccelMag < PDR.stepThresh && mag >= PDR.stepThresh) {
    registerStep(); PDR.stepCooldown = 15;
  }
  PDR.lastAccelMag = mag;
}

function registerStep() {
  if (!PDR.active || !PDR.pos) return;
  PDR.stepCount++;

  // Move in actual compass heading direction (free movement)
  const dx = Math.sin(PDR.heading) * PDR.stepLength;
  const dz = Math.cos(PDR.heading) * PDR.stepLength;
  PDR.pos.x += dx;
  PDR.pos.z += dz;
  PDR.pos.y  = pathY;

  // Record position history
  PDR.posHistory.push({ x:PDR.pos.x, z:PDR.pos.z, step:PDR.stepCount });
  if (PDR.posHistory.length > 500) PDR.posHistory.shift(); // keep last 500 steps

  // Update player mesh (always faces PDR.heading via worldGroup rotation)
  PDR.playerMesh.position.set(PDR.pos.x, pathY, PDR.pos.z);

  // Check if we should reroute
  if (PDR.stepCount - lastRerouteStep >= 10) checkReroute();

  updateNavPanel();
  updateFollowCamera();
}

// ── Reroute detection ─────────────────────────────────────────────────────────
function checkReroute() {
  if (!PDR.currentPath || !PDR.destination || !PDR.pos) return;

  // Find nearest waypoint on current path
  let minDist = Infinity;
  let nearestIdx = 0;
  for (let i = 0; i < PDR.currentPath.length; i++) {
    const wp = PDR.currentPath[i];
    const d  = Math.sqrt((PDR.pos.x-wp.x)**2 + (PDR.pos.z-wp.z)**2);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }

  if (minDist < REROUTE_THRESHOLD) {
    // Still on path — trim passed waypoints
    PDR.currentPath = PDR.currentPath.slice(nearestIdx);
  } else {
    // Off path — reroute from current position
    console.info(`[PDR] Rerouting — ${(minDist/PDR.worldScale).toFixed(1)}m off path`);
    rerouteFromCurrentPosition();
    lastRerouteStep = PDR.stepCount;
  }
}

function rerouteFromCurrentPosition() {
  if (!PDR.destination || !pathfinder) return;

  // Find nearest stall to current position to use as A* start
  let nearestStall = null, nearestD = Infinity;
  Object.entries(centroids).forEach(([name, pos]) => {
    const d = Math.sqrt((PDR.pos.x-pos.x)**2 + (PDR.pos.z-pos.z)**2);
    if (d < nearestD) { nearestD = d; nearestStall = name; }
  });

  if (!nearestStall) return;

  const result = aStar(nearestStall, PDR.destination);
  if (result) {
    PDR.currentPath = result.path.map(p => p.clone());
    // Redraw the path on the map
    clearPathObjects();
    drawRoute(result);
    setRouteHint('↺ Rerouted');
    setTimeout(() => updateNavPanel(), 1500);
    console.info(`[PDR] Rerouted via ${nearestStall}`);
  }
}

// ── Compass — smoothed heading, rotates worldGroup ────────────────────────────
function onDeviceOrientation(e) {
  if (!PDR.active) return;

  let raw = e.webkitCompassHeading != null
    ? e.webkitCompassHeading
    : (360 - (e.alpha ?? 0)) % 360;

  // Median filter (kill spikes)
  PDR.rawSamples.push(raw);
  if (PDR.rawSamples.length > 7) PDR.rawSamples.shift();
  const sorted = [...PDR.rawSamples].sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length/2)];

  // Low-pass filter with wraparound handling
  let diff = median - PDR.smoothHeading;
  if (diff >  180) diff -= 360;
  if (diff < -180) diff += 360;
  PDR.smoothHeading = (PDR.smoothHeading + diff * PDR.headingAlpha + 360) % 360;
  PDR.heading = PDR.smoothHeading * Math.PI / 180;

  // Rotate the world so "forward" (compass direction) faces -Z (camera looks -Z)
  // worldGroup.rotation.y = heading rotates map so North always aligns with phone North
  worldGroup.rotation.y = PDR.heading;

  updateCompassUI(PDR.smoothHeading);
}

// ── Fixed overhead nav camera ─────────────────────────────────────────────────
function updateFollowCamera() {
  if (!PDR.active || !PDR.pos) return;

  // Place camera directly above the player
  camera.position.set(PDR.pos.x, pathY + NAV_CAM_HEIGHT, PDR.pos.z);

  // Look straight down — set rotation directly to avoid gimbal lock from lookAt
  camera.rotation.set(-Math.PI / 2, 0, 0);
  camera.updateMatrixWorld();
}

// ── Nav panel ─────────────────────────────────────────────────────────────────
function updateNavPanel() {
  const inst   = document.getElementById('pdr-instruction');
  const distEl = document.getElementById('pdr-distance');
  if (!inst || !distEl) return;

  if (!PDR.currentPath || PDR.currentPath.length < 2) {
    // Check if arrived
    if (PDR.destination) {
      const dest = centroids[PDR.destination];
      if (dest) {
        const d = Math.sqrt((PDR.pos.x-dest.x)**2+(PDR.pos.z-dest.z)**2);
        if (d < 0.1) { inst.textContent='🎯 You have arrived!'; distEl.textContent=''; return; }
      }
    }
    inst.textContent='↑ Walk straight'; distEl.textContent=''; return;
  }

  // Total remaining distance
  let total = 0;
  for (let i=0; i<PDR.currentPath.length-1; i++) {
    const a=PDR.currentPath[i], b=PDR.currentPath[i+1];
    total += Math.sqrt((b.x-a.x)**2+(b.z-a.z)**2);
  }
  distEl.textContent = `${Math.round(total/PDR.worldScale)}m`;

  // Next turn
  const a=PDR.currentPath[0], b=PDR.currentPath[1], c=PDR.currentPath[2];
  let dir = '↑ Walk straight';
  if (c) {
    const s1=Math.atan2(b.x-a.x,b.z-a.z), s2=Math.atan2(c.x-b.x,c.z-b.z);
    const turn = ((s2-s1)*180/Math.PI+540)%360-180;
    if      (turn >  25) dir='↱ Turn right';
    else if (turn < -25) dir='↲ Turn left';
  }
  inst.textContent = dir;
}

function updateCompassUI(deg) {
  const el = document.getElementById('pdr-compass-arrow');
  if (el) el.style.transform = `rotate(${-deg}deg)`;
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
function startPDR(fromStallName, toStallName) {
  if (!pathfinder) { alert('Navigation not ready'); return; }
  if (!fromStallName||!toStallName) { alert('Set start and destination first'); return; }
  initPDRScale(); buildPlayerMesh();
  const result = aStar(fromStallName, toStallName);
  if (!result) { alert('No route found'); return; }

  PDR.active      = true;
  PDR.destination = toStallName;
  PDR.currentPath = result.path.map(p=>p.clone());
  PDR.stepCount   = 0;
  PDR.lastAccelMag= 0;
  PDR.rawSamples  = [];
  PDR.smoothHeading = 0;
  PDR.posHistory  = [];
  PDR.pos = centroids[fromStallName].clone();
  PDR.pos.y = pathY;

  PDR.playerMesh.position.set(PDR.pos.x, pathY, PDR.pos.z);
  PDR.playerMesh.visible = true;

  savedCam.pos    = camera.position.clone();
  savedCam.target = controls.target.clone();
  controls.enabled = false;

  // Reset worldGroup rotation
  worldGroup.rotation.y = 0;
  updateFollowCamera();

  document.getElementById('pdr-hud').style.display='flex';
  document.getElementById('pdr-to').textContent = stallInfo[toStallName]?.company??toStallName;
  const mt=document.getElementById('mobile-top'); if(mt) mt.style.display='none';
  updateNavPanel();
  requestSensorPermissions();
}

function stopPDR() {
  PDR.active = false;
  if (PDR.playerMesh) PDR.playerMesh.visible = false;

  // Reset worldGroup rotation
  worldGroup.rotation.y = 0;

  controls.enabled = true;
  if (savedCam.pos) {
    camera.position.copy(savedCam.pos);
    controls.target.copy(savedCam.target);
    controls.update();
  }

  document.getElementById('pdr-hud').style.display='none';
  if (window.innerWidth<=768) { const mt=document.getElementById('mobile-top'); if(mt) mt.style.display='flex'; }
  window.removeEventListener('devicemotion',      onDeviceMotion);
  window.removeEventListener('deviceorientation', onDeviceOrientation);
}

function requestSensorPermissions() {
  if (typeof DeviceMotionEvent?.requestPermission==='function') {
    DeviceMotionEvent.requestPermission()
      .then(s=>{if(s==='granted') window.addEventListener('devicemotion',onDeviceMotion,{passive:true});})
      .catch(console.warn);
    DeviceOrientationEvent.requestPermission()
      .then(s=>{if(s==='granted') window.addEventListener('deviceorientation',onDeviceOrientation,{passive:true});})
      .catch(console.warn);
  } else {
    window.addEventListener('devicemotion',      onDeviceMotion,      {passive:true});
    window.addEventListener('deviceorientation', onDeviceOrientation, {passive:true});
  }
}

// ── Manual correction ─────────────────────────────────────────────────────────
window._pdrCorrect = function(stallName) {
  if (!stallName||!PDR.active) return;
  PDR.pos = centroids[stallName].clone(); PDR.pos.y = pathY;
  PDR.playerMesh.position.set(PDR.pos.x, pathY, PDR.pos.z);
  const result = aStar(stallName, PDR.destination);
  if (result) {
    PDR.currentPath = result.path.map(p=>p.clone());
    clearPathObjects(); drawRoute(result);
  }
  updateNavPanel(); updateFollowCamera();
  document.getElementById('pdr-correction-modal').style.display='none';
};

window._startPDR = function() {
  if (!startId||!endId) { alert('Set a start and destination stall first'); return; }
  startPDR(startId,endId);
};
window._stopPDR  = stopPDR;
window._toggleTrack = function() { if (PDR.active) updateFollowCamera(); };

window._showCorrectionModal = function() {
  const modal=document.getElementById('pdr-correction-modal'); if(!modal) return;
  const q=(document.getElementById('pdr-correction-search')?.value??'').toLowerCase();
  document.getElementById('pdr-correction-list').innerHTML=Object.keys(stallMeshes).sort()
    .filter(id=>!q||id.toLowerCase().includes(q)||(stallInfo[id]?.company??'').toLowerCase().includes(q))
    .map(id=>`<div class="pdr-stall-row" onclick="window._pdrCorrect('${id}')"><span class="pdr-badge">${id}</span><span>${stallInfo[id]?.company??id}</span></div>`)
    .join('');
  modal.style.display='flex';
};

function pdrTick(t) {
  if (!PDR.active||!PDR.playerMesh) return;
  const disc=PDR.playerMesh.children[0];
  if (disc) disc.material.opacity=0.12+0.18*Math.abs(Math.sin(t*2));
}

init().catch(err => {
  console.error('[viewer] init failed:', err);
  progress(0, `❌ ${err.message}`);
});
