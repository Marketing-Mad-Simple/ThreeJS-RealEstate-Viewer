// ── bootstrap.js — runs last, after scene.js has set window.renderer etc ──
'use strict';

// ── CSS2D renderer for stall labels ──────────────────────────────────────
const css2d = new THREE.CSS2DRenderer();
css2d.setSize(window.innerWidth, window.innerHeight);
css2d.domElement.style.cssText =
  'position:fixed;top:0;left:0;pointer-events:none;z-index:10';
document.body.appendChild(css2d.domElement);
window.addEventListener('resize', () =>
  css2d.setSize(window.innerWidth, window.innerHeight));

// Patch the Three.js render call to also render CSS2D labels each frame
// window.renderer is set by scene.js before this file loads
const _orig = window.renderer.render.bind(window.renderer);
window.renderer.render = function(s, c) { _orig(s, c); css2d.render(s, c); };

// Init CSS2D label objects (labels.js)
window.initLabels();

// ── Load GLB ──────────────────────────────────────────────────────────────
function setLoad(p, m) {
  document.getElementById('loadFill').style.width = p + '%';
  document.getElementById('loadMsg').textContent  = m;
}

new THREE.GLTFLoader().load(
  'models/site.glb',
  (gltf) => {
    setLoad(90, 'Building navmesh…');

    gltf.scene.traverse(obj => {
      if (!obj.isMesh) return;
      obj.castShadow = false;  // disable shadows for clean flat look
      obj.receiveShadow = false;
      if (obj.name === 'NAV_MESH') { obj.visible = false; return; }

      // Smooth shading — recompute normals so edges blend instead of facet
      if (obj.geometry) {
        obj.geometry.computeVertexNormals();
      }
      // Apply smooth shading to all materials on this mesh
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => {
        if (m) { m.flatShading = false; m.needsUpdate = true; }
      });

      // Remap the floor's baked lightmap texture to cover the mesh exactly once.
      // Only applies to the Floor mesh — all other meshes are left untouched.
      if (obj.name === 'Floor') {
        const uvAttr = obj.geometry.attributes.uv;
        const mats2  = Array.isArray(obj.material) ? obj.material : [obj.material];
        if (uvAttr) {
          const arr = uvAttr.array;
          let minU = arr[0], maxU = arr[0], minV = arr[1], maxV = arr[1];
          for (let i = 2; i < arr.length; i += 2) {
            const u = arr[i], v = arr[i + 1];
            if (u < minU) minU = u; else if (u > maxU) maxU = u;
            if (v < minV) minV = v; else if (v > maxV) maxV = v;
          }
          const rU = maxU - minU || 1;
          const rV = maxV - minV || 1;
          mats2.forEach(m => {
            if (!m || !m.map) return;
            m.map.wrapS   = m.map.wrapT = THREE.ClampToEdgeWrapping;
            // 90° CCW rotation swaps U↔V axes — repeat/offset derived from
            // opposite ranges so aspect ratio stays correct after rotation.
            m.map.rotation = Math.PI / 2;
            m.map.center.set(0.5, 0.5);
            m.map.repeat.set(1 / rV, 1 / rU);
            m.map.offset.set((0.5 - minV) / rV - 0.5, (maxU - 0.5) / rU - 0.5);
            m.map.needsUpdate = true;
            m.needsUpdate = true;
          });
        }
      }
    });

    window.scene.add(gltf.scene);

    gltf.scene.traverse(obj => {
      if (!obj.isMesh || obj.name !== 'NAV_MESH') return;
      obj.updateWorldMatrix(true, false);
      window.buildNavmesh(obj);

      document.getElementById('navmeshLabel').textContent =
        `Navmesh: ${window.navTriangles.length} tris`;
      document.getElementById('navmeshPill')
        .querySelector('.dot').style.background = '#1D9E75';

      // Place avatar at first walkable aisle position
      const candidates = [
        [1.86, 0.009], [1.5, 0.0], [2.0, 0.5], [1.8, -0.5], [1.0, 0.0]
      ];
      for (const [cx, cz] of candidates) {
        const tri = window.findTri(cx, cz);
        if (tri) {
          window.placeAvatarImmediate(
            cx, window.triY(cx, cz, tri.a, tri.b, tri.c), cz);
          break;
        }
      }
    });

    setLoad(100, 'Ready!');
    setTimeout(() => {
      document.getElementById('loading').style.display = 'none';

      // iOS Safari requires DeviceOrientation/Motion permission to come from
      // a direct user gesture — show a prompt screen so the tap triggers it.
      // Android and desktop don't need this, so start sensors immediately.
      const needsGesture =
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function';

      if (needsGesture) {
        document.getElementById('permPrompt').style.display = 'flex';
      } else {
        // Android / desktop — start immediately
        window.requestAndStart();
      }
    }, 400);
  },
  xhr => {
    if (xhr.total)
      setLoad(
        Math.round(xhr.loaded / xhr.total * 85),
        `Loading… ${(xhr.loaded / 1024 / 1024).toFixed(1)} MB`
      );
  },
  err => {
    document.getElementById('loading').style.display = 'none';
    window.showErr(
      'Could not load models/site.glb — place it in the models/ folder. ' +
      err.message);
  }
);

// ── Start render loop ─────────────────────────────────────────────────────
// animate() is defined in scene.js and exposed on window
window.animate();
