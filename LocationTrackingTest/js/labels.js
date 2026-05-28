// ── labels.js — frustum-culled, fade-by-distance CSS2D stall labels ───────
'use strict';

// ── Tuning ────────────────────────────────────────────────────────────────
const LABEL_SHOW_DIST   = 2.2;   // world units — start fading out beyond this
const LABEL_HIDE_DIST   = 3.2;   // world units — fully invisible beyond this
const LABEL_NEAR_DIST   = 0.4;   // world units — full opacity within this
const MAX_VISIBLE       = 40;    // hard cap for DOM performance on mobile
const FRUSTUM_MARGIN    = 0.05;  // clip-space margin (0=edge, negative=some outside)

let labelObjects = [];           // { stall, div, obj, opacity }

// Reusable frustum + projected vector
const frustum   = new THREE.Frustum();
const clipMatrix = new THREE.Matrix4();
const worldPos  = new THREE.Vector3();

function initLabels() {
  if (!window.STALL_DATA) return;

  window.STALL_DATA.forEach(stall => {
    const div = document.createElement('div');
    div.className = 'stall-label';
    div.style.opacity = '0';
    div.style.transition = 'opacity 0.25s ease';
    div.style.pointerEvents = 'none';

    const idLine = document.createElement('div');
    idLine.className = 'lbl-id';
    idLine.textContent = stall.id;
    div.appendChild(idLine);

    if (stall.company && stall.company.trim() !== '' &&
        stall.company.trim().toUpperCase() !== 'EMPTY') {
      const nameLine = document.createElement('div');
      nameLine.className = 'lbl-name';
      nameLine.textContent = stall.company.trim();
      div.appendChild(nameLine);
    }

    const obj = new THREE.CSS2DObject(div);
    obj.position.set(stall.x, stall.y + 0.10, stall.z);
    obj.visible = false; // start hidden
    window.scene.add(obj);

    labelObjects.push({ stall, div, obj, opacity: 0 });
  });
}

function updateLabels(avatarX, avatarZ) {
  // Rebuild frustum from current camera
  clipMatrix.multiplyMatrices(window.camera.projectionMatrix, window.camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(clipMatrix);

  // During route preview, use a much wider label distance
  const inPreview = !!(window._previewFrom || window._previewTo);
  const showDist  = inPreview ? 99 : LABEL_SHOW_DIST;
  const hideDist  = inPreview ? 99 : LABEL_HIDE_DIST;

  // Score each label: distance + in-frustum
  const scored = labelObjects.map(lo => {
    const dx = lo.stall.x - avatarX;
    const dz = lo.stall.z - avatarZ;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Quick frustum check
    worldPos.set(lo.stall.x, lo.stall.y + 0.10, lo.stall.z);
    const inFrustum = frustum.containsPoint(worldPos);

    return { lo, dist, inFrustum };
  });

  // Sort by distance so we can enforce MAX_VISIBLE cap on closest ones
  scored.sort((a, b) => a.dist - b.dist);

  let visibleCount = 0;

  scored.forEach(({ lo, dist, inFrustum }) => {
    const isDestination = window.destStall && lo.stall.id === window.destStall.id;
    const isHighlighted = lo.div.classList.contains('highlighted');

    // Always show destination label regardless of distance/frustum
    if (isDestination) {
      lo.obj.visible = true;
      lo.div.style.opacity = '1';
      lo.div.className = 'stall-label targeted';
      visibleCount++;
      return;
    }

    // Compute target opacity
    let targetOpacity = 0;

    if (inFrustum && (visibleCount < MAX_VISIBLE || isHighlighted)) {
      if (dist <= LABEL_NEAR_DIST) {
        targetOpacity = 1;
      } else if (dist <= showDist) {
        targetOpacity = 1;
      } else if (dist <= hideDist) {
        targetOpacity = 1 - (dist - showDist) / (hideDist - showDist);
      }

      if (targetOpacity > 0.01) visibleCount++;
    }

    // Force-show highlighted stalls
    if (isHighlighted) targetOpacity = 1;

    // Apply — only touch DOM if value changed meaningfully
    const opacityChanged = Math.abs((lo.opacity || 0) - targetOpacity) > 0.02;
    if (opacityChanged) {
      lo.opacity = targetOpacity;
      if (targetOpacity < 0.01) {
        // Hide via visibility to save CSS2D render cost
        lo.obj.visible = false;
        lo.div.style.opacity = '0';
      } else {
        lo.obj.visible = true;
        lo.div.style.opacity = String(targetOpacity.toFixed(2));
      }
    }

    // Keep class fresh
    if (lo.obj.visible && !isHighlighted) {
      lo.div.className = 'stall-label';
    }
  });
}

function highlightStall(stallId) {
  labelObjects.forEach(lo => {
    if (lo.stall.id === stallId) {
      lo.div.classList.add('highlighted');
      lo.div.className = 'stall-label highlighted';
      lo.obj.visible = true;
      lo.div.style.opacity = '1';
      lo.opacity = 1;
    } else {
      lo.div.classList.remove('highlighted');
      if (lo.div.className === 'stall-label highlighted') {
        lo.div.className = 'stall-label';
      }
    }
  });
}

window.initLabels  = initLabels;
window.updateLabels = updateLabels;
window.highlightStall = highlightStall;
