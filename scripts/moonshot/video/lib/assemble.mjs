/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Video assembly + sample-frame helpers shared by both pipelines.
 * ffmpeg is used when present; otherwise an ffmpeg-command.txt is written
 * next to the frames so the mp4 can be assembled elsewhere (nothing is
 * ever installed by these scripts).
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function defaultOutRoot() {
  return process.env.VIDEO_OUT_DIR
    ?? '/private/tmp/claude-501/-Users-louistrue-Development-ifc-lite/2ec75938-454c-46d9-8819-e37d26fe15fe/scratchpad/video';
}

let ffmpegChecked = null;
export function hasFfmpeg() {
  if (ffmpegChecked === null) {
    ffmpegChecked = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  }
  return ffmpegChecked;
}

/** Assemble frames into an mp4, or write the exact command to run later. */
export function assembleMp4(framesDir, pattern, fps, outPath) {
  const ffArgs = [
    '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, pattern),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath,
  ];
  if (hasFfmpeg()) {
    console.log(`[assemble] ffmpeg -> ${outPath}`);
    const res = spawnSync('ffmpeg', ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (res.status !== 0) {
      console.error('[assemble] ffmpeg failed:', res.stderr?.toString().slice(-2000));
      return false;
    }
    return true;
  }
  const cmdFile = path.join(path.dirname(outPath), 'ffmpeg-command.txt');
  writeFileSync(cmdFile, `ffmpeg ${ffArgs.join(' ')}\n`);
  console.log(`[assemble] ffmpeg not found; wrote ${cmdFile}`);
  return false;
}

/**
 * Convert selected PNG frames to jpg quality 80 in sampleDir with a stable
 * prefix (commit-sized proof frames). Uses ffmpeg when present, otherwise
 * macOS sips.
 */
export function exportSampleJpgs(pngPaths, sampleDir, prefix) {
  mkdirSync(sampleDir, { recursive: true });
  for (const png of pngPaths) {
    const base = path.basename(png, '.png');
    const out = path.join(sampleDir, `${prefix}-${base}.jpg`);
    if (hasFfmpeg()) {
      // -qscale:v 4 is approximately libjpeg quality 80.
      spawnSync('ffmpeg', ['-y', '-i', png, '-qscale:v', '4', out], { stdio: 'ignore' });
    } else {
      spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', png, '--out', out], { stdio: 'ignore' });
    }
    console.log(`[assemble] sample ${out}`);
  }
}
