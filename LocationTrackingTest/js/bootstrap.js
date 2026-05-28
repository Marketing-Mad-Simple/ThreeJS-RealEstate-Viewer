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
      document.getElementById('status').textContent    = 'tap Start tracking';
    }, 300);
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
