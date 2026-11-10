/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native cold lane of `load-scoreboard.mjs`: one fresh `perf_probe --cold
 * --iters 1 --json --fingerprint` process per sample (the probe's own cold
 * contract), peak resident set from `/usr/bin/time`. The OS file cache is not
 * purged, as in every other cold harness here. The native pipeline is a batch
 * call with no streamed-geometry event, so there is no first-geometry time;
 * "interactive" is the probe's full load (file read plus the whole
 * `process_geometry` call, including the metadata that follows its stats).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { nativeStages } from './load-scoreboard-stats.mjs';

const TIME = '/usr/bin/time';
const RSS_MARK = '__LOAD_SCOREBOARD_MAXRSS_KB=';

/**
 * Child environment: the probe sees the side's own settings only. Fleet
 * workers export RAYON_NUM_THREADS (= the reservation's CPU count), which
 * would silently cap the product default, so it is removed unless the side
 * sets it.
 */
export function nativeEnv(base, sideEnv = {}) {
  const env = { ...base };
  delete env.RAYON_NUM_THREADS;
  return { ...env, ...sideEnv };
}

function run(cmd, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr: String(error), timedOut }); });
  });
}

/** One native cold sample. Never throws: a failure is a recorded sample with `ok: false`. */
export async function nativeSample({ side, fixture, timeoutMs = 60 * 60 * 1000 }) {
  const env = nativeEnv(process.env, side.env);
  const probeArgs = [fixture.path, '--cold', '--iters', '1', '--json', '--fingerprint', ...(side.probeArgs ?? [])];
  const useTime = existsSync(TIME);
  const [cmd, args] = useTime ? [TIME, ['-f', `${RSS_MARK}%M`, side.perfProbe, ...probeArgs]] : [side.perfProbe, probeArgs];
  const started = Date.now();
  const res = await run(cmd, args, env, timeoutMs);
  const sample = { lane: 'native-cold', ok: false, wallClockMs: Date.now() - started, exitCode: res.code, signal: res.signal,
    rayonThreads: env.RAYON_NUM_THREADS ?? 'default (all logical CPUs)', probeArgs: side.probeArgs ?? [] };
  const rss = new RegExp(`${RSS_MARK}(\\d+)`).exec(res.stderr);
  sample.peakMemoryMiB = rss ? Number(rss[1]) / 1024 : null;
  sample.peakMemoryMetric = rss ? 'process max RSS (wait4 ru_maxrss)' : 'unavailable (/usr/bin/time missing)';
  if (res.timedOut || res.code !== 0) {
    sample.error = res.timedOut ? `timed out after ${timeoutMs} ms` : `exit ${res.code ?? res.signal}: ${res.stderr.slice(-2000)}`;
    return sample;
  }
  let row;
  try {
    row = JSON.parse(res.stdout)[0];
  } catch (error) {
    return { ...sample, error: `unparseable perf_probe JSON: ${error.message}` };
  }
  if (!row || row.cold !== true || !Number.isFinite(row.fullLoadWallMs)) {
    return { ...sample, error: 'perf_probe did not report a cold full load (needs --cold support)' };
  }
  const stages = nativeStages(row);
  return {
    ...sample, ok: true,
    firstGeometryMs: null,
    interactiveMs: row.fullLoadWallMs,
    stageMs: stages,
    fingerprint: `meshes=${row.meshes} vertices=${row.vertices} triangles=${row.triangles} fnv=${(row.meshFingerprintsFnv1a64 ?? []).join(',')}`,
    probe: row,
  };
}
