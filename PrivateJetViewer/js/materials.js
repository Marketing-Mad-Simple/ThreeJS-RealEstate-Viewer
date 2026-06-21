/**
 * materials.js
 *
 * Owns every Three.js material mutation in the app.
 *
 * ROOT CAUSE FIX (multi-material meshes)
 * ────────────────────────────────────────
 * When a Blender object has more than one material slot, Three.js loads it
 * as node.material = MeshStandardMaterial[]  (an array, one entry per slot).
 * The old code did  node.material = MAT.body  which silently replaced the
 * whole array with a single material, dropping all other slots and causing
 * partial or missing colour changes.
 *
 * The fix is mutateInPlace():
 *   - If node.material is an array, iterate every slot and mutate each one
 *     individually (color, roughness, map, etc.) rather than replacing the ref.
 *   - If it is a single material, mutate it directly.
 *   - Never replace node.material — always mutate what's already there.
 *
 * This also fixes the secondary issue where assigning a shared MAT.body
 * instance to multiple meshes meant that setting aoMap on one mesh's material
 * would bleed through to every other mesh sharing that instance.
 *
 * STRATEGY CHANGE: no more shared MAT cache instances.
 * Instead, mutateInPlace() receives a plain "patch" object describing what
 * to change, and applies it to every material slot already on the mesh.
 * This is safer and handles both single and multi-material meshes correctly.
 */

import * as THREE from 'three';
import { getTexSet } from './textureRegistry.js';

/* ─────────────────────────────────────────────────────────────────
   CORE MUTATOR
   Applies a patch to every material slot on a mesh without ever
   replacing the node.material reference.
   
   patch = {
     color?:              number (hex)
     roughness?:         number
     metalness?:         number
     map?:               THREE.Texture | null
     roughnessMap?:      THREE.Texture | null
     normalMap?:         THREE.Texture | null
     normalScale?:       [number, number]
     aoMap?:             THREE.Texture | null   (only set if UV2 exists)
     emissive?:          number (hex)
     emissiveIntensity?: number
     envMapIntensity?:   number
   }
───────────────────────────────────────────────────────────────── */
function mutateInPlace(node, patch) {
  const mats = Array.isArray(node.material) ? node.material : [node.material];
  const hasUV2 = !!(node.geometry && node.geometry.attributes.uv2);

  mats.forEach(mat => {
    if (!mat) return;

    if (patch.color               !== undefined) mat.color.setHex(patch.color);
    if (patch.roughness           !== undefined) mat.roughness = patch.roughness;
    if (patch.metalness           !== undefined) mat.metalness = patch.metalness;
    if (patch.envMapIntensity     !== undefined) mat.envMapIntensity = patch.envMapIntensity;

    // Texture maps — explicit null clears the slot (removes old texture)
    if ('map'          in patch) mat.map          = patch.map          ?? null;
    if ('roughnessMap' in patch) mat.roughnessMap = patch.roughnessMap ?? null;
    if ('normalMap'    in patch) mat.normalMap    = patch.normalMap    ?? null;

    if (patch.normalScale) {
      if (!mat.normalScale) mat.normalScale = new THREE.Vector2(1, 1);
      mat.normalScale.set(patch.normalScale[0], patch.normalScale[1]);
    }

    // AO map requires UV2 on the geometry
    if ('aoMap' in patch) {
      mat.aoMap          = (patch.aoMap && hasUV2) ? patch.aoMap : null;
      mat.aoMapIntensity = 1.0;
    }

    // Emissive
    if (patch.emissive !== undefined) {
      if (!mat.emissive) mat.emissive = new THREE.Color();
      mat.emissive.setHex(patch.emissive);
    }
    if (patch.emissiveIntensity !== undefined) mat.emissiveIntensity = patch.emissiveIntensity;

    mat.needsUpdate = true;
  });
}

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

  // Patch for Body_ and Wing_ meshes
  const bodyPatch = {
    color:          paintOpt.color,
    roughness:      finishOpt.roughness,
    metalness:      paintOpt.metalness ?? 0.65,
    roughnessMap,
    normalMap,
    envMapIntensity: 0.85,
  };

  // Engine outer — slightly darker tint, slightly rougher
  const engColor = new THREE.Color(paintOpt.color).multiplyScalar(0.82);
  const enginePatch = {
    color:          engColor.getHex(),
    roughness:      Math.min(finishOpt.roughness + 0.1, 1.0),
    metalness:      paintOpt.metalness ?? 0.65,
    roughnessMap,
    normalMap,
    envMapIntensity: 0.85,
  };

  model.traverse(node => {
    if (!node.isMesh) return;
    const nm = node.name || '';

    if (nm.startsWith('Body_') || nm.startsWith('Wing_')) {
      mutateInPlace(node, bodyPatch);
    } else if (nm.startsWith('Engine_Outer')) {
      mutateInPlace(node, enginePatch);
    }
  });
}

/* ─────────────────────────────────────────────────────────────────
   INTERIOR
───────────────────────────────────────────────────────────────── */

/**
 * @param {THREE.Group}   model
 * @param {{ seatOpt, woodOpt, lightOpt, styleOpt }} opts
 * @param {string}        currentView
 * @param {THREE.PointLight} interiorLight
 */
export function applyInteriorConfig(model, { seatOpt, woodOpt, lightOpt, styleOpt }, currentView, interiorLight, cabinLights = []) {
  if (!model) return;

  // Style-driven multipliers
  const brightnessMult = styleOpt.id === 'sport' ? 0.80 : styleOpt.id === 'modern' ? 1.05 : 1.0;
  const normalDepth    = styleOpt.id === 'sport' ? 1.4  : styleOpt.id === 'modern' ? 0.8  : 1.0;

  // Light color driven by lightOpt; intensity is owned by switchView in scene.js
  interiorLight.color.setHex(lightOpt.color);
  cabinLights.forEach(l => l.color.setHex(lightOpt.color));

  // ── Seat patch ──
  const { map: seatMap, roughnessMap: seatRoughMap, normalMap: seatNormalMap, aoMap: seatAoMap }
    = getTexSet('seat', seatOpt.material); // 'leather' | 'fabric'

  const seatColor = new THREE.Color(seatOpt.color).multiplyScalar(brightnessMult).getHex();
  const seatPatch = {
    color:          seatColor,
    roughness:      seatOpt.roughness,
    metalness:      seatOpt.metalness ?? 0.02,
    map:            seatMap,
    roughnessMap:   seatRoughMap,
    normalMap:      seatNormalMap,
    aoMap:          seatAoMap,
    normalScale:    [normalDepth, normalDepth],
    envMapIntensity: 0.85,
  };

  // ── Trim patch ──
  const { map: trimMap, roughnessMap: trimRoughMap, normalMap: trimNormalMap }
    = getTexSet('trim', woodOpt.id);

  const trimPatch = {
    color:          woodOpt.color,
    roughness:      woodOpt.roughness,
    metalness:      woodOpt.metalness ?? 0.05,
    map:            trimMap,
    roughnessMap:   trimRoughMap,
    normalMap:      trimNormalMap,
    normalScale:    [0.8, 0.8],
    envMapIntensity: 0.85,
  };

  // ── Carpet patch ──
  const carpetHex = styleOpt.id === 'sport' ? 0x1A1A1E
    : styleOpt.id === 'modern' ? 0x2A2520 : 0x3A2E1A;
  const carpetPatch = {
    color:     carpetHex,
    roughness: 0.9,
    metalness: 0.0,
    map:       null,
    roughnessMap: null,
    normalMap: null,
  };

  // ── Light strip patch ──
  const lightPatch = {
    color:             lightOpt.color,
    emissive:          lightOpt.color,
    emissiveIntensity: 1.4,
    roughness:         1.0,
    metalness:         0.0,
  };

  // Traverse and apply
  model.traverse(node => {
    if (!node.isMesh) return;
    const nm = node.name || '';

    if      (nm.startsWith('Seat_'))                              mutateInPlace(node, seatPatch);
    else if (nm.startsWith('Trim_'))                              mutateInPlace(node, trimPatch);
    else if (nm.startsWith('Carpet_') || nm.startsWith('Floor_')) mutateInPlace(node, carpetPatch);
    else if (nm.startsWith('Light_Strip_'))                       mutateInPlace(node, lightPatch);
  });
}
