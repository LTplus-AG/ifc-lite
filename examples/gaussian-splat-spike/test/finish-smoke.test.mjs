/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8567: both showcase finishers, end to end, on tiny generated videos (never deliverables).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogEntry } from '../showcase-fixture.mjs';
import { screencastConcat } from '../screencast-timing.mjs';
import { BT709_TAGS, frameTimestamps, probeVideo } from '../showcase-video.mjs';

const spike = fileURLToPath(new URL('..', import.meta.url));
const FONTS = '/usr/share/fonts/truetype/dejavu';
function missingTools() {
  try {
    const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const filters = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    if (!/libx264/.test(encoders) || !/libvpx-vp9/.test(encoders) || !/\bdrawtext\b/.test(filters)) return 'ffmpeg lacks libx264, libvpx-vp9 or drawtext';
    if (!['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].every(font => existsSync(join(FONTS, font)))) return 'DejaVu fonts not installed';
    return false;
  } catch (error) {
    return `ffmpeg/ffprobe unavailable (${error.code ?? error.message})`;
  }
}
const skip = missingTools();
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const finish = (script, args) => spawnSync(process.execPath, [join(spike, script), ...args, '--threads', '2'], { encoding: 'utf8' });

// A capture with one 400 ms hold, as a real take has: seconds per frame.
const STEPS = [1 / 30, 1 / 30, 0.4, 1 / 30, 1 / 30, 1 / 30];
async function capturedFrames(dir) {
  await mkdir(join(dir, 'frames'), { recursive: true });
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-frames:v', String(STEPS.length + 1), '-pix_fmt', 'yuvj420p', join(dir, 'frames', '%06d.jpg'));
  let ts = 100;
  const frames = [{ n: 1, ts }, ...STEPS.map((step, i) => ({ n: i + 2, ts: (ts += step) }))];
  const concat = join(dir, 'frames.ffconcat');
  await writeFile(concat, screencastConcat(frames));
  return { frames, concat };
}
function assertDelivered(outputs, reference) {
  assert.equal(outputs.length, 2);
  const expected = frameTimestamps(reference);
  for (const output of outputs) {
    assert.ok(existsSync(output.file), output.file);
    const probe = probeVideo(output.file);
    for (const [key, value] of Object.entries(BT709_TAGS)) assert.equal(probe[key], value, `${output.file} ${key}`);
    assert.deepEqual(frameTimestamps(output.file), expected, `${output.file} keeps the reference timestamps`);
    assert.equal(output.frames, expected.length);
  }
  return expected;
}

test('research finisher delivers tagged MP4 and WebM on the master timestamps, never overwriting (#8567)', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'showcase-finish-research-'));
  try {
    const { concat } = await capturedFrames(dir);
    // A full-range VFR master, like Chrome's MediaRecorder take.
    const master = join(dir, 'smoke-research-preview-master.webm');
    ffmpeg('-f', 'concat', '-safe', '0', '-i', concat, '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-vf', 'scale=in_range=pc:out_range=pc,format=yuv420p',
      '-color_range', 'pc', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-deadline', 'realtime', master);
    const out = join(dir, 'final');
    const args = ['--master', master, '--asset', 'seem-kirke-v1.ply', '--out', out];
    const first = finish('finish-showcase.mjs', args);
    assert.equal(first.status, 0, first.stderr);
    const evidence = JSON.parse(await readFile(join(out, 'finish-evidence.json'), 'utf8'));
    const expected = assertDelivered(evidence.outputs, master);
    assert.ok(expected.includes(Math.round((2 / 30) * 1000)) && expected.some((t, i) => i && t - expected[i - 1] === 400), 'the 400 ms hold survives');
    const again = finish('finish-showcase.mjs', args);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /refusing to overwrite/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('integrated finisher copies the captured frames and keeps their intervals in both outputs (#8567)', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'showcase-finish-integrated-'));
  try {
    const take = join(dir, 'take');
    const { frames } = await capturedFrames(take);
    const entry = await catalogEntry('seem-kirke-v1.ply');
    const recording = { issue: 8567, frameTimestampsSeconds: frames.map(frame => frame.ts - frames[0].ts), asset: { path: entry.path, sha256: entry.sha256 },
      timeline: [{ name: 'a', caption: 'Step A', start: 0, end: 0.06 }, { name: 'b', caption: 'Step B', start: 0.06, end: 0.6 }] };
    await writeFile(join(take, 'evidence-integrated.json'), JSON.stringify(recording));
    const out = join(dir, 'final');
    const args = ['--take', take, '--out', out, '--stem', 'smoke', '--label', 'SMOKE · not a deliverable', '--disclosure', 'one', '--disclosure', 'two'];
    const run = finish('finish-integrated.mjs', args);
    assert.equal(run.status, 0, run.stderr);
    const evidence = JSON.parse(await readFile(join(out, 'finish-integrated-evidence.json'), 'utf8'));
    const expected = assertDelivered(evidence.outputs, evidence.master.file);
    const captureTimes = frames.map(frame => Math.round((frame.ts - frames[0].ts) * 1000));
    assert.deepEqual(expected.slice(0, frames.length), captureTimes, 'master keeps capture timestamps at millisecond precision');
    assert.ok(expected.every((t, i) => !i || t > expected[i - 1]), 'distinct capture frames do not acquire duplicate timestamps');
    // A take whose recorded capture hash disagrees with the catalogue is refused.
    await writeFile(join(take, 'evidence-integrated.json'), JSON.stringify({ ...recording, asset: { ...recording.asset, sha256: '0'.repeat(64) } }));
    const mismatch = finish('finish-integrated.mjs', [...args.slice(0, 3), join(dir, 'final-2'), ...args.slice(4)]);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /differs from the catalogue/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
