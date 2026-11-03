/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 RESEARCH PREVIEW finishing: adds the title card, persistent research
// label and licence credit to an untouched master take with ffmpeg drawtext.
// Frame timestamps pass through unchanged: no interpolated or duplicated frames.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { showcaseCredits } from './showcase-credits.mjs';
import { catalogEntry, repoRoot as repo, sha256File } from './showcase-fixture.mjs';
import { absoluteOutput, requireOptions } from './showcase-args.mjs';
import { BT709_FILTER, BT709_OUTPUT, TIMESTAMP_PASSTHROUGH, assertSameTimestamps, probeVideo, refuseExisting, verifyBt709 } from './showcase-video.mjs';

const { values: args } = parseArgs({ options: {
  master: { type: 'string' }, asset: { type: 'string' }, out: { type: 'string' }, splats: { type: 'string' },
  'font-dir': { type: 'string', default: '/usr/share/fonts/truetype/dejavu' }, threads: { type: 'string', default: '4' },
} });
requireOptions(args, ['master', 'asset', 'out'], '--master TAKE --asset NAME.ply --out ABS_DIR');
absoluteOutput(args.out);
const entry = await catalogEntry(args.asset);
const credits = showcaseCredits(entry);
await mkdir(args.out, { recursive: true });

const count = Number(args.splats ?? entry.gaussian.count).toLocaleString('en-US');
const lines = {
  badge: 'RESEARCH PREVIEW · not a production showcase',
  title: credits.title,
  subtitle: `${credits.capture} · ${count} Gaussian splats · real-time WebGPU render`,
  label: 'Upstream PlayCanvas engine in the ifc-lite research spike, not the ifc-lite viewer',
  credit: credits.credit,
  change: credits.change,
};
const textDir = join(args.out, 'overlay-text');
await mkdir(textDir, { recursive: true });
for (const [name, text] of Object.entries(lines)) await writeFile(join(textDir, `${name}.txt`), text);
const bold = join(args['font-dir'], 'DejaVuSans-Bold.ttf'), regular = join(args['font-dir'], 'DejaVuSans.ttf');
const master = { file: resolve(args.master), sha256: await sha256File(args.master), probe: probeVideo(args.master) };
const { width: W, height: H } = master.probe;
const px = fraction => Math.round(H * fraction);
// Title card: fade in 0.4-0.9 s, hold, fade out 4.6-5.2 s.
const fade = "alpha='if(lt(t,0.4),0,if(lt(t,0.9),(t-0.4)/0.5,if(lt(t,4.6),1,if(lt(t,5.2),(5.2-t)/0.6,0))))':enable='between(t,0.4,5.2)'";
const text = (name, font, size, color, x, y, extra) =>
  `drawtext=fontfile=${font}:textfile=${join(textDir, `${name}.txt`)}:expansion=none:fontsize=${size}:fontcolor=${color}` +
  `:box=1:boxcolor=black@0.5:boxborderw=${Math.round(size * 0.45)}:x=${x}:y=${y}${extra ? `:${extra}` : ''}`;
const left = Math.round(W * 0.021), cardLeft = Math.round(W * 0.033), cardTop = px(0.62);
const vf = [
  text('badge', bold, px(0.022), '0xFFC857', left, px(0.033)),
  text('title', bold, px(0.058), 'white', cardLeft, cardTop, fade),
  text('subtitle', regular, px(0.026), 'white', cardLeft, cardTop + px(0.085), fade),
  text('label', regular, px(0.024), '0xFFC857', cardLeft, cardTop + px(0.135), fade),
  text('credit', regular, px(0.0195), 'white@0.92', left, H - px(0.092)),
  text('change', regular, px(0.0195), 'white@0.92', left, H - px(0.056)),
  // Chrome records full-range BT.709. Deliver standard limited range so players
  // that ignore the range flag still show the captured colours.
  `scale=in_range=pc:out_range=tv,format=yuv420p,${BT709_FILTER}`,
].join(',');
const stem = basename(args.master).replace(/-master\.(webm|mp4)$/, '');
const outputs = [
  { file: join(args.out, `${stem}.mp4`), codec: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  { file: join(args.out, `${stem}.webm`), codec: ['-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p'] },
];
await refuseExisting(outputs.map(output => output.file));
for (const output of outputs) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', args.threads, '-i', master.file, '-vf', vf,
    ...TIMESTAMP_PASSTHROUGH, '-an', ...output.codec, ...BT709_OUTPUT, '-threads', args.threads, output.file], { stdio: 'inherit' });
  Object.assign(output, { sha256: await sha256File(output.file), probe: probeVideo(output.file) });
  verifyBt709(output.file, output.probe);
  output.frames = assertSameTimestamps(master.file, output.file);
  delete output.codec;
}
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const source = { head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'examples/gaussian-splat-spike') !== '' };
const evidence = { issue: 8567, label: lines.badge, source, ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  master, overlay: lines, fonts: [bold, regular],
  method: 'ffmpeg drawtext over the untouched master; -fps_mode passthrough with the demuxer time base keeps capture timestamps', outputs };
await writeFile(join(args.out, 'finish-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ master: master.probe, outputs: outputs.map(o => ({ file: o.file, sha256: o.sha256, frames: o.probe.nb_read_frames, duration: o.probe.duration })) }, null, 2));
