/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const CANVAS = Object.freeze({ width: 715, height: 743 });
export const RAW_LIMITS = Object.freeze({ logBytes: 16 * 1024 ** 2, eventBytes: 16 * 1024 ** 2, events: 1000 });
export const ORIGINAL_FLAGS = Object.freeze(['--enable-gpu', '--enable-webgpu',
  '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist']);
export const PROFILES = Object.freeze([
  Object.freeze({ name: 'original', args: ORIGINAL_FLAGS }),
  Object.freeze({ name: 'corrected', args: Object.freeze([...ORIGINAL_FLAGS,
    '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader',
    '--enable-features=CDPScreenshotNewSurface,Vulkan']) }),
]);
export const COLORS = Object.freeze([
  Object.freeze({ name: 'red', clear: [1, 0, 0, 1], bytes: [255, 0, 0, 255] }),
  Object.freeze({ name: 'blue', clear: [0, 0, 1, 1], bytes: [0, 0, 255, 255] }),
]);
export function rgba(format, bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 4) throw new Error('Four readback channels required');
  if (format === 'rgba8unorm') return [...bytes];
  if (format === 'bgra8unorm') return [bytes[2], bytes[1], bytes[0], bytes[3]];
  throw new Error(`Unsupported preferred canvas format: ${format}`);
}
export function requirePixels(actual, expected, description) {
  if (!Array.isArray(actual) || actual.length !== 4 || actual.some((value, i) => value !== expected[i]))
    throw new Error(`${description} pixel mismatch: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
}
export function backendErrors(log) {
  return log.split('\n').filter(line => /Could not find a SharedImageBackingFactory|Unable to create SkSurface|VK_ERROR|GPU process.*(?:crash|exited unexpectedly)|(?:Dawn|SharedImage|Vulkan).*(?:failed|failure|error)|(?:ERROR|failed|failure).*(?:Dawn|SharedImage|Vulkan)/i.test(line));
}
export function verdict(row, backend) {
  const pixels = row.colors?.length === 2 && row.colors.every((capture, index) => {
    const expected = COLORS[index];
    return capture.name === expected.name && capture.gpu?.submitted === true && capture.presentationFrames === 2
      && capture.png?.width === CANVAS.width && capture.png?.height === CANVAS.height
      && [capture.gpu.rgba, capture.png.center].every(actual => Array.isArray(actual)
        && actual.length === 4 && actual.every((value, i) => value === expected.bytes[i]));
  });
  if (row.status !== 'observed' || row.diagnosticRefusal || !pixels || !(row.observation?.frames > 0)
    || !(row.observation?.activeMs >= 15000) || backend.length || row.events.some(event =>
    event.kind === 'pageerror' || event.kind === 'crash' || event.kind === 'diagnostic-refusal'
    || (event.kind === 'console' && event.type === 'error')))
    return 'refused';
  return 'pixels-observed';
}
export function interpretation(rows) {
  if (rows.length !== 2 || rows[0].profile !== 'original' || rows[1].profile !== 'corrected'
    || rows.some(row => !['refused', 'pixels-observed'].includes(row.status)))
    throw new Error('Exactly two ordered prospective profiles required');
  if (rows[1].status !== 'pixels-observed') return 'Corrected profile refused: proposed environment correction is not qualified.';
  if (rows[0].status === 'refused') return 'Original refused and corrected pixels observed: narrow graphics-environment evidence only; no viewer or performance verdict.';
  return 'Both profiles observed pixels: standalone control is inconclusive about the viewer failure; no performance verdict.';
}
export function canSignalOwnedGroup(owner, current) {
  return Boolean(owner && current && owner.pid === current.pid && owner.startTime === current.startTime
    && owner.pgrp === owner.pid && current.pgrp === owner.pgrp && current.state !== 'Z');
}
export function requireCompletion(rows, interrupted) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}; completion refused`);
  interpretation(rows);
  if (rows[1].status !== 'pixels-observed') throw new Error('Corrected profile refused');
  return 'complete-controls';
}
export function requireOwnedChrome(records, parentPid, expectedArgs) {
  const mains = records.filter(record => record.identity.ppid === parentPid
    && /^(chrome|google-chrome(?:-stable)?)$/.test(record.arguments[0]?.split('/').at(-1) ?? '')
    && !record.arguments.some(arg => arg === '--type' || arg.startsWith('--type=')));
  if (mains.length !== 1) throw new Error('Exactly one directly owned Chrome main process required');
  const main = mains[0];
  for (const flag of expectedArgs) {
    const key = flag.split('=')[0];
    const actual = main.arguments.filter(arg => arg.split('=')[0] === key);
    const screenshotDefault = key === '--enable-features' && actual.length === 2
      && actual[0] === '--enable-features=CDPScreenshotNewSurface';
    if ((actual.length !== 1 && !screenshotDefault) || actual.at(-1) !== flag)
      throw new Error(`Actual Chrome profile flag mismatch: ${key}`);
  }
  return main;
}
