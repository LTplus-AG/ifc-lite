/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const run = (script, options = {}) => spawnSync(TSX, ['--eval', script], {
  cwd: ROOT, encoding: 'utf8', timeout: 10_000, ...options,
});
const WINDOWS_PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

before(() => {
  // Full-production reverts remove the new host helper. Assert the shipped
  // probe's behavior first, so missing-module loading cannot mask the oracle.
  const result = run(`
    import assert from 'node:assert/strict';
    import { installFrameProbe } from './tests/benchmark/frames/frame-probe.ts';
    const windowEvents = new EventTarget(), documentEvents = new EventTarget();
    Reflect.set(documentEvents, 'visibilityState', 'visible');
    Reflect.set(documentEvents, 'hasFocus', () => true);
    Reflect.set(globalThis, 'window', windowEvents);
    Reflect.set(globalThis, 'document', documentEvents);
    Reflect.set(globalThis, 'requestAnimationFrame', () => 1);
    installFrameProbe({ workDone: false });
    const probe = Reflect.get(globalThis, '__ifc_lite_frame_probe__');
    probe.beginForegroundGuard?.();
    windowEvents.dispatchEvent(new Event('blur'));
    assert.equal(probe.foreground?.().interruptions, 1, 'a blur must remain in the measured interval');
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('#6975 actual PowerShell wrapper refuses a missing CIM record or missing raw CPU field', {
  skip: !existsSync(WINDOWS_PS) ? 'requires native Windows PowerShell; decoder controls still run everywhere' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), '6975-cim-oracle-'));
  try {
    // Intercept only this test's executable lookup. Delegate the unchanged
    // production encoded script to real Windows PowerShell with a controlled
    // unavailable-CIM provider. No real host observation or GPU claim.
    const wrapper = join(directory, 'powershell.exe');
    writeFileSync(wrapper, `#!/usr/bin/env python3
import base64, os, sys
args = sys.argv[1:]
index = args.index('-EncodedCommand') + 1
script = base64.b64decode(args[index]).decode('utf-16le')
prefix = """
function global:Get-CimInstance {
  param([string]$ClassName, [string]$Filter)
  switch ($ClassName) {
    'Win32_PerfFormattedData_PerfOS_Processor' {
      if ($global:IfcCimOracleMode -eq 'no-cpu') { return }
      return [PSCustomObject]@{ PercentProcessorTime = $null }
    }
    'Win32_OperatingSystem' {
      return [PSCustomObject]@{ FreePhysicalMemory = 1; TotalVisibleMemorySize = 2 }
    }
    'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine' { return }
    default { throw 'Unexpected CIM class in oracle' }
  }
}
"""
mode = os.environ['IFC_LITE_CIM_ORACLE']
if mode not in ('no-cpu', 'null-cpu'): raise ValueError('unknown CIM oracle mode')
prefix = "$global:IfcCimOracleMode = '" + mode + "'\\n" + prefix
args[index] = base64.b64encode((prefix + script).encode('utf-16le')).decode('ascii')
os.execv(${JSON.stringify(WINDOWS_PS)}, [${JSON.stringify(WINDOWS_PS)}] + args)
`);
    chmodSync(wrapper, 0o700);
    for (const mode of ['no-cpu', 'null-cpu']) {
      const result = run(`
        import assert from 'node:assert/strict';
        import { readWindowsHostObservations } from './scripts/perf/frame-gpu-session.ts';
        assert.throws(() => readWindowsHostObservations(), /Windows observation failed|invalid host field/);
      `, { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, IFC_LITE_CIM_ORACLE: mode } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.stdout}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('#6975 missing telemetry cannot become an idle CPU or available empty GPU receipt', () => {
  const result = run(`
    import assert from 'node:assert/strict';
    import { decodeWindowsHostObservations } from './scripts/perf/frame-gpu-session.ts';
    const observation = {
      capturedAt: '2026-10-08T00:00:00.000Z', totalProcessorPercent: 0,
      freePhysicalKiB: 1, totalVisiblePhysicalKiB: 2,
      gpu: { status: 'unavailable', error: 'Counter unavailable' },
    };
    const rows = (patch) => [0, 1, 2].map(() => ({ ...observation, ...patch }));
    assert.equal(decodeWindowsHostObservations(rows({}))[0].totalProcessorPercent, 0,
      'an observed numeric zero is valid; absent/null is not zero');
    for (const field of ['totalProcessorPercent', 'freePhysicalKiB', 'totalVisiblePhysicalKiB']) {
      for (const missing of [null, undefined]) {
        assert.throws(() => decodeWindowsHostObservations(rows({ [field]: missing })), /invalid host field/);
      }
    }
    assert.throws(() => decodeWindowsHostObservations(rows({ totalVisiblePhysicalKiB: 0 })), /physical memory/);
    assert.throws(() => decodeWindowsHostObservations(rows({ freePhysicalKiB: 3 })), /physical memory/);
    assert.throws(() => decodeWindowsHostObservations(rows({ gpu: { status: 'available', engines: [] } })), /GPU engine/);
    assert.throws(() => decodeWindowsHostObservations(rows({ gpu: {
      status: 'available', engines: [{ name: 'engine', utilizationPercent: null }],
    } })), /GPU engine/);
    assert.throws(() => decodeWindowsHostObservations(rows({}).slice(1)), /three/);
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('#6975 a recovered foreground boundary cannot erase an interruption in the interval', () => {
  // Actual probe + EventTarget event dispatch; no GPU or native-display claim.
  const result = run(`
    import assert from 'node:assert/strict';
    import { installFrameProbe } from './tests/benchmark/frames/frame-probe.ts';
    const windowEvents = new EventTarget(), documentEvents = new EventTarget();
    let focused = true;
    Reflect.set(documentEvents, 'visibilityState', 'visible');
    Reflect.set(documentEvents, 'hasFocus', () => focused);
    Reflect.set(globalThis, 'window', windowEvents);
    Reflect.set(globalThis, 'document', documentEvents);
    Reflect.set(globalThis, 'requestAnimationFrame', () => 1);
    installFrameProbe({ workDone: false });
    const probe = Reflect.get(globalThis, '__ifc_lite_frame_probe__');
    assert.equal(typeof probe.beginForegroundGuard, 'function', 'foreground interval guard must exist');
    probe.beginForegroundGuard();
    focused = false;
    windowEvents.dispatchEvent(new Event('blur'));
    Reflect.set(documentEvents, 'visibilityState', 'hidden');
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    focused = true;
    Reflect.set(documentEvents, 'visibilityState', 'visible');
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(probe.foreground(), { visibility: 'visible', focused: true, interruptions: 2 });
    probe.beginForegroundGuard();
    assert.equal(probe.foreground().interruptions, 0, 'a new interval can begin after settling');
    focused = false;
    probe.beginForegroundGuard();
    focused = true;
    assert.equal(probe.foreground().interruptions, 1, 'an unfocused start is refused even if it recovers');
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('#6975 Linux host admission observes a real competing named graph without retaining arbitrary argv', {
  skip: process.platform !== 'linux' ? 'Linux /proc observation invariant' : false,
}, () => {
  const result = run(`
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { readLinuxHostObservation } from './scripts/perf/frame-gpu-host.ts';
    (async () => {
      const sentinel = 'fixture-private-argument-6975';
      const child = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 8000)', '--', 'pnpm typecheck', sentinel]);
      try {
        const observation = await readLinuxHostObservation();
        const found = observation.activeGraphs.find((graph) => graph.pid === child.pid);
        assert.ok(found, 'actual competing graph must refuse quiet admission');
        assert.ok(found.graphKinds.includes('pnpm typecheck'));
        assert.equal(JSON.stringify(observation).includes(sentinel), false, 'retain graph identity, never arbitrary argv');
        assert.ok(observation.MemAvailableKiB > 0);
      } finally { child.kill(); }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
