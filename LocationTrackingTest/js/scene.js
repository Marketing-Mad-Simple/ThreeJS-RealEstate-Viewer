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

const camera = new THREE.PerspectiveCamera(60, 1, 0.005, 100);
let camFollowing = true;
const camOffset  = new THREE.Vector3(0, 2.2, 0.6);

// ── Lighting ──────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xfff5e0, 0.9));
const sun = new THREE.DirectionalLight(0xffe8c0, 0.8);
sun.position.set(20, 40, 20); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -60;
sun.shadow.camera.right = sun.shadow.camera.top   =  60;
sun.shadow.camera.far   = 300;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(0, 10, 0); scene.add(fill);
const fill2 = new THREE.DirectionalLight(0xaaccff, 0.3);
fill2.position.set(-8, 6, -8); scene.add(fill2);

// ── Avatar ────────────────────────────────────────────────────────────────
const BODY_R = 0.028, BODY_H = 0.065, AVATAR_HOVER = 0.04;

const avatarRoot = new THREE.Object3D();
scene.add(avatarRoot);

const avatarMat = new THREE.MeshStandardMaterial({
  color:0x1D9E75, emissive:0x0d3d2a, roughness:0.35, metalness:0.15
});
const capMat = new THREE.MeshStandardMaterial({
  color:0x17c485, emissive:0x082e1e, roughness:0.3, metalness:0.1
});
const body = new THREE.Mesh(new THREE.CylinderGeometry(BODY_R,BODY_R,BODY_H,24), avatarMat);
body.castShadow = true; avatarRoot.add(body);
const capT = new THREE.Mesh(new THREE.SphereGeometry(BODY_R,24,12), capMat);
capT.position.y = BODY_H/2; avatarRoot.add(capT);
const capB = new THREE.Mesh(new THREE.SphereGeometry(BODY_R,24,12), capMat);
capB.position.y = -BODY_H/2; avatarRoot.add(capB);

// Beak (forward indicator)
const beakMat = new THREE.MeshStandardMaterial({color:0xffffff,emissive:0x888888,side:THREE.DoubleSide});
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
const ringMat = new THREE.MeshBasicMaterial({color:0x1D9E75,side:THREE.DoubleSide,transparent:true,opacity:0.6});
const ring = new THREE.Mesh(new THREE.RingGeometry(BODY_R*1.3, BODY_R*2.2, 40), ringMat);
ring.rotation.x=-Math.PI/2; ring.position.y=-BODY_H/2+0.005; avatarRoot.add(ring);

// Ground arrow
const arrowGndMat = new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide,transparent:true,opacity:0.9});
const agGeo = new THREE.BufferGeometry();
agGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
   0,0,BODY_R*3.5, -BODY_R*0.8,0,BODY_R*1.2, BODY_R*0.8,0,BODY_R*1.2
]),3));
agGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0,2,1]),1));
agGeo.computeVertexNormals();
const arrowGnd = new THREE.Mesh(agGeo, arrowGndMat);
arrowGnd.rotation.x=-Math.PI/2; arrowGnd.position.y=-BODY_H/2+0.006; avatarRoot.add(arrowGnd);

// Destination marker (shown when navigating)
const destMarkerMat = new THREE.MeshBasicMaterial({color:0x1D9E75,transparent:true,opacity:0.0});
const destMarker = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,0.15,16), destMarkerMat);
destMarker.position.y = 0.08;
scene.add(destMarker);

// ── Avatar world position ─────────────────────────────────────────────────
let aX=0, aY=0, aZ=0;
let tX=0, tY=0, tZ=0;
let aHeading=Math.PI, tHeading=Math.PI;

function placeAvatarImmediate(x,y,z){
  aX=x; aY=y; aZ=z; tX=x; tY=y; tZ=z;
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
function recenterCamera(){camFollowing=true; document.getElementById('recenterBtn').style.opacity='0.5';}
function updateCamera(){
  if(!camFollowing)return;
  camTarget.set(aX,aY,aZ);
  camera.position.lerp(new THREE.Vector3(aX+camOffset.x,aY+camOffset.y,aZ+camOffset.z),0.12);
  camera.lookAt(camTarget);
}

// Scroll zoom
canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  const f=e.deltaY<0?0.88:1.14;
  camOffset.y=Math.max(0.5,Math.min(8,camOffset.y*f));
  camOffset.z=Math.max(0.14,Math.min(2.2,camOffset.z*f));
},{passive:false});

// Pinch zoom
let pinchDist0=0,pinchY0=0,pinchZ0=0,pinchActive=false;
canvas.addEventListener('touchstart',e=>{
  if(e.touches.length===2){
    e.preventDefault();
    pinchActive=true;
    pinchDist0=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    pinchY0=camOffset.y; pinchZ0=camOffset.z;
  }
},{passive:false});
canvas.addEventListener('touchmove',e=>{
  if(pinchActive&&e.touches.length===2){
    e.preventDefault();
    const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    const s=pinchDist0/d;
    camOffset.y=Math.max(0.5,Math.min(8,pinchY0*s));
    camOffset.z=Math.max(0.14,Math.min(2.2,pinchZ0*s));
  }
},{passive:false});
canvas.addEventListener('touchend',()=>{if(event.touches.length<2)pinchActive=false;},{passive:true});

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
  const distToTarget=Math.sqrt((tX-aX)**2+(tZ-aZ)**2);
  document.getElementById('speedFill').style.width=Math.min(distToTarget/(window.STEP_LENGTH||0.025),1)*100+'%';
  aX+=(tX-aX)*0.18; aY+=(tY-aY)*0.18; aZ+=(tZ-aZ)*0.18;
  avatarRoot.position.set(aX,aY+AVATAR_HOVER,aZ);
  let dH=tHeading-aHeading;
  if(dH>Math.PI)dH-=Math.PI*2; if(dH<-Math.PI)dH+=Math.PI*2;
  aHeading+=dH*0.15;
  avatarRoot.rotation.y=aHeading;
  const _hr = window.currentHeadingRad||0; tHeading=Math.PI-_hr;
  const moving=window.isMoving&&distToTarget>0.002;
  avatarMat.color.setHex(moving?0x1D9E75:0x378ADD);
  avatarMat.emissive.setHex(moving?0x0d3d2a:0x0a1830);
  capMat.color.setHex(moving?0x17c485:0x4a9edd);
  // Update labels proximity
  if(window.updateLabels) window.updateLabels(aX,aZ);
  // Update destination marker
  if(window.destStall){
    destMarker.position.set(window.destStall.x, window.destStall.y+0.05, window.destStall.z);
    destMarkerMat.opacity=0.5+0.3*Math.sin(pulse*1.5);
    destMarker.scale.y=1+0.3*Math.sin(pulse*2);
  } else {
    destMarkerMat.opacity=0;
  }
  updateCamera();
  renderer.render(scene,camera);
}
// animate() called from index.html after all scripts load
