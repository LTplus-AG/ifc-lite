/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { decodeNativeOutput, requireHostMatch, type HostProfile } from './frame-gpu-night-admission.js';
import { isPhysicalConsole } from './frame-gpu-session.js';
import { sha256 } from './frame-gpu-night-profile.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing actual nightly evidence');
  return value as Record<string, unknown>;
};
const required = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

/** Inspect the exact raw single native rig sample, never a success-only summary.
 * These checks complement the source-pinned producer and independently reviewed
 * native qualification; accepting an arbitrary JSON document proves no hardware.
 */
export function requireNightEvidence(directory: string, host: HostProfile): unknown {
  const rows = readFileSync(join(directory, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
  required(rows.length === 1, 'night must retain exactly one original sample');
  const sample = object(rows[0]), meta = object(sample.meta);
  required(sample.ok === true && sample.error === undefined && sample.pair === 0 && sample.side === 'branch', 'original native sample failed');
  required(object(meta.hostBefore).quiet === true && object(meta.hostAfter).quiet === true, 'actual host admission incomplete');
  for (const value of [meta.sessionBefore, meta.sessionAfter]) {
    const row = object(value);
    for (const key of ['currentSession', 'consoleSession', 'protocol', 'connectState', 'remoteMetric', 'monitors']) {
      required(typeof row[key] === 'number' && Number.isInteger(row[key]), 'actual session field unavailable');
    }
    required(isPhysicalConsole(row as unknown as Parameters<typeof isPhysicalConsole>[0]), 'actual physical session refused');
  }
  required(object(meta.sessionBefore).currentSession === object(meta.sessionAfter).currentSession, 'actual console session changed');
  const foreground = object(meta.foreground);
  required(foreground.interruptions === 0 && foreground.visibility === 'visible' && foreground.focused === true, 'foreground interval interrupted');
  required(meta.timestampQuery === true, 'actual device timestamp-query request missing');
  required(Array.isArray(meta.pageErrors) && meta.pageErrors.length === 0, 'actual page errors present or unobserved');
  const cleanup = object(meta.cleanup);
  required(cleanup.closeError === null && cleanup.disposeError === null, 'native cleanup incomplete');
  for (const [viewport, output, executable] of [
    [meta.viewportBefore, meta.nativeOutputBefore, meta.browserExecutableWin],
    [meta.viewportAfter, meta.nativeOutputAfter, meta.browserExecutableWinAfter],
  ]) {
    required(typeof meta.browser === 'string' && typeof executable === 'string', 'actual browser identity missing');
    requireHostMatch(host, { browserVersion: meta.browser as string, adapter: meta.adapter,
      viewport, output: decodeNativeOutput(output), executableWin: executable as string });
  }
  const timing = object(meta.gpuTiming);
  let epoch: unknown;
  for (const scenario of ['orbit', 'hover']) {
    const snapshot = object(timing[scenario]);
    required(snapshot.mode === 'gpu-queries' && snapshot.errors === 0, 'actual GPU query mode failed');
    required(typeof snapshot.epoch === 'number' && Number.isSafeInteger(snapshot.epoch), 'actual GPU resource epoch missing');
    if (epoch === undefined) epoch = snapshot.epoch;
    required(snapshot.epoch === epoch, 'native GPU resource epoch changed across scenarios');
    required(Array.isArray(snapshot.frames) && snapshot.frames.length > 0, 'actual resolved GPU pass frames missing');
    for (const value of snapshot.frames as unknown[]) {
      const frame = object(value), passes = object(frame.passesMs);
      required(typeof frame.timestamp === 'number' && Number.isFinite(frame.timestamp), 'GPU frame timestamp invalid');
      required(Object.keys(passes).length > 0, 'resolved frame contains no timed native passes');
      required(Object.values(passes).every(ms => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0), 'GPU duration invalid');
    }
  }
  required(Array.isArray(sample.rows) && sample.rows.length > 0, 'native metric rows missing');
  for (const row of sample.rows as unknown[]) {
    const value = object(row);
    required(typeof value.value === 'number' && Number.isFinite(value.value), 'native metric row invalid');
  }
  for (const scenario of ['orbit', 'hover']) {
    for (const metric of ['rendered_frames', 'draws_per_rendered_frame']) {
      required((sample.rows as unknown[]).some(row => {
        const value = object(row);
        return value.scenario === scenario && value.metric === metric && typeof value.value === 'number' && value.value > 0;
      }), `${scenario}: actual completed native draws missing`);
    }
  }
  requireBrowserRetirement(directory, meta.browserOwner, meta.browserJob);
  return rows[0];
}

function requireBrowserRetirement(directory: string, ownerValue: unknown, preparedValue: unknown): void {
  // The live marker was verified by the canonical launcher/disposer. It is now
  // deleted; re-running the live decoder would reject legitimate retirement.
  // Read only this attempt's durable owner ledger, never adopt a missing profile.
  const owner = object(ownerValue), prepared = object(preparedValue);
  required(typeof owner.token === 'string' && /^[a-f0-9]{32}$/.test(owner.token), 'actual owner token invalid');
  required(typeof owner.profileWsl === 'string' && basename(owner.profileWsl) === `ifclite-frame-rig-${String(owner.token)}`,
    'actual owned profile identity invalid');
  required(JSON.stringify(prepared.owner) === JSON.stringify(owner), 'actual browser owner changed');
  const ledger = resolve(directory, 'browser-owners'), token = String(owner.token);
  required(owner.ledger === ledger, 'durable browser ledger outside this attempt');
  const originalOwner = JSON.parse(readFileSync(join(ledger, `${token}.owner.json`), 'utf8')) as unknown;
  required(JSON.stringify(originalOwner) === JSON.stringify(owner), 'actual durable owner identity changed');
  const originalJob = JSON.parse(readFileSync(join(ledger, `${token}.job.json`), 'utf8')) as unknown;
  required(JSON.stringify(originalJob) === JSON.stringify(prepared), 'actual durable Job preparation changed');
  const retired = object(JSON.parse(readFileSync(join(ledger, `${token}.retired.json`), 'utf8')) as unknown);
  const disposed = readFileSync(join(ledger, `${token}.disposed.json`));
  required(sha256(disposed) === sha256(readFileSync(join(ledger, `${token}.retired.json`))), 'profile disposal receipt differs from retirement');
  required(JSON.stringify(retired.prepared) === JSON.stringify(prepared) && Array.isArray(retired.packets), 'owned Job retirement identity missing');
  const packets = retired.packets as unknown[];
  required(packets.some(value => object(value).event === 'disposed' && object(value).activeProcesses === 0), 'owned Windows Job active-zero absent');
  const terminal = object(packets[packets.length - 1]);
  required(terminal.event === 'terminal' && terminal.ok === true && terminal.disposed === true, 'owned Windows Job terminal failure');
  required(!existsSync(String(owner.profileWsl)), 'fresh owned profile was not disposed');
}

/** Failed native samples can release the lane only with positive retirement of
 * every allocated owner. Absence alone is not proof: require the actual
 * pinned producer's no-launch observation when no owner ledger was allocated.
 */
export function requireAttemptRetirement(directory: string): { owners: number } {
  const ledger = resolve(directory, 'browser-owners');
  if (!existsSync(ledger)) {
    const rows = readFileSync(join(directory, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
    required(rows.length === 1, 'actual no-launch producer receipt missing; quarantine lease');
    const sample = object(rows[0]), meta = object(sample.meta), cleanup = object(meta.cleanup);
    required(sample.ok === false && meta.browserLaunchAttempted === false
      && cleanup.closeError === null && cleanup.disposeError === null, 'native no-birth unproved; quarantine lease');
    return { owners: 0 };
  }
  if (lstatSync(ledger).isSymbolicLink() || !lstatSync(ledger).isDirectory()) throw new Error('owned Job ledger invalid; quarantine lease');
  const names = readdirSync(ledger);
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.(owner|job|retired|disposed)\.json$/.test(name)
      || !lstatSync(join(ledger, name)).isFile()) throw new Error('unresolved owned Job artifacts; quarantine lease');
  }
  const owners = names.filter(name => name.endsWith('.owner.json'));
  if (owners.length !== 1 || names.length !== 4) throw new Error('owned Job retirement incomplete; quarantine lease');
  for (const name of owners) {
    const owner = JSON.parse(readFileSync(join(ledger, name), 'utf8')) as unknown;
    const prepared = JSON.parse(readFileSync(join(ledger, name.replace('.owner.json', '.job.json')), 'utf8')) as unknown;
    requireBrowserRetirement(directory, owner, prepared);
  }
  return { owners: owners.length };
}

/** Hash every retained raw artifact; refuse links or files outside this attempt. */
export function nightArtifactHashes(root: string): { path: string; sha256: string }[] {
  const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('night artifact link refused');
    return entry.isDirectory() ? visit(path) : entry.isFile() ? [path] : [];
  });
  return visit(root).sort().map(path => {
    required(statSync(path).isFile(), 'actual artifact missing');
    return { path: relative(root, path), sha256: sha256(readFileSync(path)) };
  });
}
