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
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
   SINGLETONS
───────────────────────────────────────────────────────────────── */
let renderer, scene, camera, controls, composer;
let flarePassRef;
let sunWorldPos; // THREE.Vector3 — kept in sync with sky shader's uSunDir
let interiorLight, sunLight;
let runwayGroup;
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
      uSunDir:  { value: new THREE.Vector3(0.60, 0.12, -0.79).normalize() },
      uSunSize: { value: 0.9990 },
    },
    // Keep a module-level reference for the flare pass to project each frame
    
    side:       THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = 'skyDome';
  scene.add(dome);

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
   POST-PROCESSING — vignette + warm grade ONLY
   No bloom pass. The sky shader handles sun glow internally.
   This pass only darkens edges and warms shadows slightly.
───────────────────────────────────────────────────────────────── */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse:  { value: null },
    uVigStr:   { value: 0.25 },
    uVigRad:   { value: 0.8 },
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
    varying vec2 vUv;
    void main() {
      vec4 col  = texture2D(tDiffuse, vUv);
      // Warm shadow lift
      float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
      col.rgb   = mix(col.rgb, col.rgb * vec3(1.04, 1.01, 0.94), (1.0 - lum) * 0.14);
      // Vignette
      float dist = length(vUv - vec2(0.5));
      col.rgb   *= smoothstep(uVigRad, uVigRad - uVigStr, dist);
      gl_FragColor = col;
    }
  `,
};

function _buildComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const flarePass = new ShaderPass(FLARE_SHADER);
  flarePass.uniforms.uAspect.value = window.innerWidth / window.innerHeight;
  composer.addPass(flarePass);
  flarePassRef = flarePass;

  const gradePass = new ShaderPass(GRADE_SHADER);
  gradePass.renderToScreen = true;
  composer.addPass(gradePass);
}

/* ─────────────────────────────────────────────────────────────────
   LIGHTING
───────────────────────────────────────────────────────────────── */
function _setupLighting() {
  scene.add(new THREE.HemisphereLight(0xD8E8F0, 0xA09060, 0.80)); // brighter sky fill so colours read

  sunLight = new THREE.DirectionalLight(0xFFCC80, 2.0);
  sunLight.position.set(60, 12, -79).normalize().multiplyScalar(60);
  sunLight.castShadow           = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  sunLight.shadow.camera.near   = 1;
  sunLight.shadow.camera.far    = 150;
  sunLight.shadow.camera.left   = -30;
  sunLight.shadow.camera.right  = 30;
  sunLight.shadow.camera.top    = 30;
  sunLight.shadow.camera.bottom = -30;
  sunLight.shadow.bias          = -0.0003;
  sunLight.shadow.normalBias    = 0.02;
  scene.add(sunLight);

  const fill = new THREE.DirectionalLight(0x8BAEC8, 0.45);
  fill.position.set(-40, 12, 60);
  scene.add(fill);

  const bounce = new THREE.DirectionalLight(0xF0A840, 0.45);
  bounce.position.set(0, -1, 0);
  scene.add(bounce);

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
  controls.maxPolarAngle = Math.PI * 0.84;
  controls.update();

  _setupLighting();
  _buildEnvMap();
  _buildSkyDome();
  _buildRunway();
  _buildComposer();

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.setSize(w, h);
    flarePassRef.uniforms.uAspect.value = w / h;
  });

  _renderLoop();
}

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
  prog(0.05, 'Loading exterior…');
  const extGLB = await _tryLoad('./models/exterior.glb', p => prog(0.05 + p * 0.35, 'Loading exterior…'));
  models.exterior = extGLB ?? _buildDemoExterior();
  _autoScale(models.exterior);
  _enableShadows(models.exterior);
  scene.add(models.exterior);

  prog(0.45, 'Loading interior…');
  const intGLB = await _tryLoad('./models/interior.glb', p => prog(0.45 + p * 0.45, 'Loading interior…'));
  models.interior = intGLB ?? _buildDemoInterior();
  _autoScale(models.interior);
  _enableShadows(models.interior);
  models.interior.visible = false;
  scene.add(models.interior);

  prog(1.0, 'Ready');
  return { usedDemo: !extGLB || !intGLB };
}

export function getModels()        { return models; }
export function getInteriorLight() { return interiorLight; }
export function getCurrentView()   { return currentView; }

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
    scene.fog        = null;
    scene.background = new THREE.Color(0x0C0C0E);
    interiorLight.intensity = 2.5;
  } else {
    if (runwayGroup) runwayGroup.visible = true;
    scene.fog        = new THREE.FogExp2(HORIZON_FOG_COLOR, 0.0030);
    scene.background = null;
    interiorLight.intensity = 0;
  }
  _animateCam(CAM_PRESETS[view].position, CAM_PRESETS[view].target, 1200);
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
   RENDER LOOP — simple single composer
───────────────────────────────────────────────────────────────── */
function _renderLoop() {
  requestAnimationFrame(_renderLoop);
  if (!isAnimating) controls.update();

  if (currentView === 'exterior' && sunWorldPos && flarePassRef) {
    _updateSunFlare();
  } else if (flarePassRef) {
    flarePassRef.uniforms.uSunScreenPos.value.z = 0; // hide flare in interior view
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
