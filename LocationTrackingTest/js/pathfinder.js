// ── pathfinder.js — A* on baked grid + Three.js dotted path ─────────────
'use strict';

// ── A* on NAV_GRID ────────────────────────────────────────────────────────

function isWalkable(gx, gz) {
  const g = window.NAV_GRID;
  if (gx < 0 || gz < 0 || gx >= g.COLS || gz >= g.ROWS) return false;
  return (g.data[gz][gx >> 5] & (1 << (gx & 31))) !== 0;
}

function worldToGrid(wx, wz) {
  const g = window.NAV_GRID;
  return {
    gx: Math.round((wx - g.XMIN) / g.RES),
    gz: Math.round((wz - g.ZMIN) / g.RES)
  };
}

function gridToWorld(gx, gz) {
  const g = window.NAV_GRID;
  return {
    x: g.XMIN + gx * g.RES,
    z: g.ZMIN + gz * g.RES
  };
}

// Snap world point to nearest walkable grid cell
function snapToWalkable(wx, wz) {
  const g = window.NAV_GRID;
  let { gx, gz } = worldToGrid(wx, wz);
  if (isWalkable(gx, gz)) return { gx, gz };
  // Search outward in rings
  for (let r = 1; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        if (isWalkable(gx + dx, gz + dz)) return { gx: gx + dx, gz: gz + dz };
      }
    }
  }
  return { gx, gz }; // fallback
}

// A* — returns array of world {x,z} waypoints or null
function astar(startX, startZ, goalX, goalZ) {
  const g = window.NAV_GRID;
  const s = snapToWalkable(startX, startZ);
  const e = snapToWalkable(goalX,  goalZ);

  const key = (gx, gz) => gz * g.COLS + gx;
  const heuristic = (gx, gz) => Math.sqrt((gx - e.gx) ** 2 + (gz - e.gz) ** 2);

  const open    = new Map(); // key → {gx,gz,g,f,parent}
  const closed  = new Set();
  const startNode = { gx: s.gx, gz: s.gz, g: 0, f: heuristic(s.gx, s.gz), parent: null };
  open.set(key(s.gx, s.gz), startNode);

  // 8-directional with strict corner guard
  const DIRS = [
    [0,-1,1],[0,1,1],[-1,0,1],[1,0,1],
    [-1,-1,1.414],[1,-1,1.414],[-1,1,1.414],[1,1,1.414]
  ];

  let iterations = 0;
  const MAX_ITER = 5000;

  while (open.size > 0 && iterations++ < MAX_ITER) {
    // Get node with lowest f
    let best = null;
    for (const node of open.values()) {
      if (!best || node.f < best.f) best = node;
    }

    if (best.gx === e.gx && best.gz === e.gz) {
      // Reconstruct path
      const raw = [];
      let cur = best;
      while (cur) { raw.push({ gx: cur.gx, gz: cur.gz }); cur = cur.parent; }
      raw.reverse();

      // Convert to world coords + smooth (string-pulling: remove colinear/unnecessary waypoints)
      const pts = raw.map(({ gx, gz }) => {
        const w = gridToWorld(gx, gz);
        return { x: w.x, z: w.z };
      });
      return simplifyPath(pts, startX, startZ, goalX, goalZ);
    }

    const bk = key(best.gx, best.gz);
    open.delete(bk);
    closed.add(bk);

    for (const [dx, dz, cost] of DIRS) {
      const nx = best.gx + dx, nz = best.gz + dz;
      if (!isWalkable(nx, nz)) continue;
      // Strict diagonal guard: BOTH cardinal neighbours must be walkable
      // This prevents cutting through any stall corner
      if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
        if (!isWalkable(best.gx + dx, best.gz) || !isWalkable(best.gx, best.gz + dz)) continue;
      }
      const nk = key(nx, nz);
      if (closed.has(nk)) continue;
      const ng = best.g + cost;
      const existing = open.get(nk);
      if (!existing || ng < existing.g) {
        open.set(nk, { gx: nx, gz: nz, g: ng, f: ng + heuristic(nx, nz), parent: best });
      }
    }
  }
  return null; // no path found
}

// Simplify path — remove intermediate points that are colinear within tolerance
function simplifyPath(pts, sx, sz, ex, ez) {
  if (pts.length <= 2) return [{ x:sx,z:sz },{ x:ex,z:ez }];
  const result = [{ x:sx, z:sz }];
  let i = 0;
  while (i < pts.length - 1) {
    let furthest = i + 1;
    for (let j = i + 2; j < pts.length; j++) {
      if (lineClearWide(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) furthest = j;
      else break;
    }
    result.push({ x: pts[furthest].x, z: pts[furthest].z });
    i = furthest;
  }
  result[result.length-1] = { x:ex, z:ez };
  return result;
}

// Width-aware line check — tests centre + both edges of the path ribbon
// so the rendered ribbon never clips stall geometry
function lineClearWide(x0, z0, x1, z1) {
  const dx = x1-x0, dz = z1-z0;
  const len = Math.sqrt(dx*dx+dz*dz) || 1;
  // Perpendicular direction (normalized)
  const px = -dz/len, pz = dx/len;
  const HALF = PATH_WIDTH * 0.55; // slightly wider than visual ribbon
  // Check 3 parallel lines: left edge, centre, right edge
  const offsets = [0, -HALF, HALF];
  for (const off of offsets) {
    const ox = px*off, oz = pz*off;
    const steps = Math.ceil(Math.max(Math.abs(dx),Math.abs(dz)) / window.NAV_GRID.RES * 2.5);
    for (let i=0; i<=steps; i++) {
      const t = i/steps;
      const { gx, gz } = worldToGrid(x0+dx*t+ox, z0+dz*t+oz);
      if (!isWalkable(gx, gz)) return false;
    }
  }
  return true;
}

// ── Three.js dotted path visuals ──────────────────────────────────────────

// ── Solid line path (Google Maps style) ──────────────────────────────────
// Uses a flat ribbon of thin quads along the path — solid, no dots.
const PATH_Y         = 0.012; // just above floor, depth tested against stalls
const PATH_COLOR     = 0x1A73E8; // Google Maps blue
const PATH_BORDER_COLOR = 0x0D47A1; // darker navy border
const PATH_WIDTH     = 0.055;    // world units wide

let pathMesh      = null;    // single merged mesh for the path line
let pathGroup     = new THREE.Group();
let pathWaypoints = [];
let pathProgress  = 0;
let fpMat         = null;    // ShaderMaterial for the Tron FP strip

// pathGroup goes in main scene so it respects stall depth (hidden behind walls)
// polygonOffset prevents z-fighting with floor
if(window.scene) window.scene.add(pathGroup);
else window.addEventListener('load', ()=>window.scene&&window.scene.add(pathGroup));

// Build a flat ribbon mesh from an array of {x,z} waypoints
function buildPathLine(waypoints) {
  pathGroup.clear();
  pathMesh = null;
  if (!waypoints || waypoints.length < 2) return;

  const verts  = [];
  const uvs    = [];
  const indices = [];
  const HALF   = PATH_WIDTH / 2;

  let totalLen = 0;
  const segLens = [];
  for (let i = 1; i < waypoints.length; i++) {
    const dx = waypoints[i].x - waypoints[i-1].x;
    const dz = waypoints[i].z - waypoints[i-1].z;
    const l  = Math.sqrt(dx*dx + dz*dz);
    segLens.push(l);
    totalLen += l;
  }

  let cumLen = 0;
  for (let i = 0; i < waypoints.length; i++) {
    const px = waypoints[i].x, pz = waypoints[i].z;

    // Compute normal perpendicular to path direction at this point
    let nx = 0, nz = 1;
    if (i === 0) {
      const dx = waypoints[1].x - px, dz = waypoints[1].z - pz;
      const l = Math.sqrt(dx*dx+dz*dz)||1;
      nx = -dz/l; nz = dx/l;
    } else if (i === waypoints.length-1) {
      const dx = px - waypoints[i-1].x, dz = pz - waypoints[i-1].z;
      const l = Math.sqrt(dx*dx+dz*dz)||1;
      nx = -dz/l; nz = dx/l;
    } else {
      // Average of prev and next segment normals
      const dx0=px-waypoints[i-1].x, dz0=pz-waypoints[i-1].z;
      const dx1=waypoints[i+1].x-px, dz1=waypoints[i+1].z-pz;
      const l0=Math.sqrt(dx0*dx0+dz0*dz0)||1;
      const l1=Math.sqrt(dx1*dx1+dz1*dz1)||1;
      nx = (-dz0/l0 - dz1/l1)*0.5;
      nz = (dx0/l0  + dx1/l1)*0.5;
      const nl = Math.sqrt(nx*nx+nz*nz)||1;
      nx/=nl; nz/=nl;
    }

    const u = cumLen / (totalLen||1);
    // Left vertex
    verts.push(px - nx*HALF, PATH_Y, pz - nz*HALF);
    uvs.push(0, u);
    // Right vertex
    verts.push(px + nx*HALF, PATH_Y, pz + nz*HALF);
    uvs.push(1, u);

    if (i > 0) cumLen += segLens[i-1];

    if (i < waypoints.length - 1) {
      const base = i * 2;
      indices.push(base, base+1, base+2, base+1, base+3, base+2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,   2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    color: PATH_COLOR,
    side: THREE.DoubleSide,
    depthWrite: true,
    transparent: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  pathMesh = new THREE.Mesh(geo, mat);
  pathMesh.userData.isNavPath = true;
  pathGroup.add(pathMesh);

  // White border line slightly wider for contrast (like Google Maps outline)
  const borderMat = new THREE.MeshBasicMaterial({
    color: PATH_BORDER_COLOR,
    side: THREE.DoubleSide,
    depthWrite: true,
    transparent: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const borderVerts = [];
  const BHALF = PATH_WIDTH / 2 + 0.008;
  for (let i = 0; i < waypoints.length; i++) {
    const px = waypoints[i].x, pz = waypoints[i].z;
    let nx=0, nz=1;
    if (i===0){const dx=waypoints[1].x-px,dz=waypoints[1].z-pz,l=Math.sqrt(dx*dx+dz*dz)||1;nx=-dz/l;nz=dx/l;}
    else if (i===waypoints.length-1){const dx=px-waypoints[i-1].x,dz=pz-waypoints[i-1].z,l=Math.sqrt(dx*dx+dz*dz)||1;nx=-dz/l;nz=dx/l;}
    else{const dx0=px-waypoints[i-1].x,dz0=pz-waypoints[i-1].z,dx1=waypoints[i+1].x-px,dz1=waypoints[i+1].z-pz,l0=Math.sqrt(dx0*dx0+dz0*dz0)||1,l1=Math.sqrt(dx1*dx1+dz1*dz1)||1;nx=(-dz0/l0-dz1/l1)*0.5;nz=(dx0/l0+dx1/l1)*0.5;const nl=Math.sqrt(nx*nx+nz*nz)||1;nx/=nl;nz/=nl;}
    borderVerts.push(px-nx*BHALF,PATH_Y-0.002,pz-nz*BHALF, px+nx*BHALF,PATH_Y-0.002,pz+nz*BHALF);
  }
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute('position', new THREE.Float32BufferAttribute(borderVerts,3));
  bGeo.setIndex(indices.slice()); // reuse same index pattern
  bGeo.computeVertexNormals();
  const borderMesh = new THREE.Mesh(bGeo, borderMat);
  borderMesh.userData.isNavPath = true;
  pathGroup.add(borderMesh);

  // First-person Tron strip — vertical ribbon with animated pulse
  const FP_Y_BOT = 0.04, FP_Y_TOP = 0.07;
  const fpVerts = [], fpUvs = [];

  // Compute per-waypoint U (0→1 along path length)
  let fpTotal = 0;
  const fpSegs = [];
  for (let i = 1; i < waypoints.length; i++) {
    const dx = waypoints[i].x - waypoints[i-1].x;
    const dz = waypoints[i].z - waypoints[i-1].z;
    const l = Math.sqrt(dx*dx + dz*dz);
    fpSegs.push(l); fpTotal += l;
  }
  let fpCum = 0;
  for (let i = 0; i < waypoints.length; i++) {
    const px = waypoints[i].x, pz = waypoints[i].z;
    const u = fpCum / (fpTotal || 1);
    fpVerts.push(px, FP_Y_BOT, pz); fpUvs.push(u, 0);
    fpVerts.push(px, FP_Y_TOP, pz); fpUvs.push(u, 1);
    if (i < waypoints.length - 1) fpCum += fpSegs[i];
  }

  const fpGeo = new THREE.BufferGeometry();
  fpGeo.setAttribute('position', new THREE.Float32BufferAttribute(fpVerts, 3));
  fpGeo.setAttribute('uv',       new THREE.Float32BufferAttribute(fpUvs,   2));
  fpGeo.setIndex(indices.slice());
  fpGeo.computeVertexNormals();

  fpMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0.0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      varying vec2 vUv;
      void main() {
        // vUv.x = 0 (start) → 1 (destination) along path
        // vUv.y = 0 (bottom) → 1 (top) of strip
        vec3 tronCyan = vec3(0.0, 0.82, 1.0);

        // Comet pulse: sharp leading edge, exponential trailing glow
        float pPos  = mod(time * 0.55, 1.3) - 0.15;
        float trail = vUv.x - pPos;
        float pulse = trail < 0.0 ? exp(trail * 18.0) : 0.0;

        // Top and bottom rails — the always-visible Tron lines
        float edgeB = smoothstep(0.35, 0.0, vUv.y);
        float edgeT = smoothstep(0.65, 1.0, vUv.y);
        float edge  = max(edgeB, edgeT);

        // Soft inner fill
        float fill = pow(1.0 - abs(vUv.y - 0.5) * 2.0, 2.0) * 0.15;

        // Base alpha: visible rails
        float alpha = edge * 0.5 + fill;
        // Pulse: brightens rails + creates inner glow cone
        alpha += pulse * (edge * 1.25 + fill * 5.0);
        alpha  = clamp(alpha, 0.0, 1.0);

        // Color shifts toward white-teal at pulse peak
        vec3 color = tronCyan + pulse * vec3(0.4, 0.6, 0.4);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });

  const fpMesh = new THREE.Mesh(fpGeo, fpMat);
  fpMesh.userData.isNavPath = true;
  pathGroup.add(fpMesh);
}

function updatePathDots(avatarX, avatarZ) {
  // Trim the path behind the avatar — hide segments already passed
  if (!pathMesh) return;
  // Path stays fully visible (trimming is complex with merged mesh)
  // Slight alpha fade so it looks natural
}

function clearPath() {
  pathGroup.clear();
  pathMesh = null;
  fpMat = null;
  pathWaypoints = [];
  pathProgress = 0;
}

// ── Public API ────────────────────────────────────────────────────────────

window.computePath = function(destStall) {
  if (!window.NAV_GRID) return;
  clearPath();
  const waypoints = astar(window.aX, window.aZ, destStall.x, destStall.z);
  if (waypoints) {
    pathWaypoints = waypoints;
    buildPathLine(waypoints);
  } else {
    console.warn('No path found to', destStall.id);
  }
};

window.clearPath = clearPath;
window.updatePathDots = updatePathDots;
window.updatePathTron = function(dt) { if (fpMat) fpMat.uniforms.time.value += dt; };
