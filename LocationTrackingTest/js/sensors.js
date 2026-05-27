// ── sensors.js — IMU, Kalman heading, step detection, GPS ────────────────
'use strict';

// ── Tuning (exposed as globals so HUD sliders can change them) ────────────
window.STEP_LENGTH = 0.025;
window.STEP_THRESH = 1.2;
const STEP_MIN_MS  = 220;
const GPS_TRUST    = 25;
const GPS_BLEND    = 0.25;
const GPS_GAP_MS   = 4000;
const GPS_JUMP_MAX = 1.0;
const GPS_WORLD_SCALE = 0.19;

// ── Kalman heading ────────────────────────────────────────────────────────
let compassHeading=0;
let kAngle=0,kBias=0,kP00=1,kP01=0,kP10=0,kP11=1;

function kalman(newC,gyroRate,dt){
  const rate=gyroRate-kBias; kAngle+=dt*rate;
  kP00+=dt*(dt*kP11-kP01-kP10+0.001); kP01-=dt*kP11; kP10-=dt*kP11; kP11+=0.003*dt;
  let d=newC-kAngle; if(d>180)d-=360; if(d<-180)d+=360;
  const S=kP00+0.5,K0=kP00/S,K1=kP10/S;
  kAngle+=K0*d; kBias+=K1*d;
  kP00-=K0*kP00; kP01-=K0*kP01; kP10-=K1*kP00; kP11-=K1*kP01;
  kAngle=((kAngle%360)+360)%360; return kAngle;
}

// ── Step detection ────────────────────────────────────────────────────────
let magLP=9.81, stepPhase='seek_peak', stepCount=0, lastStepMs=0;
window.currentHeadingRad=0;
window.isMoving=false;
let started=false, lastMotionT=null;

function onOrientation(e){
  if(typeof e.webkitCompassHeading==='number') compassHeading=e.webkitCompassHeading;
  else if(e.alpha!=null) compassHeading=(360-e.alpha)%360;
}

function onMotion(e){
  if(!started) return;
  const now=Date.now();
  if(!lastMotionT){lastMotionT=now;return;}
  const dt=Math.min((now-lastMotionT)/1000,0.1);
  lastMotionT=now;

  const rr=e.rotationRate;
  const gyroYaw=(rr&&rr.alpha!=null)?rr.alpha:0;
  const heading=kalman(compassHeading,gyroYaw,dt);
  window.currentHeadingRad=heading*Math.PI/180;
  document.getElementById('hdg').textContent=Math.round(heading);
  document.getElementById('compass').style.transform=`rotate(${-heading}deg)`;

  const aig=e.accelerationIncludingGravity;
  if(!aig||aig.x===null) return;
  const mag=Math.sqrt(aig.x*aig.x+aig.y*aig.y+aig.z*aig.z);
  magLP=0.93*magLP+0.07*mag;
  const dev=mag-magLP;

  if(stepPhase==='seek_peak'){
    if(dev > window.STEP_THRESH && now-lastStepMs > STEP_MIN_MS){
      stepCount++;
      lastStepMs=now;
      document.getElementById('stepCount').textContent=stepCount;

      if(window.isMoving){
        // beak direction: (sin(h), -cos(h)) — matches tHeading = PI - h
        const dx= Math.sin(window.currentHeadingRad)*window.STEP_LENGTH;
        const dz=-Math.cos(window.currentHeadingRad)*window.STEP_LENGTH;
        const r=constrain(aX,aZ,aX+dx,aZ+dz);
        tX=r.x; tZ=r.z; tY=r.y;
        document.getElementById('pos').textContent=aX.toFixed(2)+', '+aZ.toFixed(2);
        // Recompute path every ~10 steps so it stays accurate as you move
        if(window.destStall && window.computePath && stepCount%10===0){
          window.computePath(window.destStall);
        }
      }
      stepPhase='seek_valley';
    }
  } else {
    if(dev < -window.STEP_THRESH*0.5) stepPhase='seek_peak';
  }
}

// ── GPS ───────────────────────────────────────────────────────────────────
let gpsEnabled=true, originLat=null, originLng=null;
let gpsWX=null, gpsWZ=null, gpsAcc=Infinity, lastGpsCorr=0;

function latLngToM(lat,lng,oLat,oLng){
  const R=6371000,dLat=(lat-oLat)*Math.PI/180,dLng=(lng-oLng)*Math.PI/180;
  const mid=((lat+oLat)/2)*Math.PI/180;
  return{x:dLng*R*Math.cos(mid)*GPS_WORLD_SCALE, z:-dLat*R*GPS_WORLD_SCALE};
}

function onGPS(pos){
  const{latitude,longitude,accuracy}=pos.coords; gpsAcc=accuracy;
  if(originLat===null){originLat=latitude;originLng=longitude;gpsWX=aX;gpsWZ=aZ;}
  else{const m=latLngToM(latitude,longitude,originLat,originLng);gpsWX=aX+m.x;gpsWZ=aZ+m.z;}
  const pill=document.getElementById('gpsPill'),lbl=document.getElementById('gpsLabel');
  if(!gpsEnabled){pill.className='pill off2';lbl.textContent='GPS: off';return;}
  pill.className=accuracy<GPS_TRUST?'pill good':'pill poor';
  lbl.textContent=`GPS ±${Math.round(accuracy)}m${accuracy<GPS_TRUST?' ✓':' (noisy)'}`;
  const now=Date.now();
  if(gpsEnabled&&accuracy<GPS_TRUST&&now-lastGpsCorr>GPS_GAP_MS){
    const dx=gpsWX-aX,dz=gpsWZ-aZ,jump=Math.hypot(dx,dz);
    if(jump<GPS_JUMP_MAX){
      const tx=aX+GPS_BLEND*dx,tz=aZ+GPS_BLEND*dz;
      const tri=findTri(tx,tz);
      if(tri){tX=tx;tZ=tz;tY=triY(tx,tz,tri.a,tri.b,tri.c);lastGpsCorr=now;}
    }
  }
}

function onGPSError(e){
  document.getElementById('gpsPill').className='pill poor';
  document.getElementById('gpsLabel').textContent=
    ({1:'GPS denied',2:'GPS unavailable',3:'GPS timeout'})[e.code]||'GPS error';
}

function startGPS(){
  if(!navigator.geolocation){document.getElementById('gpsLabel').textContent='GPS unsupported';return;}
  document.getElementById('gpsLabel').textContent='GPS: acquiring…';
  const o={enableHighAccuracy:true,maximumAge:2000,timeout:15000};
  navigator.geolocation.getCurrentPosition(
    p=>{onGPS(p);navigator.geolocation.watchPosition(onGPS,onGPSError,o);},
    e=>{onGPSError(e);navigator.geolocation.watchPosition(onGPS,onGPSError,{...o,timeout:20000});},
    {enableHighAccuracy:true,timeout:15000,maximumAge:0}
  );
}

window.toggleGPS=function(){
  gpsEnabled=!gpsEnabled;
  document.getElementById('gpsBtn').textContent='GPS: '+(gpsEnabled?'ON':'OFF');
  document.getElementById('gpsBtn').className=gpsEnabled?'btn btn-primary':'btn btn-off';
  if(!gpsEnabled){
    document.getElementById('gpsPill').className='pill off2';
    document.getElementById('gpsLabel').textContent='GPS: off';
  }
};

// ── Start / stop / reset ──────────────────────────────────────────────────
window.requestAndStart=async function(){
  document.getElementById('status').textContent='requesting…';
  try{
    if(typeof DeviceOrientationEvent?.requestPermission==='function')
      if(await DeviceOrientationEvent.requestPermission()!=='granted')
        { showErr('Orientation permission denied'); return; }
    if(typeof DeviceMotionEvent?.requestPermission==='function')
      if(await DeviceMotionEvent.requestPermission()!=='granted')
        { showErr('Motion permission denied'); return; }
    window.addEventListener('deviceorientation',onOrientation,true);
    window.addEventListener('devicemotion',onMotion,true);
    startGPS();
    started=true; kAngle=0; kBias=0; window._sensorsStarted=true;
    document.getElementById('startBtn').style.display='none';
    document.getElementById('moveBtn').style.display='';
    document.getElementById('gpsBtn').style.display='';
    document.getElementById('resetBtn').style.display='';
    document.getElementById('status').textContent='tap Walking to track';
  }catch(err){showErr('Error: '+err.message);}
};

window.toggleMove=function(){
  window.isMoving=!window.isMoving;
  if(!window.isMoving){tX=aX;tZ=aZ;tY=aY;}
  document.getElementById('moveBtn').textContent='Walking: '+(window.isMoving?'ON':'OFF');
  document.getElementById('moveBtn').className=window.isMoving?'btn btn-active':'btn btn-primary';
  document.getElementById('status').textContent=window.isMoving?'tracking steps':'stationary';
};

window.resetTracking=function(){
  window.isMoving=false; lastMotionT=null;
  stepCount=0; stepPhase='seek_peak'; magLP=9.81;
  kAngle=0;kBias=0;kP00=1;kP01=0;kP10=0;kP11=1;
  window.currentHeadingRad=0;
  if(typeof resetHeading!=="undefined") resetHeading();
  originLat=null;originLng=null;gpsWX=null;gpsWZ=null;gpsAcc=Infinity;lastGpsCorr=0;
  if(navTriangles.length){
    const candidates=[[1.86,0.009],[1.5,0.0],[2.0,0.5],[1.8,-0.5],[1.0,0.0]];
    let placed=false;
    for(const[cx,cz] of candidates){
      const tri=findTri(cx,cz);
      if(tri){placeAvatarImmediate(cx,triY(cx,cz,tri.a,tri.b,tri.c),cz);placed=true;break;}
    }
    if(!placed){
      const mid=navTriangles[Math.floor(navTriangles.length/2)];
      placeAvatarImmediate((mid.a.x+mid.b.x+mid.c.x)/3,mid.a.y,(mid.a.z+mid.b.z+mid.c.z)/3);
    }
  }
  document.getElementById('moveBtn').textContent='Walking: OFF';
  document.getElementById('moveBtn').className='btn btn-primary';
  document.getElementById('status').textContent='reset — ready';
  document.getElementById('pos').textContent='0, 0';
  document.getElementById('stepCount').textContent='0';
  document.getElementById('speedFill').style.width='0%';
  document.getElementById('gpsPill').className='pill';
  document.getElementById('gpsLabel').textContent='GPS: —';
  window.clearDestination&&window.clearDestination();
};
