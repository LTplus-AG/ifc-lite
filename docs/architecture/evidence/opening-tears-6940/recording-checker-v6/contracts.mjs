// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';

// requestAnimationFrame uses the frame clock: its first callback timestamp can
// precede registration during the same frame. Later callbacks must follow it.
export function validateFrameTimes(times, start, finish, must) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  must(finite(start) && finite(finish) && finish >= start && finish - start <= 3000,
    'Invalid frame probe clock/deadline');
  must(Array.isArray(times) && times.length > 0, 'Missing frame callbacks');
  must(times.every((value, index) => finite(value) && value >= 0 && value <= finish
    && (index === 0 || (value >= start && value > times[index - 1]))),
  'Invalid callback timestamp/order');
}

// The existing finalizer writes here. Read the original bytes in place; no
// rename, copy, search fallback or silent choice between alternative receipts.
export function sidecarPath(root, index, sample) {
  if (!Number.isSafeInteger(index) || index < 0 || typeof sample?.id !== 'string'
    || !/^[a-zA-Z0-9_-]+$/.test(sample.id)) {
    throw Error('Invalid planned sample index/id');
  }
  return path.join(root, `case-${String(index).padStart(2, '0')}`,
    `${sample.id}.recording-frame-class-reviewed.json`);
}

// Bind the inspected value to ffprobe, then retain one timebase for the cohort.
export function validateVideoTimebase(actual, inspected, expected, must) {
  must(typeof actual === 'string' && /^[1-9][0-9]*\/[1-9][0-9]*$/.test(actual),
    'Missing/invalid video stream timebase');
  must(actual === inspected, 'Inspected timebase differs from video stream');
  must(expected === undefined || actual === expected, 'Video timebase changed across cohort');
  return actual;
}
