/**
 * textureRegistry.js
 *
 * Single source of truth for every texture in the project.
 *
 * HOW IT WORKS
 * ─────────────
 * TEXTURE_MANIFEST declares every texture set as a plain object.
 * loadAll() iterates the manifest, fetches each file with THREE.TextureLoader,
 * applies the correct colorSpace (sRGB for baseColor, Linear for data maps),
 * and caches the result in TEXTURES so the rest of the app can just read
 * TEXTURES.seat.leather.map etc. — no async needed at point of use.
 *
 * FALLBACK STRATEGY
 * ─────────────────
 * If a file is missing (404) the loader resolves with null.
 * Materials that receive a null map simply fall back to the solid-colour +
 * programmatic roughness path that already works without textures.
 * This means the viewer is fully functional before your artist delivers anything.
 *
 * ADDING A NEW TEXTURE SET
 * ────────────────────────
 * 1. Drop the files into the correct subfolder under /textures/.
 * 2. Add an entry to TEXTURE_MANIFEST below — that's it.
 * 3. Reference it in materials.js via TEXTURES.<category>.<name>.
 */

import * as THREE from 'three';

/* ─────────────────────────────────────────────────────────────────
   TEXTURE MANIFEST
   ─────────────────────────────────────────────────────────────────
   Structure:
     <category>: {
       <name>: {
         map:          path to baseColor  (sRGB)
         roughnessMap: path to roughness  (Linear / grayscale)
         normalMap:    path to normal     (Linear / tangent-space)
         aoMap:        path to AO         (Linear / grayscale)  [optional]
         repeat:       [u, v] tile repeat on the mesh           [optional, default 4x4]
       }
     }

   FILE NAMING CONVENTION your artist should follow:
     textures/
       seat/
         leather/
           baseColor.jpg      ← diffuse colour (shoot for neutral mid-grey/cream
                                 so tinting with material.color works cleanly)
           roughness.jpg      ← grayscale: white=rough, black=smooth
           normal.jpg         ← tangent-space normal (DirectX or OpenGL — note which)
           ao.jpg             ← ambient occlusion (optional but recommended)
         fabric/
           baseColor.jpg
           roughness.jpg
           normal.jpg
           ao.jpg
       trim/
         walnut/ …same files…
         maple/  …
         ebony/  …
         carbon/ …
       exterior/
         paint/
           roughness.jpg      ← shared roughness map for all paint options
           normal.jpg         ← subtle panel-line normal
─────────────────────────────────────────────────────────────────── */

export const TEXTURE_MANIFEST = {

  seat: {
    leather: {
      map:          './textures/seat/leather/baseColor.jpg',
      roughnessMap: './textures/seat/leather/roughness.jpg',
      normalMap:    './textures/seat/leather/normal.jpg',
      aoMap:        './textures/seat/leather/ao.jpg',
      repeat: [4, 4],
    },
    fabric: {
      map:          './textures/seat/fabric/baseColor.jpg',
      roughnessMap: './textures/seat/fabric/roughness.jpg',
      normalMap:    './textures/seat/fabric/normal.jpg',
      aoMap:        './textures/seat/fabric/ao.jpg',
      repeat: [5, 5],
    },
  },

  trim: {
    walnut: {
      map:          './textures/trim/walnut/baseColor.jpg',
      roughnessMap: './textures/trim/walnut/roughness.jpg',
      normalMap:    './textures/trim/walnut/normal.jpg',
      repeat: [2, 2],
    },
    maple: {
      map:          './textures/trim/maple/baseColor.jpg',
      roughnessMap: './textures/trim/maple/roughness.jpg',
      normalMap:    './textures/trim/maple/normal.jpg',
      repeat: [2, 2],
    },
    ebony: {
      map:          './textures/trim/ebony/baseColor.jpg',
      roughnessMap: './textures/trim/ebony/roughness.jpg',
      normalMap:    './textures/trim/ebony/normal.jpg',
      repeat: [2, 2],
    },
    carbon: {
      map:          './textures/trim/carbon/baseColor.jpg',
      roughnessMap: './textures/trim/carbon/roughness.jpg',
      normalMap:    './textures/trim/carbon/normal.jpg',
      repeat: [3, 3],
    },
  },

  exterior: {
    paint: {
      // No baseColor here — colour is 100% programmatic via material.color.
      // The roughness map adds micro-scratches / panel seam variation on top
      // of the programmatic roughness scalar.
      roughnessMap: './textures/exterior/paint/roughness.jpg',
      normalMap:    './textures/exterior/paint/normal.jpg',
      repeat: [8, 8],
    },
  },

};

/* ─────────────────────────────────────────────────────────────────
   LOADED TEXTURES CACHE  (populated by loadAll, read everywhere else)
───────────────────────────────────────────────────────────────── */
export const TEXTURES = {};   // shape mirrors TEXTURE_MANIFEST but values are THREE.Texture | null

/* ─────────────────────────────────────────────────────────────────
   LOADER HELPERS
───────────────────────────────────────────────────────────────── */
const tl = new THREE.TextureLoader();

/**
 * Load a single texture, returning null on error instead of throwing.
 * colorSpace: THREE.SRGBColorSpace for baseColor, THREE.LinearSRGBColorSpace for data maps.
 */
function loadOne(path, colorSpace, repeat = [4, 4]) {
  return new Promise(resolve => {
    tl.load(
      path,
      tex => {
        tex.colorSpace  = colorSpace;
        tex.wrapS       = THREE.RepeatWrapping;
        tex.wrapT       = THREE.RepeatWrapping;
        tex.repeat.set(repeat[0], repeat[1]);
        tex.anisotropy  = 8;   // sharpens textures at grazing angles
        resolve(tex);
      },
      undefined,        // progress — not needed here
      () => resolve(null),   // error → graceful null fallback
    );
  });
}

/**
 * loadAll()
 * Walks the manifest and populates TEXTURES.
 * Call once during app init, before applyMaterial is ever called.
 * Returns a Promise that resolves when every fetch attempt has settled.
 *
 * Progress callback: onProgress(loaded, total) — use to update your loading bar.
 */
export async function loadAll(onProgress) {
  const jobs = [];   // flat list of { category, name, slot, path, colorSpace, repeat }

  for (const [category, names] of Object.entries(TEXTURE_MANIFEST)) {
    TEXTURES[category] = TEXTURES[category] || {};
    for (const [name, slots] of Object.entries(names)) {
      TEXTURES[category][name] = TEXTURES[category][name] || {};
      const repeat = slots.repeat || [4, 4];
      for (const [slot, path] of Object.entries(slots)) {
        if (slot === 'repeat') continue;
        // baseColor / map → sRGB colour data
        // everything else (roughness, normal, ao) → linear data
        const colorSpace = (slot === 'map')
          ? THREE.SRGBColorSpace
          : THREE.LinearSRGBColorSpace;
        jobs.push({ category, name, slot, path, colorSpace, repeat });
      }
    }
  }

  let loaded = 0;
  const total = jobs.length;

  await Promise.all(jobs.map(async job => {
    const tex = await loadOne(job.path, job.colorSpace, job.repeat);
    TEXTURES[job.category][job.name][job.slot] = tex;
    loaded++;
    if (onProgress) onProgress(loaded, total);
  }));
}

/**
 * getTexSet(category, name)
 * Safe accessor — returns the loaded set or an empty object if not found.
 * Callers can do:  const { map, roughnessMap, normalMap } = getTexSet('seat','leather')
 * and each will simply be null if the file wasn't loaded.
 */
export function getTexSet(category, name) {
  return (TEXTURES[category] && TEXTURES[category][name]) || {};
}
