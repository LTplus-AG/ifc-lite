/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpuInstanceCullWgsl, splitHiLo } from './gpu-instance-cull.js';

const f = Math.fround;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The vertex stage's `(local + high) + low` in f32 (rteWorldPosition). */
const vertex = (local: number, hi: number, lo: number) => f(f(local + hi) + lo);

/** The CPU packer's split of an exact f64 delta (instanced-rte.ts). */
const cpuSplit = (d: number) => { const hi = f(d); return [hi, f(d - hi)] as const; };

/** CPU mirror of the WGSL split, for tests: returns [s, e] per axis. */
export function emulateGpuSplit(anchor: readonly [number, number, number], eye: readonly [number, number, number]): { s: number[]; e: number[] } {
  const f = Math.fround;
  const s: number[] = [], e: number[] = [];
  for (let k = 0; k < 3; k++) {
    const [aHi, aLo] = splitHiLo(anchor[k]!);
    const [eHi, eLo] = splitHiLo(eye[k]!);
    const a = f(aHi - eHi), b = f(aLo - eLo);
    const sum = f(a + b);
    const bb = f(sum - a);
    const err = f(f(a - f(sum - bb)) + f(b - bb));
    s.push(sum); e.push(err);
  }
  return { s, e };
}

test('GPU split of a georeferenced anchor matches the f64 delta to well under a micron', () => {
  const r = rng(7);
  let worst = 0;
  for (let n = 0; n < 20000; n++) {
    // ~5,000 km from the origin (UTM northing class), eye within 3 km of the anchor.
    const anchor: [number, number, number] = [2_600_000 + r() * 5000, 400 + r() * 300, -(5_000_000 + r() * 5000)];
    const eye: [number, number, number] = [anchor[0] + (r() - 0.5) * 6000, anchor[1] + (r() - 0.5) * 200, anchor[2] + (r() - 0.5) * 6000];
    const { s, e } = emulateGpuSplit(anchor, eye);
    for (let k = 0; k < 3; k++) {
      const exact = anchor[k]! - eye[k]!;
      worst = Math.max(worst, Math.abs((s[k]! + e[k]!) - exact));
    }
  }
  // The f64→(hi, lo) split of each operand keeps ~48 bits; the residual is nanometres.
  assert.ok(worst < 1e-6, `worst split error ${worst} m`);
});

test('jitter: a vertex 1 m from the eye at 5,000 km lands where the CPU packer puts it (sub-0.1 mm)', () => {
  const r = rng(11);
  let worstVsCpu = 0;
  let worstVsExact = 0;
  for (let n = 0; n < 20000; n++) {
    const anchor: [number, number, number] = [3_000_000 + r() * 1000, 50 + r() * 50, -(5_000_000 + r() * 1000)];
    // Close-up: the eye orbits within a metre or so of the occurrence.
    const eye: [number, number, number] = [anchor[0] + (r() - 0.5) * 2, anchor[1] + (r() - 0.5) * 2, anchor[2] + (r() - 0.5) * 2];
    const local = (r() - 0.5) * 2; // template-local vertex offset, metres
    const { s, e } = emulateGpuSplit(anchor, eye);
    for (let k = 0; k < 3; k++) {
      const exact = anchor[k]! - eye[k]! + local;
      const gpu = vertex(local, s[k]!, e[k]!);
      const [hi, lo] = cpuSplit(anchor[k]! - eye[k]!);
      const cpu = vertex(local, hi, lo);
      worstVsCpu = Math.max(worstVsCpu, Math.abs(gpu - cpu));
      worstVsExact = Math.max(worstVsExact, Math.abs(gpu - exact));
    }
  }
  assert.ok(worstVsExact < 1e-4, `worst vertex error vs exact ${worstVsExact} m`);
  assert.ok(worstVsCpu < 1e-6, `worst vertex difference vs CPU packer ${worstVsCpu} m`);
});

test('naive f32 world subtraction at 5,000 km jitters by decimetres (what the hi/lo split avoids)', () => {
  const anchor = 5_000_000.30;
  const eye = 5_000_000.05;
  const naive = f(f(anchor) - f(eye));
  const { s, e } = emulateGpuSplit([anchor, 0, 0], [eye, 0, 0]);
  assert.ok(Math.abs(naive - (anchor - eye)) > 0.1);
  assert.ok(Math.abs((s[0]! + e[0]!) - (anchor - eye)) < 1e-6);
});

test('cull shader keeps the error-free TwoSum and the RTE envelope', () => {
  assert.match(gpuInstanceCullWgsl, /let e = \(\(a - av\) \* k\) \+ \(\(b - bb\) \* k\);/);
  // The sum goes through a runtime 1.0 so a reassociating driver cannot fold the error term away (measured on NVIDIA Vulkan).
  assert.match(gpuInstanceCullWgsl, /let s = \(a \+ b\) \* k;/);
  assert.match(gpuInstanceCullWgsl, /P\.misc\.y/);
  // Records are written in the INSTANCED_VERTEX_BUFFERS layout (22 words).
  assert.match(gpuInstanceCullWgsl, /const RECORD_WORDS: u32 = 22u;/);
});
