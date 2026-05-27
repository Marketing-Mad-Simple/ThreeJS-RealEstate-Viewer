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

  const DIRS = [
    [-1,0,1],[1,0,1],[0,-1,1],[0,1,1],
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
      // Diagonal: both cardinal neighbors must be walkable (prevents corner-cutting)
      if (cost > 1 && (!isWalkable(best.gx + dx, best.gz) || !isWalkable(best.gx, best.gz + dz))) continue;
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
  if (pts.length <= 2) return pts;
  const result = [{ x: sx, z: sz }]; // use exact start
  let i = 0;
  while (i < pts.length - 1) {
    let furthest = i + 1;
    for (let j = i + 2; j < pts.length; j++) {
      // Check if we can go directly from pts[i] to pts[j] staying on navmesh
      if (lineClear(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) furthest = j;
      else break;
    }
    result.push(pts[furthest]);
    i = furthest;
  }
  result[result.length - 1] = { x: ex, z: ez }; // exact end
  return result;
}

// Check if a line segment stays on the walkable grid
function lineClear(x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const steps = Math.max(Math.abs(dx), Math.abs(dz)) / window.NAV_GRID.RES * 1.5;
  const n = Math.ceil(steps);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const { gx, gz } = worldToGrid(x0 + dx * t, z0 + dz * t);
    if (!isWalkable(gx, gz)) return false;
  }
  return true;
}

// ── Three.js dotted path visuals ──────────────────────────────────────────

const PATH_DOT_SPACING = 0.10; // metres between dots along path
const PATH_DOT_R       = 0.018;
const PATH_Y           = 0.025; // float above floor
const PATH_COLOR_WALK  = 0x1D9E75;
const PATH_COLOR_DONE  = 0x1D9E75;
const PATH_PULSE_SPEED = 1.8;

let pathDots      = [];   // Three.js meshes
let pathGroup     = new THREE.Group();
let pathWaypoints = [];   // [{x,z}] full smoothed path
let pathProgress  = 0;    // index of next waypoint to reach
let pathPulse     = 0;

window.scene.add(pathGroup);

const dotGeo = new THREE.CircleGeometry(PATH_DOT_R, 8);
dotGeo.rotateX(-Math.PI / 2);

function buildPathDots(waypoints) {
  // Clear existing
  pathGroup.clear();
  pathDots = [];

  if (!waypoints || waypoints.length < 2) return;

  // Expand waypoints into evenly spaced dots along the polyline
  const dotPositions = [];
  let distAccum = 0;
  let nextDotAt  = PATH_DOT_SPACING * 0.5; // first dot offset

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    if (segLen < 0.001) continue;
    const ux = (b.x - a.x) / segLen, uz = (b.z - a.z) / segLen;
    let d = nextDotAt - distAccum;
    while (d <= segLen) {
      dotPositions.push({ x: a.x + ux * d, z: a.z + uz * d });
      d += PATH_DOT_SPACING;
    }
    distAccum += segLen;
    nextDotAt = distAccum + (d - segLen); // carry over
  }

  // Create dot meshes
  dotPositions.forEach((p, idx) => {
    const mat = new THREE.MeshBasicMaterial({
      color: PATH_COLOR_WALK, transparent: true, opacity: 0.85
    });
    const mesh = new THREE.Mesh(dotGeo, mat);
    mesh.position.set(p.x, PATH_Y, p.z);
    mesh.userData.idx = idx;
    mesh.userData.totalDots = dotPositions.length;
    pathGroup.add(mesh);
    pathDots.push(mesh);
  });
}

function updatePathDots(avatarX, avatarZ) {
  if (!pathDots.length) return;
  pathPulse += 0.05;

  pathDots.forEach((dot, i) => {
    const dx = dot.position.x - avatarX;
    const dz = dot.position.z - avatarZ;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Dots behind avatar (within 0.12 units) become invisible
    if (dist < 0.12) {
      dot.material.opacity = 0;
      return;
    }

    // Animate: dots pulse and fade based on distance from avatar
    // Closest dots are brightest, distant ones are fainter
    const normalizedDist = Math.min(dist / 2.5, 1);
    const baseFade = 1 - normalizedDist * 0.6;

    // Travelling wave effect along path (dots further along "pulse" later)
    const wave = Math.sin(pathPulse * PATH_PULSE_SPEED - i * 0.4) * 0.2;
    dot.material.opacity = Math.max(0.1, Math.min(1, baseFade + wave));

    // Scale down distant dots
    const s = 0.6 + 0.4 * (1 - normalizedDist);
    dot.scale.setScalar(s);
  });
}

function clearPath() {
  pathGroup.clear();
  pathDots = [];
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
    buildPathDots(waypoints);
  } else {
    console.warn('No path found to', destStall.id);
  }
};

window.clearPath = clearPath;
window.updatePathDots = updatePathDots;
