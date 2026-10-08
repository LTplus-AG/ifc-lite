/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readWindowsHostObservations, type WindowsHostObservation } from './frame-gpu-session.js';

// Retained v12 host policy, not a claim that every source of interference is known.
export const HOST_POLICY = { version: 'native-host-v12-departure-observation', minimumLinuxKiB: 41_943_040, maximumWindowsCpuPercent: 10 } as const;
const NEEDLES = [
  'turbo run', 'turbo/bin/turbo', 'pnpm typecheck', 'pnpm test', 'pnpm build',
  'vite/bin/vite', 'vitest', 'rustc', 'cargo test', 'cargo clippy', 'wasm-pack',
  'tsc --', 'typescript/bin/tsc', 'tsx --test', 'node --test',
];

interface Graph {
  pid: number; executable: string; graphKinds: string[]; devServer: boolean;
  ticks: number; startTimeTicks: string;
}
export interface ObservedGraph extends Omit<Graph, 'ticks'> {
  cpuSecondsObserved: number | null;
  observationSeconds: number;
}

/** Named workload classifier only; arbitrary command lines are never retained. */
export function classifyHostGraph(args: readonly string[]): Omit<Graph, 'pid' | 'ticks' | 'startTimeTicks'> | null {
  if (!args.length || ['bash', 'sh', 'python3', 'python', 'timeout'].includes(basename(args[0]))) return null;
  const command = args.join(' ');
  const graphKinds = NEEDLES.filter((needle) => command.includes(needle));
  if (basename(args[0]) === 'perf_probe') graphKinds.push('native perf_probe benchmark');
  return graphKinds.length ? {
    executable: basename(args[0]), graphKinds,
    devServer: command.includes('vite/bin/vite') && !command.includes(' build'),
  } : null;
}

function snapshot(): Map<number, Graph> {
  const rows = new Map<number, Graph>();
  for (const directory of readdirSync('/proc')) {
    if (!/^\d+$/.test(directory)) continue;
    try {
      const args = readFileSync(`/proc/${directory}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const graph = classifyHostGraph(args);
      if (!graph) continue;
      const stat = readFileSync(`/proc/${directory}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ticks = Number(fields[11]) + Number(fields[12]);
      if (!Number.isFinite(ticks) || !/^\d+$/.test(fields[19] ?? '')) throw new Error('invalid /proc process timing');
      rows.set(Number(directory), { pid: Number(directory), ...graph, ticks, startTimeTicks: fields[19] });
    } catch (error) {
      // A departing process is ordinary; other observation failures refuse admission.
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') as unknown : null;
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
    }
  }
  return rows;
}

export interface LinuxHostObservation {
  capturedAt: string;
  MemAvailableKiB: number;
  activeGraphs: ObservedGraph[];
  observedIdleDevServers: ObservedGraph[];
}

/** v12 one-second named graph policy, also retaining processes that departed. */
export async function readLinuxHostObservation(): Promise<LinuxHostObservation> {
  const ticksRun = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 });
  const ticksPerSecond = Number(ticksRun.stdout.trim());
  if (ticksRun.error || ticksRun.status !== 0 || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
    throw new Error('cannot observe Linux process CPU tick scale');
  }
  const before = snapshot(), started = performance.now();
  await sleep(1000);
  const after = snapshot(), elapsed = (performance.now() - started) / 1000;
  const activeGraphs: ObservedGraph[] = [], observedIdleDevServers: ObservedGraph[] = [];
  for (const pid of new Set([...before.keys(), ...after.keys()])) {
    const prior = before.get(pid), current = after.get(pid), source = current ?? prior!;
    const stable = !!prior && !!current && prior.startTimeTicks === current.startTimeTicks;
    const { ticks: _ticks, ...identity } = source;
    const seconds = stable ? (current!.ticks - prior!.ticks) / ticksPerSecond : null;
    const row = { ...identity, cpuSecondsObserved: seconds, observationSeconds: elapsed };
    if (source.devServer && stable && seconds !== null && seconds >= 0 && seconds < 0.05 * elapsed) {
      observedIdleDevServers.push(row);
    } else activeGraphs.push(row);
  }
  const memory = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  if (!memory) throw new Error('missing Linux available-memory observation');
  return { capturedAt: new Date().toISOString(), MemAvailableKiB: Number(memory[1]), activeGraphs, observedIdleDevServers };
}

export interface HostAdmission {
  policy: typeof HOST_POLICY;
  capturedAt: string;
  linux: LinuxHostObservation;
  windows: WindowsHostObservation[];
  quiet: boolean;
  scope: string;
}

export async function readHostAdmission(): Promise<HostAdmission> {
  // Sequential observers keep each interval's duration explicit.
  const linux = await readLinuxHostObservation();
  const windows = readWindowsHostObservations();
  return {
    policy: HOST_POLICY, capturedAt: new Date().toISOString(), linux, windows,
    quiet: linux.activeGraphs.length === 0 && linux.MemAvailableKiB >= HOST_POLICY.minimumLinuxKiB
      && windows.every((sample) => sample.totalProcessorPercent <= HOST_POLICY.maximumWindowsCpuPercent),
    scope: 'Declared Linux graph/memory and Windows host CPU observations. Raw GPU engine counters only; no GPU quiet threshold or zero unknown interference claim.',
  };
}
