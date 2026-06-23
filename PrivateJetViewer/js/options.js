/**
 * options.js
 *
 * All configurator option data.
 *
 * Each option object has:
 *   id          — unique key used in config state
 *   name        — display name shown in the card
 *   desc        — one-line description shown under the name
 *   thumb       — fn(ctx, w, h) that paints the card thumbnail on a 2D canvas
 *
 *   Plus type-specific fields consumed by materials.js:
 *     paint  → color (hex int), metalness
 *     finish → roughness
 *     seat   → color (hex int), material ('leather'|'fabric'), roughness, metalness
 *     wood   → color (hex int), roughness, metalness
 *     light  → color (hex int)
 *     style  → id is the key, no extra fields
 *     stripe → stripeColor (hex int | null)
 */

import * as THREE from 'three';

/* ─────────────────────────────────────────────────────────────────
   THUMBNAIL PAINTERS
   Each returns a function(ctx, w, h) so they can be called lazily
   and reused across multiple canvas sizes.
───────────────────────────────────────────────────────────────── */

function rgb(hex) {
  const c = new THREE.Color(hex);
  return `rgb(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)})`;
}
function rgba(hex, a) {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${a})`;
}

// Paint: metallic solid with specular sheen
export function solidThumb(hex, { roughness = 0.1, metalness = 0.7 } = {}) {
  return (ctx, w, h) => {
    ctx.fillStyle = rgb(hex);
    ctx.fillRect(0, 0, w, h);

    const grd = ctx.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0,    `rgba(255,255,255,${metalness * 0.24})`);
    grd.addColorStop(0.4,  `rgba(255,255,255,0)`);
    grd.addColorStop(1,    `rgba(0,0,0,${roughness * 0.5})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    if (metalness > 0.4) {
      ctx.save();
      ctx.globalAlpha = 0.20;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(w * 0.28, h * 0.22, w * 0.5, h * 0.08, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };
}

// Stripe preview: shows the base paint colour with an accent band
export function stripeThumb(baseHex, stripeHex) {
  return (ctx, w, h) => {
    ctx.fillStyle = rgb(baseHex);
    ctx.fillRect(0, 0, w, h);

    if (stripeHex !== null) {
      ctx.fillStyle = rgb(stripeHex);
      ctx.fillRect(0, h * 0.38, w, h * 0.22);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, h * 0.38, w, 1);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(4, 4);       ctx.lineTo(w-4, h-4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(w-4, 4);     ctx.lineTo(4,   h-4); ctx.stroke();
    }
  };
}

// Finish: same pearl base, different specular treatment
export function finishThumb(roughness) {
  return (ctx, w, h) => {
    ctx.fillStyle = rgb(0xE0DDD8);
    ctx.fillRect(0, 0, w, h);

    if (roughness < 0.15) {
      // Gloss — sharp highlight + dark fall-off
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0,    'rgba(255,255,255,0.70)');
      g.addColorStop(0.22, 'rgba(255,255,255,0)');
      g.addColorStop(1,    'rgba(0,0,0,0.32)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.ellipse(w*0.24, h*0.18, w*0.28, h*0.06, 0, 0, Math.PI*2);
      ctx.fill();
    } else if (roughness < 0.5) {
      // Satin — soft diffuse gradient
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, 'rgba(255,255,255,0.32)');
      g.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    } else {
      // Matte — flat with noise grain
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      for (let i = 0; i < 220; i++) {
        ctx.fillRect(Math.random()*w, Math.random()*h, 1, 1);
      }
    }
  };
}

// Leather: colour tint + stitch lines + grain
export function leatherThumb(hex) {
  return (ctx, w, h) => {
    ctx.fillStyle = rgb(hex);
    ctx.fillRect(0, 0, w, h);

    // Cross-stitch
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2, 5]);
    for (let y = h * 0.18; y < h; y += h * 0.28) {
      ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(w-6, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Subtle grain pores
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    for (let i = 0; i < 20; i++) {
      ctx.fillRect((i * 17 * w / 20) % w, (i * 13 * h / 20) % h, 2.5, 1);
    }

    // Sheen
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  };
}

// Fabric / cloth: woven dot pattern
export function fabricThumb(hex) {
  return (ctx, w, h) => {
    ctx.fillStyle = rgb(hex);
    ctx.fillRect(0, 0, w, h);

    // Warp/weft weave
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let iy = 0; iy < h; iy += 4) {
      for (let ix = (iy % 8 === 0 ? 0 : 2); ix < w; ix += 4) {
        ctx.fillRect(ix, iy, 1.8, 1.8);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let iy = 2; iy < h; iy += 4) {
      for (let ix = (iy % 8 === 0 ? 2 : 0); ix < w; ix += 4) {
        ctx.fillRect(ix, iy, 1.8, 1.8);
      }
    }

    // Soft diffuse sheen (no specular — fabric is not glossy)
    const g = ctx.createRadialGradient(w*0.3, h*0.3, 0, w*0.5, h*0.5, w*0.7);
    g.addColorStop(0, 'rgba(255,255,255,0.09)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  };
}

// Wood trim: colour + grain lines (straight / burl / wavy)
export function woodThumb(hex, grain = 'straight') {
  return (ctx, w, h) => {
    ctx.fillStyle = rgb(hex);
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1;

    if (grain === 'burl') {
      for (let i = 0; i < 6; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${0.03 + i * 0.012})`;
        ctx.beginPath();
        ctx.ellipse(w*(0.18 + i*0.14), h*(0.28 + i*0.07), 7+i*3, 5+i*2, 0.3, 0, Math.PI*2);
        ctx.stroke();
      }
    } else {
      for (let y = 0; y < h; y += 5) {
        ctx.strokeStyle = `rgba(255,255,255,${0.04 + (y % 10 === 0 ? 0.03 : 0)})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y + (grain === 'wavy' ? Math.sin(y * 0.4) * 3 : 0));
        ctx.stroke();
      }
    }

    // Lacquer sheen
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0,   'rgba(255,255,255,0.12)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    g.addColorStop(1,   'rgba(0,0,0,0.14)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  };
}

// Lighting: dark BG with coloured glow + emissive strip
export function lightThumb(hex) {
  return (ctx, w, h) => {
    ctx.fillStyle = '#0E0E12';
    ctx.fillRect(0, 0, w, h);

    const g = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, w*0.55);
    g.addColorStop(0,    rgb(hex));
    g.addColorStop(0.38, rgba(hex, 0.38));
    g.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = rgb(hex);
    ctx.fillRect(0, h*0.44, w, h*0.12);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(0, h*0.44, w, 1);
  };
}

// Floor: wood-plank pattern with two tonal variants
export function floorThumb(variant) {
  return (ctx, w, h) => {
    ctx.fillStyle = variant === 1 ? '#B08050' : '#4A3520';
    ctx.fillRect(0, 0, w, h);

    // Plank dividers
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    for (let y = 0; y <= h; y += Math.round(h / 3)) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(w * 0.5, 0);          ctx.lineTo(w * 0.5, h / 3);  ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w * 0.25, h / 3);     ctx.lineTo(w * 0.25, h * 2 / 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w * 0.75, h * 2 / 3); ctx.lineTo(w * 0.75, h);     ctx.stroke();

    // Subtle grain
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.7;
    for (let y = 3; y < h; y += 5) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y + Math.sin(y * 0.5) * 1.5); ctx.stroke();
    }

    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  };
}

// Metal: brushed-metal look with two tonal variants
export function metalThumb(variant) {
  return (ctx, w, h) => {
    ctx.fillStyle = variant === 1 ? '#9BA3AE' : '#6B7280';
    ctx.fillRect(0, 0, w, h);

    // Horizontal brush lines (deterministic — no Math.random for stable thumbs)
    for (let y = 0; y < h; y += 2) {
      const a = ((y * 37) % 7) * 0.005 + 0.01;
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0,    'rgba(255,255,255,0.30)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.05)');
    g.addColorStop(1,    'rgba(0,0,0,0.22)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    // Sharp specular streak
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(w * 0.25, h * 0.2, w * 0.55, h * 0.05, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
}

// Plastic: smooth surface with a soft highlight, two variants (light / dark)
export function plasticThumb(variant) {
  return (ctx, w, h) => {
    ctx.fillStyle = variant === 1 ? '#D0CCC4' : '#2A2A30';
    ctx.fillRect(0, 0, w, h);

    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0,   'rgba(255,255,255,0.20)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    g.addColorStop(1,   'rgba(0,0,0,0.14)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    // Soft specular dot
    const r = ctx.createRadialGradient(w * 0.3, h * 0.25, 0, w * 0.3, h * 0.25, w * 0.38);
    r.addColorStop(0, 'rgba(255,255,255,0.22)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = r; ctx.fillRect(0, 0, w, h);
  };
}

// Interior style: decorative schematic
export function styleThumb(style) {
  return (ctx, w, h) => {
    if (style === 'classic') {
      ctx.fillStyle = '#221C10'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#C8A96E'; ctx.lineWidth = 1;
      ctx.strokeRect(4, 4, w-8, h-8);
      ctx.strokeRect(8, 8, w-16, h-16);
      // Cross ornament
      ctx.beginPath(); ctx.moveTo(w/2-6, h/2); ctx.lineTo(w/2+6, h/2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(w/2, h/2-6); ctx.lineTo(w/2, h/2+6); ctx.stroke();
    } else if (style === 'modern') {
      ctx.fillStyle = '#12121A'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(200,169,110,0.12)'; ctx.fillRect(0, h*0.55, w, h*0.45);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, h*0.55); ctx.lineTo(w, h*0.55); ctx.stroke();
      // Minimalist circle
      ctx.strokeStyle = 'rgba(200,169,110,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(w/2, h*0.3, 10, 0, Math.PI*2); ctx.stroke();
    } else {
      // Sport: dark carbon + gold diagonal
      ctx.fillStyle = '#0E0E10'; ctx.fillRect(0, 0, w, h);
      // Carbon weave
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
      for (let i = -h; i < w+h; i += 6) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i+h, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i+h, 0); ctx.lineTo(i, h); ctx.stroke();
      }
      // Gold speed stripe
      ctx.strokeStyle = '#C8A96E'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(0, h*0.62); ctx.lineTo(w, h*0.32); ctx.stroke();
    }
  };
}

/* ─────────────────────────────────────────────────────────────────
   OPTION DEFINITIONS
───────────────────────────────────────────────────────────────── */

export const OPTIONS = {

  paint: [
    // metalness: paint/lacquer finishes are 0.0–0.10 (dielectric).
    // Only Silver Mist mimics bare polished metal (0.85).
    // Champagne Gold has a pearl-metallic flake effect (0.35).
    { id:'pearl_white',     name:'Pearl White',     desc:'Timeless aviation white with luminescent depth.',           color:0xF0EEE9, metalness:0.05, thumb: solidThumb(0xF0EEE9, {roughness:0.10, metalness:0.05}) },
    { id:'midnight_black',  name:'Midnight Black',  desc:'Deep obsidian that absorbs and refracts light.',           color:0x1A1A1E, metalness:0.08, thumb: solidThumb(0x1A1A1E, {roughness:0.08, metalness:0.08}) },
    { id:'champagne_gold',  name:'Champagne Gold',  desc:'Warm metallic gold reminiscent of grand boulevards.',      color:0xC8A96E, metalness:0.35, thumb: solidThumb(0xC8A96E, {roughness:0.10, metalness:0.35}) },
    { id:'navy_eclipse',    name:'Navy Eclipse',    desc:'Rich midnight blue with subtle atmospheric shimmer.',      color:0x1C2B4A, metalness:0.05, thumb: solidThumb(0x1C2B4A, {roughness:0.12, metalness:0.05}) },
    { id:'silver_mist',     name:'Silver Mist',     desc:'Cool brushed silver with refined industrial character.',   color:0xA8AEBA, metalness:0.85, thumb: solidThumb(0xA8AEBA, {roughness:0.15, metalness:0.85}) },
    { id:'obsidian_red',    name:'Obsidian Red',    desc:'Deep burgundy with a commanding, assertive presence.',    color:0x6B1E22, metalness:0.05, thumb: solidThumb(0x6B1E22, {roughness:0.14, metalness:0.05}) },
  ],

  stripe: [
    { id:'none',   name:'No Stripe',    desc:'Clean, uninterrupted exterior lines.',                        stripeColor: null,     thumb: stripeThumb(0xF0EEE9, null)     },
    { id:'gold',   name:'Gold Accent',  desc:'A signature gold pinstripe along the fuselage.',             stripeColor:0xC8A96E,  thumb: stripeThumb(0xF0EEE9, 0xC8A96E) },
    { id:'silver', name:'Silver Line',  desc:'Understated silver for a clean aeronautic silhouette.',      stripeColor:0xC0C4CC,  thumb: stripeThumb(0xF0EEE9, 0xC0C4CC) },
    { id:'carbon', name:'Carbon Edge',  desc:'High-contrast carbon for a sport-influenced look.',          stripeColor:0x2A2A2A,  thumb: stripeThumb(0xF0EEE9, 0x2A2A2A) },
  ],

  finish: [
    { id:'gloss', name:'High Gloss', desc:'Mirror-like surface that reflects with precision.',   roughness:0.08, thumb: finishThumb(0.08) },
    { id:'satin', name:'Satin',      desc:'Soft mid-sheen — refined without being flashy.',      roughness:0.35, thumb: finishThumb(0.35) },
    { id:'matte', name:'Matte',      desc:'Flat, tactile and undeniably contemporary.',          roughness:0.72, thumb: finishThumb(0.72) },
  ],

  // Seat options: material key maps to texture set in textureRegistry
  seat: [
    { id:'leather_ivory',   name:'Nappa Leather · Ivory',  desc:'Supple full-grain Nappa in ivory — the classic aviation choice.',            color:0xE8E0D0, material:'leather',   roughness:0.45, metalness:0.02, thumb: leatherThumb(0xE8E0D0) },
    { id:'leather_cognac',  name:'Nappa Leather · Cognac', desc:'Rich cognac leather with warm amber and chocolate undertones.',               color:0x8B5E3C, material:'leather',   roughness:0.45, metalness:0.02, thumb: leatherThumb(0x8B5E3C) },
    { id:'smooth_leather',  name:'Smooth Leather',         desc:'Full-grain leather with a supple hand feel and subtle natural pore structure — precision-baked for photorealistic surface detail.',  color:0xFFFFFF, material:'leather_1', roughness:0.40, metalness:0.02, thumb: leatherThumb(0xC49A6C) },
    { id:'quilted_leather', name:'Quilted Leather',        desc:'Diamond-stitched leather in the classic aviation configuration — every stitch and crease captured in the baked texture.',            color:0xFFFFFF, material:'leather_2', roughness:0.38, metalness:0.02, thumb: leatherThumb(0xA0714A) },
  ],

  wood: [
    { id:'walnut', name:'American Walnut',       desc:'Straight-grain walnut with warm chocolate tones and open pores.',                                                                  color:0x5C3D1E, roughness:0.38, metalness:0.05, thumb: woodThumb(0x5C3D1E, 'straight') },
    { id:'maple',  name:'Maple Burl',            desc:'Rare burl maple with dramatic swirling figure and golden lustre.',                                                                 color:0xC8A882, roughness:0.32, metalness:0.05, thumb: woodThumb(0xC8A882, 'burl')     },
    { id:'trim_1', name:'Natural Wood Veneer',   desc:'Warm-toned wood veneer with an open-grain finish — baked from the full interior UV set for precise grain alignment across every trim surface.',  color:0xFFFFFF, roughness:0.35, metalness:0.03, thumb: woodThumb(0x9B7040, 'straight')  },
    { id:'trim_2', name:'Dark Wood Veneer',      desc:'Deep-toned veneer with a tight grain and lacquered surface — baked from the full interior UV set for dramatic, seamless coverage.', color:0xFFFFFF, roughness:0.25, metalness:0.03, thumb: woodThumb(0x3A2010, 'wavy')      },
  ],

  floor: [
    { id:'floor_1', name:'Natural Hardwood', desc:'Warm natural hardwood with open grain and a satin sheen — baked from the cabin floor UV layout for seamless plank alignment.',     roughness:0.75, metalness:0.0, thumb: floorThumb(1) },
    { id:'floor_2', name:'Dark Hardwood',    desc:'Rich dark-stained hardwood with deep contrast and a refined matte surface — baked from the cabin floor UV layout for full fidelity.', roughness:0.75, metalness:0.0, thumb: floorThumb(2) },
  ],

  metal: [
    { id:'metal_1', name:'Brushed Silver',  desc:'Satin-brushed aluminium with cool neutral tones — baked with directional grain detail for a premium industrial finish.',          roughness:0.45, metalness:0.85, thumb: metalThumb(1) },
    { id:'metal_2', name:'Gunmetal',        desc:'Burnished dark metal with rich depth and contrast — baked surface detail adds micro-scratch variation for a bold, refined look.', roughness:0.40, metalness:0.85, thumb: metalThumb(2) },
  ],

  plastic: [
    { id:'plastic_1', name:'Warm Tan Trim',        desc:'Warm earthy-toned cabin plastic with a smooth matte surface — baked texture captures subtle panel lines and mould transitions with a natural sand tone.', roughness:0.55, metalness:0.0, thumb: solidThumb(0xB08860, {roughness:0.55, metalness:0.0}) },
    { id:'plastic_2', name:'Graphite Cabin Trim',  desc:'Dark graphite cabin plastic with a high-performance aesthetic — baked surface detail adds micro-texture for a tactile, refined finish.',                   roughness:0.50, metalness:0.0, thumb: plasticThumb(2) },
  ],

  lighting: [
    { id:'warm', name:'Warm White',     desc:'Golden 2700 K glow — intimate and inviting.',          color:0xF4C77A, thumb: lightThumb(0xF4C77A) },
    { id:'cool', name:'Daylight White', desc:'Crisp 5000 K brightness — energising and clear.',      color:0xD0E8FF, thumb: lightThumb(0xD0E8FF) },
    { id:'rose', name:'Rose Blush',     desc:'Soft rose-tinted mood lighting for evening travel.',   color:0xFFD0D8, thumb: lightThumb(0xFFD0D8) },
    { id:'blue', name:'Midnight Blue',  desc:'Cool blue ambience — serene and ultramodern.',         color:0xA0C8FF, thumb: lightThumb(0xA0C8FF) },
  ],

};

/* Default config state */
export const DEFAULT_CONFIG = {
  paint:   'pearl_white',
  stripe:  'none',
  finish:  'gloss',
  seat:    'leather_ivory',
  wood:    'walnut',
  lighting:'warm',
  floor:   'floor_1',
  metal:   'metal_1',
  plastic: 'plastic_1',
};

/* Helper: resolve an option object from OPTIONS by group + id */
export function resolveOpt(group, id) {
  return OPTIONS[group].find(o => o.id === id) || OPTIONS[group][0];
}
