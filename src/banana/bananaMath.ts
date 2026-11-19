export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SpineSample {
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

export interface RipenessPalette {
  ripeness: number;
  stageLabel: string;
  stageLabelJa: string;
  stageSubtitle: string;
  baseHex: string;
  bellyHex: string;
  neckTipHex: string;
  ridgeTintHex: string;
  stemHex: string;
  spotDensity: number;
  spotOpacity: number;
  roughness: number;
  clearcoat: number;
}

export const BANANA_SPEC = {
  /** Number of natural longitudinal ridges on a Cavendish banana. */
  ridgeCount: 5,
  /** Number of articulated peel petals (aligned 1-to-1 with ridges). */
  petalCount: 5,
  /** Maximum mid-belly radius in meters at 1:1 real scale (~4.1 cm diameter). */
  maxRadius: 0.0208,
  /** Outer peel wall thickness in meters at mid-belly (~2.3 mm). */
  peelThickness: 0.0023,
  /** Pedicel (woody stem) approximate length in meters at 1:1 scale. */
  pedicelLength: 0.044,
  /** Maximum peel fraction of spine length when fully peeled. */
  maxPeelFraction: 0.56,
} as const;

const SPINE_P0: Vec3 = {x: 0.044, y: 0.0, z: 0.0};
const SPINE_P1: Vec3 = {x: -0.016, y: 0.056, z: 0.0025};
const SPINE_P2: Vec3 = {x: -0.022, y: 0.148, z: -0.002};
const SPINE_P3: Vec3 = {x: 0.04, y: 0.204, z: 0.0};

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-8) return {x: 0, y: 1, z: 0};
  return {x: v.x / len, y: v.y / len, z: v.z / len};
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Evaluates the banana spine position and Bishop-like non-twisting frame at t in [0, 1].
 * t = 0 is the bottom blossom tip; t = 1 is the upper neck shoulder where the pedicel begins.
 */
export function evaluateBananaSpine(tInput: number): SpineSample {
  const t = clamp01(tInput);
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;

  const w0 = uu * u;
  const w1 = 3 * uu * t;
  const w2 = 3 * u * tt;
  const w3 = tt * t;

  const position: Vec3 = {
    x: w0 * SPINE_P0.x + w1 * SPINE_P1.x + w2 * SPINE_P2.x + w3 * SPINE_P3.x,
    y: w0 * SPINE_P0.y + w1 * SPINE_P1.y + w2 * SPINE_P2.y + w3 * SPINE_P3.y,
    z: w0 * SPINE_P0.z + w1 * SPINE_P1.z + w2 * SPINE_P2.z + w3 * SPINE_P3.z,
  };

  const d0 = 3 * uu;
  const d1 = 6 * u * t;
  const d2 = 3 * tt;

  const rawTangent: Vec3 = {
    x:
      d0 * (SPINE_P1.x - SPINE_P0.x) +
      d1 * (SPINE_P2.x - SPINE_P1.x) +
      d2 * (SPINE_P3.x - SPINE_P2.x),
    y:
      d0 * (SPINE_P1.y - SPINE_P0.y) +
      d1 * (SPINE_P2.y - SPINE_P1.y) +
      d2 * (SPINE_P3.y - SPINE_P2.y),
    z:
      d0 * (SPINE_P1.z - SPINE_P0.z) +
      d1 * (SPINE_P2.z - SPINE_P1.z) +
      d2 * (SPINE_P3.z - SPINE_P2.z),
  };

  const tangent = normalizeVec3(rawTangent);
  // Lock reference side vector near +Z so the 5 longitudinal ridges never flip or twist.
  const refSide: Vec3 = {x: 0, y: 0, z: 1};
  const normal = normalizeVec3(crossVec3(tangent, refSide));
  const binormal = normalizeVec3(crossVec3(normal, tangent));

  return {position, tangent, normal, binormal};
}

/**
 * Computes the longitudinal envelope radius (before pentagonal ridging) at t in [0, 1].
 */
export function evaluateBananaLongitudinalProfile(tInput: number): number {
  const t = clamp01(tInput);
  // Rapid botanical swell from blunt floral tip, plump mid-belly, graceful neck taper.
  const tipCap = Math.pow(smoothstep(0.0, 0.085, t), 0.56);
  const tipPinch = 1.0 - 0.065 * Math.exp(-Math.pow((t - 0.028) / 0.022, 2));
  const belly = 0.88 + 0.14 * Math.sin(Math.PI * Math.pow(t, 0.92));
  const neckTaper = 1.0 - 0.54 * Math.pow(smoothstep(0.72, 1.0, t), 1.35);
  const shoulderFlare = 1.0 - 0.08 * Math.exp(-Math.pow((t - 0.96) / 0.04, 2));

  const minTipRadius = 0.0028;
  const bodyRadius =
    BANANA_SPEC.maxRadius * tipCap * tipPinch * belly * neckTaper * shoulderFlare;
  return Math.max(minTipRadius * (1 - smoothstep(0.0, 0.03, t)), bodyRadius);
}

/**
 * Computes the 5-ridged pentagonal cross-section radius at (t, theta).
 * theta = Math.PI corresponds to the outer convex spine of the banana.
 * theta = 0 corresponds to the broader inner concave face.
 */
export function evaluateBananaCrossSectionRadius(
  tInput: number,
  theta: number
): number {
  const t = clamp01(tInput);
  const baseRadius = evaluateBananaLongitudinalProfile(t);

  // Ridges are subtle in the plump belly and sharper along the neck & tip shoulders.
  const endFade = smoothstep(0.01, 0.08, t) * (1 - 0.2 * smoothstep(0.95, 1.0, t));
  const neckSharpening = 1 + 0.48 * smoothstep(0.68, 0.96, t);
  const ridgeAmp = 0.062 * endFade * neckSharpening;

  const angleFromOuter = theta - Math.PI;
  // Blend cos(5x) with subtle cos(10x) to form 5 rounded ridge ribs & broader flat facets.
  const fiveFold =
    Math.cos(5 * angleFromOuter) + 0.24 * Math.cos(10 * angleFromOuter);
  // Natural dorsal-ventral asymmetry: slightly flatter on the inner concave belly.
  const innerFlatten = 1 - 0.045 * Math.cos(theta) * smoothstep(0.1, 0.85, t);
  // Subtle lateral cheek fullness.
  const lateralWidth = 1 - 0.025 * Math.cos(2 * theta);

  return Math.max(0.0018, baseRadius * innerFlatten * lateralWidth * (1 + ridgeAmp * fiveFold));
}

/**
 * Computes the inner edible flesh radius at (t, theta).
 * Flesh is softer and rounder than the outer angular peel.
 */
export function evaluateFleshCrossSectionRadius(
  tInput: number,
  theta: number
): number {
  const t = clamp01(tInput);
  const outer = evaluateBananaCrossSectionRadius(t, theta);
  const base = evaluateBananaLongitudinalProfile(t);
  // Smooth the outer angular ridges toward the softer rounded-pentagonal flesh contour.
  const softenedOuter = lerp(outer, base * 0.985, 0.58);
  const thickness =
    BANANA_SPEC.peelThickness * (0.72 + 0.35 * smoothstep(0.05, 0.25, t));
  // Taper cleanly at bottom & softly domed rounded tip at top of inner fruit.
  const bottomEnd = smoothstep(0.025, 0.09, t);
  const tipPhase = smoothstep(0.86, 0.968, t);
  const topEnd = Math.pow(Math.max(0, 1 - Math.pow(tipPhase, 1.8)), 0.44);
  return Math.max(0.0005, (softenedOuter - thickness) * bottomEnd * topEnd);
}

/**
 * Evaluates the woody pedicel (stem) spine extending past t = 1.0 for u in [0, 1].
 */
export function evaluatePedicelSpine(uInput: number): SpineSample {
  const u = clamp01(uInput);
  const shoulder = evaluateBananaSpine(1.0);

  // Continue tangentially from shoulder and curve slightly backward/upward like a bunch cut stem.
  const start = shoulder.position;
  const len = BANANA_SPEC.pedicelLength;
  const dir0 = shoulder.tangent;
  // Curve gently toward +X / +Y
  const bendAngle = 0.28 * u * u;
  const cosB = Math.cos(bendAngle);
  const sinB = Math.sin(bendAngle);

  // Average direction integration in the (tangent, normal) plane.
  const steps = 8;
  const stepU = u / steps;
  let px = start.x;
  let py = start.y;
  let pz = start.z;
  for (let i = 0; i < steps; i++) {
    const midU = (i + 0.5) * stepU;
    const a = 0.28 * midU * midU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Rotate tangent slightly toward -normal (rightward hook on banana stem)
    const tx = dir0.x * ca - shoulder.normal.x * sa;
    const ty = dir0.y * ca - shoulder.normal.y * sa;
    const tz = dir0.z * ca - shoulder.normal.z * sa;
    px += tx * len * stepU;
    py += ty * len * stepU;
    pz += tz * len * stepU;
  }

  const tangent = normalizeVec3({
    x: dir0.x * cosB - shoulder.normal.x * sinB,
    y: dir0.y * cosB - shoulder.normal.y * sinB,
    z: dir0.z * cosB - shoulder.normal.z * sinB,
  });
  const refSide: Vec3 = {x: 0, y: 0, z: 1};
  const normal = normalizeVec3(crossVec3(tangent, refSide));
  const binormal = normalizeVec3(crossVec3(normal, tangent));

  return {
    position: {x: px, y: py, z: pz},
    tangent,
    normal,
    binormal,
  };
}

/**
 * Evaluates the woody pedicel cross-section radius at (u, theta) for u in [0, 1].
 */
export function evaluatePedicelRadius(uInput: number, theta: number): number {
  const u = clamp01(uInput);
  const neckRadius = evaluateBananaLongitudinalProfile(1.0);
  // Narrows gently through waist, then flares at the cut crown end.
  const waist = 1 - 0.22 * Math.sin(Math.PI * Math.min(1, u * 1.15));
  const crownFlare = 1 + 0.28 * Math.pow(smoothstep(0.62, 1.0, u), 1.6);
  const fibrousGrooves = 1 + 0.085 * Math.cos(5 * (theta - Math.PI));
  return Math.max(0.0025, neckRadius * waist * crownFlare * fibrousGrooves);
}

const PETAL_PEEL_SCHEDULE: readonly {start: number; end: number}[] = [
  {start: 0.0, end: 0.66}, // Petal 0 (stem carrier): cracks & peels first
  {start: 0.22, end: 0.88}, // Petal 1 (right-back flank)
  {start: 0.12, end: 0.78}, // Petal 2 (front-opposite strip peels second)
  {start: 0.42, end: 1.0}, // Petal 3 (front-left strip peels last)
  {start: 0.32, end: 0.94}, // Petal 4 (left-back flank)
];

/**
 * Maps global peelAmount [0..1] to an individual petal's staggered progress [0..1]
 * with smooth organic acceleration & settling.
 */
export function evaluatePetalPeelProgress(
  globalPeelInput: number,
  petalIndex: number
): number {
  const globalPeel = clamp01(globalPeelInput);
  const schedule =
    PETAL_PEEL_SCHEDULE[
      ((petalIndex % BANANA_SPEC.petalCount) + BANANA_SPEC.petalCount) %
        BANANA_SPEC.petalCount
    ];
  return smoothstep(schedule.start, schedule.end, globalPeel);
}

/**
 * Computes C2-smooth bend angle (radians) along a peeled petal strip given
 * arc distance from the continuous hinge point (meters) and petal progress [0..1].
 */
export function evaluatePeelCurlAngle(
  sInput: number,
  petalProgressInput: number
): number {
  const s = clamp01(sInput);
  const p = clamp01(petalProgressInput);
  if (p <= 1e-4 || s <= 0) return 0;

  // Gentle C2 ramp-up right at hinge (s^2) arching past horizontal (~135-150 deg)
  // with a subtle tip curl-out so strips drape naturally without stiffly spiking or clipping.
  const easeOnset = s * s * (2.15 - 1.15 * s);
  const tipCurl = 0.24 * Math.pow(smoothstep(0.52, 1.0, s), 1.35);
  const maxAngle = lerp(0.42, 2.38, Math.pow(p, 0.85));
  return maxAngle * (easeOnset + tipCurl);
}

/**
 * Returns the hinge spine parameter tHinge in [1 - maxPeelFraction, 1] for a given petal progress.
 */
export function getPeelHingeT(petalProgressInput: number): number {
  const p = clamp01(petalProgressInput);
  // Subtle initial stem-crack threshold before hinge travels smoothly down the fruit
  const travel = smoothstep(0.04, 1.0, p);
  return 1.0 - BANANA_SPEC.maxPeelFraction * travel;
}

function mixHex(hexA: string, hexB: string, tInput: number): string {
  const t = clamp01(tInput);
  const a = parseInt(hexA.replace('#', ''), 16);
  const b = parseInt(hexB.replace('#', ''), 16);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/**
 * Maps a continuous ripeness factor [0..1] to botanical Cavendish peel colors,
 * sugar-spot density, and surface PBR roughness/clearcoat parameters.
 */
export function computeRipenessPalette(ripenessInput: number): RipenessPalette {
  const r = clamp01(ripenessInput);

  if (r < 0.35) {
    const k = r / 0.35;
    return {
      ripeness: r,
      stageLabel: 'Unripe Green',
      stageLabelJa: '未熟グリーン',
      stageSubtitle: 'Crisp chartreuse epidermis, firm starch',
      baseHex: mixHex('#86a42b', '#d8ca28', k),
      bellyHex: mixHex('#97b532', '#ebd52c', k),
      neckTipHex: mixHex('#5b7b1f', '#89a024', k),
      ridgeTintHex: mixHex('#719126', '#c5b824', k),
      stemHex: mixHex('#647d26', '#768228', k),
      spotDensity: lerp(0.0, 0.04, k),
      spotOpacity: lerp(0.0, 0.22, k),
      roughness: lerp(0.5, 0.4, k),
      clearcoat: lerp(0.1, 0.18, k),
    };
  }

  if (r < 0.68) {
    const k = (r - 0.35) / 0.33;
    return {
      ripeness: r,
      stageLabel: 'Golden Ripe',
      stageLabelJa: '食べ頃イエロー',
      stageSubtitle: 'Warm Cavendish yellow, balanced sweetness',
      baseHex: mixHex('#d8ca28', '#f0bf18', k),
      bellyHex: mixHex('#ebd52c', '#f8cf28', k),
      neckTipHex: mixHex('#89a024', '#a8a026', k),
      ridgeTintHex: mixHex('#c5b824', '#d8a214', k),
      stemHex: mixHex('#768228', '#6f6224', k),
      spotDensity: lerp(0.04, 0.28, k),
      spotOpacity: lerp(0.22, 0.68, k),
      roughness: lerp(0.4, 0.33, k),
      clearcoat: lerp(0.18, 0.24, k),
    };
  }

  const k = (r - 0.68) / 0.32;
  return {
    ripeness: r,
    stageLabel: 'Sugar Spotted',
    stageLabelJa: 'シュガースポット',
    stageSubtitle: 'Rich honey-amber skin with sugar spots',
    baseHex: mixHex('#f0bf18', '#dc9c16', k),
    bellyHex: mixHex('#f8cf28', '#e9ab1c', k),
    neckTipHex: mixHex('#a8a026', '#72531e', k),
    ridgeTintHex: mixHex('#d8a214', '#925d15', k),
    stemHex: mixHex('#6f6224', '#4c391d', k),
    spotDensity: lerp(0.28, 1.0, k),
    spotOpacity: lerp(0.68, 0.96, k),
    roughness: lerp(0.33, 0.44, k),
    clearcoat: lerp(0.24, 0.12, k),
  };
}
