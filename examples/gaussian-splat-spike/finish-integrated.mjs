/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 integrated-viewer finishing. The screencast's JPEG frames are copied
// unchanged into the master. Deliverables add a strip *below* the capture with
// the live step caption, build label, disclosures and licence credit, so no
// viewer UI is covered. Capture timestamps pass through; nothing is resampled.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { showcaseCredits } from './showcase-credits.mjs';
import { catalogEntry, repoRoot, sha256File } from './showcase-fixture.mjs';
import { captionWindows } from './screencast-timing.mjs';
import { absoluteOutput, requireOptions } from './showcase-args.mjs';
import { BT709_FILTER, BT709_OUTPUT, TIMESTAMP_PASSTHROUGH, assertSameTimestamps, probeVideo, refuseExisting, verifyBt709 } from './showcase-video.mjs';

const { values: args } = parseArgs({ options: {
  take: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' }, disclosure: { type: 'string', multiple: true },
  stem: { type: 'string', default: 'integrated' }, threads: { type: 'string', default: '4' },
  'font-dir': { type: 'string', default: '/usr/share/fonts/truetype/dejavu' },
} });
requireOptions(args, ['take', 'out', 'label'], '--take DIR --out ABS_DIR --label TEXT --disclosure TEXT [--disclosure TEXT]');
if (!args.disclosure?.length) throw new Error('missing --disclosure');
absoluteOutput(args.out);
const take = resolve(args.take);
const recording = JSON.parse(await readFile(join(take, 'evidence-integrated.json'), 'utf8'));
if (recording.failure) throw new Error('refusing to finish a failed take');
// The recorder verified the local capture bytes at take time; the credit comes from the
// catalogue entry, which must carry the same SHA-256 the take recorded.
const entry = await catalogEntry(recording.asset.path.replace(/^gaussian\//, ''));
if (recording.asset.sha256 !== entry.sha256) throw new Error('take asset SHA-256 differs from the catalogue entry');
const credits = showcaseCredits(entry);
const captions = captionWindows(recording.timeline);
await mkdir(args.out, { recursive: true });
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', args.threads, ...a], { stdio: 'inherit' });

const master = join(args.out, `${args.stem}-master.mkv`);
await refuseExisting([master, join(args.out, `${args.stem}.mp4`), join(args.out, `${args.stem}.webm`)]);
ffmpeg('-f', 'concat', '-safe', '0', '-i', join(take, 'frames.ffconcat'), '-c', 'copy', master);
const textDir = join(args.out, 'overlay-text');
await mkdir(textDir, { recursive: true });
const lines = { label: args.label, ...Object.fromEntries(args.disclosure.map((d, i) => [`disclosure-${i}`, d])), credit: credits.credit, change: credits.change };
for (const [name, value] of Object.entries(lines)) await writeFile(join(textDir, `${name}.txt`), value);
for (const [i, window] of captions.entries()) await writeFile(join(textDir, `step-${i}.txt`), window.caption);
// Strip rows: live caption, one row per disclosure, then the two credit rows.
const W = 1920, H = 1080, ROW = 32, STRIP = 70 + ROW * args.disclosure.length + 2 * 30;
const bold = join(args['font-dir'], 'DejaVuSans-Bold.ttf'), regular = join(args['font-dir'], 'DejaVuSans.ttf');
const text = (file, font, size, color, x, y, extra) =>
  `drawtext=fontfile=${font}:textfile=${join(textDir, file)}:expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}${extra ? `:${extra}` : ''}`;
const filter = [
  `scale=${W}:${H}:flags=lanczos,pad=${W}:${H + STRIP}:0:0:color=0x0b0d10`,
  ...captions.map((w, i) => text(`step-${i}.txt`, bold, 30, 'white', 32, H + 16, `enable='between(t,${w.start},${w.end})'`)),
  text('label.txt', bold, 22, '0xFFC857', 'w-tw-32', H + 22),
  ...args.disclosure.map((_, i) => text(`disclosure-${i}.txt`, regular, 21, 'white@0.92', 32, H + 62 + ROW * i)),
  text('credit.txt', regular, 19, 'white@0.80', 32, H + 66 + ROW * args.disclosure.length),
  text('change.txt', regular, 19, 'white@0.80', 32, H + 96 + ROW * args.disclosure.length),
  // Screencast JPEGs are full range; deliver standard limited-range BT.709.
  `scale=in_range=pc:out_range=tv,format=yuv420p,${BT709_FILTER}`,
].join(',');
const outputs = [
  { file: join(args.out, `${args.stem}.mp4`), codec: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-movflags', '+faststart'] },
  { file: join(args.out, `${args.stem}.webm`), codec: ['-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2'] },
];
for (const output of outputs) {
  ffmpeg('-i', master, '-vf', filter, ...TIMESTAMP_PASSTHROUGH, '-an', ...output.codec, ...BT709_OUTPUT, output.file);
  Object.assign(output, { sha256: await sha256File(output.file), probe: probeVideo(output.file) });
  verifyBt709(output.file, output.probe);
  output.frames = assertSameTimestamps(master, output.file);
  delete output.codec;
}
const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' }).trim();
const evidence = { issue: 8567, recording, credits, captions, overlay: lines,
  tooling: { head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'examples/gaussian-splat-spike') !== '' },
  master: { file: master, sha256: await sha256File(master), probe: probeVideo(master) }, outputs,
  method: 'concat demuxer with real screencast intervals; JPEG frames copied to the master; strip below the capture; timestamps passed through' };
await writeFile(join(args.out, 'finish-integrated-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ master: evidence.master.sha256, outputs: outputs.map(o => ({ file: o.file, sha256: o.sha256,
  frames: o.frames, duration: o.probe.duration })) }, null, 1));
