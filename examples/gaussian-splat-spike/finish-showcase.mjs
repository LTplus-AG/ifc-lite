/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 RESEARCH PREVIEW finishing: adds the title card, persistent research
// label and licence credit to an untouched master take with ffmpeg drawtext.
// Frame timestamps pass through unchanged: no interpolated or duplicated frames.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { showcaseCredits } from './showcase-credits.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const { values: args } = parseArgs({ options: {
  master: { type: 'string' }, asset: { type: 'string' }, out: { type: 'string' }, splats: { type: 'string' },
  'font-dir': { type: 'string', default: '/usr/share/fonts/truetype/dejavu' },
} });
if (!args.master || !args.asset || !args.out || !isAbsolute(args.out)) throw new Error('usage: --master TAKE --asset NAME.ply --out ABS_DIR');
const manifest = JSON.parse(await readFile(join(repo, 'tests/models/manifest.json'), 'utf8'));
const entry = manifest.files.find(file => file.path === `gaussian/${args.asset}`);
const credits = showcaseCredits(entry);
await mkdir(args.out, { recursive: true });
const sha256File = path => new Promise((done, fail) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
});
const probe = file => {
  const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,profile,width,height,pix_fmt,avg_frame_rate,r_frame_rate,nb_read_frames,color_space,color_primaries,color_transfer:format=duration,size,format_name',
    '-of', 'json', file], { encoding: 'utf8' }));
  return { ...json.streams[0], ...json.format };
};

const count = Number(args.splats ?? entry.gaussian.count).toLocaleString('en-US');
const lines = {
  badge: 'RESEARCH PREVIEW · not a production showcase',
  title: credits.title,
  subtitle: `Real capture: ${credits.capture} · ${count} Gaussian splats · real-time WebGPU render`,
  label: 'Upstream PlayCanvas engine in the ifc-lite research spike, not the ifc-lite viewer',
  credit: credits.credit,
  change: credits.change,
};
const textDir = join(args.out, 'overlay-text');
await mkdir(textDir, { recursive: true });
for (const [name, text] of Object.entries(lines)) await writeFile(join(textDir, `${name}.txt`), text);
const bold = join(args['font-dir'], 'DejaVuSans-Bold.ttf'), regular = join(args['font-dir'], 'DejaVuSans.ttf');
const master = { file: resolve(args.master), sha256: await sha256File(args.master), probe: probe(args.master) };
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
].join(',');
const stem = basename(args.master).replace(/-master\.(webm|mp4)$/, '');
const outputs = [
  { file: join(args.out, `${stem}.mp4`), codec: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  { file: join(args.out, `${stem}.webm`), codec: ['-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p'] },
];
for (const output of outputs) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', master.file, '-vf', vf, '-fps_mode', 'passthrough', '-an', ...output.codec, output.file], { stdio: 'inherit' });
  Object.assign(output, { sha256: await sha256File(output.file), probe: probe(output.file) });
  delete output.codec;
}
const evidence = { issue: 8567, label: lines.badge, master, overlay: lines, fonts: [bold, regular],
  method: 'ffmpeg drawtext over the untouched master; -fps_mode passthrough keeps capture timestamps', outputs };
await writeFile(join(args.out, 'finish-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ master: master.probe, outputs: outputs.map(o => ({ file: o.file, sha256: o.sha256, frames: o.probe.nb_read_frames, duration: o.probe.duration })) }, null, 2));
