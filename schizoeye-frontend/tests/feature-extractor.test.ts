import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { innerWidth: 1920, innerHeight: 1080 },
});

const { FEATURE_ORDER, createFeatureExtractor } = await import('../public/feature-extractor.js');

/** Build a fixed free-viewing set covering multiple images and gaze directions. */
function makeFreeViewingRows() {
  const rows = [];
  for (let image = 0; image < 4; image += 1) {
    for (let i = 0; i < 120; i += 1) {
      const time = i / 30;
      rows.push({
        timestamp_ms: i * (1000 / 30),
        x: 960 + 300 * Math.sin(time * 2.1 + image),
        y: 540 + 180 * Math.cos(time * 1.7 + image),
        velocity: 250 + 30 * Math.sin(time),
        image_index: image,
        is_blink: 0,
        confidence: 0.9,
      });
    }
  }
  return rows;
}

/** Build deterministic horizontal and Lissajous pursuit traces. */
function makeSpemRows() {
  const rows = [];
  const phases = [
    ['Horizontal_0.4Hz', 0.4, false],
    ['Lissajous_0.2Hz', 0.2, true],
    ['Lissajous_0.4Hz', 0.4, true],
  ] as const;
  for (const [phase, frequency, isLissajous] of phases) {
    for (let i = 0; i < 720; i += 1) {
      const time = i / 30;
      rows.push({
        Timestamp: time,
        TaskPhase: phase,
        TargetX: 960 + 260 * Math.sin(2 * Math.PI * frequency * time),
        TargetY: 540 + (isLissajous ? 170 * Math.sin(4 * Math.PI * frequency * time) : 0),
        EyeX: 960 + 240 * Math.sin(2 * Math.PI * frequency * (time - 0.08)),
        EyeY: 540 + (isLissajous ? 150 * Math.sin(4 * Math.PI * frequency * (time - 0.08)) : 0),
      });
    }
  }
  return rows;
}

/** Build fixation and antisaccade samples to cover all task feature families. */
function makeSchizoEyeRows() {
  const rows = [];
  let timestamp = 0;
  for (const phase of ['FIX_NONE', 'FIX_SINGLE', 'FIX_MULTI']) {
    for (let i = 0; i < 150; i += 1, timestamp += 33) {
      rows.push({
        Timestamp_ms: timestamp,
        Phase: phase,
        Gaze_X: 960 + 4 * Math.sin(i / 5),
        Gaze_Y: 540 + 5 * Math.cos(i / 6),
        Target_X: 960,
        Target_Y: 540,
      });
    }
  }
  for (let trial = 0; trial < 10; trial += 1) {
    for (let i = 0; i < 35; i += 1) {
      const gazeX = i < 8 ? 960 + Math.sin(i) * 3 : (trial % 2 ? 750 : 1170);
      rows.push({
        Timestamp_ms: timestamp + trial * 1100 + i * 33,
        Phase: 'ANTISACCADE',
        Gaze_X: gazeX,
        Gaze_Y: 540,
        Target_X: 960 + (trial % 2 ? 100 : -100),
        Target_Y: 540,
      });
    }
  }
  return rows;
}

test('all 59 calculated features match the pre-refactor baseline fixture', () => {
  const result = createFeatureExtractor(37).extractSessionFeatures(
    makeFreeViewingRows(),
    makeSpemRows(),
    makeSchizoEyeRows(),
  );
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  assert.equal(Object.keys(result.finalFeatures).length, 59);
  assert.deepEqual(Object.keys(result.finalFeatures), [...FEATURE_ORDER]);
  assert.equal(digest, '91ff19a1f45e6014b71ae756380f48fa3846f5d113c98ef9a81ba88279911341');
});
