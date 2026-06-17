/**
 * materials.js
 *
 * Owns every THREE.js material mutation in the app.
 *
 * PUBLIC API
 * ──────────
 *   applyExteriorConfig(model, paintOpt, finishOpt)
 *   applyInteriorConfig(model, opts, currentView, interiorLight)
 *
 * HOW TEXTURE + PROGRAMMATIC VALUES INTERACT
 * ──────────────────────────────────────────
 *   map          → Three multiplies material.color × texture pixel.
 *                  If map is null, material.color is the sole colour source.
 *
 *   roughnessMap → Three multiplies material.roughness × texture pixel (0–1).
 *                  Set material.roughness = 1.0 to use the map as-is,
 *                  or lower it to darken (less rough) the whole surface.
 *                  We deliberately keep material.roughness as a scalar
 *                  so the Finish selector still does something meaningful
 *                  even when a roughness map is present.
 *
 *   normalMap    → material.normalScale controls depth (Vector2, default 1,1).
 *                  We expose normalScale per material type so the style
 *                  selector can dial it up/down (sport = more pronounced).
 *
 *   aoMap        → requires a second UV set (UV2) on the mesh. If your GLB
 *                  doesn't have UV2 we skip aoMap silently.
 */

import * as THREE from 'three';
import { getTexSet } from './textureRegistry.js';

/* ─────────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────────── */

/**
 * Assign texture slots to a material, skipping nulls gracefully.
 * Clears slots that have become null (e.g. switching from textured
 * to a type that has no texture yet) so old textures don't linger.
 */
function assignTextures(mat, { map = null, roughnessMap = null, normalMap = null, aoMap = null } = {}) {
  mat.map          = map          ?? null;
  mat.roughnessMap = roughnessMap ?? null;
  mat.normalMap    = normalMap    ?? null;

  // aoMap only works if the mesh has UV2 — check on the geometry side.
  // We set it here; applyToMesh() will guard the geometry check.
  mat._pendingAoMap = aoMap ?? null;

  mat.needsUpdate  = true;
}

/**
 * Apply the material to a specific mesh, handling the UV2 / aoMap guard.
 */
function applyToMesh(mesh, mat) {
  mesh.material = mat;

  // AO maps require a second UV channel. Only assign if geometry has it.
  if (mat._pendingAoMap && mesh.geometry.attributes.uv2) {
    mat.aoMap          = mat._pendingAoMap;
    mat.aoMapIntensity = 1.0;
  } else {
    mat.aoMap = null;
  }

  mat.envMapIntensity = 0.85;
  mat.needsUpdate     = true;
}

/* ─────────────────────────────────────────────────────────────────
   MATERIAL CACHE
   We create ONE MeshStandardMaterial per logical surface type and
   mutate it on every config change — cheaper than creating new ones.
───────────────────────────────────────────────────────────────── */
const MAT = {
  body:      new THREE.MeshStandardMaterial({ name: 'body'      }),
  engineOuter: new THREE.MeshStandardMaterial({ name: 'engineOuter' }),
  seat:      new THREE.MeshStandardMaterial({ name: 'seat'      }),
  trim:      new THREE.MeshStandardMaterial({ name: 'trim'      }),
  carpet:    new THREE.MeshStandardMaterial({ name: 'carpet'    }),
  // Light strips are emissive — kept separate
  lightStrip: new THREE.MeshStandardMaterial({ name: 'lightStrip', roughness: 1, metalness: 0 }),
};

/* ─────────────────────────────────────────────────────────────────
   EXTERIOR
───────────────────────────────────────────────────────────────── */

/**
 * @param {THREE.Group}  model
 * @param {{ color: number, metalness: number }} paintOpt
 * @param {{ roughness: number }}               finishOpt
 */
export function applyExteriorConfig(model, paintOpt, finishOpt) {
  if (!model) return;

  const { roughnessMap, normalMap } = getTexSet('exterior', 'paint');

  // ── Body + Wings ──
  MAT.body.color.setHex(paintOpt.color);
  MAT.body.roughness  = finishOpt.roughness;          // scalar scales the map
  MAT.body.metalness  = paintOpt.metalness ?? 0.65;
  assignTextures(MAT.body, { roughnessMap, normalMap });
  // No baseColor map — colour is 100% programmatic so all paint options
  // look correct without needing per-colour textures.

  // ── Engine outer — slightly darker + a touch more rough ──
  const engColor = new THREE.Color(paintOpt.color).multiplyScalar(0.82);
  MAT.engineOuter.color.copy(engColor);
  MAT.engineOuter.roughness = Math.min(finishOpt.roughness + 0.1, 1.0);
  MAT.engineOuter.metalness = paintOpt.metalness ?? 0.65;
  assignTextures(MAT.engineOuter, { roughnessMap, normalMap });

  model.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const nm = node.name || '';
    if (nm.startsWith('Body_') || nm.startsWith('Wing_')) applyToMesh(node, MAT.body);
    if (nm.startsWith('Engine_Outer'))                    applyToMesh(node, MAT.engineOuter);
  });
}

/* ─────────────────────────────────────────────────────────────────
   INTERIOR
───────────────────────────────────────────────────────────────── */

/**
 * @param {THREE.Group}  model
 * @param {{ seatOpt, woodOpt, lightOpt, styleOpt }} opts  — all resolved option objects
 * @param {string}       currentView  — 'interior' | 'exterior'
 * @param {THREE.PointLight} interiorLight
 */
export function applyInteriorConfig(model, { seatOpt, woodOpt, lightOpt, styleOpt }, currentView, interiorLight) {
  if (!model) return;

  // ── Style multipliers ──
  const brightnessMult = styleOpt.id === 'sport' ? 0.80 : styleOpt.id === 'modern' ? 1.05 : 1.0;
  const normalDepth    = styleOpt.id === 'sport' ? 1.4  : styleOpt.id === 'modern' ? 0.8  : 1.0;

  // ── Cabin lighting ──
  interiorLight.color.setHex(lightOpt.color);
  interiorLight.intensity = currentView === 'interior' ? 2.5 : 0;

  // ────────────── SEAT ──────────────
  // Determine which texture set to use based on material type
  const seatTexKey = seatOpt.material; // 'leather' | 'fabric'
  const { map: seatMap, roughnessMap: seatRoughMap, normalMap: seatNormalMap, aoMap: seatAoMap }
    = getTexSet('seat', seatTexKey);

  const seatColor = new THREE.Color(seatOpt.color).multiplyScalar(brightnessMult);
  MAT.seat.color.copy(seatColor);

  // roughness: use opt value as the scalar multiplier on top of the map
  MAT.seat.roughness    = seatOpt.roughness;
  MAT.seat.metalness    = seatOpt.metalness ?? 0.02;
  MAT.seat.normalScale  = MAT.seat.normalScale ?? new THREE.Vector2(1, 1);
  MAT.seat.normalScale.set(normalDepth, normalDepth);

  assignTextures(MAT.seat, {
    map:          seatMap,
    roughnessMap: seatRoughMap,
    normalMap:    seatNormalMap,
    aoMap:        seatAoMap,
  });

  // ────────────── TRIM (wood / carbon) ──────────────
  const { map: trimMap, roughnessMap: trimRoughMap, normalMap: trimNormalMap }
    = getTexSet('trim', woodOpt.id);

  MAT.trim.color.setHex(woodOpt.color);
  MAT.trim.roughness   = woodOpt.roughness;
  MAT.trim.metalness   = woodOpt.metalness ?? 0.05;
  MAT.trim.normalScale = MAT.trim.normalScale ?? new THREE.Vector2(1, 1);
  MAT.trim.normalScale.set(0.8, 0.8);   // wood trim normal is subtle

  assignTextures(MAT.trim, {
    map:          trimMap,
    roughnessMap: trimRoughMap,
    normalMap:    trimNormalMap,
  });

  // ────────────── CARPET ──────────────
  const carpetHex = styleOpt.id === 'sport' ? 0x1A1A1E
    : styleOpt.id === 'modern' ? 0x2A2520 : 0x3A2E1A;
  MAT.carpet.color.setHex(carpetHex);
  MAT.carpet.roughness = 0.9;
  MAT.carpet.metalness = 0.0;
  assignTextures(MAT.carpet);  // no textures yet — clears any old ones

  // ────────────── LIGHT STRIPS ──────────────
  MAT.lightStrip.color.setHex(lightOpt.color);
  MAT.lightStrip.emissive    = MAT.lightStrip.emissive ?? new THREE.Color();
  MAT.lightStrip.emissive.setHex(lightOpt.color);
  MAT.lightStrip.emissiveIntensity = 1.4;

  // ── Traverse and assign ──
  model.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const nm = node.name || '';
    if      (nm.startsWith('Seat_'))        applyToMesh(node, MAT.seat);
    else if (nm.startsWith('Trim_'))        applyToMesh(node, MAT.trim);
    else if (nm.startsWith('Carpet_') || nm.startsWith('Floor_')) applyToMesh(node, MAT.carpet);
    else if (nm.startsWith('Light_Strip_')) applyToMesh(node, MAT.lightStrip);
  });
}
