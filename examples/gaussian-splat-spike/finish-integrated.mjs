/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 integrated-viewer finishing. The screencast's JPEG frames are copied
// unchanged into the master. Deliverables add a strip *below* the capture with
// the live step caption, build label, disclosures and licence credit, so no
// viewer UI is covered. Capture timestamps pass through; nothing is resampled.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { showcaseCredits } from './showcase-credits.mjs';
import { repoRoot, sha256File, verifiedFixture } from './showcase-fixture.mjs';
import { captionWindows } from './screencast-timing.mjs';

const { values: args } = parseArgs({ options: {
  take: { type: 'string' }, out: { type: 'string' }, assets: { type: 'string' }, label: { type: 'string' }, disclosure: { type: 'string', multiple: true },
  stem: { type: 'string', default: 'integrated' }, threads: { type: 'string', default: '4' },
  'font-dir': { type: 'string', default: '/usr/share/fonts/truetype/dejavu' },
} });
for (const key of ['take', 'out', 'assets', 'label', 'disclosure']) if (!args[key]?.length) throw new Error(`--${key} required`);
const take = resolve(args.take);
const recording = JSON.parse(await readFile(join(take, 'evidence-integrated.json'), 'utf8'));
if (recording.failure) throw new Error('refusing to finish a failed take');
const { entry } = await verifiedFixture(recording.asset.path.replace(/^gaussian\//, ''), resolve(args.assets));
const credits = showcaseCredits(entry);
const captions = captionWindows(recording.timeline);
await mkdir(args.out, { recursive: true });
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
  'stream=codec_name,width,height,pix_fmt,nb_read_frames,color_range,color_space,color_primaries,color_transfer:format=duration,size', '-of', 'json', file], { encoding: 'utf8' }));
const BT709 = { color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709' };
const verifyTags = (file, stream) => {
  const wrong = Object.entries(BT709).filter(([key, value]) => stream[key] !== value);
  if (wrong.length) throw new Error(`${file} colour tags ${wrong.map(([k]) => `${k}=${stream[k]}`).join(', ')}; expected limited-range BT.709`);
};
// Delivered files are never overwritten: regenerate into a new --out or --stem.
const refuseExisting = async file => {
  if (await access(file).then(() => true, () => false)) throw new Error(`refusing to overwrite ${file}`);
};
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', args.threads, ...a], { stdio: 'inherit' });

const master = join(args.out, `${args.stem}-master.mkv`);
for (const file of [master, join(args.out, `${args.stem}.mp4`), join(args.out, `${args.stem}.webm`)]) await refuseExisting(file);
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
  // Screencast JPEGs are full range; deliver standard limited-range BT.709, tagged on
  // the frames themselves (ffmpeg 8 ignores the -color_* output options alone).
  'scale=in_range=pc:out_range=tv,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
].join(',');
const outputs = [
  { file: join(args.out, `${args.stem}.mp4`), codec: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-movflags', '+faststart'] },
  { file: join(args.out, `${args.stem}.webm`), codec: ['-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2'] },
];
for (const output of outputs) {
  ffmpeg('-i', master, '-vf', filter, '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-an', ...output.codec,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', output.file);
  Object.assign(output, { sha256: await sha256File(output.file), probe: probe(output.file) });
  verifyTags(output.file, output.probe.streams[0]);
  delete output.codec;
}
const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' }).trim();
const evidence = { issue: 8567, recording, credits, captions, overlay: lines,
  tooling: { head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'examples/gaussian-splat-spike') !== '' },
  master: { file: master, sha256: await sha256File(master), probe: probe(master) }, outputs,
  method: 'concat demuxer with real screencast intervals; JPEG frames copied to the master; strip below the capture; timestamps passed through' };
await writeFile(join(args.out, 'finish-integrated-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ master: evidence.master.sha256, outputs: outputs.map(o => ({ file: o.file, sha256: o.sha256,
  frames: o.probe.streams[0].nb_read_frames, duration: o.probe.format.duration })) }, null, 1));
