/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
export const literal = value => `'${value.replaceAll("'", "''")}'`;
export function windowsPath(path) {
  const result = spawnSync('wslpath', ['-w', path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
export function powershell(script, timeout = 15000) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';\n" + script, 'utf16le').toString('base64')],
  { encoding: 'utf8', timeout });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
export function createWindowsCpuFixture(mode = 'no-endpoint', directory) {
  assert.ok(['no-endpoint', 'endpoint', 'controller-orphan'].includes(mode), 'Unknown controlled CPU fixture mode');
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'ifc-job-controller-cpu-'));
  const win = windowsPath(dir), exe = join(dir, 'chrome.exe');
  for (const name of ['frame-gpu-process-identity.cs', 'frame-gpu-cpu-fixture.cs',
    'frame-gpu-job.cs', 'frame-gpu-job-input.cs', 'frame-gpu-job-supervisor.ps1']) {
    writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)));
  }
  writeFileSync(join(dir, 'fixture.mode'), mode);
  powershell(`Add-Type -Path @(${literal(win + '\\frame-gpu-process-identity.cs')},${literal(win + '\\frame-gpu-cpu-fixture.cs')}) -OutputAssembly ${literal(windowsPath(exe))} -OutputType ConsoleApplication`);
  const identityPrelude = `Add-Type -Path ${literal(win + '\\frame-gpu-process-identity.cs')};`;
  return { dir, win, exe, executable: windowsPath(exe),
    commandLine: `"${windowsPath(exe)}" --fixture-mode=${mode} --fixture-root="${win}"`,
    identityPrelude,
    observeExact(identity) {
      return JSON.parse(powershell(`${identityPrelude}[IfcProcessIdentity]::ObserveExact(${identity.pid},${literal(identity.created)})|ConvertTo-Json -Compress`));
    },
    terminateExact(identity, deadlineMs = 5000) {
      assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0);
      return JSON.parse(powershell(`${identityPrelude}[IfcProcessIdentity]::TerminateExact(${identity.pid},${literal(identity.created)},${deadlineMs})|ConvertTo-Json -Compress`));
    },
  };
}
