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

   FILE LAYOUT (artist-delivered sets under textures/):
     Seat/1/   Seat_Fabric_Base_color.jpg · Normal.jpg · Normal_OpenGL.jpg · Roughness.jpg
     Seat/2/   (same files — second fabric variant)
     Trim/1/   Wood__Base_color.jpg · Normal.jpg · Roughness.jpg
     Trim/2/   (same files — second wood variant)
     Floor/1/  Floor_Base_color.jpg · Normal.jpg · Roughness.jpg
     Floor/2/  (same files — second floor variant)
     Metal/1/  Body_Metal_Base_color.jpg · Roughness.jpg
     Metal/2/  (same files — second metal variant)
     Plastic/1/ Body_Plastic_Base_color.jpg · Normal.jpg · Roughness.jpg
     Plastic/2/ (same files — second plastic variant)
─────────────────────────────────────────────────────────────────── */

export const TEXTURE_MANIFEST = {

  seat: {
    leather_1: {
      map:          './textures/Seat/1/Seat_Fabric_Base_color.jpg',
      roughnessMap: './textures/Seat/1/Seat_Fabric_Roughness.jpg',
      normalMap:    './textures/Seat/1/Seat_Fabric_Normal.jpg',
      repeat: [1, 1],
    },
    leather_2: {
      map:          './textures/Seat/2/Seat_Fabric_Base_color.jpg',
      roughnessMap: './textures/Seat/2/Seat_Fabric_Roughness.jpg',
      normalMap:    './textures/Seat/2/Seat_Fabric_Normal.jpg',
      repeat: [1, 1],
    },
  },

  trim: {
    trim_1: {
      map:          './textures/Trim/1/Wood__Base_color.jpg',
      roughnessMap: './textures/Trim/1/Wood__Roughness.jpg',
      normalMap:    './textures/Trim/1/Wood__Normal.jpg',
      repeat: [1, 1],
    },
    trim_2: {
      map:          './textures/Trim/2/Wood__Base_color.jpg',
      roughnessMap: './textures/Trim/2/Wood__Roughness.jpg',
      normalMap:    './textures/Trim/2/Wood__Normal.jpg',
      repeat: [1, 1],
    },
  },

  floor: {
    floor_1: {
      map:          './textures/Floor/1/Floor_Base_color.jpg',
      roughnessMap: './textures/Floor/1/Floor_Roughness.jpg',
      normalMap:    './textures/Floor/1/Floor_Normal.jpg',
      repeat: [1, 1],
    },
    floor_2: {
      map:          './textures/Floor/2/Floor_Base_color.jpg',
      roughnessMap: './textures/Floor/2/Floor_Roughness.jpg',
      normalMap:    './textures/Floor/2/Floor_Normal.jpg',
      repeat: [1, 1],
    },
  },

  metal: {
    metal_1: {
      map:          './textures/Metal/1/Body_Metal_Base_color.jpg',
      roughnessMap: './textures/Metal/1/Body_Metal_Roughness.jpg',
      repeat: [1, 1],
    },
    metal_2: {
      map:          './textures/Metal/2/Body_Metal_Base_color.jpg',
      roughnessMap: './textures/Metal/2/Body_Metal_Roughness.jpg',
      repeat: [1, 1],
    },
  },

  plastic: {
    plastic_1: {
      map:          './textures/Plastic/1/Body_Plastic_Base_color.jpg',
      roughnessMap: './textures/Plastic/1/Body_Plastic_Roughness.jpg',
      normalMap:    './textures/Plastic/1/Body_Plastic_Normal.jpg',
      repeat: [1, 1],
    },
    plastic_2: {
      map:          './textures/Plastic/2/Body_Plastic_Base_color.jpg',
      roughnessMap: './textures/Plastic/2/Body_Plastic_Roughness.jpg',
      normalMap:    './textures/Plastic/2/Body_Plastic_Normal.jpg',
      repeat: [1, 1],
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
        tex.colorSpace = colorSpace;
        tex.flipY      = false; // match GLTFLoader convention — Y=0 at top
        tex.anisotropy = 8;

        const isBaked = repeat[0] === 1 && repeat[1] === 1;
        if (isBaked) {
          // Baked Substance Painter textures: UV islands fill [0,1] exactly.
          // RepeatWrapping lets bilinear filtering bleed past the 1.0 edge and
          // wrap to the opposite side (a different UV island) → dark seam patches.
          // ClampToEdgeWrapping pins the filter at the last texel instead.
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
        } else {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(repeat[0], repeat[1]);
        }

        resolve(tex);
      },
      undefined,
      () => resolve(null),
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
