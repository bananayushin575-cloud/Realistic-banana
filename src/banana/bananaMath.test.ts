import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BANANA_SPEC,
  computeRipenessPalette,
  evaluateBananaCrossSectionRadius,
  evaluateBananaLongitudinalProfile,
  evaluateBananaSpine,
  evaluateFleshCrossSectionRadius,
  evaluatePeelCurlAngle,
  evaluatePetalPeelProgress,
  evaluatePedicelRadius,
  evaluatePedicelSpine,
  getPeelHingeT,
} from './bananaMath';

test('banana spine is continuous, finite, and forms a realistic crescent curve', () => {
  const bottom = evaluateBananaSpine(0);
  const mid = evaluateBananaSpine(0.5);
  const top = evaluateBananaSpine(1);

  assert.ok(top.position.y > mid.position.y);
  assert.ok(mid.position.y > bottom.position.y);
  // Realistic vertical span ~20 cm at 1:1 scale
  assert.ok(top.position.y > 0.18 && top.position.y < 0.23);
  // Crescent bow: mid-belly sits further -X than tips
  assert.ok(mid.position.x < bottom.position.x);
  assert.ok(mid.position.x < top.position.x);

  // Orthonormal frame check
  for (const sample of [bottom, mid, top]) {
    const tLen = Math.hypot(sample.tangent.x, sample.tangent.y, sample.tangent.z);
    const nLen = Math.hypot(sample.normal.x, sample.normal.y, sample.normal.z);
    const bLen = Math.hypot(sample.binormal.x, sample.binormal.y, sample.binormal.z);
    assert.ok(Math.abs(tLen - 1) < 1e-5);
    assert.ok(Math.abs(nLen - 1) < 1e-5);
    assert.ok(Math.abs(bLen - 1) < 1e-5);
  }
});

test('5-ridge pentagonal cross-section produces 5 periodic ridge crests and positive radii', () => {
  const t = 0.55;
  const ridgeOuter = evaluateBananaCrossSectionRadius(t, Math.PI);
  const ridgeNext = evaluateBananaCrossSectionRadius(
    t,
    Math.PI + (2 * Math.PI) / BANANA_SPEC.ridgeCount
  );
  const valley = evaluateBananaCrossSectionRadius(
    t,
    Math.PI + Math.PI / BANANA_SPEC.ridgeCount
  );

  assert.ok(ridgeOuter > valley, 'ridge crest must protrude further than facet valley');
  assert.ok(ridgeNext > valley, 'adjacent ridge crest must protrude further than valley');

  // Plump mid-belly must be wider than neck and blossom tip
  const tipProfile = evaluateBananaLongitudinalProfile(0.02);
  const bellyProfile = evaluateBananaLongitudinalProfile(0.45);
  const neckProfile = evaluateBananaLongitudinalProfile(0.98);
  assert.ok(bellyProfile > tipProfile);
  assert.ok(bellyProfile > neckProfile);

  // Flesh radius must remain strictly inside outer peel radius across the body
  for (let i = 1; i < 10; i++) {
    const sampleT = i / 10;
    const outer = evaluateBananaCrossSectionRadius(sampleT, Math.PI * 0.7);
    const flesh = evaluateFleshCrossSectionRadius(sampleT, Math.PI * 0.7);
    assert.ok(flesh > 0 && flesh < outer);
  }
});

test('pedicel stem continues seamlessly from banana neck shoulder', () => {
  const shoulder = evaluateBananaSpine(1.0);
  const pedicelStart = evaluatePedicelSpine(0.0);
  const pedicelEnd = evaluatePedicelSpine(1.0);

  assert.ok(Math.abs(pedicelStart.position.x - shoulder.position.x) < 1e-6);
  assert.ok(Math.abs(pedicelStart.position.y - shoulder.position.y) < 1e-6);
  assert.ok(pedicelEnd.position.y > pedicelStart.position.y);

  const waistR = evaluatePedicelRadius(0.45, Math.PI);
  const crownR = evaluatePedicelRadius(1.0, Math.PI);
  assert.ok(crownR > waistR, 'pedicel flares toward the cut crown');
});

test('peel kinematics stagger strips sequentially and drape cleanly under curl', () => {
  assert.equal(getPeelHingeT(0), 1.0);
  assert.equal(evaluatePeelCurlAngle(0.5, 0), 0);
  assert.equal(evaluatePeelCurlAngle(0, 1), 0);

  // Sequential stagger: at 25% global peel, lead strip 0 is well underway while last strip 3 hasn't started
  const leadAt25 = evaluatePetalPeelProgress(0.25, 0);
  const midAt25 = evaluatePetalPeelProgress(0.25, 2);
  const lastAt25 = evaluatePetalPeelProgress(0.25, 3);
  assert.ok(leadAt25 > midAt25);
  assert.equal(lastAt25, 0);
  assert.equal(evaluatePetalPeelProgress(1.0, 3), 1);

  const nearHingeCurl = evaluatePeelCurlAngle(0.1, 1.0);
  const midCurl = evaluatePeelCurlAngle(0.5, 1.0);
  const tipCurl = evaluatePeelCurlAngle(1.0, 1.0);
  assert.ok(nearHingeCurl > 0 && nearHingeCurl < 0.25, 'C2 onset near hinge is gentle');
  assert.ok(midCurl > nearHingeCurl);
  assert.ok(tipCurl > midCurl && tipCurl > 2.4, 'full curl drapes past horizontal');
  assert.ok(getPeelHingeT(1.0) < 0.5);
});

test('ripeness palette clamps inputs and transitions green -> yellow -> sugar spotted', () => {
  const under = computeRipenessPalette(-1);
  const green = computeRipenessPalette(0);
  const ripe = computeRipenessPalette(0.55);
  const spotted = computeRipenessPalette(1);
  const over = computeRipenessPalette(2);

  assert.equal(under.ripeness, 0);
  assert.equal(over.ripeness, 1);
  assert.equal(green.spotDensity, 0);
  assert.ok(ripe.spotDensity > green.spotDensity);
  assert.ok(spotted.spotDensity > ripe.spotDensity);
  assert.notEqual(green.baseHex, ripe.baseHex);
  assert.notEqual(ripe.baseHex, spotted.baseHex);
});
