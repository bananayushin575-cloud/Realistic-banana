import * as THREE from 'three';

import {computeRipenessPalette} from './bananaMath';

interface SugarSpot {
  u: number;
  v: number;
  rx: number;
  ry: number;
  angle: number;
  threshold: number;
  haloScale: number;
  intensity: number;
  kind: 'sugar' | 'freckle' | 'russet';
}

export interface BananaTextureSet {
  peelMap: THREE.CanvasTexture;
  peelBumpMap: THREE.CanvasTexture;
  peelRoughnessMap: THREE.CanvasTexture;
  pithMap: THREE.CanvasTexture;
  pithBumpMap: THREE.CanvasTexture;
  fleshMap: THREE.CanvasTexture;
  fleshBumpMap: THREE.CanvasTexture;
  stemMap: THREE.CanvasTexture;
  stemCutMap: THREE.CanvasTexture;
  blossomMap: THREE.CanvasTexture;
  shadowMap: THREE.CanvasTexture;
  pedestalMap: THREE.CanvasTexture;
  updateRipeness(ripeness: number): void;
  dispose(): void;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function configureTexture(
  texture: THREE.CanvasTexture,
  isColor: boolean,
  maxAnisotropy: number,
  wrapRepeat = true
): THREE.CanvasTexture {
  if (isColor) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  texture.wrapS = wrapRepeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

function buildSeededSpots(rng: () => number): SugarSpot[] {
  const spots: SugarSpot[] = [];
  // 1. Fine epidermal freckles & tiny russet flecks along ridges
  for (let i = 0; i < 140; i++) {
    const ridgeIndex = Math.floor(rng() * 5);
    const ridgeU = (0.1 + ridgeIndex * 0.2) % 1;
    const nearRidge = rng() < 0.6;
    const u = nearRidge
      ? (ridgeU + (rng() - 0.5) * 0.045 + 1) % 1
      : rng();
    const v = 0.08 + rng() * 0.84;
    spots.push({
      u,
      v,
      rx: 0.002 + rng() * 0.004,
      ry: 0.003 + rng() * 0.008,
      angle: (rng() - 0.5) * 0.35,
      threshold: 0.25 + rng() * 0.55,
      haloScale: 1.5,
      intensity: 0.35 + rng() * 0.4,
      kind: nearRidge && rng() < 0.55 ? 'russet' : 'freckle',
    });
  }

  // 2. Classic Cavendish sugar spots (cluster slightly along mid-belly & shoulders)
  for (let i = 0; i < 190; i++) {
    const u = rng();
    // Bias slightly toward belly & upper shoulder
    const v = Math.min(0.93, Math.max(0.06, 0.12 + rng() * 0.78));
    const baseSize = 0.004 + Math.pow(rng(), 1.8) * 0.015;
    spots.push({
      u,
      v,
      rx: baseSize * (0.75 + rng() * 0.5),
      ry: baseSize * (1.0 + rng() * 0.9),
      angle: (rng() - 0.5) * 0.4,
      threshold: 0.42 + rng() * 0.54,
      haloScale: 1.7 + rng() * 0.6,
      intensity: 0.65 + rng() * 0.35,
      kind: 'sugar',
    });
  }
  return spots;
}

export function createBananaTextureSet(
  renderer?: THREE.WebGLRenderer | null,
  initialRipeness = 0.55
): BananaTextureSet {
  const maxAnisotropy = renderer
    ? Math.min(8, renderer.capabilities.getMaxAnisotropy())
    : 4;
  const rng = createMulberry32(20261118);
  const spots = buildSeededSpots(rng);

  const W = 1024;
  const H = 1024;

  // --- Static peel fiber & cuticle micro-detail layer (composited once) ---
  const peelFiberOverlay = createCanvas(W, H);
  const fiberCtx = peelFiberOverlay.getContext('2d')!;
  fiberCtx.clearRect(0, 0, W, H);

  // Fine longitudinal vascular striations across the epidermis
  for (let i = 0; i < 650; i++) {
    const x = rng() * W;
    const isLight = rng() < 0.5;
    fiberCtx.strokeStyle = isLight
      ? `rgba(255, 252, 220, ${(0.03 + rng() * 0.05).toFixed(3)})`
      : `rgba(110, 88, 18, ${(0.035 + rng() * 0.055).toFixed(3)})`;
    fiberCtx.lineWidth = 0.8 + rng() * 2.1;
    fiberCtx.beginPath();
    let cx = x;
    fiberCtx.moveTo(cx, 0);
    for (let seg = 1; seg <= 16; seg++) {
      cx += (rng() - 0.5) * 2.2;
      fiberCtx.lineTo(cx, (seg / 16) * H);
    }
    fiberCtx.stroke();
  }

  // Subtle organic micro-mottling patches (natural plant pigment unevenness)
  for (let i = 0; i < 240; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const rx = 12 + rng() * 44;
    const ry = 28 + rng() * 90;
    const g = fiberCtx.createRadialGradient(x, y, 2, x, y, ry);
    const bright = rng() < 0.52;
    g.addColorStop(
      0,
      bright ? 'rgba(255, 248, 195, 0.06)' : 'rgba(130, 110, 20, 0.055)'
    );
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    fiberCtx.fillStyle = g;
    fiberCtx.beginPath();
    fiberCtx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    fiberCtx.fill();
  }

  // --- Peel Albedo Canvas ---
  const peelCanvas = createCanvas(W, H);
  const peelCtx = peelCanvas.getContext('2d')!;
  const peelMap = configureTexture(new THREE.CanvasTexture(peelCanvas), true, maxAnisotropy);

  // --- Peel Bump & Roughness Maps (512x512 linear) ---
  const BW = 512;
  const BH = 512;
  const bumpCanvas = createCanvas(BW, BH);
  const bumpCtx = bumpCanvas.getContext('2d')!;
  bumpCtx.fillStyle = '#808080';
  bumpCtx.fillRect(0, 0, BW, BH);

  const roughCanvas = createCanvas(BW, BH);
  const roughCtx = roughCanvas.getContext('2d')!;
  roughCtx.fillStyle = '#585858'; // ~0.34 base waxy satin
  roughCtx.fillRect(0, 0, BW, BH);

  // Draw vascular fiber micro-ribs into bump + subtle matte streaks into roughness
  for (let i = 0; i < 420; i++) {
    const x = rng() * BW;
    const shade = Math.floor(110 + rng() * 38);
    bumpCtx.strokeStyle = `rgba(${shade}, ${shade}, ${shade}, 0.25)`;
    bumpCtx.lineWidth = 0.8 + rng() * 1.4;
    bumpCtx.beginPath();
    bumpCtx.moveTo(x, 0);
    bumpCtx.lineTo(x + (rng() - 0.5) * 4, BH);
    bumpCtx.stroke();
  }

  // Epidermal waxy cuticle pores
  for (let i = 0; i < 1800; i++) {
    const x = rng() * BW;
    const y = rng() * BH;
    const r = 0.6 + rng() * 1.3;
    const v = rng() < 0.5 ? 105 : 148;
    bumpCtx.fillStyle = `rgba(${v},${v},${v},0.16)`;
    bumpCtx.beginPath();
    bumpCtx.arc(x, y, r, 0, Math.PI * 2);
    bumpCtx.fill();
  }

  // Roughness variation: ridges slightly rougher, neck & tip matte
  for (let k = 0; k < 5; k++) {
    const rx = ((0.1 + k * 0.2) % 1) * BW;
    const grad = roughCtx.createLinearGradient(rx - 18, 0, rx + 18, 0);
    grad.addColorStop(0, 'rgba(130, 130, 130, 0)');
    grad.addColorStop(0.5, 'rgba(130, 130, 130, 0.22)');
    grad.addColorStop(1, 'rgba(130, 130, 130, 0)');
    roughCtx.fillStyle = grad;
    roughCtx.fillRect(rx - 18, 0, 36, BH);
  }
  const neckRoughGrad = roughCtx.createLinearGradient(0, 0, 0, BH * 0.16);
  neckRoughGrad.addColorStop(0, 'rgba(175, 175, 175, 0.72)');
  neckRoughGrad.addColorStop(1, 'rgba(175, 175, 175, 0)');
  roughCtx.fillStyle = neckRoughGrad;
  roughCtx.fillRect(0, 0, BW, BH * 0.16);

  const tipRoughGrad = roughCtx.createLinearGradient(0, BH * 0.88, 0, BH);
  tipRoughGrad.addColorStop(0, 'rgba(175, 175, 175, 0)');
  tipRoughGrad.addColorStop(1, 'rgba(175, 175, 175, 0.82)');
  roughCtx.fillStyle = tipRoughGrad;
  roughCtx.fillRect(0, BH * 0.88, BW, BH * 0.12);

  const peelBumpMap = configureTexture(
    new THREE.CanvasTexture(bumpCanvas),
    false,
    maxAnisotropy
  );
  const peelRoughnessMap = configureTexture(
    new THREE.CanvasTexture(roughCanvas),
    false,
    maxAnisotropy
  );

  // --- Inner Peel Pith Texture (creamy fibrous stringy albedo) ---
  const pithCanvas = createCanvas(512, 512);
  const pithCtx = pithCanvas.getContext('2d')!;
  pithCtx.fillStyle = '#f5ecd0';
  pithCtx.fillRect(0, 0, 512, 512);
  const pithBumpCanvas = createCanvas(512, 512);
  const pithBumpCtx = pithBumpCanvas.getContext('2d')!;
  pithBumpCtx.fillStyle = '#808080';
  pithBumpCtx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 360; i++) {
    const x = rng() * 512;
    pithCtx.strokeStyle =
      rng() < 0.55 ? 'rgba(255, 252, 240, 0.35)' : 'rgba(218, 198, 145, 0.25)';
    pithCtx.lineWidth = 1 + rng() * 2.8;
    pithCtx.beginPath();
    pithCtx.moveTo(x, 0);
    pithCtx.lineTo(x + (rng() - 0.5) * 6, 512);
    pithCtx.stroke();

    const bv = Math.floor(95 + rng() * 70);
    pithBumpCtx.strokeStyle = `rgba(${bv}, ${bv}, ${bv}, 0.35)`;
    pithBumpCtx.lineWidth = 1 + rng() * 2.5;
    pithBumpCtx.beginPath();
    pithBumpCtx.moveTo(x, 0);
    pithBumpCtx.lineTo(x + (rng() - 0.5) * 6, 512);
    pithBumpCtx.stroke();
  }
  const pithMap = configureTexture(new THREE.CanvasTexture(pithCanvas), true, maxAnisotropy);
  const pithBumpMap = configureTexture(
    new THREE.CanvasTexture(pithBumpCanvas),
    false,
    maxAnisotropy
  );

  // --- Inner Edible Flesh Texture ---
  const fleshCanvas = createCanvas(512, 512);
  const fleshCtx = fleshCanvas.getContext('2d')!;
  const fleshGrad = fleshCtx.createLinearGradient(0, 0, 0, 512);
  fleshGrad.addColorStop(0, '#f3e5b2');
  fleshGrad.addColorStop(0.5, '#f8ecc3');
  fleshGrad.addColorStop(1, '#f1dfa6');
  fleshCtx.fillStyle = fleshGrad;
  fleshCtx.fillRect(0, 0, 512, 512);

  const fleshBumpCanvas = createCanvas(512, 512);
  const fleshBumpCtx = fleshBumpCanvas.getContext('2d')!;
  fleshBumpCtx.fillStyle = '#808080';
  fleshBumpCtx.fillRect(0, 0, 512, 512);

  // Soft vertical fibrous grain & subtle 3-carpel seam lines
  for (let c = 0; c < 3; c++) {
    const cx = ((c + 0.5) / 3) * 512;
    const cg = fleshCtx.createLinearGradient(cx - 12, 0, cx + 12, 0);
    cg.addColorStop(0, 'rgba(225, 198, 128, 0)');
    cg.addColorStop(0.5, 'rgba(225, 198, 128, 0.22)');
    cg.addColorStop(1, 'rgba(225, 198, 128, 0)');
    fleshCtx.fillStyle = cg;
    fleshCtx.fillRect(cx - 12, 0, 24, 512);
  }
  for (let i = 0; i < 450; i++) {
    const x = rng() * 512;
    const y = rng() * 512;
    fleshCtx.fillStyle =
      rng() < 0.5 ? 'rgba(255, 252, 238, 0.16)' : 'rgba(218, 196, 130, 0.14)';
    fleshCtx.fillRect(x, y, 1.5, 14 + rng() * 34);

    const bShade = rng() < 0.5 ? 112 : 144;
    fleshBumpCtx.fillStyle = `rgba(${bShade},${bShade},${bShade},0.22)`;
    fleshBumpCtx.fillRect(x, y, 1.5, 10 + rng() * 24);
  }
  // Tiny organic ovule/seed micro-specks faintly visible through flesh
  for (let i = 0; i < 95; i++) {
    const x = rng() * 512;
    const y = 30 + rng() * 450;
    fleshCtx.fillStyle = `rgba(145, 110, 62, ${(0.08 + rng() * 0.1).toFixed(3)})`;
    fleshCtx.beginPath();
    fleshCtx.ellipse(x, y, 1.2, 2.2, 0, 0, Math.PI * 2);
    fleshCtx.fill();
  }
  const fleshMap = configureTexture(new THREE.CanvasTexture(fleshCanvas), true, maxAnisotropy);
  const fleshBumpMap = configureTexture(
    new THREE.CanvasTexture(fleshBumpCanvas),
    false,
    maxAnisotropy
  );

  // --- Woody Stem (Pedicel) Bark Texture (updated dynamically on ripeness) ---
  const stemCanvas = createCanvas(256, 256);
  const stemCtx = stemCanvas.getContext('2d')!;
  const stemMap = configureTexture(new THREE.CanvasTexture(stemCanvas), true, maxAnisotropy);

  // --- Cut Crown Fibrous Face Texture ---
  const stemCutCanvas = createCanvas(256, 256);
  const cutCtx = stemCutCanvas.getContext('2d')!;
  cutCtx.fillStyle = '#c9b37e';
  cutCtx.fillRect(0, 0, 256, 256);
  const cutGrad = cutCtx.createRadialGradient(128, 128, 10, 128, 128, 126);
  cutGrad.addColorStop(0, '#d7c598');
  cutGrad.addColorStop(0.72, '#b39a65');
  cutGrad.addColorStop(0.9, '#6e5732');
  cutGrad.addColorStop(1, '#4a3d22');
  cutCtx.fillStyle = cutGrad;
  cutCtx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 110; i++) {
    const ang = rng() * Math.PI * 2;
    const dist = Math.sqrt(rng()) * 102;
    const x = 128 + Math.cos(ang) * dist;
    const y = 128 + Math.sin(ang) * dist;
    cutCtx.fillStyle =
      rng() < 0.65 ? 'rgba(92, 68, 34, 0.45)' : 'rgba(235, 222, 185, 0.35)';
    cutCtx.beginPath();
    cutCtx.arc(x, y, 1.4 + rng() * 2.4, 0, Math.PI * 2);
    cutCtx.fill();
  }
  const stemCutMap = configureTexture(
    new THREE.CanvasTexture(stemCutCanvas),
    true,
    maxAnisotropy,
    false
  );

  // --- Blossom End Dried Floral Nub Texture ---
  const blossomCanvas = createCanvas(128, 128);
  const blCtx = blossomCanvas.getContext('2d')!;
  blCtx.fillStyle = '#2d1e13';
  blCtx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 180; i++) {
    const x = rng() * 128;
    const y = rng() * 128;
    blCtx.fillStyle =
      rng() < 0.5 ? 'rgba(18, 10, 6, 0.4)' : 'rgba(72, 50, 30, 0.32)';
    blCtx.beginPath();
    blCtx.arc(x, y, 1 + rng() * 3.5, 0, Math.PI * 2);
    blCtx.fill();
  }
  const blossomMap = configureTexture(
    new THREE.CanvasTexture(blossomCanvas),
    true,
    maxAnisotropy,
    false
  );

  // --- Soft Radial Contact Shadow Texture ---
  const shadowCanvas = createCanvas(256, 256);
  const shCtx = shadowCanvas.getContext('2d')!;
  const shGrad = shCtx.createRadialGradient(128, 128, 8, 128, 128, 124);
  shGrad.addColorStop(0, 'rgba(8, 10, 14, 0.58)');
  shGrad.addColorStop(0.42, 'rgba(8, 10, 14, 0.28)');
  shGrad.addColorStop(0.75, 'rgba(8, 10, 14, 0.08)');
  shGrad.addColorStop(1, 'rgba(8, 10, 14, 0)');
  shCtx.fillStyle = shGrad;
  shCtx.fillRect(0, 0, 256, 256);
  const shadowMap = configureTexture(
    new THREE.CanvasTexture(shadowCanvas),
    true,
    maxAnisotropy,
    false
  );

  // --- Studio Slate Pedestal Texture ---
  const pedCanvas = createCanvas(512, 512);
  const pedCtx = pedCanvas.getContext('2d')!;
  const pedGrad = pedCtx.createRadialGradient(256, 256, 16, 256, 256, 256);
  pedGrad.addColorStop(0, '#2a2e36');
  pedGrad.addColorStop(0.7, '#22262e');
  pedGrad.addColorStop(1, '#1a1d24');
  pedCtx.fillStyle = pedGrad;
  pedCtx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1600; i++) {
    const x = rng() * 512;
    const y = rng() * 512;
    const v = rng() < 0.5 ? 52 : 24;
    pedCtx.fillStyle = `rgba(${v}, ${v + 2}, ${v + 6}, 0.14)`;
    pedCtx.fillRect(x, y, 1 + rng() * 3, 1 + rng() * 2);
  }
  const pedestalMap = configureTexture(
    new THREE.CanvasTexture(pedCanvas),
    true,
    maxAnisotropy,
    false
  );

  let lastDrawnRipeness = -1;

  function drawPeelForRipeness(ripeness: number) {
    const palette = computeRipenessPalette(ripeness);

    // 1. Longitudinal base gradient (y=0 top neck -> y=H bottom blossom tip)
    const vGrad = peelCtx.createLinearGradient(0, 0, 0, H);
    vGrad.addColorStop(0.0, palette.neckTipHex);
    vGrad.addColorStop(0.11, palette.baseHex);
    vGrad.addColorStop(0.35, palette.bellyHex);
    vGrad.addColorStop(0.68, palette.baseHex);
    vGrad.addColorStop(0.9, palette.baseHex);
    vGrad.addColorStop(1.0, palette.neckTipHex);
    peelCtx.fillStyle = vGrad;
    peelCtx.fillRect(0, 0, W, H);

    // 2. Subtle tonal variation along the 5 ridge crests (u = 0.1, 0.3, 0.5, 0.7, 0.9)
    for (let k = 0; k < 5; k++) {
      const rx = ((0.1 + k * 0.2) % 1) * W;
      const ridgeGrad = peelCtx.createLinearGradient(rx - 28, 0, rx + 28, 0);
      ridgeGrad.addColorStop(0, 'rgba(0,0,0,0)');
      ridgeGrad.addColorStop(0.5, palette.ridgeTintHex);
      ridgeGrad.addColorStop(1, 'rgba(0,0,0,0)');
      peelCtx.save();
      peelCtx.globalAlpha = 0.26 + palette.ripeness * 0.24;
      peelCtx.fillStyle = ridgeGrad;
      peelCtx.fillRect(rx - 28, 0, 56, H);
      peelCtx.restore();
    }

    // 3. Static vascular fiber & mottling layer
    peelCtx.drawImage(peelFiberOverlay, 0, 0);

    // 4. Sugar spots & russeting flecks (driven smoothly by ripeness)
    if (palette.spotOpacity > 0.01) {
      for (const spot of spots) {
        if (ripeness < spot.threshold - 0.12) continue;
        const localProgress = Math.min(
          1,
          Math.max(0, (ripeness - (spot.threshold - 0.12)) / 0.28)
        );
        const alpha = localProgress * spot.intensity * palette.spotOpacity;
        if (alpha < 0.02) continue;

        const cx = spot.u * W;
        const cy = (1 - spot.v) * H;
        const rx = spot.rx * W * (0.7 + 0.45 * localProgress);
        const ry = spot.ry * H * (0.7 + 0.45 * localProgress);

        // Draw wrapped horizontally if near UV seam x=0 or x=W
        const offsets = cx < rx * 2 ? [0, W] : cx > W - rx * 2 ? [0, -W] : [0];
        for (const ox of offsets) {
          const px = cx + ox;
          peelCtx.save();
          peelCtx.translate(px, cy);
          peelCtx.rotate(spot.angle);

          if (spot.kind === 'sugar') {
            // Golden-ochre halo + dark umber core
            const haloR = Math.max(rx, ry) * spot.haloScale;
            const halo = peelCtx.createRadialGradient(0, 0, haloR * 0.15, 0, 0, haloR);
            halo.addColorStop(0, `rgba(68, 36, 12, ${(alpha * 0.92).toFixed(3)})`);
            halo.addColorStop(0.45, `rgba(112, 62, 16, ${(alpha * 0.7).toFixed(3)})`);
            halo.addColorStop(0.75, `rgba(178, 114, 22, ${(alpha * 0.34).toFixed(3)})`);
            halo.addColorStop(1, 'rgba(178, 114, 22, 0)');
            peelCtx.scale(rx / haloR, ry / haloR);
            peelCtx.fillStyle = halo;
            peelCtx.beginPath();
            peelCtx.arc(0, 0, haloR, 0, Math.PI * 2);
            peelCtx.fill();
          } else {
            peelCtx.fillStyle =
              spot.kind === 'russet'
                ? `rgba(118, 76, 30, ${(alpha * 0.65).toFixed(3)})`
                : `rgba(82, 48, 18, ${(alpha * 0.72).toFixed(3)})`;
            peelCtx.beginPath();
            peelCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
            peelCtx.fill();
          }
          peelCtx.restore();
        }
      }
    }

    // 5. Update woody pedicel stem bark tint
    stemCtx.fillStyle = palette.stemHex;
    stemCtx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 120; i++) {
      const sx = (i / 120) * 256;
      stemCtx.strokeStyle =
        i % 3 === 0 ? 'rgba(42, 32, 16, 0.25)' : 'rgba(180, 170, 95, 0.15)';
      stemCtx.lineWidth = 1.6;
      stemCtx.beginPath();
      stemCtx.moveTo(sx, 0);
      stemCtx.lineTo(sx + ((i % 5) - 2) * 2, 256);
      stemCtx.stroke();
    }
    const stemCrownGrad = stemCtx.createLinearGradient(0, 0, 0, 72);
    stemCrownGrad.addColorStop(0, 'rgba(58, 44, 24, 0.72)');
    stemCrownGrad.addColorStop(1, 'rgba(58, 44, 24, 0)');
    stemCtx.fillStyle = stemCrownGrad;
    stemCtx.fillRect(0, 0, 256, 72);

    peelMap.needsUpdate = true;
    stemMap.needsUpdate = true;
    lastDrawnRipeness = ripeness;
  }

  drawPeelForRipeness(initialRipeness);

  return {
    peelMap,
    peelBumpMap,
    peelRoughnessMap,
    pithMap,
    pithBumpMap,
    fleshMap,
    fleshBumpMap,
    stemMap,
    stemCutMap,
    blossomMap,
    shadowMap,
    pedestalMap,
    updateRipeness(ripeness: number) {
      if (Math.abs(ripeness - lastDrawnRipeness) < 0.015) return;
      drawPeelForRipeness(ripeness);
    },
    dispose() {
      peelMap.dispose();
      peelBumpMap.dispose();
      peelRoughnessMap.dispose();
      pithMap.dispose();
      pithBumpMap.dispose();
      fleshMap.dispose();
      fleshBumpMap.dispose();
      stemMap.dispose();
      stemCutMap.dispose();
      blossomMap.dispose();
      shadowMap.dispose();
      pedestalMap.dispose();
    },
  };
}
