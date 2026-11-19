import * as THREE from 'three';

import {
  BANANA_SPEC,
  clamp01,
  computeRipenessPalette,
  evaluateBananaCrossSectionRadius,
  evaluateBananaSpine,
  evaluateFleshCrossSectionRadius,
  evaluatePeelCurlAngle,
  evaluatePetalPeelProgress,
  evaluatePedicelRadius,
  evaluatePedicelSpine,
  getPeelHingeT,
  lerp,
  smoothstep,
  type SpineSample,
} from './bananaMath';
import {createBananaTextureSet, type BananaTextureSet} from './bananaTextures';

export interface BananaRig {
  root: THREE.Group;
  specimenGroup: THREE.Group;
  pedestalGroup: THREE.Group;
  textures: BananaTextureSet;
  setRipeness(ripeness: number): void;
  setPeelAmount(peelAmount: number): void;
  setPedestalVisible(visible: boolean): void;
  dispose(): void;
}

interface PetalState {
  index: number;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  thetaStart: number;
  thetaEnd: number;
  thetaCenter: number;
  hingeOffset: number;
  curlMultiplier: number;
  tipPosition: THREE.Vector3;
  tipTangent: THREE.Vector3;
  tipNormal: THREE.Vector3;
  tipBinormal: THREE.Vector3;
}

const PETAL_LON_SEGMENTS = 44;
const PETAL_CIRC_SEGMENTS = 10;

// Slight botanical asymmetry between the 5 peel strips
const PETAL_HINGE_OFFSETS = [0.0, 0.025, -0.015, 0.02, -0.012];
const PETAL_CURL_MULTIPLIERS = [1.03, 0.95, 1.07, 0.97, 1.01];
const PETAL_SIDE_SPLAY = [0.0, 0.08, -0.07, 0.085, -0.075];

// Precompute rest spine samples & cumulative arc length once at module load
const SPINE_T: number[] = [];
const SPINE_SAMPLES: SpineSample[] = [];
const SPINE_ARC_LENGTHS: number[] = [];
for (let i = 0; i <= PETAL_LON_SEGMENTS; i++) {
  const t = 0.005 + (i / PETAL_LON_SEGMENTS) * 0.995;
  const sample = evaluateBananaSpine(t);
  SPINE_T.push(t);
  SPINE_SAMPLES.push(sample);
  if (i === 0) {
    SPINE_ARC_LENGTHS.push(0);
  } else {
    const prev = SPINE_SAMPLES[i - 1];
    const segLen = Math.hypot(
      sample.position.x - prev.position.x,
      sample.position.y - prev.position.y,
      sample.position.z - prev.position.z
    );
    SPINE_ARC_LENGTHS.push(SPINE_ARC_LENGTHS[i - 1] + segLen);
  }
}
const TOTAL_SPINE_ARC = SPINE_ARC_LENGTHS[PETAL_LON_SEGMENTS];

function spineToVec3(v: {x: number; y: number; z: number}, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v.x, v.y, v.z);
}

/**
 * Creates a double-walled articulated peel petal geometry (Group 0 = outer skin,
 * Group 1 = inner creamy pith + cut seam side walls + top neck rim).
 */
function createPetalGeometry(
  thetaStart: number,
  thetaEnd: number
): THREE.BufferGeometry {
  const nT = PETAL_LON_SEGMENTS;
  const nTh = PETAL_CIRC_SEGMENTS;
  const rows = nT + 1;
  const cols = nTh + 1;
  const surfaceVertCount = rows * cols;
  const totalVerts = surfaceVertCount * 2; // outer + inner surfaces

  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);

  // Assign static UVs
  for (let i = 0; i <= nT; i++) {
    const t = 0.005 + (i / nT) * 0.995;
    for (let j = 0; j <= nTh; j++) {
      const f = j / nTh;
      const theta = thetaStart + f * (thetaEnd - thetaStart);
      const u = ((theta / (Math.PI * 2)) % 1 + 1) % 1;
      const idxOuter = i * cols + j;
      const idxInner = surfaceVertCount + idxOuter;

      uvs[idxOuter * 2] = u;
      uvs[idxOuter * 2 + 1] = t;

      // Inner pith uses local petal UVs for crisp vertical fibrous pith texture
      uvs[idxInner * 2] = f;
      uvs[idxInner * 2 + 1] = t;
    }
  }

  const outerIndices: number[] = [];
  const innerAndWallIndices: number[] = [];

  // Outer surface triangles (outward normals)
  for (let i = 0; i < nT; i++) {
    for (let j = 0; j < nTh; j++) {
      const v00 = i * cols + j;
      const v10 = (i + 1) * cols + j;
      const v01 = i * cols + (j + 1);
      const v11 = (i + 1) * cols + (j + 1);
      outerIndices.push(v00, v10, v11, v00, v11, v01);
    }
  }

  // Inner surface triangles (inward normals toward banana flesh)
  for (let i = 0; i < nT; i++) {
    for (let j = 0; j < nTh; j++) {
      const v00 = surfaceVertCount + i * cols + j;
      const v10 = surfaceVertCount + (i + 1) * cols + j;
      const v01 = surfaceVertCount + i * cols + (j + 1);
      const v11 = surfaceVertCount + (i + 1) * cols + (j + 1);
      innerAndWallIndices.push(v00, v11, v10, v00, v01, v11);
    }
  }

  // Left cut wall (j = 0)
  for (let i = 0; i < nT; i++) {
    const o0 = i * cols;
    const o1 = (i + 1) * cols;
    const i0 = surfaceVertCount + o0;
    const i1 = surfaceVertCount + o1;
    innerAndWallIndices.push(o0, i0, i1, o0, i1, o1);
  }

  // Right cut wall (j = nTh)
  for (let i = 0; i < nT; i++) {
    const o0 = i * cols + nTh;
    const o1 = (i + 1) * cols + nTh;
    const i0 = surfaceVertCount + o0;
    const i1 = surfaceVertCount + o1;
    innerAndWallIndices.push(o0, o1, i1, o0, i1, i0);
  }

  // Top shoulder cut rim (i = nT)
  for (let j = 0; j < nTh; j++) {
    const o0 = nT * cols + j;
    const o1 = nT * cols + j + 1;
    const i0 = surfaceVertCount + o0;
    const i1 = surfaceVertCount + o1;
    innerAndWallIndices.push(o0, i0, i1, o0, i1, o1);
  }

  const allIndices = [...outerIndices, ...innerAndWallIndices];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(allIndices);
  geometry.addGroup(0, outerIndices.length, 0);
  geometry.addGroup(outerIndices.length, innerAndWallIndices.length, 1);
  return geometry;
}

function getWallThickness(t: number): number {
  return (
    BANANA_SPEC.peelThickness *
    (0.55 + 0.45 * smoothstep(0.02, 0.18, t)) *
    (1.0 - 0.25 * smoothstep(0.92, 1.0, t))
  );
}

function getArcLengthAtT(tInput: number): number {
  const t = clamp01(tInput);
  const f = clamp01((t - 0.005) / 0.995) * PETAL_LON_SEGMENTS;
  const idx = Math.min(PETAL_LON_SEGMENTS - 1, Math.floor(f));
  const frac = f - idx;
  return lerp(SPINE_ARC_LENGTHS[idx], SPINE_ARC_LENGTHS[idx + 1], frac);
}

/**
 * Updates vertex positions of an articulated peel petal for a given global peelAmount [0..1]
 * using staggered petal progression, continuous inner-pith hinge pivoting, and outward curling.
 */
function updatePetalGeometry(petal: PetalState, globalPeelAmount: number) {
  const nT = PETAL_LON_SEGMENTS;
  const nTh = PETAL_CIRC_SEGMENTS;
  const cols = nTh + 1;
  const surfaceVertCount = (nT + 1) * cols;
  const posAttr = petal.geometry.getAttribute('position') as THREE.BufferAttribute;

  const petalProgress = evaluatePetalPeelProgress(globalPeelAmount, petal.index);
  const baseHingeT = getPeelHingeT(petalProgress);
  const hingeT =
    petalProgress <= 0.001
      ? 1.0
      : Math.min(0.992, Math.max(0.28, baseHingeT + petal.hingeOffset * petalProgress));
  const hingeArc = getArcLengthAtT(hingeT);
  const maxArcFromHinge = Math.max(0.004, TOTAL_SPINE_ARC - hingeArc);

  const ringPos: THREE.Vector3[] = new Array(nT + 1);
  const ringT: THREE.Vector3[] = new Array(nT + 1);
  const ringN: THREE.Vector3[] = new Array(nT + 1);
  const ringB: THREE.Vector3[] = new Array(nT + 1);
  const ringPeeled = new Uint8Array(nT + 1);

  const thetaCenter = petal.thetaCenter;
  const cosC = Math.cos(thetaCenter);
  const sinC = Math.sin(thetaCenter);

  let peeledStarted = false;
  const lastCurledPos = new THREE.Vector3();
  const lastT = new THREE.Vector3();
  const lastN = new THREE.Vector3();
  const lastB = new THREE.Vector3();
  let prevS = 0;
  let prevCurlAngle = 0;

  const radialOut = new THREE.Vector3();
  const sideAxis = new THREE.Vector3();
  const rotQ = new THREE.Quaternion();
  const splayQ = new THREE.Quaternion();
  const gravityQ = new THREE.Quaternion();
  const specimenDown = new THREE.Vector3(0, -1, 0);
  const gravityAxis = new THREE.Vector3();
  const midDir = new THREE.Vector3();

  for (let i = 0; i <= nT; i++) {
    const t = SPINE_T[i];
    const sample = SPINE_SAMPLES[i];

    if (t <= hingeT || petalProgress <= 0.001) {
      ringPos[i] = new THREE.Vector3(sample.position.x, sample.position.y, sample.position.z);
      ringT[i] = new THREE.Vector3(sample.tangent.x, sample.tangent.y, sample.tangent.z);
      ringN[i] = new THREE.Vector3(sample.normal.x, sample.normal.y, sample.normal.z);
      ringB[i] = new THREE.Vector3(sample.binormal.x, sample.binormal.y, sample.binormal.z);
      ringPeeled[i] = 0;
      continue;
    }

    ringPeeled[i] = 1;
    let ds: number;

    if (!peeledStarted) {
      peeledStarted = true;
      // Anchor smoothly from the continuous hinge point on the inner pith contact wall
      const hSample = evaluateBananaSpine(hingeT);
      lastT.set(hSample.tangent.x, hSample.tangent.y, hSample.tangent.z);
      lastN.set(hSample.normal.x, hSample.normal.y, hSample.normal.z);
      lastB.set(hSample.binormal.x, hSample.binormal.y, hSample.binormal.z);

      const hRadialOut = new THREE.Vector3()
        .addScaledVector(lastN, cosC)
        .addScaledVector(lastB, sinC)
        .normalize();
      const rOuterHinge = evaluateBananaCrossSectionRadius(hingeT, thetaCenter);
      const rInnerHinge = Math.max(0.0005, rOuterHinge - getWallThickness(hingeT));

      lastCurledPos
        .set(hSample.position.x, hSample.position.y, hSample.position.z)
        .addScaledVector(hRadialOut, rInnerHinge);
      prevS = 0;
      prevCurlAngle = 0;
      ds = Math.max(0, SPINE_ARC_LENGTHS[i] - hingeArc);
    } else {
      ds = SPINE_ARC_LENGTHS[i] - SPINE_ARC_LENGTHS[i - 1];
    }

    const s = clamp01((SPINE_ARC_LENGTHS[i] - hingeArc) / maxArcFromHinge);
    const curlAngle = evaluatePeelCurlAngle(s, petalProgress) * petal.curlMultiplier;
    const deltaCurl = curlAngle - prevCurlAngle;

    // Outward radial axis for this petal at the current ring frame
    radialOut
      .set(0, 0, 0)
      .addScaledVector(lastN, cosC)
      .addScaledVector(lastB, sinC)
      .normalize();

    // Side tangent perpendicular to (lastT, radialOut): cross(lastT, radialOut) x lastT = +radialOut
    sideAxis.crossVectors(lastT, radialOut);
    if (sideAxis.lengthSq() > 1e-10) {
      sideAxis.normalize();
    } else {
      sideAxis.set(0, 0, 1);
    }

    // POSITIVE deltaCurl rotates tangent OUTWARD toward +radialOut
    rotQ.setFromAxisAngle(sideAxis, deltaCurl);
    const nextT = lastT.clone().applyQuaternion(rotQ).normalize();
    const nextN = lastN.clone().applyQuaternion(rotQ).normalize();
    const nextB = lastB.clone().applyQuaternion(rotQ).normalize();

    // Subtle organic sideways splay twist along peeled strip
    const deltaSplay = PETAL_SIDE_SPLAY[petal.index] * petalProgress * (s - prevS);
    if (Math.abs(deltaSplay) > 1e-6) {
      splayQ.setFromAxisAngle(nextT, deltaSplay);
      nextN.applyQuaternion(splayQ).normalize();
      nextB.applyQuaternion(splayQ).normalize();
    }

    // Gentle gravity pull downward once strip arches outward
    const gravityWeight = 0.016 * (s - prevS) * smoothstep(0.2, 0.9, s) * petalProgress;
    if (gravityWeight > 1e-5) {
      gravityAxis.crossVectors(nextT, specimenDown);
      if (gravityAxis.lengthSq() > 1e-6) {
        gravityAxis.normalize();
        const downAngle = Math.min(0.08, gravityWeight * 4.5);
        gravityQ.setFromAxisAngle(gravityAxis, downAngle);
        nextT.applyQuaternion(gravityQ).normalize();
        nextN.applyQuaternion(gravityQ).normalize();
        nextB.applyQuaternion(gravityQ).normalize();
      }
    }

    // Advance inextensibly along the midpoint tangent
    midDir.copy(lastT).add(nextT).normalize();
    const nextPos = lastCurledPos.clone().addScaledVector(midDir, ds);

    ringPos[i] = nextPos;
    ringT[i] = nextT;
    ringN[i] = nextN;
    ringB[i] = nextB;

    lastCurledPos.copy(nextPos);
    lastT.copy(nextT);
    lastN.copy(nextN);
    lastB.copy(nextB);
    prevS = s;
    prevCurlAngle = curlAngle;
  }

  // Record tip frame so the woody pedicel attaches seamlessly to petal 0's neck shoulder
  petal.tipTangent.copy(ringT[nT]);
  petal.tipNormal.copy(ringN[nT]);
  petal.tipBinormal.copy(ringB[nT]);
  if (ringPeeled[nT]) {
    const tipRadialOut = new THREE.Vector3()
      .addScaledVector(ringN[nT], cosC)
      .addScaledVector(ringB[nT], sinC)
      .normalize();
    const rOuterTip = evaluateBananaCrossSectionRadius(SPINE_T[nT], thetaCenter);
    const rInnerTip = Math.max(0.0005, rOuterTip - getWallThickness(SPINE_T[nT]));
    const centerShift = rInnerTip * lerp(1.0, 0.56, smoothstep(0.0, 0.25, petalProgress));
    petal.tipPosition.copy(ringPos[nT]).addScaledVector(tipRadialOut, -centerShift);
  } else {
    petal.tipPosition.copy(ringPos[nT]);
  }

  // Write outer and inner vertices
  const ringRadialOut = new THREE.Vector3();
  const ringLateral = new THREE.Vector3();

  for (let i = 0; i <= nT; i++) {
    const t = SPINE_T[i];
    const center = ringPos[i];
    const nVec = ringN[i];
    const bVec = ringB[i];
    const isPeeled = ringPeeled[i] === 1;

    const s = isPeeled
      ? clamp01((SPINE_ARC_LENGTHS[i] - hingeArc) / maxArcFromHinge)
      : 0;
    const unCup = isPeeled ? smoothstep(0.03, 0.52, s) : 0;
    const radialGap = isPeeled
      ? 0.0012 * smoothstep(0.0, 0.22, s) * petalProgress
      : 0;

    ringRadialOut
      .set(0, 0, 0)
      .addScaledVector(nVec, cosC)
      .addScaledVector(bVec, sinC)
      .normalize();
    ringLateral
      .set(0, 0, 0)
      .addScaledVector(nVec, -sinC)
      .addScaledVector(bVec, cosC)
      .normalize();

    const rCenter = evaluateBananaCrossSectionRadius(t, thetaCenter);
    const wallThick = getWallThickness(t);
    const rInnerCenter = Math.max(0.0005, rCenter - wallThick);

    for (let j = 0; j <= nTh; j++) {
      const f = j / nTh;
      const theta = thetaStartOrLerp(petal.thetaStart, petal.thetaEnd, f);
      const rOuter = evaluateBananaCrossSectionRadius(t, theta);
      const rInner = Math.max(0.0005, rOuter - wallThick);
      const closedInnerR = t < 0.02 ? rOuter * 0.85 : rInner;

      const idxOuter = i * cols + j;
      const idxInner = surfaceVertCount + idxOuter;

      if (!isPeeled) {
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const rx = nVec.x * cosT + bVec.x * sinT;
        const ry = nVec.y * cosT + bVec.y * sinT;
        const rz = nVec.z * cosT + bVec.z * sinT;

        posAttr.setXYZ(idxOuter, center.x + rx * rOuter, center.y + ry * rOuter, center.z + rz * rOuter);
        posAttr.setXYZ(
          idxInner,
          center.x + rx * closedInnerR,
          center.y + ry * closedInnerR,
          center.z + rz * closedInnerR
        );
      } else {
        const dTheta = theta - thetaCenter;
        const cosD = Math.cos(dTheta);
        const sinD = Math.sin(dTheta);
        const edgeDist = Math.abs(f - 0.5) * 2;
        const edgeLip = -0.00045 * edgeDist * edgeDist * smoothstep(0.06, 0.45, s);

        // Outer skin vertex relative to inner pith pivot
        const outerAlongRad = rOuter * cosD - rInnerCenter;
        const outerRelRad =
          lerp(outerAlongRad, rOuter - rInnerCenter, 0.56 * unCup) + radialGap + edgeLip;
        const outerRelLat = rOuter * sinD * lerp(1.0, 1.06, unCup);

        posAttr.setXYZ(
          idxOuter,
          center.x + ringRadialOut.x * outerRelRad + ringLateral.x * outerRelLat,
          center.y + ringRadialOut.y * outerRelRad + ringLateral.y * outerRelLat,
          center.z + ringRadialOut.z * outerRelRad + ringLateral.z * outerRelLat
        );

        // Inner pith vertex relative to inner pith pivot
        const innerAlongRad = closedInnerR * cosD - rInnerCenter;
        const innerRelRad =
          lerp(innerAlongRad, closedInnerR - rInnerCenter, 0.56 * unCup) + radialGap + edgeLip;
        const innerRelLat = closedInnerR * sinD * lerp(1.0, 1.06, unCup);

        posAttr.setXYZ(
          idxInner,
          center.x + ringRadialOut.x * innerRelRad + ringLateral.x * innerRelLat,
          center.y + ringRadialOut.y * innerRelRad + ringLateral.y * innerRelLat,
          center.z + ringRadialOut.z * innerRelRad + ringLateral.z * innerRelLat
        );
      }
    }
  }

  posAttr.needsUpdate = true;
  petal.geometry.computeVertexNormals();
  petal.geometry.computeBoundingSphere();
}

function thetaStartOrLerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function createFleshGeometry(): THREE.BufferGeometry {
  const nT = 40;
  const nTh = 36;
  const rows = nT + 1;
  const cols = nTh + 1;

  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices: number[] = [];

  for (let i = 0; i <= nT; i++) {
    const t = 0.03 + (i / nT) * 0.935;
    const sample = evaluateBananaSpine(t);

    for (let j = 0; j <= nTh; j++) {
      const f = j / nTh;
      const theta = f * Math.PI * 2;
      const r = i === nT ? 0.0 : evaluateFleshCrossSectionRadius(t, theta);

      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const vx = sample.position.x + (sample.normal.x * cosT + sample.binormal.x * sinT) * r;
      const vy = sample.position.y + (sample.normal.y * cosT + sample.binormal.y * sinT) * r;
      const vz = sample.position.z + (sample.normal.z * cosT + sample.binormal.z * sinT) * r;

      const idx = i * cols + j;
      positions[idx * 3] = vx;
      positions[idx * 3 + 1] = vy;
      positions[idx * 3 + 2] = vz;
      uvs[idx * 2] = f;
      uvs[idx * 2 + 1] = t;
    }
  }

  for (let i = 0; i < nT; i++) {
    for (let j = 0; j < nTh; j++) {
      const v00 = i * cols + j;
      const v10 = (i + 1) * cols + j;
      const v01 = i * cols + (j + 1);
      const v11 = (i + 1) * cols + (j + 1);
      indices.push(v00, v10, v11, v00, v11, v01);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createPedicelGeometry(): {
  bodyGeometry: THREE.BufferGeometry;
  cutCapGeometry: THREE.BufferGeometry;
} {
  const nU = 16;
  const nTh = 24;
  const rows = nU + 1;
  const cols = nTh + 1;
  const baseShoulder = evaluateBananaSpine(1.0);
  const origin = new THREE.Vector3(
    baseShoulder.position.x,
    baseShoulder.position.y,
    baseShoulder.position.z
  );

  // Express pedicel in local frame relative to shoulder (tangent, normal, binormal)
  const shoulderBasis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(baseShoulder.normal.x, baseShoulder.normal.y, baseShoulder.normal.z),
    new THREE.Vector3(baseShoulder.tangent.x, baseShoulder.tangent.y, baseShoulder.tangent.z),
    new THREE.Vector3(baseShoulder.binormal.x, baseShoulder.binormal.y, baseShoulder.binormal.z)
  );
  const invShoulderBasis = shoulderBasis.clone().invert();

  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices: number[] = [];

  const worldPt = new THREE.Vector3();
  const topRingLocal: THREE.Vector3[] = [];

  for (let i = 0; i <= nU; i++) {
    const u = i / nU;
    const sample = evaluatePedicelSpine(u);
    for (let j = 0; j <= nTh; j++) {
      const f = j / nTh;
      const theta = f * Math.PI * 2;
      const r = evaluatePedicelRadius(u, theta);
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // Slight organic angled cut bevel at crown end (u -> 1)
      const cutBevel = u > 0.85 ? 0.0018 * Math.cos(theta - 0.5) * smoothstep(0.85, 1.0, u) : 0;

      worldPt.set(
        sample.position.x +
          (sample.normal.x * cosT + sample.binormal.x * sinT) * r +
          sample.tangent.x * cutBevel,
        sample.position.y +
          (sample.normal.y * cosT + sample.binormal.y * sinT) * r +
          sample.tangent.y * cutBevel,
        sample.position.z +
          (sample.normal.z * cosT + sample.binormal.z * sinT) * r +
          sample.tangent.z * cutBevel
      );
      worldPt.sub(origin).applyMatrix4(invShoulderBasis);

      const idx = i * cols + j;
      positions[idx * 3] = worldPt.x;
      positions[idx * 3 + 1] = worldPt.y;
      positions[idx * 3 + 2] = worldPt.z;
      uvs[idx * 2] = f;
      uvs[idx * 2 + 1] = u;

      if (i === nU) {
        topRingLocal.push(worldPt.clone());
      }
    }
  }

  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < nTh; j++) {
      const v00 = i * cols + j;
      const v10 = (i + 1) * cols + j;
      const v01 = i * cols + (j + 1);
      const v11 = (i + 1) * cols + (j + 1);
      indices.push(v00, v10, v11, v00, v11, v01);
    }
  }

  const bodyGeometry = new THREE.BufferGeometry();
  bodyGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  bodyGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  bodyGeometry.setIndex(indices);
  bodyGeometry.computeVertexNormals();

  // Fibrous cut cap disk at top of pedicel
  const capPositions: number[] = [];
  const capUvs: number[] = [];
  const capIndices: number[] = [];
  const center = new THREE.Vector3();
  for (let j = 0; j < nTh; j++) center.add(topRingLocal[j]);
  center.divideScalar(nTh);

  // Center vertex
  capPositions.push(center.x, center.y - 0.0008, center.z);
  capUvs.push(0.5, 0.5);

  for (let j = 0; j <= nTh; j++) {
    const p = topRingLocal[j];
    const theta = (j / nTh) * Math.PI * 2;
    capPositions.push(p.x, p.y, p.z);
    capUvs.push(0.5 + 0.48 * Math.cos(theta), 0.5 + 0.48 * Math.sin(theta));
  }

  for (let j = 1; j <= nTh; j++) {
    capIndices.push(0, j + 1, j);
  }

  const cutCapGeometry = new THREE.BufferGeometry();
  cutCapGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(capPositions, 3)
  );
  cutCapGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(capUvs, 2));
  cutCapGeometry.setIndex(capIndices);
  cutCapGeometry.computeVertexNormals();

  return {bodyGeometry, cutCapGeometry};
}

function createBlossomTipGeometry(): THREE.BufferGeometry {
  // Sculpted dried floral remnant nub at t = 0
  const points: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.003),
    new THREE.Vector2(0.0022, 0.0026),
    new THREE.Vector2(0.0036, 0.0014),
    new THREE.Vector2(0.0034, -0.0024),
    new THREE.Vector2(0.0022, -0.0044),
    new THREE.Vector2(0.0008, -0.0048),
    new THREE.Vector2(0.0, -0.0036),
  ];
  const geo = new THREE.LatheGeometry(points, 20);
  // Subtle 5-lobed organic wrinkling on the floral nub
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 0.0005) {
      const ang = Math.atan2(z, x);
      const scale = 1 + 0.14 * Math.cos(5 * ang) + 0.08 * Math.sin(3 * ang);
      pos.setXYZ(i, x * scale, y, z * scale);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

function createPhloemStrands(
  basePithMaterial: THREE.MeshStandardMaterial
): {group: THREE.Group; update(peelAmount: number): void; dispose(): void} {
  const group = new THREE.Group();
  group.name = 'PhloemStrands';
  const geometries: THREE.BufferGeometry[] = [];
  const meshes: THREE.Mesh[] = [];
  const strandMaterial = basePithMaterial.clone();
  strandMaterial.color.set(0xf6efd6);
  strandMaterial.emissive.set(0x3a321e);
  strandMaterial.emissiveIntensity = 0.22;
  strandMaterial.transparent = true;
  strandMaterial.opacity = 0;
  strandMaterial.depthWrite = false;

  const angles = [0.25, 1.5, 2.85, 4.4];
  for (let i = 0; i < angles.length; i++) {
    const theta = angles[i];
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = 0.36 + (k / 10) * 0.38;
      const sample = evaluateBananaSpine(t);
      const r = evaluateFleshCrossSectionRadius(t, theta) + 0.0003;
      const curlOut = k > 6 ? Math.pow((k - 6) / 4, 1.6) * 0.0032 : 0;
      const cosT = Math.cos(theta + k * 0.03);
      const sinT = Math.sin(theta + k * 0.03);
      pts.push(
        new THREE.Vector3(
          sample.position.x + (sample.normal.x * cosT + sample.binormal.x * sinT) * (r + curlOut),
          sample.position.y + (sample.normal.y * cosT + sample.binormal.y * sinT) * (r + curlOut),
          sample.position.z + (sample.normal.z * cosT + sample.binormal.z * sinT) * (r + curlOut)
        )
      );
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, 14, 0.00032, 5, false);
    const mesh = new THREE.Mesh(geo, strandMaterial);
    mesh.visible = false;
    geometries.push(geo);
    meshes.push(mesh);
    group.add(mesh);
  }

  return {
    group,
    update(peelAmount: number) {
      const fade = smoothstep(0.28, 0.82, peelAmount);
      const visible = fade > 0.01;
      strandMaterial.opacity = fade * 0.85;
      for (const mesh of meshes) {
        mesh.visible = visible;
      }
      group.scale.setScalar(0.96 + 0.04 * fade);
    },
    dispose() {
      for (const geo of geometries) geo.dispose();
      strandMaterial.dispose();
    },
  };
}

function createPedestal(
  textures: BananaTextureSet,
  castShadow: boolean
): {group: THREE.Group; dispose(): void} {
  const group = new THREE.Group();
  group.name = 'StudioPedestal';

  // Sleek chamfered slate cylinder profile
  const plinthPoints = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.084, 0),
    new THREE.Vector2(0.086, 0.003),
    new THREE.Vector2(0.086, 0.009),
    new THREE.Vector2(0.081, 0.012),
    new THREE.Vector2(0, 0.012),
  ];
  const plinthGeo = new THREE.LatheGeometry(plinthPoints, 64);
  const plinthMat = new THREE.MeshStandardMaterial({
    map: textures.pedestalMap,
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.08,
  });
  const plinthMesh = new THREE.Mesh(plinthGeo, plinthMat);
  plinthMesh.receiveShadow = castShadow;
  plinthMesh.castShadow = castShadow;
  group.add(plinthMesh);

  // Subtle brushed warm-brass rim inlay
  const ringGeo = new THREE.TorusGeometry(0.077, 0.0011, 12, 64);
  ringGeo.rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xc9a86a,
    roughness: 0.28,
    metalness: 0.88,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.position.y = 0.0122;
  group.add(ringMesh);

  // Soft contact shadow disc directly on top of pedestal
  const shadowGeo = new THREE.CircleGeometry(0.072, 48);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: textures.shadowMap,
    transparent: true,
    opacity: 0.76,
    depthWrite: false,
  });
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  shadowMesh.position.y = 0.013;
  group.add(shadowMesh);

  return {
    group,
    dispose() {
      plinthGeo.dispose();
      plinthMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
    },
  };
}

export function buildRealisticBanana(options?: {
  renderer?: THREE.WebGLRenderer | null;
  initialRipeness?: number;
  initialPeel?: number;
  castShadow?: boolean;
}): BananaRig {
  const initialRipeness = options?.initialRipeness ?? 0.55;
  const initialPeel = options?.initialPeel ?? 0.0;
  const castShadow = options?.castShadow ?? true;

  const textures = createBananaTextureSet(options?.renderer, initialRipeness);
  const root = new THREE.Group();
  root.name = 'BananaShowcaseRoot';

  const specimenGroup = new THREE.Group();
  specimenGroup.name = 'CavendishBanana';
  // Elevate slightly above the pedestal surface and pose at an authentic ~11° specimen angle
  specimenGroup.position.set(-0.01, 0.025, 0);
  specimenGroup.rotation.z = -0.14;
  root.add(specimenGroup);

  const initialPalette = computeRipenessPalette(initialRipeness);

  // 1. Peel outer epidermis & inner creamy pith materials (distinct roughness for realistic contrast)
  const peelMaterial = new THREE.MeshPhysicalMaterial({
    map: textures.peelMap,
    bumpMap: textures.peelBumpMap,
    bumpScale: 0.00085,
    roughnessMap: textures.peelRoughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    clearcoat: initialPalette.clearcoat,
    clearcoatRoughness: 0.36,
    sheen: 0.14,
    sheenRoughness: 0.65,
    sheenColor: new THREE.Color(0xfff4c2),
  });

  const pithMaterial = new THREE.MeshStandardMaterial({
    map: textures.pithMap,
    bumpMap: textures.pithBumpMap,
    bumpScale: 0.0005,
    color: 0xf4ecd2,
    roughness: 0.84,
    metalness: 0.0,
  });

  // 2. Edible inner flesh material (creamy satin moisture + sheen)
  const fleshMaterial = new THREE.MeshPhysicalMaterial({
    map: textures.fleshMap,
    bumpMap: textures.fleshBumpMap,
    bumpScale: 0.00025,
    color: 0xffffff,
    roughness: 0.32,
    metalness: 0.0,
    clearcoat: 0.24,
    clearcoatRoughness: 0.38,
    sheen: 0.32,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0xfff8dc),
  });

  // 3. Woody pedicel & cut face materials
  const stemMaterial = new THREE.MeshStandardMaterial({
    map: textures.stemMap,
    bumpMap: textures.peelBumpMap,
    bumpScale: 0.0009,
    color: 0xffffff,
    roughness: 0.84,
    metalness: 0.0,
  });

  const stemCutMaterial = new THREE.MeshStandardMaterial({
    map: textures.stemCutMap,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
  });

  const blossomMaterial = new THREE.MeshStandardMaterial({
    map: textures.blossomMap,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
  });

  // Build 5 articulated peel petals around the 5 ridge centers
  const petals: PetalState[] = [];
  const sectorWidth = (Math.PI * 2) / BANANA_SPEC.petalCount;
  for (let k = 0; k < BANANA_SPEC.petalCount; k++) {
    const thetaCenter = Math.PI + k * sectorWidth;
    const thetaStart = thetaCenter - sectorWidth / 2;
    const thetaEnd = thetaCenter + sectorWidth / 2;
    const geometry = createPetalGeometry(thetaStart, thetaEnd);
    const mesh = new THREE.Mesh(geometry, [peelMaterial, pithMaterial]);
    mesh.name = `BananaPeelPetal_${k}`;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = castShadow;
    specimenGroup.add(mesh);

    petals.push({
      index: k,
      mesh,
      geometry,
      thetaStart,
      thetaEnd,
      thetaCenter,
      hingeOffset: PETAL_HINGE_OFFSETS[k],
      curlMultiplier: PETAL_CURL_MULTIPLIERS[k],
      tipPosition: new THREE.Vector3(),
      tipTangent: new THREE.Vector3(),
      tipNormal: new THREE.Vector3(),
      tipBinormal: new THREE.Vector3(),
    });
  }

  // Build inner banana flesh core
  const fleshGeometry = createFleshGeometry();
  const fleshMesh = new THREE.Mesh(fleshGeometry, fleshMaterial);
  fleshMesh.name = 'BananaFlesh';
  fleshMesh.castShadow = castShadow;
  fleshMesh.receiveShadow = castShadow;
  specimenGroup.add(fleshMesh);

  // Build delicate fibrous phloem strands
  const strands = createPhloemStrands(pithMaterial);
  specimenGroup.add(strands.group);

  // Build woody pedicel stem (anchored dynamically to petal 0's shoulder tip)
  const {bodyGeometry: pedicelBodyGeo, cutCapGeometry: pedicelCapGeo} =
    createPedicelGeometry();
  const stemGroup = new THREE.Group();
  stemGroup.name = 'BananaPedicel';
  const stemBodyMesh = new THREE.Mesh(pedicelBodyGeo, stemMaterial);
  stemBodyMesh.castShadow = castShadow;
  stemBodyMesh.receiveShadow = castShadow;
  const stemCutMesh = new THREE.Mesh(pedicelCapGeo, stemCutMaterial);
  stemCutMesh.castShadow = castShadow;
  stemGroup.add(stemBodyMesh, stemCutMesh);
  specimenGroup.add(stemGroup);

  // Build dark dried blossom tip nub at t = 0
  const blossomGeo = createBlossomTipGeometry();
  const blossomMesh = new THREE.Mesh(blossomGeo, blossomMaterial);
  blossomMesh.name = 'BananaBlossomTip';
  const bottomSample = evaluateBananaSpine(0);
  spineToVec3(bottomSample.position, blossomMesh.position);
  const bottomBasis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(bottomSample.normal.x, bottomSample.normal.y, bottomSample.normal.z),
    new THREE.Vector3(bottomSample.tangent.x, bottomSample.tangent.y, bottomSample.tangent.z),
    new THREE.Vector3(bottomSample.binormal.x, bottomSample.binormal.y, bottomSample.binormal.z)
  );
  blossomMesh.quaternion.setFromRotationMatrix(bottomBasis);
  blossomMesh.castShadow = castShadow;
  specimenGroup.add(blossomMesh);

  // Build studio turntable pedestal & contact shadow
  const pedestal = createPedestal(textures, castShadow);
  root.add(pedestal.group);

  const stemBasisMatrix = new THREE.Matrix4();

  function applyPeel(peelAmount: number) {
    const p = clamp01(peelAmount);
    for (const petal of petals) {
      updatePetalGeometry(petal, p);
    }

    // Anchor woody pedicel to back peel petal (petal 0) tip transform
    const anchorPetal = petals[0];
    stemGroup.position.copy(anchorPetal.tipPosition);
    stemBasisMatrix.makeBasis(
      anchorPetal.tipNormal,
      anchorPetal.tipTangent,
      anchorPetal.tipBinormal
    );
    stemGroup.quaternion.setFromRotationMatrix(stemBasisMatrix);

    strands.update(p);
  }

  function applyRipeness(ripeness: number) {
    const r = clamp01(ripeness);
    textures.updateRipeness(r);
    const palette = computeRipenessPalette(r);
    peelMaterial.clearcoat = palette.clearcoat;
    peelMaterial.roughness = 0.85 + palette.roughness * 0.45;
  }

  applyPeel(initialPeel);
  applyRipeness(initialRipeness);

  return {
    root,
    specimenGroup,
    pedestalGroup: pedestal.group,
    textures,
    setRipeness: applyRipeness,
    setPeelAmount: applyPeel,
    setPedestalVisible(visible: boolean) {
      pedestal.group.visible = visible;
    },
    dispose() {
      for (const petal of petals) petal.geometry.dispose();
      fleshGeometry.dispose();
      pedicelBodyGeo.dispose();
      pedicelCapGeo.dispose();
      blossomGeo.dispose();
      strands.dispose();
      pedestal.dispose();
      peelMaterial.dispose();
      pithMaterial.dispose();
      fleshMaterial.dispose();
      stemMaterial.dispose();
      stemCutMaterial.dispose();
      blossomMaterial.dispose();
      textures.dispose();
    },
  };
}
