/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
export const literal = value => `'${value.replaceAll("'", "''")}'`;
export function windowsPath(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !path.includes('\0'), 'Expected a nonempty fixture path');
  if (process.platform === 'win32') {
    const native = resolve(path);
    assert.ok(win32.isAbsolute(native), 'Expected native absolute Windows fixture path');
    return native;
  }
  const result = spawnSync('wslpath', ['-w', path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
export function powershell(script, timeout = 15000, receiptPath) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';\n" + script, 'utf16le').toString('base64')],
  { encoding: 'utf8', timeout });
  if (receiptPath) writeFileSync(receiptPath, JSON.stringify({ script, status: result.status,
    signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2), { flag: 'wx' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
// Archive after the actual test's bounded process cleanup, including failed assertions.
// Register before native path conversion/compilation so setup failures retain source.
export function retainCpuFixture(context, dir, metadata) {
  writeFileSync(join(dir, 'fixture-metadata.json'), JSON.stringify({ ...metadata, fixtureDirectory: dir,
    platform: process.platform, node: process.version, test: context.name }, null, 2), { flag: 'wx' });
  const evidence = process.env.IFC_JOB_EVIDENCE_DIR;
  if (evidence) context.after(() => {
    mkdirSync(evidence, { recursive: true });
    const target = join(evidence, basename(dir));
    mkdirSync(target); // Exclusive ownership: do not overwrite a prior invocation.
    cpSync(dir, target, { recursive: true, errorOnExist: true, force: false });
    const pins = Object.fromEntries(readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => [entry.name, createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex')]));
    writeFileSync(join(target, 'archived-file-pins.json'), JSON.stringify(pins, null, 2), { flag: 'wx' });
  });
}
export function createWindowsCpuFixture(mode = 'no-endpoint', directory, context) {
  assert.ok(['no-endpoint', 'endpoint', 'controller-orphan'].includes(mode), 'Unknown controlled CPU fixture mode');
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'ifc job controller CPU '));
  if (context) retainCpuFixture(context, dir, { mode, domain: 'Windows CPU Job' });
  for (const name of ['frame-gpu-process-identity.cs', 'frame-gpu-cpu-fixture.cs',
    'frame-gpu-job.cs', 'frame-gpu-job-input.cs', 'frame-gpu-job-supervisor.ps1']) {
    writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)));
  }
  writeFileSync(join(dir, 'fixture.mode'), mode);
  const win = windowsPath(dir), exe = join(dir, 'chrome.exe');
  powershell(`Add-Type -Path @(${literal(win + '\\frame-gpu-process-identity.cs')},${literal(win + '\\frame-gpu-cpu-fixture.cs')}) -OutputAssembly ${literal(windowsPath(exe))} -OutputType ConsoleApplication`, 15000, join(dir, 'compilation-receipt.json'));
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

// #7221: one provider boundary for developer/WSL and designated native CI.
export function windowsCpuUnavailable() {
  if (process.env.IFC_JOB_PLATFORM === 'posix') {
    assert.ok(process.platform !== 'win32' && process.env.IFC_JOB_REQUIRE_NATIVE !== '1', 'A required native provider cannot be skipped by POSIX scope');
    return 'Windows native domain is qualified by the required Windows lane';
  }
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Write-Output ($PSVersionTable.PSEdition + ':' + $PSVersionTable.PSVersion.Major + '.' + $PSVersionTable.PSVersion.Minor)"],
    { encoding: 'utf8', timeout: 10000 });
  if (!probe.error && probe.status === 0 && probe.stdout.trim() === 'Desktop:5.1') return false;
  const reason = 'Actual Windows PowerShell 5.1 Job provider unavailable; containment unqualified';
  if (process.env.IFC_JOB_REQUIRE_NATIVE === '1' || process.platform === 'win32') {
    throw new Error(`${reason}: ${probe.error?.message ?? probe.stderr ?? probe.stdout}`);
  }
  return reason;
}
