/**
 * scene.js
 *
 * APPROACH: Single scene, no bloom pass on the sky.
 * The sun glow is drawn entirely inside the sky fragment shader using
 * smooth power functions — this gives a physically plausible atmospheric
 * glow without any post-processing. Only a vignette+grade ShaderPass runs
 * at the end, which is safe because it never amplifies anything above 1.
 *
 * PUBLIC API
 *   initScene() / loadModels(cb) / switchView(view) / resetCamera()
 *   getModels() / getInteriorLight() / getCurrentView()
 */

import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }     from 'three/addons/loaders/DRACOLoader.js';
import { EffectComposer }    from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }        from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass }        from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass }   from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment }   from 'three/addons/environments/RoomEnvironment.js';

/* ─────────────────────────────────────────────────────────────────
   CAMERA PRESETS
───────────────────────────────────────────────────────────────── */
export const CAM_PRESETS = {
  exterior: {
    position: new THREE.Vector3(8, 3, 14),
    target:   new THREE.Vector3(0, 0.5, 0),
  },
  interior: {
    position: new THREE.Vector3(0, 1.2, 4),
    target:   new THREE.Vector3(0, 1.0, 0),
  },
};

/* ─────────────────────────────────────────────────────────────────
   SUN CONTROL  — single source of truth for sun direction
   
   Everything that needs to know where the sun is (the sky shader's
   glow, the directional shadow-casting light, and the lens flare's
   screen-space projection) derives from this one object. Change the
   values here and call updateSunDirection() to apply — no need to
   touch the sky shader, lighting, or flare code separately.
   
   HOW TO THINK ABOUT THE ANGLES (clock-position framing):
     The default exterior camera looks at the aircraft from roughly
     its front-right, with the nose pointing toward the camera/+Z side.
     Using a clock face centered on the aircraft as seen in that default
     view:
       clockHours = 12   →  sun directly in front of the aircraft (toward camera)
       clockHours = 3    →  sun off the right side
       clockHours = 6    →  sun directly behind the aircraft (tail side)
       clockHours = 9    →  sun off the left side
     elevationDeg = how high the sun sits above the horizon (0 = on the
     horizon, 90 = straight overhead). Golden-hour looks best in the
     5–20° range; midday in the 50–80° range.
   
   EXAMPLE — to put the sun at the aircraft's 10–11 o'clock as requested:
     clockHours: 10.5, elevationDeg: 12
───────────────────────────────────────────────────────────────── */
export const SUN_CONTROL = {
  clockHours:   10.5,  // 0–12, clock position relative to the aircraft's nose (see above)
  elevationDeg: 12,    // 0–90, height above the horizon
};

/**
 * Converts SUN_CONTROL's clock-position + elevation into a normalized
 * THREE.Vector3 direction. Clock 12 maps to +Z (toward the default camera,
 * roughly the aircraft's nose side), going clockwise when viewed from above
 * — clock 3 is +X, clock 6 is -Z, clock 9 is -X — matching the intuitive
 * "12 o'clock is in front of you" framing.
 */
function _sunDirFromClock(clockHours, elevationDeg) {
  // Clock → azimuth: 12 o'clock = 0°, clockwise positive (clock 3 = 90°, etc.)
  const azimuthRad   = (clockHours / 12) * Math.PI * 2;
  const elevationRad = THREE.MathUtils.degToRad(elevationDeg);

  const horizDist = Math.cos(elevationRad);
  const x = Math.sin(azimuthRad) * horizDist;   // clock 3 → +X
  const z = Math.cos(azimuthRad) * horizDist;   // clock 12 → +Z
  const y = Math.sin(elevationRad);

  return new THREE.Vector3(x, y, z).normalize();
}

/* ─────────────────────────────────────────────────────────────────
   SINGLETONS
───────────────────────────────────────────────────────────────── */
let renderer, scene, camera, controls, composer;
let flarePassRef, _gradePass;
let sunWorldPos; // THREE.Vector3 — kept in sync with sky shader's uSunDir
let interiorLight, sunLight, hemisphereLight, fillLight, bounceLight;
const _cabinLights  = [];
const _windowLights = []; // kept separate — always daylight-cool, not recoloured by lighting option
const _cookieSpots      = []; // SpotLights with octagon cookie texture — project window patches onto floor
const _stripGlowMeshes  = []; // additive shader quads beside strip lights — no actual lights
let runwayGroup;
let _groundLevelY = 0;
let skyDomeMat, skyDomeMesh; // kept so updateSunDirection() and switchView() can reference them
let currentView = 'exterior';
let isAnimating  = false;
const models = { exterior: null, interior: null };

// Materials that have height-fog injected, so we can update the fog colour
// uniform if the sky palette ever changes (e.g. different time-of-day presets)
const _heightFogMaterials = [];

// Shared horizon colour — matches what the sky shader actually renders
// at the horizon LINE (where dir.y ≈ 0, i.e. h ≈ 0.5 in the sky shader),
// since that's the band the runway visually meets at typical camera angles.
// At h=0.5 the sky shader is fully in COL_MID (0.80,0.85,0.92) blended
// ~33% toward COL_ZENITH (0.42,0.58,0.82) — a cool pale blue, NOT the
// warm golden-horizon tone used lower in the sky (h<0.2).
// Kept as a single source of truth so runway fog and sky never drift
// out of sync if the palette changes later.
const HORIZON_FOG_COLOR = new THREE.Color(0.70, 0.78, 0.88);

/* ─────────────────────────────────────────────────────────────────
   HEIGHT FOG (via onBeforeCompile shader injection)
   
   THREE.FogExp2 is distance-only — it fades based on distance from the
   camera regardless of height, which doesn't hide a flat horizon line
   well (the runway end is roughly the same distance as the sky behind
   it, so distance fog alone barely touches it).
   
   True height fog fades based on world-space Y (or, here, distance
   along the ground combined with a height falloff) — exactly what's
   needed to dissolve a runway into haze before the hard edge is visible.
   
   applyHeightFog(material) patches the material's shader to blend the
   final colour toward a fog colour based on world-space distance AND
   the camera's view angle toward the horizon, mimicking real atmospheric
   haze that thickens toward the horizon.
───────────────────────────────────────────────────────────────── */
function applyHeightFog(material) {
  // Disable Three's built-in distance fog on this material — we inject our
  // own custom height fog below, and Three's <fog_pars_vertex>/<fog_pars_fragment>
  // chunks declare 'vFogDepth' / 'fogFactor', which previously collided with
  // identically-named variables in our custom injection and broke shader
  // compilation entirely (causing the whole runway to vanish).
  material.fog = false;

  material.onBeforeCompile = (shader) => {
    // uHFogDensity is calibrated so the fog stays nearly invisible within
    // ~40 units of the camera (where the aircraft and immediate runway
    // sit) and only becomes prominent past ~100 units, fully obscuring
    // the runway's hard edge by ~250 units. uHFogStart pushes the onset
    // distance out so close-range geometry isn't affected at all.
    shader.uniforms.uHFogColor         = { value: HORIZON_FOG_COLOR.clone() };
    shader.uniforms.uHFogDensity       = { value: 0.006 };
    shader.uniforms.uHFogStart         = { value: 35.0 };
    shader.uniforms.uHFogHeightFalloff = { value: 0.15 };
    shader.uniforms.uHFogCameraPos     = { value: camera.position };

    // Use uniquely-prefixed varying/variable names ('vHFogWorldPos',
    // 'hFogFactor') so there is zero chance of colliding with any
    // Three.js built-in shader chunk, now or in future Three versions.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vHFogWorldPos;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
       vHFogWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       uniform vec3  uHFogColor;
       uniform float uHFogDensity;
       uniform float uHFogStart;
       uniform float uHFogHeightFalloff;
       uniform vec3  uHFogCameraPos;
       varying vec3  vHFogWorldPos;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       // Height-based exponential fog: thicker near ground level (y≈0),
       // thins out with height, and intensifies with horizontal distance
       // BEYOND uHFogStart — close-range geometry (e.g. the aircraft and
       // the runway directly beneath/around it) stays completely clear.
       float hFogDistXZ    = length(vHFogWorldPos.xz - uHFogCameraPos.xz);
       float hFogEffDist   = max(hFogDistXZ - uHFogStart, 0.0);
       float hFogHeightAtt = exp(-max(vHFogWorldPos.y, 0.0) * uHFogHeightFalloff);
       float hFogFactor    = 1.0 - exp(-uHFogDensity * hFogEffDist * hFogHeightAtt);
       hFogFactor = clamp(hFogFactor, 0.0, 1.0);
       gl_FragColor.rgb = mix(gl_FragColor.rgb, uHFogColor, hFogFactor);`
    );

    material.userData.fogShader = shader;
  };
  material.needsUpdate = true;
  _heightFogMaterials.push(material);
}

/**
 * Walks every mesh in a loaded object (e.g. the artist's scene.glb) and
 * applies height fog to each unique material found. Materials can be
 * shared across multiple meshes in a GLB, so a Set is used to avoid
 * patching the same material twice.
 */
function _applyHeightFogToObject(object) {
  const seen = new Set();
  object.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(mat => {
      if (seen.has(mat)) return;
      seen.add(mat);
      applyHeightFog(mat);
    });
  });
}

/**
 * Flattens reflectivity on every material in an object tree (e.g. an
 * artist-supplied scene.glb). Many DCC export pipelines bake in a default
 * metalness/specular value that looks fine in the original renderer but
 * reads as an unwanted hard chrome highlight under this scene's strong
 * directional sun light. This forces every material to a matte, fully
 * dielectric (non-metal) finish — appropriate for concrete, asphalt,
 * fencing, and architectural surfaces — while leaving glass/emissive
 * materials alone if you exclude them via the skip predicate.
 *
 * @param {THREE.Object3D} object
 * @param {(mat: THREE.Material) => boolean} [skip] - return true to leave a material untouched
 */
function _flattenReflectivity(object, skip = () => false) {
  const seen = new Set();
  object.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(mat => {
      if (seen.has(mat) || skip(mat)) return;
      seen.add(mat);
      if ('metalness' in mat)  mat.metalness  = 0.0;
      if ('roughness' in mat)  mat.roughness  = 0.78;  // was 0.92 — less flat, buildings pick up directionality
      if ('envMapIntensity' in mat) mat.envMapIntensity = 0.60; // was 0.35 — more IBL so lit surfaces read brighter
      // Clear any baked specular/reflectivity extension values from the GLB export
      if ('specularIntensity' in mat) mat.specularIntensity = 0.05;
      if ('clearcoat' in mat)  mat.clearcoat  = 0.0;
      mat.needsUpdate = true;
    });
  });
}

function _enforceInteriorCulling(object) {
  const seen = new Set();
  object.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(mat => {
      if (seen.has(mat)) return;
      seen.add(mat);
      mat.side = THREE.FrontSide;
      mat.needsUpdate = true;
    });
  });
}

const gltfLoader  = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/');
gltfLoader.setDRACOLoader(dracoLoader);

/* ─────────────────────────────────────────────────────────────────
   SKY DOME — golden-hour shader with built-in sun glow
   The glow is computed analytically in the shader, not via bloom.
   Layers of glow:
     • Wide atmospheric scatter  pow(cosAngle, 4) — wide orange-amber wash
     • Medium corona             pow(cosAngle, 12) — tighter creamy ring
     • Sharp disc                step near uSunSize — tiny bright circle
───────────────────────────────────────────────────────────────── */
const SKY_VERT = `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp  = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_FRAG = `
  uniform vec3  uSunDir;
  uniform float uSunSize;
  varying vec3  vWorldPos;

  void main() {
    vec3  dir = normalize(vWorldPos);
    float h   = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

    // ── Base sky gradient (golden hour) ──────────────────────────
    // Ground scatter: warm sandy
    vec3 sky = mix(vec3(0.72, 0.66, 0.52), vec3(1.00, 0.72, 0.28), smoothstep(0.00, 0.06, h));
    // Orange → golden horizon
    sky = mix(sky,  vec3(0.98, 0.88, 0.68), smoothstep(0.04, 0.18, h));
    // Golden → hazy white-blue mid
    sky = mix(sky,  vec3(0.80, 0.85, 0.92), smoothstep(0.15, 0.40, h));
    // Pale blue → deeper zenith blue
    sky = mix(sky,  vec3(0.42, 0.58, 0.82), smoothstep(0.32, 0.85, h));

    // ── Sun glow layers (all in shader, no bloom pass needed) ────
    vec3  sunN     = normalize(uSunDir);
    float cosA     = dot(dir, sunN);
    float cosAPos  = max(cosA, 0.0);

    // Wide atmospheric scatter glow — large warm wash around sun direction
    float scatter  = pow(cosAPos, 6.0) * 0.28;  // tighter + dimmer
    sky += vec3(1.00, 0.82, 0.48) * scatter;

    // Medium corona — tighter creamy ring
    float corona   = pow(cosAPos, 22.0) * 0.45;  // tighter, less intense
    sky += vec3(1.00, 0.94, 0.78) * corona;

    // Near horizon warm column under the sun (atmospheric perspective)
    float horizBand = smoothstep(0.00, 0.18, h) * (1.0 - smoothstep(0.08, 0.32, h));
    float sunCol    = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z)),
                                  normalize(vec3(sunN.x, 0.0, sunN.z))), 0.0), 5.0);
    sky += vec3(1.00, 0.72, 0.28) * horizBand * sunCol * 0.35;

    // Sharp sun disc
    float disc = smoothstep(uSunSize - 0.002, uSunSize + 0.001, cosA);
    sky += vec3(1.00, 0.97, 0.88) * disc * 0.8;

    // Clamp to prevent runaway values going into tone-mapper
    sky = min(sky, vec3(2.0));

    gl_FragColor = vec4(sky, 1.0);
  }
`;

function _buildSkyDome() {
  const geo = new THREE.SphereGeometry(400, 48, 24);
  const mat = new THREE.ShaderMaterial({
    vertexShader:   SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uSunDir:  { value: _sunDirFromClock(SUN_CONTROL.clockHours, SUN_CONTROL.elevationDeg) },
      uSunSize: { value: 0.9990 },
    },
    side:       THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = 'skyDome';
  scene.add(dome);
  skyDomeMat  = mat;
  skyDomeMesh = dome;

  // Place the sun very far away along uSunDir, for screen-space projection
  // in the flare pass. Distance just needs to exceed the camera's far plane
  // logic — we use 700 (inside the 800 far clip) so it projects correctly.
  sunWorldPos = mat.uniforms.uSunDir.value.clone().multiplyScalar(700);
}

/* ─────────────────────────────────────────────────────────────────
   RUNWAY
───────────────────────────────────────────────────────────────── */
function _buildRunway() {
  runwayGroup = new THREE.Group();
  runwayGroup.name = 'runway';

  const tarmacMat = new THREE.MeshStandardMaterial({ color: 0x5A5648, roughness: 0.90, metalness: 0.03 });
  applyHeightFog(tarmacMat);
  const slab = new THREE.Mesh(new THREE.PlaneGeometry(80, 300), tarmacMat);
  slab.rotation.x = -Math.PI / 2; slab.receiveShadow = true;
  runwayGroup.add(slab);

  const apronMat = new THREE.MeshStandardMaterial({ color: 0x484840, roughness: 0.96 });
  applyHeightFog(apronMat);
  [-45, 45].forEach(x => {
    const a = new THREE.Mesh(new THREE.PlaneGeometry(12, 300), apronMat);
    a.rotation.x = -Math.PI / 2; a.position.set(x, -0.002, 0); a.receiveShadow = true;
    runwayGroup.add(a);
  });

  const jointMat = new THREE.MeshStandardMaterial({ color: 0x252520, roughness: 0.98 });
  applyHeightFog(jointMat);
  for (let z = -140; z <= 140; z += 14) {
    const j = new THREE.Mesh(new THREE.PlaneGeometry(80, 0.18), jointMat);
    j.rotation.x = -Math.PI / 2; j.position.set(0, 0.001, z);
    runwayGroup.add(j);
  }

  const dashMat = new THREE.MeshStandardMaterial({ color: 0xE0DCCC, roughness: 0.85 });
  applyHeightFog(dashMat);
  for (let z = -145; z <= 145; z += 12) {
    const d = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 6), dashMat);
    d.rotation.x = -Math.PI / 2; d.position.set(0, 0.002, z);
    runwayGroup.add(d);
  }

  // Edge lights — very dim, won't trigger any bloom
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xFFE4A0, emissive: new THREE.Color(0xFFE4A0), emissiveIntensity: 0.3, roughness: 1,
  });
  for (let z = -140; z <= 140; z += 10) {
    [-38, 38].forEach(x => {
      const el = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.18), lightMat);
      el.position.set(x, 0.03, z); runwayGroup.add(el);
    });
  }

  const threshMat = new THREE.MeshStandardMaterial({ color: 0xF0EDE0, roughness: 0.82 });
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    const b = new THREE.Mesh(new THREE.PlaneGeometry(3, 18), threshMat);
    b.rotation.x = -Math.PI / 2; b.position.set(i * 6.5, 0.002, -55);
    runwayGroup.add(b);
  }

  const termMat = new THREE.MeshStandardMaterial({ color: 0x1A1C22, roughness: 1 });
  applyHeightFog(termMat);
  const term = new THREE.Mesh(new THREE.BoxGeometry(90, 8, 4), termMat);
  term.position.set(0, 4, -155); runwayGroup.add(term);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(4, 22, 4), termMat);
  tower.position.set(38, 11, -155); runwayGroup.add(tower);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(7, 3, 7),
    new THREE.MeshStandardMaterial({ color: 0x2A3040, roughness: 0.3, metalness: 0.3 }));
  cab.position.set(38, 23.5, -155); runwayGroup.add(cab);

  const winMat = new THREE.MeshStandardMaterial({ color: 0x8899AA, roughness: 0.1, metalness: 0.5 });
  for (let i = -4; i <= 4; i++) {
    const w1 = new THREE.Mesh(new THREE.BoxGeometry(7, 1.8, 0.2), winMat);
    w1.position.set(i * 10, 3.5, -153.1); runwayGroup.add(w1);
    const w2 = new THREE.Mesh(new THREE.BoxGeometry(7, 1.4, 0.2), winMat);
    w2.position.set(i * 10, 6.0, -153.1); runwayGroup.add(w2);
  }

  scene.add(runwayGroup);
}

/* ─────────────────────────────────────────────────────────────────
   SUN LENS FLARE — anchored to the sun's actual screen position
   
   Unlike a screen-space streak (which indiscriminately catches any
   bright pixel, including the white aircraft body), this flare is
   driven by projecting the sun's 3D world position into 2D screen
   space every frame. The shader only draws flare elements along the
   line from that point through screen-center, and fades out entirely
   when the sun is behind the camera or off-screen.
   
   uSunScreenPos — xy = screen-space sun position (0..1), z = visibility
                   (0 = hidden/behind camera, 1 = fully visible)
───────────────────────────────────────────────────────────────── */
const FLARE_SHADER = {
  uniforms: {
    tDiffuse:      { value: null },
    uSunScreenPos: { value: new THREE.Vector3(0.5, 0.5, 0) }, // x, y, visibility
    uAspect:       { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3  uSunScreenPos; // x, y, visibility
    uniform float uAspect;
    varying vec2  vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float vis = uSunScreenPos.z;

      if (vis > 0.001) {
        vec2 sunPos = uSunScreenPos.xy;

        // Aspect-correct distance so the flare elements are circular, not stretched
        vec2 toPixel = vUv - sunPos;
        toPixel.x *= uAspect;
        float dist = length(toPixel);

        vec3 flare = vec3(0.0);

        // 1) Soft core glow around the sun position
        float core = exp(-dist * dist * 90.0) * 0.9;
        flare += vec3(1.0, 0.92, 0.75) * core;

        // 2) Wider warm halo
        float halo = exp(-dist * dist * 14.0) * 0.35;
        flare += vec3(1.0, 0.65, 0.35) * halo;

        // 3) Anamorphic horizontal streak through the sun position only
        //    (fades vertically so it's a thin horizontal line, not a blob)
        float vertFalloff = exp(-toPixel.y * toPixel.y * 800.0);
        float horizFalloff = exp(-toPixel.x * toPixel.x * 2.0);
        float streak = vertFalloff * horizFalloff * 0.8;
        flare += vec3(1.0, 0.35, 0.2) * streak;

        // 4) A few small secondary glints along the line from sun → screen center
        vec2 toCenter = vec2(0.5) - sunPos;
        for (int i = 1; i <= 3; i++) {
          float t = float(i) * 0.32;
          vec2 ghostPos = sunPos + toCenter * t;
          vec2 d = vUv - ghostPos;
          d.x *= uAspect;
          float gd = length(d);
          float ghost = exp(-gd * gd * 400.0) * 0.18 / float(i);
          flare += vec3(1.0, 0.55, 0.3) * ghost;
        }

        flare *= vis;
        base.rgb += flare;
      }

      gl_FragColor = base;
    }
  `,
};

/* ─────────────────────────────────────────────────────────────────
   POST-PROCESSING — S-curve grade + vignette + bloom
───────────────────────────────────────────────────────────────── */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse:  { value: null },
    uVigStr:   { value: 0.35 },
    uVigRad:   { value: 0.78 },
    // S-curve controls: lift (shadow floor), gamma (midtone pivot), gain (highlight ceiling)
    uLift:     { value: new THREE.Vector3(0.02,  0.015, 0.010) }, // warm shadow lift
    uGamma:    { value: new THREE.Vector3(0.97,  0.97,  1.00)  }, // slightly cool gamma
    uGain:     { value: new THREE.Vector3(1.00,  0.98,  0.95)  }, // warm highlight
    uContrast: { value: 1.12 }, // midtone contrast multiplier
    uSaturation: { value: 1.08 }, // slight saturation boost
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVigStr;
    uniform float uVigRad;
    uniform vec3  uLift;
    uniform vec3  uGamma;
    uniform vec3  uGain;
    uniform float uContrast;
    uniform float uSaturation;
    varying vec2 vUv;

    // ASC-CDL colour grade: (col * gain + lift) ^ (1/gamma)
    vec3 cdl(vec3 c) {
      c = c * uGain + uLift;
      c = pow(max(c, vec3(0.0)), vec3(1.0) / uGamma);
      return c;
    }

    // Smooth S-curve contrast around 0.5 (operates in display space)
    float sCurve(float x) {
      x = clamp(x, 0.0, 1.0);
      return x * x * (3.0 - 2.0 * x); // smoothstep — gentle S
    }
    vec3 sCurve3(vec3 c) {
      // Blend between linear and S-curved by uContrast weight
      vec3 curved = vec3(sCurve(c.r), sCurve(c.g), sCurve(c.b));
      return mix(c, curved, uContrast - 1.0);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);

      // 1. CDL grade (lift / gamma / gain)
      col.rgb = cdl(col.rgb);

      // 2. S-curve contrast
      col.rgb = sCurve3(col.rgb);

      // 3. Saturation
      float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
      col.rgb = mix(vec3(lum), col.rgb, uSaturation);

      // 4. Vignette
      float vd = length(vUv - vec2(0.5));
      col.rgb *= smoothstep(uVigRad, uVigRad - uVigStr, vd);

      gl_FragColor = col;
    }
  `,
};

let _bloomPass; // kept so switchView can tune threshold per-view

function _buildComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const flarePass = new ShaderPass(FLARE_SHADER);
  flarePass.uniforms.uAspect.value = window.innerWidth / window.innerHeight;
  composer.addPass(flarePass);
  flarePassRef = flarePass;

  // Selective bloom — only pixels above threshold 0.85 are bloomed,
  // so dark walls and seats are unaffected; windows and strips glow.
  _bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.18,   // strength
    0.55,   // radius
    0.85,   // threshold
  );
  _bloomPass.enabled = false; // off by default — only active in interior view
  composer.addPass(_bloomPass);

  _gradePass = new ShaderPass(GRADE_SHADER);
  _gradePass.renderToScreen = true;
  composer.addPass(_gradePass);
}

/* ─────────────────────────────────────────────────────────────────
   LIGHTING
───────────────────────────────────────────────────────────────── */
function _setupLighting() {
  hemisphereLight = new THREE.HemisphereLight(0xD8E8F0, 0xA09060, 1.1);
  scene.add(hemisphereLight);

  sunLight = new THREE.DirectionalLight(0xFFCC80, 2.0);
  sunLight.position.copy(
    _sunDirFromClock(SUN_CONTROL.clockHours, SUN_CONTROL.elevationDeg).multiplyScalar(60)
  );
  sunLight.castShadow           = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  sunLight.shadow.camera.near   = 1;
  sunLight.shadow.camera.far    = 300;  // cover distant buildings
  sunLight.shadow.camera.left   = -80;  // wide enough to include control tower
  sunLight.shadow.camera.right  = 80;
  sunLight.shadow.camera.top    = 80;
  sunLight.shadow.camera.bottom = -80;
  sunLight.shadow.bias          = -0.0003;
  sunLight.shadow.normalBias    = 0.02;
  scene.add(sunLight);

  fillLight = new THREE.DirectionalLight(0x8BAEC8, 1.0);
  fillLight.position.set(-40, 12, 60);
  scene.add(fillLight);

  bounceLight = new THREE.DirectionalLight(0xF0A840, 0.45);
  bounceLight.position.set(0, -1, 0);
  scene.add(bounceLight);

  // ── Cabin hemisphere light ───────────────────────────────────────
  // Primary ambient fill.  Sky (top) = warm cabin white, ground (bottom)
  // = very dark warm so floors stay dark without being pitch-black.
  // No physical position, so no hot-spot artefacts on the ceiling.
  const cabinHemi = new THREE.HemisphereLight(0xFFE8CC, 0x1A0E06, 0);
  cabinHemi.userData.interiorIntensity = 0.85;
  scene.add(cabinHemi);
  _cabinLights.push(cabinHemi);

  // ── SpotLights pointing straight down ────────────────────────────
  // Used only for shadow-casting.  The cone goes downward only, so the
  // ceiling surface directly above the light is never illuminated →
  // no bright ceiling blob.  Cabin runs X −7…+7, ceiling at y≈3.27.
  [
    { x:  4.5, shadow: false },
    { x:  0.0, shadow: true  },
    { x: -4.5, shadow: false },
  ].forEach(({ x, shadow }) => {
    const spot = new THREE.SpotLight(0xFFE8CC, 0, 9,
      THREE.MathUtils.degToRad(72), 0.50, 1.8);
    spot.position.set(x, 3.05, 0);
    spot.target.position.set(x, 0, 0); // aim straight down
    spot.userData.interiorIntensity = 1.8;
    scene.add(spot);
    scene.add(spot.target); // target must live in the scene
    if (shadow) {
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.camera.near = 0.3;
      spot.shadow.camera.far  = 9;
      spot.shadow.bias        = -0.002;
      spot.shadow.radius      = 5;
    }
    _cabinLights.push(spot);
  });

  // Strip glow is handled entirely by bloom on the emissive strip mesh.
  // emissiveIntensity=2.0 in materials.js ensures the strips far exceed
  // the bloom threshold while seats/trim stay below it.
  // _stripGlowMeshes is kept empty so setStripGlowColor() is a no-op.

  // ── Window cookie spotlights ─────────────────────────────────────
  // Each spot uses a canvas-generated octagon texture as its .map (cookie /
  // gobo) to project a window-shaped light patch onto the floor and seats.
  // Positioned just inside the cabin wall at window height, aimed inward and
  // downward so the patch lands between the window and the aisle.
  // No shadow maps needed — the cookie provides the shaping.
  (function _buildWindowCookies() {
    // ── Cookie texture — blurred octagon so projected patch is soft ─
    const SIZE = 512;
    const cv   = document.createElement('canvas');
    cv.width   = cv.height = SIZE;
    const ctx  = cv.getContext('2d');
    const cx = SIZE / 2, cy = SIZE / 2;
    const r   = SIZE * 0.34;
    const cut = r   * 0.42;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Moderate blur softens the edges without hollowing out the centre.
    // No stroke ring — it projects as a dark halo and kills the fill read.
    ctx.filter = 'blur(6px)';
    ctx.beginPath();
    ctx.moveTo(cx - r + cut, cy - r);
    ctx.lineTo(cx + r - cut, cy - r);
    ctx.lineTo(cx + r,       cy - r + cut);
    ctx.lineTo(cx + r,       cy + r - cut);
    ctx.lineTo(cx + r - cut, cy + r);
    ctx.lineTo(cx - r + cut, cy + r);
    ctx.lineTo(cx - r,       cy + r - cut);
    ctx.lineTo(cx - r,       cy - r + cut);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.filter = 'none';

    // Centre bloom — heart of the patch is brightest
    const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.9);
    inner.addColorStop(0, 'rgba(255,255,255,0.30)');
    inner.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = inner;
    ctx.fillRect(0, 0, SIZE, SIZE);

    const cookieTex = new THREE.CanvasTexture(cv);

    [
      { x:  5.5, z:  1.92 },
      { x:  2.0, z:  1.92 },
      { x: -2.0, z:  1.92 },
      { x: -5.5, z:  1.92 },
      { x:  5.5, z: -1.92 },
      { x:  2.0, z: -1.92 },
      { x: -2.0, z: -1.92 },
      { x: -5.5, z: -1.92 },
    ].forEach(({ x, z }) => {
      const spot = new THREE.SpotLight(
        0xD4EAFF,                       // cool daylight blue
        0,                              // off by default — switchView enables
        6.5,                            // distance
        THREE.MathUtils.degToRad(36),  // wide cone → large floor patch
        0.55,                           // penumbra: soft but still has solid centre
        1.4,                            // decay
      );
      spot.map = cookieTex;
      spot.position.set(x, 1.85, z);
      // Target below floor (Y=−0.4) steepens the beam so it hits carpet;
      // Z pulled toward centre so the patch lands at seat base / aisle edge
      spot.target.position.set(x, -0.4, z * 0.55);
      scene.add(spot);
      scene.add(spot.target);
      _cookieSpots.push(spot);
    });
  })();

  // ── Window fill lights ───────────────────────────────────────────
  // Simulate daylight bleeding in through the oval windows.
  // Cool sky-blue (0xC8DFFF) so they read as exterior light, not cabin
  // warmth.  4 per side along the cabin length, at window height y≈1.8.
  // Z pushed just inside the wall (±2.0) so the light originates from
  // where the windows sit.  No shadows — purely additive fill.
  // Z pulled to ±1.3 — clearly inside the cabin so the light casts inward
  // onto seats/floor rather than back onto the window frame and wall surround.
  // Distance 2.2 keeps the reach local to the seat zone beside each window.
  [
    new THREE.Vector3( 5.5, 1.6,  1.3),
    new THREE.Vector3( 2.0, 1.6,  1.3),
    new THREE.Vector3(-2.0, 1.6,  1.3),
    new THREE.Vector3(-5.5, 1.6,  1.3),
    new THREE.Vector3( 5.5, 1.6, -1.3),
    new THREE.Vector3( 2.0, 1.6, -1.3),
    new THREE.Vector3(-2.0, 1.6, -1.3),
    new THREE.Vector3(-5.5, 1.6, -1.3),
  ].forEach(pos => {
    const wl = new THREE.PointLight(0xC8DFFF, 0, 2.2, 2.0);
    wl.position.copy(pos);
    scene.add(wl);
    _windowLights.push(wl);
  });

  interiorLight = new THREE.PointLight(0xF4C77A, 0, 8, 1.5);
  interiorLight.position.set(0, 2.5, 0);
  scene.add(interiorLight);
}

/* ─────────────────────────────────────────────────────────────────
   ENV MAP
───────────────────────────────────────────────────────────────── */
function _buildEnvMap() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.8;
}

/* ─────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────── */
export function initScene() {
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('canvas'),
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled   = true;
  renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace    = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(HORIZON_FOG_COLOR, 0.0030); // gentler, matches runway height fog falloff

  camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 800);
  camera.position.copy(CAM_PRESETS.exterior.position);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAM_PRESETS.exterior.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.minDistance   = 3;
  controls.maxDistance   = 80;
  // Vertical orbit constraint, expressed as elevation-above-horizon for clarity:
  //   elevation = 90°  → looking straight down from directly overhead
  //   elevation =  0°  → looking level along the horizon
  //   elevation = -10° → looking 10° below horizontal (slightly down at the tarmac)
  // Three.js OrbitControls uses "polar angle" instead, measured from straight
  // up (0°) to straight down (180°), i.e. polarAngle = 90° - elevation.
  // So elevation ∈ [-10°, 90°]  →  polarAngle ∈ [0°, 100°].
  const MIN_ELEVATION_DEG = -3;
  const MAX_ELEVATION_DEG = 90;
  controls.minPolarAngle = THREE.MathUtils.degToRad(90 - MAX_ELEVATION_DEG); // 0°   (straight overhead)
  controls.maxPolarAngle = THREE.MathUtils.degToRad(90 - MIN_ELEVATION_DEG); // 100° (10° below horizon)
  controls.update();

  _setupLighting();
  _buildEnvMap();
  _buildSkyDome();
  _buildComposer();
  _buildHotspots();
  _setupHotspotInteraction();
  // NOTE: the runway/environment is now loaded asynchronously inside
  // loadModels() — it tries scene.glb first, falling back to the
  // procedural runway (_buildRunway) only if that file is missing.

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.setSize(w, h);
    if (_bloomPass) _bloomPass.resolution.set(w, h);
    flarePassRef.uniforms.uAspect.value = w / h;
  });

  _renderLoop();
}

/* ─────────────────────────────────────────────────────────────────
   INTERIOR OCCLUSION FADE
   Per-frame raycaster: cast a ray from the orbit target toward the
   camera. Any interior mesh that sits between them gets its opacity
   faded proportionally to how close it is to the camera. Restores
   full opacity the next frame when the mesh is no longer occluding.
───────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────
   MODEL LOADING
───────────────────────────────────────────────────────────────── */
function _tryLoad(path, onProgress) {
  return new Promise(resolve => {
    gltfLoader.load(
      path,
      gltf => resolve(gltf.scene),
      e    => { if (onProgress && e.total) onProgress(e.loaded / e.total); },
      ()   => resolve(null),
    );
  });
}

function _autoScale(model) {
  const box = new THREE.Box3().setFromObject(model);
  const sz  = box.getSize(new THREE.Vector3());
  const max = Math.max(sz.x, sz.y, sz.z);
  if (max > 0) model.scale.setScalar(14 / max);
  const box2 = new THREE.Box3().setFromObject(model);
  model.position.sub(box2.getCenter(new THREE.Vector3()));
  model.position.y += box2.getSize(new THREE.Vector3()).y / 2;
}

function _enableShadows(model) {
  model.traverse(n => {
    if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
  });
}

export async function loadModels(onProgress) {
  const prog = (p, label) => onProgress && onProgress(p, label);

  // ── Environment / runway scene (scene.glb) — loaded FIRST so the
  // aircraft has somewhere to sit by the time it appears. Falls back
  // to the procedural runway if the artist's file isn't present yet. ──
  prog(0.02, 'Loading environment…');
  const sceneGLB = await _tryLoad('./models/scene.glb', p => prog(0.02 + p * 0.18, 'Loading environment…'));
  if (sceneGLB) {
    runwayGroup = sceneGLB;
    runwayGroup.name = 'runway'; // keep the same name other code looks for
    _enableShadows(runwayGroup);
    _flattenReflectivity(runwayGroup); // kill the artist GLB's baked-in chrome/metallic look
    _applyHeightFogToObject(runwayGroup); // dissolve distant parts into haze, same as procedural version
    scene.add(runwayGroup);

    // Use the environment's own ground level for the aircraft, instead
    // of assuming y=0 — the artist's GLB may not be authored with its
    // tarmac surface exactly at the origin.
    //
    // NOTE: envBox.max.y picks up the TALLEST point in the whole scene,
    // which works if the tarmac is the highest flat surface, but will be
    // wrong if there's a control tower / fence / building taller than the
    // runway. If the aircraft still looks misaligned after this change,
    // hardcode the known tarmac height here instead, e.g.:
    //   _groundLevelY = 0;       // if scene.glb's tarmac sits at y=0
    //   _groundLevelY = -0.3;    // if it sits slightly below origin
    const envBox = new THREE.Box3().setFromObject(runwayGroup);
    _groundLevelY = -0.6;
    // _groundLevelY = 0; // ← uncomment and adjust if auto-detection is off
  } else {
    _buildRunway(); // procedural fallback — builds + adds its own runwayGroup
    _groundLevelY = 0; // procedural runway's tarmac is authored at y=0
  }

  prog(0.20, 'Loading exterior…');
  const extGLB = await _tryLoad('./models/exterior.glb', p => prog(0.20 + p * 0.30, 'Loading exterior…'));
  models.exterior = extGLB ?? _buildDemoExterior();
  _autoScale(models.exterior);
  models.exterior.position.y += _groundLevelY; // rest the aircraft on the actual ground surface
  _enableShadows(models.exterior);
  scene.add(models.exterior);

  prog(0.50, 'Loading interior…');
  const intGLB = await _tryLoad('./models/interior.glb', p => prog(0.50 + p * 0.45, 'Loading interior…'));
  models.interior = intGLB ?? _buildDemoInterior();
  _autoScale(models.interior);
  _enableShadows(models.interior);
  if (intGLB) _enforceInteriorCulling(models.interior);
  models.interior.visible = false;
  scene.add(models.interior);

  prog(1.0, 'Ready');
  return { usedDemo: !extGLB || !intGLB, usedDemoEnvironment: !sceneGLB };
}

export function getModels()        { return models; }
export function getInteriorLight() { return interiorLight; }
export function getCabinLights()   { return _cabinLights; }
export function getCurrentView()   { return currentView; }

// ── Strip glow shader system ──────────────────────────────────────
// injectStripGlowShaders() walks every material on the interior model
// and patches its GLSL via onBeforeCompile to compute per-fragment
// distance to the two strip lines (world-space YZ plane).  The result
// is a smooth gradient that hugs any curved surface — no planes needed.
const _stripGlowUniforms = [];   // one entry per unique material

export function injectStripGlowShaders(model) {
  if (!model) return;
  const seen = new Set();

  model.traverse(node => {
    if (!node.isMesh) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(mat => {
      if (!mat || !mat.isMeshStandardMaterial || seen.has(mat)) return;
      seen.add(mat);

      // Uniform block shared between onBeforeCompile invocations and
      // the set* helpers below — stored by reference so value changes
      // are picked up without needing to recompile the shader.
      const uni = {
        uSGColor:     { value: new THREE.Color(0xFFE8CC) },
        uSGIntensity: { value: 0.0 },
        uSGY:         { value: 2.72 },   // strip world Y
        uSGZ:         { value: 1.88 },   // strip world |Z| (mirrored for both sides)
        uSGRadius:    { value: 1.0  },   // falloff radius in metres
      };
      _stripGlowUniforms.push(uni);

      const prev = mat.onBeforeCompile;   // preserve any existing hook
      mat.onBeforeCompile = shader => {
        if (prev) prev(shader);
        Object.assign(shader.uniforms, uni);

        // ── Vertex: pass world position to fragment ──────────────
        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vSGWorldPos;',
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
           vSGWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );

        // ── Fragment: add strip contribution before tone mapping ─
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
           varying vec3  vSGWorldPos;
           uniform vec3  uSGColor;
           uniform float uSGIntensity;
           uniform float uSGY;
           uniform float uSGZ;
           uniform float uSGRadius;`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <tonemapping_fragment>',
          `// Strip glow — distance in YZ plane to each strip line (infinite along X)
           float _sgDistR = length(vSGWorldPos.yz - vec2(uSGY,  uSGZ));
           float _sgDistL = length(vSGWorldPos.yz - vec2(uSGY, -uSGZ));
           float _sgDist  = min(_sgDistR, _sgDistL);
           float _sgFall  = max(0.0, 1.0 - _sgDist / uSGRadius);
           _sgFall = _sgFall * _sgFall * _sgFall;   // cubic: tight near strip, fades fast
           gl_FragColor.rgb += uSGColor * uSGIntensity * _sgFall;
           #include <tonemapping_fragment>`,
        );
      };

      mat.needsUpdate = true;
    });
  });
}

export function setStripGlowColor(hex) {
  const c = new THREE.Color(hex);
  _stripGlowUniforms.forEach(u => u.uSGColor.value.copy(c));
}

export function setStripGlowIntensity(v) {
  _stripGlowUniforms.forEach(u => u.uSGIntensity.value = v);
}

/**
 * updateSunDirection(clockHours, elevationDeg)
 *
 * Recomputes the sun direction and propagates it to every system that
 * depends on it: the sky shader's glow, the shadow-casting directional
 * light, and the lens flare's screen-space projection target.
 *
 * Call this any time after initScene() has run (i.e. after the sky dome
 * and lighting exist) to retune the sun position live, e.g. from a dev
 * UI slider or directly in the browser console:
 *
 *   import { updateSunDirection } from './scene.js';
 *   updateSunDirection(10.5, 12);   // aircraft's ~10–11 o'clock, low golden-hour angle
 *
 * If called with no arguments, re-reads the current SUN_CONTROL values —
 * useful if you've edited SUN_CONTROL directly and want to apply it.
 */
export function updateSunDirection(clockHours = SUN_CONTROL.clockHours, elevationDeg = SUN_CONTROL.elevationDeg) {
  SUN_CONTROL.clockHours   = clockHours;
  SUN_CONTROL.elevationDeg = elevationDeg;

  const dir = _sunDirFromClock(clockHours, elevationDeg);

  // Sky shader glow
  if (skyDomeMat) skyDomeMat.uniforms.uSunDir.value.copy(dir);

  // Shadow-casting directional light
  if (sunLight) sunLight.position.copy(dir.clone().multiplyScalar(60));

  // Lens flare screen-space projection target
  sunWorldPos = dir.clone().multiplyScalar(700);
}

/* ─────────────────────────────────────────────────────────────────
   VIEW SWITCHING
───────────────────────────────────────────────────────────────── */
export function switchView(view) {
  if (view === currentView || isAnimating) return false;
  currentView = view;
  models.exterior.visible = (view === 'exterior');
  models.interior.visible = (view === 'interior');
  if (view === 'interior') {
    if (runwayGroup) runwayGroup.visible = false;
    if (skyDomeMesh) skyDomeMesh.visible = false;
    if (_hotspotGroup) _hotspotGroup.visible = true;
    scene.fog                  = null;
    scene.background           = new THREE.Color(0x000000);
    renderer.toneMappingExposure = 0.72; // lower headroom so bright materials compress rather than clip
    if (_bloomPass) { _bloomPass.enabled = true; _bloomPass.threshold = 0.88; _bloomPass.strength = 0.45; _bloomPass.radius = 0.80; }
    if (_gradePass) {
      const u = _gradePass.uniforms;
      u.uLift.value.set(0.02, 0.015, 0.010);
      u.uGamma.value.set(0.97, 0.97,  1.00);
      u.uGain.value.set(0.88, 0.86,  0.84); // roll off highlights — white seats stay detailed instead of blowing out
      u.uContrast.value   = 1.12;
      u.uSaturation.value = 1.08;
    }
    scene.environmentIntensity = 0.45;
    sunLight.intensity        = 0;
    fillLight.intensity       = 0;
    bounceLight.intensity     = 0;
    hemisphereLight.intensity = 0;
    _cabinLights.forEach(l => l.intensity = l.userData.interiorIntensity ?? 4.5);
    _windowLights.forEach(l => l.intensity = 0);
    _cookieSpots.forEach(s => s.intensity = 2.8);
    setStripGlowIntensity(1.5);
    interiorLight.intensity   = 0;
    // Free-look controls until a spot is chosen
    controls.enablePan   = true;
    controls.minDistance = 0.5;
    controls.maxDistance = 12;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
  } else {
    if (runwayGroup) runwayGroup.visible = true;
    if (skyDomeMesh) skyDomeMesh.visible = true;
    if (_hotspotGroup) _hotspotGroup.visible = false;
    renderer.domElement.style.cursor = '';
    scene.fog                  = new THREE.FogExp2(HORIZON_FOG_COLOR, 0.0030);
    scene.background           = null;
    renderer.toneMappingExposure = 1.1;
    if (_bloomPass) { _bloomPass.enabled = false; }
    if (_gradePass) {
      const u = _gradePass.uniforms;
      u.uLift.value.set(0.0, 0.0, 0.0);
      u.uGamma.value.set(1.0, 1.0, 1.0);
      u.uGain.value.set(1.0, 1.0, 1.0);
      u.uContrast.value   = 1.0;
      u.uSaturation.value = 1.0;
    }
    scene.environmentIntensity = 0.8;
    sunLight.intensity        = 2.0;
    fillLight.intensity       = 1.0;
    bounceLight.intensity     = 0.45;
    hemisphereLight.intensity = 1.1;
    _cabinLights.forEach(l => l.intensity = 0);
    _windowLights.forEach(l => l.intensity = 0);
    _cookieSpots.forEach(s => s.intensity = 0);
    setStripGlowIntensity(0.0);
    interiorLight.intensity   = 0;
    // Restore exterior orbit constraints
    controls.enablePan   = true;
    controls.minDistance = 3;
    controls.maxDistance = 80;
    controls.minPolarAngle = THREE.MathUtils.degToRad(0);
    controls.maxPolarAngle = THREE.MathUtils.degToRad(93);
  }
  if (view === 'interior') {
    _goToSpot(1); // land on centre hotspot by default
  } else {
    _animateCam(CAM_PRESETS.exterior.position, CAM_PRESETS.exterior.target, 1200);
  }
  return true;
}

export function resetCamera(duration = 800) {
  _animateCam(CAM_PRESETS[currentView].position, CAM_PRESETS[currentView].target, duration);
}

function _animateCam(toPos, toTarget, dur) {
  isAnimating = true;
  const fromPos = camera.position.clone();
  const fromTgt = controls.target.clone();
  const t0      = performance.now();
  function tick(now) {
    const t    = Math.min((now - t0) / dur, 1);
    const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    camera.position.lerpVectors(fromPos, toPos, ease);
    controls.target.lerpVectors(fromTgt, toTarget, ease);
    controls.update();
    if (t < 1) requestAnimationFrame(tick);
    else isAnimating = false;
  }
  requestAnimationFrame(tick);
}

/* ─────────────────────────────────────────────────────────────────
   INTERIOR HOTSPOTS
   Three floor-level ring markers the user clicks/taps to warp to a
   fixed camera position. At each spot the user can rotate freely but
   cannot pan or zoom out past a set radius.
───────────────────────────────────────────────────────────────── */
// Cabin runs along X (−7..+7 after _autoScale). These positions sit in
// the centre of each of the three visible cabin sections.
const INTERIOR_SPOTS = [
  { camPos: new THREE.Vector3( 2.5, 2.3,  0.5), target: new THREE.Vector3( 2.5, 2.0,  0.0) },
  { camPos: new THREE.Vector3( -0.5, 2.3,  1.0), target: new THREE.Vector3( -0.5, 2.0, -0.5) },
  { camPos: new THREE.Vector3(-4.0, 2.3,  0.5), target: new THREE.Vector3(-5.5, 2.0,  0.0) },
];

let _hotspotGroup = null;
const _hotspotMeshes = [];

function _buildHotspots() {
  _hotspotGroup = new THREE.Group();
  _hotspotGroup.name    = 'interiorHotspots';
  _hotspotGroup.visible = false;

  INTERIOR_SPOTS.forEach((spot, i) => {
    const x = spot.camPos.x;

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.025, 8, 48),
      new THREE.MeshStandardMaterial({
        color: 0xFFFFFF, emissive: 0xFFFFFF, emissiveIntensity: 1.2,
        roughness: 1, metalness: 0, transparent: true, opacity: 0.9,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.1, 0);
    ring.userData.spotIndex = i;

    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.07, 24),
      new THREE.MeshStandardMaterial({
        color: 0xFFFFFF, emissive: 0xFFFFFF, emissiveIntensity: 2.0,
        roughness: 1, metalness: 0,
      })
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(x, 0.1, 0);
    dot.userData.spotIndex = i;

    _hotspotGroup.add(ring, dot);
    _hotspotMeshes.push(ring, dot);
  });

  scene.add(_hotspotGroup);
}

function _goToSpot(index) {
  const spot = INTERIOR_SPOTS[index];
  _animateCam(spot.camPos, spot.target, 900);
  setTimeout(() => {
    controls.enablePan   = false;
    controls.minDistance = 0.3;
    controls.maxDistance = 5.8;
  }, 920);
}

function _setupHotspotInteraction() {
  const raycaster   = new THREE.Raycaster();
  const ptr         = new THREE.Vector2();
  let   hoveredMesh = null;

  function toNDC(e) {
    const rect    = renderer.domElement.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    ptr.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    ptr.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  }

  renderer.domElement.addEventListener('pointerdown', e => {
    if (currentView !== 'interior' || !_hotspotGroup?.visible) return;
    toNDC(e);
    raycaster.setFromCamera(ptr, camera);
    const hits = raycaster.intersectObjects(_hotspotMeshes, false);
    if (hits.length > 0 && hits[0].object.userData.spotIndex !== undefined) {
      _goToSpot(hits[0].object.userData.spotIndex);
    }
  });

  renderer.domElement.addEventListener('pointermove', e => {
    if (currentView !== 'interior' || !_hotspotGroup?.visible) return;
    toNDC(e);
    raycaster.setFromCamera(ptr, camera);
    const hits = raycaster.intersectObjects(_hotspotMeshes, false);
    const hit  = hits.length > 0 ? hits[0].object : null;

    if (hoveredMesh && hoveredMesh !== hit) {
      hoveredMesh.material.emissiveIntensity = hoveredMesh.userData.baseEmissive;
      renderer.domElement.style.cursor = '';
    }
    if (hit && hit !== hoveredMesh) {
      hit.userData.baseEmissive = hit.material.emissiveIntensity;
      hit.material.emissiveIntensity = 4.0;
      renderer.domElement.style.cursor = 'pointer';
    }
    hoveredMesh = hit;
  });
}

/* ─────────────────────────────────────────────────────────────────
   RENDER LOOP — simple single composer
───────────────────────────────────────────────────────────────── */
function _renderLoop() {
  requestAnimationFrame(_renderLoop);
  if (!isAnimating) controls.update();

  if (currentView === 'exterior' && sunWorldPos && flarePassRef) {
    _updateSunFlare();
  } else if (flarePassRef) {
    flarePassRef.uniforms.uSunScreenPos.value.z = 0;
  }

  composer.render();
}

/**
 * Projects the sun's world position into normalized screen space (0..1)
 * and computes a visibility factor:
 *   - 0 if the sun is behind the camera (checked via view-space Z, not NDC,
 *     since project() can mirror X/Y for behind-camera points instead of
 *     cleanly reporting them as invalid)
 *   - 0 if a raycast from camera to sun hits the aircraft (occluded)
 *   - fades smoothly near screen edges so the flare doesn't pop in/out
 */
const _flareRaycaster  = new THREE.Raycaster();
const _sunNDC           = new THREE.Vector3();
const _sunViewSpace     = new THREE.Vector3();
const _camForward       = new THREE.Vector3();
const _toSun            = new THREE.Vector3();

function _updateSunFlare() {
  // ── Step 1: reject if sun is behind the camera using view-space Z ──
  // (more reliable than checking projected NDC z, which can misbehave
  // for points exactly behind the camera due to perspective divide)
  _sunViewSpace.copy(sunWorldPos).applyMatrix4(camera.matrixWorldInverse);
  if (_sunViewSpace.z > 0) {
    // Positive view-space Z means the point is behind the camera
    // (Three.js camera looks down -Z in view space)
    flarePassRef.uniforms.uSunScreenPos.value.z = 0;
    return;
  }

  // ── Step 2: project to NDC, now safe since we know it's in front ──
  _sunNDC.copy(sunWorldPos).project(camera);

  // NOTE: fragment shader's vUv has origin bottom-left, Y increasing upward —
  // same convention as NDC. No sign flip needed for Y (earlier version
  // incorrectly flipped it, which put the flare on the opposite vertical
  // half of the screen from the actual sun).
  const screenX = (_sunNDC.x * 0.5) + 0.5;
  const screenY = (_sunNDC.y * 0.5) + 0.5;

  // Fade out as the sun nears/exceeds screen edges
  const edgeFadeX = 1.0 - THREE.MathUtils.smoothstep(Math.abs(_sunNDC.x), 0.85, 1.05);
  const edgeFadeY = 1.0 - THREE.MathUtils.smoothstep(Math.abs(_sunNDC.y), 0.85, 1.05);
  let visibility = edgeFadeX * edgeFadeY;

  // ── Step 3: occlusion check — only test against the aircraft itself ──
  // (the runway is excluded: at low sun angles a ray toward the sun can
  // graze the runway plane and falsely register as occluded)
  if (visibility > 0.01 && models.exterior) {
    _toSun.copy(sunWorldPos).sub(camera.position).normalize();
    _flareRaycaster.set(camera.position, _toSun);
    _flareRaycaster.far = sunWorldPos.distanceTo(camera.position);
    const hits = _flareRaycaster.intersectObject(models.exterior, true);
    if (hits.length > 0) visibility = 0;
  }

  flarePassRef.uniforms.uSunScreenPos.value.set(screenX, screenY, visibility);
}

/* ─────────────────────────────────────────────────────────────────
   PROCEDURAL DEMO GEOMETRY
───────────────────────────────────────────────────────────────── */
function _buildDemoExterior() {
  const g       = new THREE.Group(); g.name = 'demo_exterior';
  const bodyMat = new THREE.MeshStandardMaterial({ color:0xF0EEE9, roughness:0.12, metalness:0.7, name:'Body_Paint' });
  const glassMat= new THREE.MeshStandardMaterial({ color:0x2A3850, roughness:0.0, metalness:0.1, transparent:true, opacity:0.55 });
  const darkMat = new THREE.MeshStandardMaterial({ color:0x1A1A1E, roughness:0.3, metalness:0.8 });
  const engMat  = new THREE.MeshStandardMaterial({ color:0x888890, roughness:0.2, metalness:0.9, name:'Engine_Metal' });
  const fus  = new THREE.Mesh(new THREE.CylinderGeometry(0.85,0.6,12,32), bodyMat);
  fus.name='Body_Fuselage'; fus.rotation.z=Math.PI/2; fus.castShadow=true; g.add(fus);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.6,3.5,24), bodyMat);
  nose.name='Body_Nose'; nose.rotation.z=-Math.PI/2; nose.position.set(7.7,0,0); g.add(nose);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.85,2.5,24), bodyMat);
  tail.name='Body_Tail'; tail.rotation.z=Math.PI/2; tail.position.set(-7.2,0,0); g.add(tail);
  [['Wing_Left',3.5],['Wing_Right',-3.5]].forEach(([nm,z])=>{
    const w=new THREE.Mesh(new THREE.BoxGeometry(7,0.12,1.6),bodyMat); w.name=nm; w.position.set(-1.5,-0.15,z); g.add(w);
  });
  [['Wing_WingletL',3.8],['Wing_WingletR',-3.8]].forEach(([nm,z])=>{
    const wl=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.7,0.4),bodyMat); wl.name=nm; wl.position.set(-4.9,0.35,z); g.add(wl);
  });
  [['Wing_HStabL',1.8],['Wing_HStabR',-1.8]].forEach(([nm,z])=>{
    const hs=new THREE.Mesh(new THREE.BoxGeometry(3.5,0.1,0.9),bodyMat); hs.name=nm; hs.position.set(-7.8,0.3,z); g.add(hs);
  });
  const vs=new THREE.Mesh(new THREE.BoxGeometry(2.2,1.5,0.1),bodyMat); vs.name='Wing_VStab'; vs.position.set(-7.2,1.35,0); g.add(vs);
  [1.2,-1.2].forEach(z=>{
    const pod=new THREE.Group();
    const outer=new THREE.Mesh(new THREE.CylinderGeometry(0.38,0.3,3.0,20),engMat); outer.name='Engine_Outer'; outer.rotation.z=Math.PI/2;
    const inner=new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.18,3.0,20),darkMat); inner.rotation.z=Math.PI/2;
    pod.add(outer,inner); pod.position.set(-6.5,0.7,z); g.add(pod);
  });
  const winGeo=new THREE.BoxGeometry(0.35,0.32,0.06);
  for(let i=-3;i<=3;i++){
    [0.86,-0.86].forEach(z=>{const w=new THREE.Mesh(winGeo,glassMat);w.name='Glass_Win';w.position.set(i*1.2,0.45,z);g.add(w);});
  }
  g.position.y=1.2; return g;
}

function _buildDemoInterior() {
  const g=new THREE.Group(); g.name='demo_interior';
  const wallMat =new THREE.MeshStandardMaterial({color:0xE8E0D0,roughness:0.7,name:'Wall_Panel'});
  const floorMat=new THREE.MeshStandardMaterial({color:0x3A2E1A,roughness:0.9,name:'Carpet_Floor'});
  const ceilMat =new THREE.MeshStandardMaterial({color:0xDDD5C5,roughness:0.8});
  const trimMat =new THREE.MeshStandardMaterial({color:0x5C3D1E,roughness:0.4,metalness:0.05,name:'Trim_Wood'});
  const seatMat =new THREE.MeshStandardMaterial({color:0xE8E0D0,roughness:0.5,metalness:0.02,name:'Seat_Leather'});
  const metalMat=new THREE.MeshStandardMaterial({color:0xC8A96E,roughness:0.2,metalness:0.9});
  const glassMat=new THREE.MeshStandardMaterial({color:0x2A3850,transparent:true,opacity:0.4});
  const stripMat=new THREE.MeshStandardMaterial({color:0xF4C77A,emissive:new THREE.Color(0xF4C77A),emissiveIntensity:1.5,roughness:1,name:'Light_Strip_'});
  const floor=new THREE.Mesh(new THREE.BoxGeometry(8,0.06,2.6),floorMat); floor.receiveShadow=true; g.add(floor);
  const ceil=new THREE.Mesh(new THREE.BoxGeometry(8,0.06,2.6),ceilMat); ceil.position.y=1.85; g.add(ceil);
  [-1.3,1.3].forEach(z=>{const w=new THREE.Mesh(new THREE.BoxGeometry(8,1.85,0.08),wallMat);w.position.set(0,0.925,z);g.add(w);});
  const railGeo=new THREE.BoxGeometry(8,0.06,0.06);
  [[1.5,-1.26],[1.5,1.26],[0.32,-1.26],[0.32,1.26]].forEach(([y,z])=>{const r=new THREE.Mesh(railGeo,trimMat);r.name='Trim_Rail';r.position.set(0,y,z);g.add(r);});
  const wGeo=new THREE.BoxGeometry(0.05,0.52,0.68);
  for(let i=-2;i<=2;i++){[-1.26,1.26].forEach(z=>{const w=new THREE.Mesh(wGeo,glassMat);w.position.set(i*1.4,0.95,z);g.add(w);});}
  function makeSeat(x,z,fwd=true){
    const sg=new THREE.Group(); sg.name='Seat_Club';
    const base=new THREE.Mesh(new THREE.BoxGeometry(0.62,0.1,0.62),metalMat); base.position.y=0.1; sg.add(base);
    const cush=new THREE.Mesh(new THREE.BoxGeometry(0.58,0.14,0.58),seatMat); cush.name='Seat_Cushion'; cush.position.y=0.22; sg.add(cush);
    const back=new THREE.Mesh(new THREE.BoxGeometry(0.58,0.70,0.10),seatMat); back.name='Seat_Back'; back.position.set(0,0.64,fwd?-0.26:0.26); sg.add(back);
    const head=new THREE.Mesh(new THREE.BoxGeometry(0.40,0.22,0.12),seatMat); head.name='Seat_Headrest'; head.position.set(0,1.06,fwd?-0.28:0.28); sg.add(head);
    [[-0.33,'Trim_Armrest_L'],[0.33,'Trim_Armrest_R']].forEach(([ax,nm])=>{const a=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.08,0.52),trimMat);a.name=nm;a.position.set(ax,0.42,0);sg.add(a);});
    sg.position.set(x,0,z); if(!fwd)sg.rotation.y=Math.PI; return sg;
  }
  [[-2.5,-0.7,true],[-2.5,0.7,true],[-1.0,-0.7,false],[-1.0,0.7,false],[1.8,-0.7,true],[1.8,0.7,true]].forEach(([x,z,f])=>g.add(makeSeat(x,z,f)));
  const tbl=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.04,1.0),trimMat); tbl.name='Trim_Table'; tbl.position.set(-1.75,0.55,0); g.add(tbl);
  const leg=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.45,8),metalMat); leg.position.set(-1.75,0.3,0); g.add(leg);
  const sGeo=new THREE.BoxGeometry(7,0.03,0.15);
  [-0.9,0.9].forEach(z=>{const s=new THREE.Mesh(sGeo,stripMat);s.name='Light_Strip_';s.position.set(0,1.78,z);g.add(s);});
  g.position.y=0.06; return g;
}
