/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Cinematic recorder, pure parts: the camera path must be identical for a
// before and an after clip (a function of the manifest only), continuous
// between shots, never static for long, and the IFC -> viewer axis fit must
// recover the viewer's convention; the composer's verdict must only state
// what both clips measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const load = async (name) => { const u = new URL(name, import.meta.url); return existsSync(u) ? import(u.href) : null; };
const pathModule = await load('./huge-geometry-cinema-path.mjs');
const showcaseModule = await load('./huge-geometry-showcase.mjs');
const ladderModule = await load('./huge-geometry-ladder.mjs');
const composeModule = await load('./huge-geometry-compose.mjs');
const need = (m, name) => { assert.ok(m, `scripts/perf/${name} does not exist`); return m; };
const P = () => need(pathModule, 'huge-geometry-cinema-path.mjs');

const showcaseOf = (elements) => {
  const s = need(ladderModule, 'huge-geometry-ladder.mjs').resolveScenario({ look: 'showcase', elements });
  return need(showcaseModule, 'huge-geometry-showcase.mjs').generateShowcaseModel(() => {}, s).showcase;
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('camera path: a pure function of the manifest (same tier, same path)', () => {
  const a = P().buildShots(showcaseOf(30000)), b = P().buildShots(showcaseOf(30000));
  assert.deepEqual(a, b);
  for (const shot of a) for (const u of [0, 0.37, 1]) assert.deepEqual(P().poseAt(shot, u), P().poseAt(shot, u));
});

test('camera path: shots chain without jumps, cover every beat, and keep moving', () => {
  const shots = P().buildShots(showcaseOf(30000));
  for (let i = 1; i < shots.length; i++) {
    const end = P().poseAt(shots[i - 1], 1), start = P().poseAt(shots[i], 0);
    assert.ok(dist(end.eye, start.eye) < 1e-6 && dist(end.target, start.target) < 1e-6, `jump between ${shots[i - 1].name} and ${shots[i].name}`);
  }
  assert.deepEqual(shots.filter((s) => s.beat).map((s) => s.beat).sort(), ['colour', 'isolate', 'pick', 'section']);
  for (const name of ['fly-in', 'orbit', 'dive', 'street', 'pull-back']) assert.ok(shots.some((s) => s.name === name), name);
  // No static stretch longer than ~3 s: within every 1 s window of every shot, the eye or the view direction moves.
  for (const shot of shots) {
    const steps = Math.ceil(shot.durationMs / 1000);
    for (let k = 0; k < steps; k++) {
      const u0 = k / steps, u1 = Math.min(1, (k + 1) / steps);
      if (shot.hold && u0 >= shot.hold[0] - 1 / steps && u1 <= shot.hold[1] + 1 / steps) continue; // a declared still moment
      const a = P().poseAt(shot, u0), b = P().poseAt(shot, u1);
      assert.ok(dist(a.eye, b.eye) + dist(a.target, b.target) > 0.05, `${shot.name} static in second ${k}`);
    }
  }
  for (const shot of shots) if (shot.hold) assert.ok((shot.hold[1] - shot.hold[0]) * shot.durationMs <= 2500, `${shot.name} holds too long`);
  const total = P().totalMs(shots);
  assert.ok(total > 45000 && total < 90000, `path is ${total} ms`);
});

test('camera path: street level is at street level, the overview sees the whole city', () => {
  const sc = showcaseOf(250000);
  const shots = P().buildShots(sc);
  const street = shots.find((s) => s.name === 'street');
  for (const u of [0, 0.5, 1]) assert.ok(P().poseAt(street, u).eye[2] < 10);
  const span = Math.max(sc.bbox.max[0] - sc.bbox.min[0], sc.bbox.max[1] - sc.bbox.min[1]);
  const first = P().poseAt(shots[0], 0);
  assert.ok(dist(first.eye, first.target) > span, 'fly-in starts beyond the city');
});

test('axis fit: recovers a Z-up -> Y-up mapping with an offset, and a mirrored one', () => {
  const sc = showcaseOf(20000);
  for (const truth of [(p) => [p[0] - 10, p[2] + 3, -p[1] + 7], (p) => [-p[1], p[2], p[0] + 100]]) {
    const pairs = sc.hero.anchors.map((a) => ({ ifc: a.centre, viewer: truth(a.centre) }));
    const map = P().solveAxisMap(pairs);
    assert.ok(map.rms < 1e-9);
    for (const q of [[1, 2, 3], [-50, 80, 12]]) assert.ok(dist(map.apply(q), truth(q)) < 1e-9);
  }
  assert.equal(P().solveAxisMap([{ ifc: [0, 0, 0], viewer: [0, 0, 0] }]), null);
});

test('composer: verdict states only what both clips measured', () => {
  const c = need(composeModule, 'huge-geometry-compose.mjs');
  const shot = (median, p95, draws) => ({ name: 'orbit', start: 0, end: 1, frames: { frameMs: { median, p95, worst: p95 }, drawsPerFrame: { median: draws }, trianglesPerFrame: { median: 1 } } });
  const ok = (load, median, draws) => ({ status: 'ok', load: { timings: { interactiveMs: load * 1000, firstFrameMs: 1000 } }, shots: [shot(median, median * 2, draws)], peak: { rendererPssMiB: 4096 } });
  const lines = c.verdictLines(c.headline(ok(30, 40, 900)), c.headline(ok(10, 10, 90)));
  assert.ok(lines.some((l) => /load: 30\.0 → 10\.0 s \(3\.00× lower\)/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /frame median: 40\.0 → 10\.0 ms \(4\.00× lower\)/.test(l)));
  const failed = { status: 'failed', failure: { kind: 'renderer-crash' }, shots: [] };
  assert.match(c.verdictLines(c.headline(failed), c.headline(ok(10, 10, 90)))[0], /before FAILED \(renderer-crash\)/);
  assert.match(c.verdictLines(c.headline(ok(10, 10, 90)), c.headline(failed))[0], /after FAILED/);
});

test('composer: pair timeline aligns shots by name and holds a failed clip', () => {
  const c = need(composeModule, 'huge-geometry-compose.mjs');
  const clip = (loadLen, shotLens) => {
    let t = 3 + loadLen;
    const shots = shotLens.map(([name, len]) => { const s = { name, caption: name, start: t, end: t + len }; t += len; return s; });
    return { status: 'ok', timeline: { load: [3, 3 + loadLen], path: shots.length ? [shots[0].start, t] : null }, shots };
  };
  const b = clip(20, [['fly-in', 7.2], ['orbit', 9.4]]), a = clip(8, [['fly-in', 7.0], ['orbit', 9.0]]);
  const seg = c.pairTimeline(b, a);
  assert.deepEqual(seg.map((s) => s.kind), ['load', 'shot', 'shot']);
  assert.equal(seg[0].length, 20);
  assert.ok(Math.abs(seg[1].length - 7.2) < 1e-9);
  assert.equal(seg[2].src[1](0), a.shots[1].start);
  assert.equal(seg[0].done[1](9), true);
  const dead = { status: 'failed', timeline: { load: [3, 40], path: null }, shots: [] };
  const seg2 = c.pairTimeline(dead, a);
  assert.equal(seg2.length, 3);
  assert.equal(seg2[1].src[0](2), 40 - 0.04, 'the failed clip holds its last load frame');
});

test('composer: a clip that errored before its load still composes', () => {
  const c = need(composeModule, 'huge-geometry-compose.mjs');
  const errored = { status: 'error', timeline: { title: [0, 3], load: null, path: null }, shots: [] };
  const ok = { status: 'ok', timeline: { load: [3, 11], path: [11, 18] }, shots: [{ name: 'fly-in', caption: 'fly-in', start: 11, end: 18 }] };
  const seg = c.pairTimeline(errored, ok);
  assert.deepEqual(seg.map((s) => s.kind), ['load', 'shot']);
  assert.equal(seg[0].length, 8);
  assert.equal(seg[1].src[0](1), 3, 'the errored pane holds its last title-card frame');
});

test('remote outputs: HGFILE lines round-trip, incomplete files are refused', async () => {
  const u = await load('./huge-geometry-unpack.mjs');
  need(u, 'huge-geometry-unpack.mjs');
  const buf = Buffer.from(Array.from({ length: 200000 }, (_, i) => i % 251));
  const b64 = buf.toString('base64'), chunk = 1 << 16, n = Math.ceil(b64.length / chunk);
  const lines = Array.from({ length: n }, (_, i) => `HGFILE clips/x.webm ${i + 1}/${n} ${b64.slice(i * chunk, (i + 1) * chunk)}`);
  const noise = ['[cinema] something', ...lines.reverse(), 'exit 0'].join('\n');
  const { files, incomplete } = u.unpack(noise);
  assert.deepEqual(files.get('clips/x.webm'), buf);
  assert.equal(incomplete.length, 0);
  assert.deepEqual(u.unpack(lines.slice(1).join('\n')).incomplete, ['clips/x.webm']);
});
