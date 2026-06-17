# AETHER — Private Jet Configurator
### Artist & Developer Reference

An interactive 3D luxury private jet viewer built with Three.js. The viewer loads two GLB files — an exterior aircraft scene and a cabin interior scene — and applies real-time material changes driven by the configurator UI.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [How the Viewer Works](#2-how-the-viewer-works)
3. [GLB Model Requirements](#3-glb-model-requirements)
4. [Mesh Naming Convention](#4-mesh-naming-convention)
   - [Exterior GLB](#exterior-glb-exteriorglb)
   - [Interior GLB](#interior-glb-interiorglb)
   - [Quick Reference Table](#quick-reference-table)
5. [What the Viewer Does to Each Mesh](#5-what-the-viewer-does-to-each-mesh)
6. [Textures](#6-textures)
7. [Camera Presets](#7-camera-presets)
8. [Configurator Options](#8-configurator-options)
9. [Controls](#9-controls)
10. [Hosting](#10-hosting)
11. [Dependencies](#11-dependencies)

---

## 1. Project Structure

```
jet-viewer/
├── index.html                    ← Entry point (no changes needed)
├── css/
│   └── style.css                 ← All UI styles
├── js/
│   ├── viewer.js                 ← Boot sequence / orchestrator
│   ├── scene.js                  ← Three.js scene, camera, lighting, model loader
│   ├── materials.js              ← All material mutation logic
│   ├── options.js                ← Configurator option data + card thumbnails
│   ├── textureRegistry.js        ← All texture paths and loader
│   └── ui.js                     ← DOM / panel builder
├── models/
│   ├── exterior.glb              ← ⚠️  Your exterior aircraft model
│   └── interior.glb              ← ⚠️  Your cabin interior model
├── textures/
│   ├── README.md                 ← Texture specs for the artist
│   ├── seat/
│   │   ├── leather/              ← baseColor, roughness, normal, ao
│   │   └── fabric/               ← baseColor, roughness, normal, ao
│   ├── trim/
│   │   ├── walnut/
│   │   ├── maple/
│   │   ├── ebony/
│   │   └── carbon/
│   └── exterior/
│       └── paint/                ← roughness, normal (no baseColor needed)
└── README.md                     ← This file
```

> **No GLB files yet?** The viewer runs in **Demo Mode** automatically — procedural geometry is shown so the full UI can be explored immediately. Drop your GLBs into `/models/` when ready and refresh.

---

## 2. How the Viewer Works

The viewer reads **mesh names** from the GLB to decide which material to apply. It does **not** use Blender material slots, UV layers, or object collections for this — only the object/mesh name matters.

When a user changes a configurator option (e.g. switches from Ivory to Cognac leather), the viewer traverses all meshes in the relevant model and finds every mesh whose name starts with the correct prefix (e.g. `Seat_`), then overwrites its material with the new colour, roughness, and texture.

Meshes whose names don't match any known prefix are left completely untouched — they keep whatever material was baked into the GLB.

---

## 3. GLB Model Requirements

| Property | Requirement |
|----------|-------------|
| Format | GLB (binary GLTF). GLTF + separate `.bin` is not supported. |
| Compression | Draco compression is supported and recommended for large models. |
| Scale | Any scale — the viewer auto-scales the model to fit. |
| Origin | Model origin can be anywhere — the viewer auto-centres it. |
| UV channels | UV1 is required for textures. UV2 is optional; used for AO maps if present. |
| Materials in Blender | Materials baked into the GLB are used as the **starting point** — the viewer then overwrites specific slots based on mesh name. Assign sensible Blender materials anyway so the fallback looks correct. |
| Max file size | No hard limit, but under 50 MB per GLB is recommended for web performance. |

---

## 4. Mesh Naming Convention

This is the most important section. The viewer matches mesh names using **prefix rules** — it checks whether the mesh name **starts with** a specific string. The prefix is case-sensitive.

### Exterior GLB (`exterior.glb`)

This file contains the full aircraft viewed from outside.

#### `Body_` — Main airframe (paint colour applied)

Any mesh that should receive the user's chosen **paint colour and finish** must start with `Body_`.

This includes:
- Fuselage panels
- Nose cone
- Tail section
- Belly fairing
- Any structural surface that is the same colour as the main fuselage

**Examples of valid names:**
```
Body_Fuselage
Body_Fuselage_Upper
Body_Fuselage_Lower
Body_Nose
Body_TailSection
Body_BellyFairing
Body_Door_L
Body_Door_R
Body_ServiceHatch
```

**What the viewer does:** Sets `color` to the chosen paint hex, `roughness` to the chosen finish value (Gloss/Satin/Matte), and applies the exterior paint roughness + normal maps from `/textures/exterior/paint/`.

---

#### `Wing_` — Wings and tail surfaces (same paint as body)

Any aerodynamic surface that should match the fuselage colour must start with `Wing_`.

This includes:
- Main wings (left and right)
- Winglets
- Horizontal stabilisers
- Vertical stabiliser / tail fin
- Control surfaces (ailerons, elevators, rudder) if they should match body colour

**Examples of valid names:**
```
Wing_Left
Wing_Right
Wing_WingletL
Wing_WingletR
Wing_HStab_L
Wing_HStab_R
Wing_VStab
Wing_Aileron_L
Wing_Elevator_L
Wing_Rudder
```

**What the viewer does:** Identical treatment to `Body_` — same paint colour, finish, and texture maps.

---

#### `Engine_Outer` — Engine nacelle exterior (auto-darkened paint)

The outer casing of the engine pod. The viewer applies the same paint colour as the body but **multiplied by 0.82** (slightly darker) and with roughness increased by 0.1 to suggest a different surface condition.

**This prefix must be exactly `Engine_Outer` — do not use just `Engine_`.**

The inner engine (fan face, nozzle, dark internals) should be named with any other prefix or no prefix — it will be left untouched.

**Examples of valid names:**
```
Engine_Outer_L
Engine_Outer_R
Engine_Outer_Pod_L
Engine_Outer_Nacelle_R
```

**Do NOT name these `Engine_Outer`:**
- Fan blade / inlet face → name it `Engine_Inlet_L` or similar (untouched)
- Exhaust nozzle → name it `Engine_Nozzle_L` (untouched)
- Engine pylon → name it `Engine_Pylon_L` (untouched) or `Body_Pylon_L` if it should match fuselage colour

---

#### `Glass_` — Windows (untouched, kept as Blender material)

Windows and canopy glass. The viewer does not modify these — keep whatever semi-transparent material you set in Blender.

**Examples of valid names:**
```
Glass_Window_01
Glass_Window_02
Glass_Cockpit_L
Glass_Cockpit_R
```

---

#### Untouched meshes (no special prefix)

Anything that should keep its Blender material unchanged simply needs to avoid the prefixes above. Good practice is to use a clear descriptive name.

**Examples:**
```
LandingGear_Nose
LandingGear_Main_L
Wheel_Nose
Wheel_Main_L
Antenna_VHF
Pitot_L
NavigationLight_L
StrobLight_Tail
```

---

### Interior GLB (`interior.glb`)

This file contains the cabin viewed from inside. It should be a separate GLB — do not combine exterior and interior into one file.

#### `Seat_` — All seat components (upholstery colour + material texture)

Every mesh that is part of a seat and should receive the user's chosen upholstery must start with `Seat_`.

This includes the cushion, seat back, headrest, and any padded bolsters. It does **not** include armrests (those are `Trim_` — see below).

**Examples of valid names:**
```
Seat_01_Cushion
Seat_01_Back
Seat_01_Headrest
Seat_02_Cushion
Seat_02_Back
Seat_02_Headrest
Seat_Divan_Cushion
Seat_Divan_Back
```

**What the viewer does:** Replaces `map`, `roughnessMap`, `normalMap`, and `aoMap` with the chosen seat texture set (leather or fabric from `/textures/seat/`), then tints with the chosen colour (Ivory, Cognac, Charcoal etc.), and sets roughness to the material-appropriate value.

> **Tip:** All seat meshes share one material instance in the viewer. If you want a seat component to be a different material (e.g. a plastic back shell that should not get leather), name it something else like `Plastic_Seat_Shell_01`.

---

#### `Trim_` — Wood trim, armrests, tables, panels (wood/carbon texture)

Any surface that should receive the user's chosen wood or carbon fibre trim must start with `Trim_`.

This includes:
- Armrests
- Side ledge / window surround
- Centre console facing
- Table tops and table legs (if wooden)
- Cabin divider panels with wood veneer
- Any accent strips or inlays

**Examples of valid names:**
```
Trim_Armrest_01_L
Trim_Armrest_01_R
Trim_WindowLedge_L
Trim_WindowLedge_R
Trim_Table_Centre
Trim_Table_Leg
Trim_Console_Forward
Trim_DividerPanel
Trim_CupHolder_Surround
Trim_Rail_Upper_L
Trim_Rail_Lower_L
```

**What the viewer does:** Replaces `map`, `roughnessMap`, and `normalMap` with the chosen trim texture (walnut, maple, ebony, or carbon from `/textures/trim/`), tints with the trim colour, and sets roughness/metalness appropriate to the trim type.

---

#### `Carpet_` or `Floor_` — Cabin floor (interior style colour)

The floor covering. Either prefix works — use whichever makes more sense for your scene.

**Examples of valid names:**
```
Carpet_Main
Carpet_Aisle
Carpet_Galley
Floor_Galley
Floor_Lavatory
```

**What the viewer does:** Changes the floor colour based on the Interior Style selector (Classic → dark brown, Modern → dark grey-brown, Sport → near-black). No texture is applied currently — add one to `textureRegistry.js` when ready.

---

#### `Light_Strip_` — Emissive cabin lighting strips

Any mesh that acts as an emissive light source inside the cabin — LED strips, mood lighting inlays, backlit panels — must start with `Light_Strip_`.

**Examples of valid names:**
```
Light_Strip_Ceiling_L
Light_Strip_Ceiling_R
Light_Strip_Floor_L
Light_Strip_Floor_R
Light_Strip_Overhead_01
```

**What the viewer does:** Sets `color`, `emissive`, and `emissiveIntensity` on these meshes to the chosen ambient lighting colour (Warm White, Daylight, Rose Blush, Midnight Blue). These meshes should have `roughness = 1` and `metalness = 0` in Blender — the viewer overrides emissive.

---

#### `Glass_` — Porthole windows inside cabin (untouched)

Same as exterior — windows viewed from inside. Left untouched.

```
Glass_Porthole_01
Glass_Porthole_02
```

---

#### Untouched interior meshes

Everything else — structural shell, ceiling panels, galley appliances, lavatory, decorative objects — keeps its Blender material.

**Examples:**
```
Shell_Fuselage_Inner
Ceiling_Panel_Main
Ceiling_Overhead_Bin
Galley_Oven
Galley_Counter
Lav_Door
Metal_Seatbelt_Buckle
Plastic_LightSwitch
```

---

### Quick Reference Table

| Prefix | File | What changes | Driven by |
|--------|------|-------------|-----------|
| `Body_` | exterior.glb | Paint colour, finish roughness | Paint + Finish selectors |
| `Wing_` | exterior.glb | Paint colour, finish roughness | Paint + Finish selectors |
| `Engine_Outer` | exterior.glb | Paint colour (×0.82), finish roughness (+0.1) | Paint + Finish selectors |
| `Glass_` | both | **Nothing — left as Blender material** | — |
| `Seat_` | interior.glb | Upholstery colour + leather/fabric texture | Seat Upholstery selector |
| `Trim_` | interior.glb | Wood/carbon colour + trim texture | Wood Trim selector |
| `Carpet_` | interior.glb | Floor colour (style-dependent) | Interior Style selector |
| `Floor_` | interior.glb | Floor colour (style-dependent) | Interior Style selector |
| `Light_Strip_` | interior.glb | Emissive colour + intensity | Ambient Lighting selector |
| *(anything else)* | both | **Nothing — left as Blender material** | — |

---

## 5. What the Viewer Does to Each Mesh

When the viewer applies a material it **replaces the entire material** on that mesh with a shared `MeshStandardMaterial` instance. This means:

- Any Blender material properties (subsurface scattering, custom nodes, etc.) are lost on affected meshes
- Only `MeshStandardMaterial` properties are used: `color`, `roughness`, `metalness`, `map`, `roughnessMap`, `normalMap`, `aoMap`, `emissive`, `emissiveIntensity`
- Meshes that keep their Blender material are fully unaffected — Blender materials export correctly for those

This is intentional — it gives the viewer full programmatic control over the configurable surfaces.

---

## 6. Textures

See [`textures/README.md`](./textures/README.md) for the full texture specification including file names, resolution, colour space, and tiling guidance.

**Summary:**
- Drop files into the correct subfolder under `/textures/`
- Filenames must match exactly: `baseColor.jpg`, `roughness.jpg`, `normal.jpg`, `ao.jpg`
- Missing files are handled gracefully — the viewer falls back to programmatic colour

---

## 7. Camera Presets

Edit `CAM_PRESETS` in `js/scene.js` to frame your actual models correctly after export:

```js
export const CAM_PRESETS = {
  exterior: {
    position: new THREE.Vector3(8, 3, 14),   // camera position
    target:   new THREE.Vector3(0, 0.5, 0),  // look-at point
  },
  interior: {
    position: new THREE.Vector3(0, 1.2, 4),
    target:   new THREE.Vector3(0, 1.0, 0),
  },
};
```

Use the orbit controls in the browser to find a good angle, then read `camera.position` and `controls.target` from the browser console (`window._camera` and `window._controls` — add those exports temporarily if needed).

---

## 8. Configurator Options

### Exterior
| Option | Choices |
|--------|---------|
| Paint Colour | Pearl White, Midnight Black, Champagne Gold, Navy Eclipse, Silver Mist, Obsidian Red |
| Accent Stripe | None, Gold Accent, Silver Line, Carbon Edge |
| Surface Finish | High Gloss, Satin, Matte |

### Interior
| Option | Choices |
|--------|---------|
| Seat Upholstery | Nappa Leather (Ivory / Cognac / Charcoal), Woven Cloth (Cream / Slate / Navy) |
| Wood Trim | American Walnut, Maple Burl, Macassar Ebony, Carbon Fibre |
| Ambient Lighting | Warm White, Daylight White, Rose Blush, Midnight Blue |
| Interior Style | Classic, Modern, Sport |

---

## 9. Controls

| Action | Input |
|--------|-------|
| Orbit / rotate | Left-click drag |
| Pan | Right-click drag |
| Zoom | Scroll wheel |
| Switch view | Exterior / Interior toggle pill (top centre) |
| Collapse panel | Arrow button on panel header |
| Reset camera | ↺ button (top right) |
| Fullscreen | ⤢ button (top right) |

---

## 10. Hosting

1. Push this folder to a GitHub repository root (or `/docs` subfolder).
2. Go to **Settings → Pages → Source → main branch / root**.
3. Live at `https://<username>.github.io/<repo-name>/`

No npm build step needed — Three.js loads via jsDelivr CDN.

---

## 11. Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| Three.js | 0.165.0 | 3D scene, renderer, PBR materials |
| GLTFLoader | (bundled) | Load `.glb` / `.gltf` models |
| DRACOLoader | (bundled) | Draco-compressed GLB support |
| OrbitControls | (bundled) | Orbit, pan, zoom camera |
| RoomEnvironment | (bundled) | IBL environment lighting |
| Google Fonts | — | Cormorant Garamond + DM Sans |
