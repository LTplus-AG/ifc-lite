/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567: one video contract for both showcase finishers, so their probe fields,
// colour tagging, timestamp passthrough and overwrite refusal cannot drift apart.
import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// ffmpeg 8 ignores the -color_* output options alone; tag the frames themselves.
export const BT709_FILTER = 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
export const BT709_OUTPUT = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
export const BT709_TAGS = Object.freeze({ color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709' });
// Capture timestamps pass through unchanged: no resampling, interpolation or duplication.
export const TIMESTAMP_PASSTHROUGH = ['-fps_mode', 'passthrough', '-enc_time_base:v', 'demux'];

/** Stream and container facts for one video, flattened; includes every tag BT709_TAGS checks. */
export function probeVideo(file) {
  const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,profile,width,height,pix_fmt,avg_frame_rate,r_frame_rate,nb_read_frames,color_range,color_space,color_primaries,color_transfer'
    + ':format=duration,size,format_name', '-of', 'json', file], { encoding: 'utf8' }));
  return { ...json.streams[0], ...json.format };
}

/** Throws unless the probed stream is tagged limited-range BT.709 in all four fields. */
export function verifyBt709(file, probe) {
  const wrong = Object.entries(BT709_TAGS).filter(([key, value]) => probe[key] !== value);
  if (wrong.length) throw new Error(`${file} colour tags ${wrong.map(([key]) => `${key}=${probe[key]}`).join(', ')}; expected limited-range BT.709`);
}

/** Presentation timestamps in milliseconds, in display order. */
export function frameTimestamps(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.split('\n').map(line => line.replace(/,$/, '').trim()).filter(Boolean).map(value => Math.round(Number(value) * 1000));
}

/** Verify the integrated master against retained capture times, not itself. */
export function assertCaptureTimestamps(seconds, file) {
  if (!Array.isArray(seconds) || seconds.length < 2 || seconds[0] !== 0
      || seconds.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= seconds[i - 1]))) {
    throw new Error('take lacks valid retained capture timestamps; record a new take');
  }
  const expected = seconds.map(t => Math.round(t * 1000));
  const actual = frameTimestamps(file);
  // ffconcat repeats the last JPEG to express its final hold duration.
  if (actual.length !== expected.length + 1 || expected.some((t, i) => actual[i] !== t)
      || actual.at(-1) <= actual.at(-2)) {
    throw new Error('master timestamps differ from the retained capture at millisecond precision');
  }
}

/** Throws unless `file` carries exactly the reference's frame timestamps. */
export function assertSameTimestamps(reference, file) {
  const expected = frameTimestamps(reference), actual = frameTimestamps(file);
  const at = expected.findIndex((t, i) => actual[i] !== t);
  if (expected.length !== actual.length || at !== -1) {
    throw new Error(`${file} timestamps differ from ${reference}: ${actual.length} vs ${expected.length} frames, first difference at frame ${at}`);
  }
  return expected.length;
}

/** Delivered files are never overwritten: regenerate into a new directory or stem. */
export async function refuseExisting(files) {
  for (const file of files) if (await access(file).then(() => true, () => false)) throw new Error(`refusing to overwrite ${file}`);
}
