// Safe defaults — overwritten when sensors.js loads
window.currentHeadingRad = window.currentHeadingRad || 0;
window.isMoving          = window.isMoving          || false;
window.STEP_LENGTH       = window.STEP_LENGTH       || 0.025;
window.destStall         = window.destStall         || null;

// ── scene.js — Three.js scene, navmesh, avatar, camera ──────────────────

'use strict';

// ── Renderer ──────────────────────────────────────────────────────────────
const canvas   = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputEncoding    = THREE.sRGBEncoding;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x18181f);
scene.fog = new THREE.Fog(0x18181f, 6, 22);

// Overlay scene — avatar + path render here without tone mapping
const overlayScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(60, 1, 0.005, 100);
let camFollowing = true;
const camOffset  = new THREE.Vector3(0, 2.2, 0.6);
let _firstPersonMode = false;
const FP_EYE_HEIGHT  = 0.11; // world units above avatar floor (≈25% lower than 0.15)

// ── Lighting — matches Blender sun (elevation 20°, rotation 202°, strength 0.3) ──
// Sky ambient: world strength 0.3 → low ambient so baked lightmap contrast shows through
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
// Single directional sun — Blender → Three.js coord conversion (Y-up):
//   Three.js X = cos(20°)·sin(202°) ≈ -0.352
//   Three.js Y = sin(20°)           ≈  0.342
//   Three.js Z = -cos(20°)·cos(202°)≈  0.871
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(-0.352, 0.342, 0.871);
sun.castShadow = false;
scene.add(sun);

// ── Avatar ────────────────────────────────────────────────────────────────
const BODY_R = 0.028, BODY_H = 0.065, AVATAR_HOVER = 0.04;

const avatarRoot = new THREE.Object3D();
overlayScene.add(avatarRoot);

// MeshBasicMaterial with toneMapped:false — bypasses ACES and sRGB encoding
const avatarMat = new THREE.MeshBasicMaterial({ color: 0xFF2D55, toneMapped: false }); // iOS-style red-pink
const capMat    = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, toneMapped: false }); // pure white
const body = new THREE.Mesh(new THREE.CylinderGeometry(BODY_R,BODY_R,BODY_H,24), avatarMat);
body.castShadow = true; avatarRoot.add(body);
const capT = new THREE.Mesh(new THREE.SphereGeometry(BODY_R,24,12), capMat);
capT.position.y = BODY_H/2; avatarRoot.add(capT);
const capB = new THREE.Mesh(new THREE.SphereGeometry(BODY_R,24,12), capMat);
capB.position.y = -BODY_H/2; avatarRoot.add(capB);

// Beak (forward indicator)
const beakMat = new THREE.MeshBasicMaterial({ color: 0xFF9500, side: THREE.DoubleSide, toneMapped: false }); // bright amber
const beakGeo = new THREE.BufferGeometry();
beakGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
   0,    0,    BODY_R*3.5,
  -BODY_R*1.2, 0, BODY_R*0.3,
   BODY_R*1.2, 0, BODY_R*0.3,
   0, BODY_R*0.8, BODY_R*0.3,
]),3));
beakGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0,1,2, 0,2,3, 0,3,1, 1,3,2]),1));
beakGeo.computeVertexNormals();
const beak = new THREE.Mesh(beakGeo, beakMat); beak.position.y=0.12; avatarRoot.add(beak);

// Ground ring
const ringMat = new THREE.MeshBasicMaterial({color:0xFF2D55,side:THREE.DoubleSide,transparent:true,opacity:0.9,toneMapped:false});
const ring = new THREE.Mesh(new THREE.RingGeometry(BODY_R*1.3, BODY_R*2.2, 40), ringMat);
ring.rotation.x=-Math.PI/2; ring.position.y=-BODY_H/2+0.005; avatarRoot.add(ring);

// Ground arrow
const arrowGndMat = new THREE.MeshBasicMaterial({color:0xFF9500,side:THREE.DoubleSide,transparent:true,opacity:1.0,toneMapped:false});
const agGeo = new THREE.BufferGeometry();
agGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
   0,0,BODY_R*3.5, -BODY_R*0.8,0,BODY_R*1.2, BODY_R*0.8,0,BODY_R*1.2
]),3));
agGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0,2,1]),1));
agGeo.computeVertexNormals();
const arrowGnd = new THREE.Mesh(agGeo, arrowGndMat);
arrowGnd.rotation.x=-Math.PI/2; arrowGnd.position.y=-BODY_H/2+0.006; avatarRoot.add(arrowGnd);

// Destination marker — pulsing green pin shown when navigating
// In scene (not overlayScene) so it depth-tests against stall walls
const destMarkerMat = new THREE.MeshBasicMaterial({color:0x00E676,transparent:true,opacity:0.0,toneMapped:false});
const destMarker = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.004,0.5,8), destMarkerMat);
destMarker.position.y = 0.25;
scene.add(destMarker);

// FROM/TO markers as CSS2DObjects — render in DOM overlay, always above labels
function makePin(color, label) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    display:flex;flex-direction:column;align-items:center;pointer-events:none;
    opacity:0;transition:opacity 0.2s;
  `;
  const dot = document.createElement('div');
  dot.style.cssText = `
    width:20px;height:20px;border-radius:50%;
    background:${color};border:3px solid #fff;
    box-shadow:0 2px 12px rgba(0,0,0,0.6), 0 0 0 4px ${color}44;
    flex-shrink:0;
  `;
  wrap.appendChild(dot);
  const obj = new THREE.CSS2DObject(wrap);
  obj.visible = false;
  scene.add(obj); // added to main scene but rendered in CSS2D layer
  return { obj, wrap };
}

const fromPin = makePin('#4A9EDD', 'START');
const toPin   = makePin('#FF6B2B', 'END');
// Aliases for animate loop
const fromMarker = fromPin.obj;
const toMarker   = toPin.obj;

// ── Avatar world position ─────────────────────────────────────────────────
// Position state — on window so sensors.js can read/write
let aX=0, aY=0, aZ=0;
let tX=0, tY=0, tZ=0;
let aHeading=0, tHeading=0;
function resetHeading(){ aHeading=0; tHeading=0; }

function placeAvatarImmediate(x,y,z){
  // Update local vars (used by animate lerp)
  aX=x; aY=y; aZ=z;
  // Update window targets (sensors.js writes here, animate reads here)
  window.tX=x; window.tY=y; window.tZ=z;
  window.aX=x; window.aY=y; window.aZ=z;
  avatarRoot.position.set(x,y+AVATAR_HOVER,z);
}

// ── Navmesh ───────────────────────────────────────────────────────────────
let navTriangles=[], navReady=false;

function buildNavmesh(mesh){
  const geo=mesh.geometry.clone();
  geo.applyMatrix4(mesh.matrixWorld);
  const pos=geo.attributes.position, idx=geo.index?.array;
  const triCount=idx?idx.length/3:pos.count/3;
  navTriangles=[];
  for(let t=0;t<triCount;t++){
    const i0=idx?idx[t*3]:t*3, i1=idx?idx[t*3+1]:t*3+1, i2=idx?idx[t*3+2]:t*3+2;
    const a=new THREE.Vector3(pos.getX(i0),pos.getY(i0),pos.getZ(i0));
    const b=new THREE.Vector3(pos.getX(i1),pos.getY(i1),pos.getZ(i1));
    const c=new THREE.Vector3(pos.getX(i2),pos.getY(i2),pos.getZ(i2));
    navTriangles.push({a,b,c,
      minX:Math.min(a.x,b.x,c.x),maxX:Math.max(a.x,b.x,c.x),
      minZ:Math.min(a.z,b.z,c.z),maxZ:Math.max(a.z,b.z,c.z)});
  }
  navReady=true;
  console.log('Navmesh:',navTriangles.length,'tris');
}

function _s(p1x,p1z,p2x,p2z,p3x,p3z){return(p1x-p3x)*(p2z-p3z)-(p2x-p3x)*(p1z-p3z);}
function ptInTri(px,pz,a,b,c){
  const d1=_s(px,pz,a.x,a.z,b.x,b.z),d2=_s(px,pz,b.x,b.z,c.x,c.z),d3=_s(px,pz,c.x,c.z,a.x,a.z);
  return!((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0));
}
function triY(px,pz,a,b,c){
  const v0x=c.x-a.x,v0z=c.z-a.z,v1x=b.x-a.x,v1z=b.z-a.z,v2x=px-a.x,v2z=pz-a.z;
  const d00=v0x*v0x+v0z*v0z,d01=v0x*v1x+v0z*v1z,d02=v0x*v2x+v0z*v2z;
  const d11=v1x*v1x+v1z*v1z,d12=v1x*v2x+v1z*v2z;
  const inv=1/(d00*d11-d01*d01);
  return a.y+(d00*d12-d01*d02)*inv*(b.y-a.y)+(d11*d02-d01*d12)*inv*(c.y-a.y);
}
function findTri(px,pz){
  for(const t of navTriangles){
    if(px<t.minX||px>t.maxX||pz<t.minZ||pz>t.maxZ)continue;
    if(ptInTri(px,pz,t.a,t.b,t.c))return t;
  }
  return null;
}
function constrain(ox,oz,nx,nz){
  if(!navReady)return{x:nx,z:nz,y:aY};
  let t;
  t=findTri(nx,nz);if(t)return{x:nx,z:nz,y:triY(nx,nz,t.a,t.b,t.c)};
  t=findTri(nx,oz);if(t)return{x:nx,z:oz,y:triY(nx,oz,t.a,t.b,t.c)};
  t=findTri(ox,nz);if(t)return{x:ox,z:nz,y:triY(ox,nz,t.a,t.b,t.c)};
  t=findTri(ox,oz);return{x:ox,z:oz,y:t?triY(ox,oz,t.a,t.b,t.c):aY};
}

// ── Camera ────────────────────────────────────────────────────────────────
const camTarget=new THREE.Vector3();
function recenterCamera(){ /* recenter button removed */ }
// Camera animation state
let camAnim = null;
let camPreviewMode = false; // true = stay at preview position, don't follow avatar

function animateCamera(toPos, toTarget, duration, onDone) {
  // Accept plain {x,y,z} or THREE.Vector3
  const tp = (toPos instanceof THREE.Vector3) ? toPos
    : new THREE.Vector3(toPos.x, toPos.y, toPos.z);
  const tt = (toTarget instanceof THREE.Vector3) ? toTarget
    : new THREE.Vector3(toTarget.x, toTarget.y, toTarget.z);
  camAnim = {
    fromPos:    camera.position.clone(),
    fromTarget: camTarget.clone(),
    toPos:      tp,
    toTarget:   tt,
    t:          0,
    duration:   duration || 1.2,
    onDone:     onDone || null
  };
}

function updateCamera(){
  if (camAnim) {
    camAnim.t += (1/60) / camAnim.duration;
    const t = Math.min(camAnim.t, 1);
    // Smoothstep ease
    const e = t * t * (3 - 2 * t);
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    const lerpedTarget = new THREE.Vector3().lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);
    camera.lookAt(lerpedTarget);
    if (t >= 1) {
      const done = camAnim.onDone;
      camAnim = null;
      if (done) done();
    }
    return;
  }
  // First-person mode: camera at eye level, oriented by device heading
  if (_firstPersonMode) {
    const hr   = window.currentHeadingRad || 0;
    const eyeY = aY + FP_EYE_HEIGHT;
    const lookX = aX + Math.sin(hr);
    const lookZ = aZ - Math.cos(hr);
    camera.position.set(aX, eyeY, aZ);
    camera.lookAt(lookX, eyeY, lookZ);
    camTarget.set(lookX, eyeY, lookZ); // keep in sync for exit-animation fromTarget
    return;
  }
  // Preview mode: camera stays where it is, no follow
  if (camPreviewMode) return;
  // Free top-down camera: pan target drifts toward avatar unless user has panned manually
  if (!_freeCamMoved) {
    _panX += (aX - _panX) * 0.08;
    _panZ += (aZ - _panZ) * 0.08;
  }
  camTarget.set(_panX, 0, _panZ);
  camera.position.set(_panX + camOffset.x, camOffset.y, _panZ + camOffset.z);
  camera.lookAt(camTarget);
}

// ── Free camera pan + zoom ────────────────────────────────────────────────
// _panX/_panZ: world-space camera look-at target on the floor plane
// _freeCamMoved: when false the look-at slowly follows the avatar
let _panX = 0, _panZ = 0, _freeCamMoved = false;

const _panRaycaster = new THREE.Raycaster();
const _panPlane     = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y=0 floor

function _screenToFloor(clientX, clientY) {
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth)  * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1
  );
  _panRaycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  return _panRaycaster.ray.intersectPlane(_panPlane, hit) ? hit : null;
}

// Mouse pan (desktop)
let _mousePanning = false, _mPanLX = 0, _mPanLY = 0;
canvas.addEventListener('mousedown', e => {
  if (_firstPersonMode || camPreviewMode) return;
  _mousePanning = true; _mPanLX = e.clientX; _mPanLY = e.clientY;
});
canvas.addEventListener('mousemove', e => {
  if (!_mousePanning) return;
  const c = _screenToFloor(e.clientX, e.clientY);
  const l = _screenToFloor(_mPanLX, _mPanLY);
  if (c && l) { _panX -= c.x - l.x; _panZ -= c.z - l.z; _freeCamMoved = true; }
  _mPanLX = e.clientX; _mPanLY = e.clientY;
});
window.addEventListener('mouseup', () => { _mousePanning = false; });

// Scroll zoom (desktop)
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (_firstPersonMode) return;
  const f = e.deltaY < 0 ? 0.88 : 1.14;
  camOffset.y = Math.max(0.5, Math.min(8,   camOffset.y * f));
  camOffset.z = Math.max(0.14,Math.min(2.2, camOffset.z * f));
}, {passive: false});

// Touch: single-finger pan + two-finger pinch zoom
let pinchDist0 = 0, pinchY0 = 0, pinchZ0 = 0, pinchActive = false;
let _tPanning = false, _tPanLX = 0, _tPanLY = 0;

canvas.addEventListener('touchstart', e => {
  if (_firstPersonMode) return;
  if (e.touches.length === 2) {
    e.preventDefault();
    _tPanning   = false;
    pinchActive = true;
    pinchDist0  = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                             e.touches[0].clientY - e.touches[1].clientY);
    pinchY0 = camOffset.y; pinchZ0 = camOffset.z;
  } else if (e.touches.length === 1 && !camPreviewMode) {
    e.preventDefault();
    _tPanning = true; pinchActive = false;
    _tPanLX = e.touches[0].clientX; _tPanLY = e.touches[0].clientY;
  }
}, {passive: false});

canvas.addEventListener('touchmove', e => {
  if (_firstPersonMode) return;
  if (pinchActive && e.touches.length === 2) {
    e.preventDefault();
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                         e.touches[0].clientY - e.touches[1].clientY);
    const s = pinchDist0 / d;
    camOffset.y = Math.max(0.5, Math.min(8,   pinchY0 * s));
    camOffset.z = Math.max(0.14,Math.min(2.2, pinchZ0 * s));
  } else if (_tPanning && e.touches.length === 1 && !camPreviewMode) {
    e.preventDefault();
    const c = _screenToFloor(e.touches[0].clientX, e.touches[0].clientY);
    const l = _screenToFloor(_tPanLX, _tPanLY);
    if (c && l) { _panX -= c.x - l.x; _panZ -= c.z - l.z; _freeCamMoved = true; }
    _tPanLX = e.touches[0].clientX; _tPanLY = e.touches[0].clientY;
  }
}, {passive: false});

canvas.addEventListener('touchend', e => {
  if (e.touches.length < 2) pinchActive = false;
  if (e.touches.length === 0) _tPanning = false;
}, {passive: true});

// ── Resize ────────────────────────────────────────────────────────────────
function onResize(){
  renderer.setSize(window.innerWidth,window.innerHeight);
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize',onResize); onResize();

// ── Render loop ───────────────────────────────────────────────────────────
let pulse=0;
function animate(){
  requestAnimationFrame(animate);
  pulse+=0.045;
  ring.material.opacity=0.4+0.2*Math.sin(pulse);
  ring.scale.setScalar(1+0.1*Math.sin(pulse*0.7));
  // Read target position written by sensors.js each step
  const _tX=window.tX, _tY=window.tY, _tZ=window.tZ;
  const distToTarget=Math.sqrt((_tX-aX)**2+(_tZ-aZ)**2);
  document.getElementById('speedFill').style.width=Math.min(distToTarget/(window.STEP_LENGTH||0.025),1)*100+'%';
  // Lerp actual position toward target
  aX+=(_tX-aX)*0.18; aY+=(_tY-aY)*0.18; aZ+=(_tZ-aZ)*0.18;
  // Export current rendered position for distance calcs in other modules
  window.aX=aX; window.aY=aY; window.aZ=aZ;
  avatarRoot.position.set(aX,aY+AVATAR_HOVER,aZ);
  // Compass heading (0=north, clockwise). Beak points +Z local.
  // Three.js rotation.y: positive = CCW from above. North = -Z.
  // To face north: rotate beak (+Z) to -Z = π. Each degree CW = +rad.
  // So: rotation.y = π + headingRad
  const _hr = window.currentHeadingRad || 0;
  tHeading = Math.PI - _hr;

  // Shortest-path lerp — normalize both angles first to avoid unbounded accumulation
  aHeading = ((aHeading % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
  tHeading = ((tHeading % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
  let dH = tHeading - aHeading;
  if (dH >  Math.PI) dH -= Math.PI*2;
  if (dH < -Math.PI) dH += Math.PI*2;
  aHeading += dH * 0.15;
  avatarRoot.rotation.y = aHeading;
  const moving = window.isMoving && distToTarget > 0.002;
  avatarMat.color.setHex(moving ? 0xFF2D55 : 0xFF6B8A); // hot pink-red moving, lighter still
  capMat.color.setHex(moving ? 0xFFFFFF : 0xFFDDDD);
  // Update labels proximity
  if(window.updateLabels) window.updateLabels(aX,aZ);
  // Update path dots
  if(window.updatePathDots) window.updatePathDots(aX,aZ);
  // Advance Tron pulse shader
  if(window.updatePathTron) window.updatePathTron(1/60);
  // Pulse selected stall glow
  if(window.updateStallGlow) window.updateStallGlow(1/60);
  // Update nav distance
  if(window.updateNavActiveDist) window.updateNavActiveDist();
  // Destination marker (during active navigation)
  if(window.destStall && window._navigating){
    destMarker.position.set(window.destStall.x, window.destStall.y+0.25, window.destStall.z);
    destMarkerMat.opacity=0.7+0.3*Math.sin(pulse*2);
    destMarker.scale.y=1+0.15*Math.sin(pulse*2.5);
  } else {
    destMarkerMat.opacity=0;
  }
  // Preview FROM marker (CSS2D)
  if(window._previewFrom){
    fromMarker.position.set(window._previewFrom.x, 0.15, window._previewFrom.z);
    fromMarker.visible = true;
    fromPin.wrap.style.opacity = '1';
  } else {
    fromMarker.visible = false;
    fromPin.wrap.style.opacity = '0';
  }
  // Preview TO marker (CSS2D)
  if(window._previewTo){
    toMarker.position.set(window._previewTo.x, 0.15, window._previewTo.z);
    toMarker.visible = true;
    toPin.wrap.style.opacity = '1';
  } else {
    toMarker.visible = false;
    toPin.wrap.style.opacity = '0';
  }
  updateCamera();
  // Render main scene (with ACES tone mapping)
  renderer.render(scene, camera);
  // Render overlay (avatar + path) — clear depth so path sits on top of floor
  renderer.autoClear = false;
  renderer.clearDepth();  // clear depth buffer only, keep color from main scene
  const prevTM = renderer.toneMapping;
  const prevEnc = renderer.outputEncoding;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputEncoding = THREE.LinearEncoding;
  renderer.render(overlayScene, camera);
  renderer.toneMapping = prevTM;
  renderer.outputEncoding = prevEnc;
  renderer.autoClear = true;
}
// ── Expose ALL shared globals on window ──────────────────────────────────
window.renderer             = renderer;
window.scene                = scene;
window.camera               = camera;
window.camOffset            = camOffset;
window.buildNavmesh         = buildNavmesh;
window.findTri              = findTri;
window.triY                 = triY;
window.constrain            = constrain;
window.placeAvatarImmediate = placeAvatarImmediate;
window.navTriangles         = navTriangles;  // initial ref; buildNavmesh repopulates this array
window._navTrianglesRef     = navTriangles;  // same ref — bootstrap.js uses this
window.resetHeading         = resetHeading;
window.avatarMat            = avatarMat;
window.capMat               = capMat;
window.ring                 = ring;
window.destMarker           = destMarker;
window.destMarkerMat        = destMarkerMat;
window.animate              = animate;       // bootstrap.js calls window.animate()
window.animateCamera        = animateCamera;
window.fromMarker           = fromMarker;
window.toMarker             = toMarker;
window.stopCamAnim = function() { camAnim = null; camPreviewMode = false; _freeCamMoved = false; };
window.setCamPreview   = function(on){ camPreviewMode = on; };
window.overlayScene         = overlayScene;  // pathfinder.js adds pathGroup here

window.enterFirstPerson = function() {
  camAnim = null;
  camPreviewMode = false;
  _firstPersonMode = true;
  window._firstPersonMode = true;
  avatarRoot.visible = false;
  _freeCamMoved = false; // so exit-FP re-centers on avatar
};

window.exitFirstPerson = function(onDone) {
  if (!_firstPersonMode) { if (onDone) onDone(); return; }
  _firstPersonMode = false;
  window._firstPersonMode = false;
  avatarRoot.visible = true;
  _panX = aX; _panZ = aZ; // re-center free cam on avatar
  animateCamera(
    { x: aX + camOffset.x, y: camOffset.y, z: aZ + camOffset.z },
    { x: aX, y: 0.02, z: aZ },
    0.8,
    () => { window.stopCamAnim(); if (onDone) onDone(); }
  );
};

// Position state
window.tX = 0; window.tY = 0; window.tZ = 0;
window.aX = 0; window.aY = 0; window.aZ = 0;

// animate() called from index.html after all scripts load
