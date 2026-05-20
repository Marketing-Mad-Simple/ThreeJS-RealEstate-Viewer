# AR Work — 3D Site Layout Viewer

An interactive 3D real estate plot viewer built with Three.js. Load your GLB model, click any plot to see its details, filter by status, and orbit freely around the site.

---

## Folder Structure

```
real-estate-viewer/
├── index.html              ← Entry point
├── css/
│   └── style.css           ← All UI styles
├── js/
│   └── viewer.js           ← Three.js scene, GLB loader, raycasting, popups
├── data/
│   └── plots.json          ← Plot info: price, size, status, facing
├── models/
│   └── site.glb            ← ⚠️  Place YOUR exported GLB file here
└── README.md
```

---

## Setup

### 1. Add your GLB
Drop your exported Blender file into `models/` and name it `site.glb`.

**Blender Naming Convention** — every plot mesh must be named:
```
Plot_01, Plot_02, Plot_03 … Plot_57
```
Roads, trees, ground, and other non-interactive meshes can have any name.  
Only meshes whose names match `Plot_XX` will be clickable.

### 2. Update plot data
Edit `data/plots.json` to reflect real prices, sizes, and statuses:
```json
{
  "01": {
    "area": "96 sqm",
    "type": "Small",
    "size": "8 × 12 m",
    "price": "₹38L",
    "status": "available",
    "facing": "North"
  }
}
```

**Status values:** `available` | `reserved` | `sold`

## Hosting on GitHub Pages

1. Push this folder to a GitHub repository (repo root or a `/docs` subfolder).
2. Go to **Settings → Pages**.
3. Set source to `main` branch, `/ (root)` folder (or `/docs` if you put it there).
4. Your viewer will be live at `https://<username>.github.io/<repo-name>/`

> Three.js loads via jsDelivr CDN — no npm build step needed.

---

## Controls

| Action | Input |
|---|---|
| Orbit / rotate | Left-click drag |
| Pan | Right-click drag |
| Zoom | Scroll wheel |
| Select plot | Left-click on a plot |
| Dismiss popup | Click ✕ or click empty space |
| Reset camera | ⌂ button (bottom right) |
| Filter by status | Bottom pill buttons |

---

## Customising Plot Colors

Edit the `STATUS_COLORS` object in `js/viewer.js`:
```js
const STATUS_COLORS = {
  available: 0x4ade80,   // green
  reserved:  0xfbbf24,   // amber
  sold:      0x3b82f6,   // blue
};
```

---

## Adding More Plot Fields

Add new keys to each entry in `plots.json`, then update the popup template in `viewer.js` (`showPopup` function) to render them.

---

## Dependencies

All loaded via CDN — no npm required.

| Library | Version | Purpose |
|---|---|---|
| Three.js | 0.165.0 | 3D scene, renderer, raycasting |
| GLTFLoader | (bundled) | Load `.glb` / `.gltf` files |
| OrbitControls | (bundled) | Zoom, pan, orbit |
| Google Fonts | — | Syne + DM Sans typography |
