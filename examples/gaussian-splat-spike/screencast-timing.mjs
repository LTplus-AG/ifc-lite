/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 integrated recording: pure timing helpers for CDP screencast frames.
// Frame times are quantized to milliseconds (the delivered Matroska timebase).
// No constant-rate resampling or interpolation.

const frameName = n => `frames/${String(n).padStart(6, '0')}.jpg`;

/** ffconcat script whose durations are the real gaps between captured frames. */
export function screencastConcat(frames, finalSeconds = 1 / 30) {
  if (!Array.isArray(frames) || frames.length < 2) throw new Error('need at least two captured frames');
  for (let i = 1; i < frames.length; i++) {
    if (!(frames[i].ts > frames[i - 1].ts)) throw new Error(`frame ${frames[i].n} is not after frame ${frames[i - 1].n}`);
  }
  const lines = ['ffconcat version 1.0'];
  frames.forEach((frame, i) => {
    lines.push(`file '${frameName(frame.n)}'`);
    // image2 defaults to 25 fps, otherwise rounding every timestamp to 40 ms.
    lines.push('option framerate 1000');
    // Round absolute offsets first: rounding each 1/30 s gap accumulates drift.
    const startMs = Math.round((frame.ts - frames[0].ts) * 1000);
    const endMs = Math.round(((frames[i + 1]?.ts ?? frame.ts + finalSeconds) - frames[0].ts) * 1000);
    lines.push(`duration ${((endMs - startMs) / 1000).toFixed(3)}`);
  });
  // The concat demuxer needs the last file repeated for its duration to apply.
  lines.push(`file '${frameName(frames.at(-1).n)}'`);
  lines.push('option framerate 1000');
  return lines.join('\n') + '\n';
}

/** Interval distribution of one take, for diagnostics; never a performance figure. */
export function intervalStats(frames) {
  const gaps = frames.slice(1).map((f, i) => (f.ts - frames[i].ts) * 1000).sort((a, b) => a - b);
  if (!gaps.length) throw new Error('need at least two captured frames');
  const at = q => +gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))].toFixed(1);
  return { frames: frames.length, seconds: +(frames.at(-1).ts - frames[0].ts).toFixed(3), p50: at(0.5), p95: at(0.95), max: +gaps.at(-1).toFixed(1),
    over50ms: gaps.filter(g => g > 50).length };
}

/** Caption windows from the recorded journey timeline; overlapping steps are refused. */
export function captionWindows(timeline) {
  const windows = timeline.filter(step => step.caption).map(step => ({ caption: step.caption, start: step.start, end: step.end }));
  windows.forEach((w, i) => {
    if (!(w.end > w.start)) throw new Error(`caption "${w.caption}" has no duration`);
    if (i && w.start < windows[i - 1].end) throw new Error(`caption "${w.caption}" overlaps "${windows[i - 1].caption}"`);
  });
  return windows;
}
