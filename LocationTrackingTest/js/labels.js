// ── labels.js — proximity-based CSS2D stall labels ───────────────────────
'use strict';

const LABEL_RADIUS   = 0.55; // world units — labels appear within this distance of avatar
const MAX_LABELS     = 18;   // cap to avoid DOM overload on mobile

let labelObjects = []; // { stall, div, obj (CSS2DObject) }

function initLabels(css2dRenderer){
  if(!window.STALL_DATA) return;

  window.STALL_DATA.forEach(stall => {
    // Create DOM element
    const div = document.createElement('div');
    div.className = 'stall-label';
    const idLine   = document.createElement('div');
    idLine.className = 'lbl-id';
    idLine.textContent = stall.id;
    const nameLine = document.createElement('div');
    nameLine.className = 'lbl-name';
    nameLine.textContent = stall.company || '';
    div.appendChild(idLine);
    if(stall.company && stall.company !== 'EMPTY') div.appendChild(nameLine);

    // CSS2DObject — attaches to a world position
    const obj = new THREE.CSS2DObject(div);
    obj.position.set(stall.x, stall.y + 0.12, stall.z);
    obj.visible = false;
    scene.add(obj);

    labelObjects.push({ stall, div, obj });
  });
}

function updateLabels(avatarX, avatarZ){
  // Sort by distance, show nearest MAX_LABELS
  const sorted = labelObjects
    .map(lo => {
      const dx=lo.stall.x-avatarX, dz=lo.stall.z-avatarZ;
      return { lo, dist: Math.sqrt(dx*dx+dz*dz) };
    })
    .sort((a,b)=>a.dist-b.dist);

  sorted.forEach(({lo, dist}, i) => {
    const show = dist <= LABEL_RADIUS && i < MAX_LABELS;
    lo.obj.visible = show;

    if(show){
      // Highlight if this is the destination
      if(window.destStall && lo.stall.id === window.destStall.id){
        lo.div.className = 'stall-label targeted';
      } else {
        lo.div.className = 'stall-label';
      }
    }
  });
}

// Highlight a specific stall by ID (used by search / nav)
function highlightStall(stallId){
  labelObjects.forEach(lo => {
    if(lo.stall.id === stallId){
      lo.div.className = 'stall-label highlighted';
      lo.obj.visible = true; // force visible even if far
    } else if(lo.div.className === 'stall-label highlighted'){
      lo.div.className = 'stall-label';
    }
  });
}

window.initLabels = initLabels;
window.updateLabels = updateLabels;
window.highlightStall = highlightStall;
