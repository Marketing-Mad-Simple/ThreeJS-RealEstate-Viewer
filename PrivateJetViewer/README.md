# AETHER — Private Jet Configurator

An interactive 3D luxury private jet viewer and configurator built with Three.js. View the exterior and interior of a private jet, and customise paint, finish, seat material/colour, wood trim, and ambient lighting — all in real time.

---

## Folder Structure

```
jet-viewer/
├── index.html              ← Entry point
├── css/
│   └── style.css           ← All UI styles (desktop + mobile responsive)
├── js/
│   └── viewer.js           ← Three.js scene, loader, configurator logic
├── models/
│   ├── exterior.glb        ← ⚠️  Place YOUR exterior GLB here
│   └── interior.glb        ← ⚠️  Place YOUR interior GLB here
└── README.md
```

> **No GLB files?** The viewer runs in **Demo Mode** automatically — a procedural jet geometry is shown so you can explore the full UI immediately. Drop in your GLBs when ready.

---

## Setup

### 1. Add your GLB models

Export from Blender (or any DCC tool) and place in `models/`:

| File | Contents |
|------|----------|
| `exterior.glb` | Full aircraft exterior |
| `interior.glb` | Cabin interior scene |

### 2. Name your meshes (Blender convention)

The viewer applies materials based on mesh name prefixes:

| Prefix | What it controls |
|--------|-----------------|
| `Body_` | Fuselage, nose, tail → receives paint colour + finish |
| `Wing_` | Wings, stabilisers → same as Body |
| `Engine_` | Engine pods → slightly darkened paint |
| `Seat_` | All seat parts → seat colour + material roughness |
| `Trim_` | Wood trim, armrests, tables → wood colour |
| `Carpet_` / `Floor_` | Cabin floor → interior style colour |
| `Light_Strip_` | Emissive lighting strips → ambient light colour |
| `Glass_` | Windows → left untouched |

Any meshes not matching these prefixes are left as-is (roads, ground, decorative elements).

### 3. Camera presets

Edit `CAM_PRESETS` in `viewer.js` to match your model scale and focal point:

```js
const CAM_PRESETS = {
  exterior: {
    position: new THREE.Vector3(8, 3, 14),
    target:   new THREE.Vector3(0, 0.5, 0),
  },
  interior: {
    position: new THREE.Vector3(0, 1.2, 4),
    target:   new THREE.Vector3(0, 1.0, 0),
  },
};
```

---

## Configurator Options

### Exterior
| Option | Choices |
|--------|---------|
| Paint Color | Pearl White, Midnight Black, Champagne Gold, Navy Eclipse, Silver Mist, Obsidian Red |
| Accent Stripe | None, Gold, Silver, Carbon |
| Finish Type | Gloss, Matte, Satin |

### Interior
| Option | Choices |
|--------|---------|
| Seat Material | Full Leather, Alcantara, Fine Fabric |
| Seat Color | Ivory, Cognac, Charcoal, Warm Cream, Deep Navy |
| Wood Trim | Walnut, Maple Burl, Ebony, Carbon Fibre |
| Ambient Lighting | Warm White, Cool White, Rose Blush, Midnight Blue |
| Interior Style | Classic, Modern, Sport |

---

## Controls

| Action | Input |
|--------|-------|
| Orbit / rotate | Left-click drag |
| Pan | Right-click drag |
| Zoom | Scroll wheel |
| Switch view | Exterior / Interior toggle (top centre) |
| Collapse panel | Arrow button on panel header |
| Reset camera | ↺ button (top right) |
| Fullscreen | ⤢ button (top right) |

---

## Hosting (GitHub Pages)

1. Push this folder to a GitHub repository root (or `/docs`).
2. Go to **Settings → Pages → Source → main branch / root**.
3. Live at `https://<username>.github.io/<repo-name>/`

No npm build step needed — Three.js loads via jsDelivr CDN.

---

## Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| Three.js | 0.165.0 | 3D scene, renderer, lighting |
| GLTFLoader | (bundled) | Load `.glb` / `.gltf` models |
| DRACOLoader | (bundled) | Compressed GLB support |
| OrbitControls | (bundled) | Orbit, pan, zoom |
| RoomEnvironment | (bundled) | IBL environment map |
| Google Fonts | — | Cormorant Garamond + DM Sans |
