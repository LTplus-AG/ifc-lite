/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const source = readFileSync(new URL('./frame-gpu-native-port.ps1', import.meta.url), 'utf8');
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 });
const skip = probe.error || probe.status !== 0 ? 'Actual native Windows port controls unavailable; qualification held' : false;
test('#6975 actual native allocation excludes a held socket and retires its returned-port reservation', { skip, timeout: 15000 }, context => {
  const evidence = mkdtempSync(join(tmpdir(),'ifc-native-port-control-'));
  const script = `$ErrorActionPreference='Stop'; ${source}
$held=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$held.ExclusiveAddressUse=$true
$rebound=$null;$heldPort=$null;$receipt=$null;$returnedPortRebound=$false;$stopped=$false;$failure=$null;$cleanupFailures=@()
try {
  $held.Start();$heldPort=([Net.IPEndPoint]$held.LocalEndpoint).Port
  $receipt=Get-IfcUnusedLoopbackPort
  $rebound=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,[int]$receipt.port);$rebound.ExclusiveAddressUse=$true
  $rebound.Start();$returnedPortRebound=$true
} catch {$failure=$_.Exception.ToString()} finally {
  if($null -ne $rebound){try{$rebound.Stop()}catch{$cleanupFailures+=$_.Exception.ToString()}}
  try{$held.Stop()}catch{$cleanupFailures+=$_.Exception.ToString()}
  $stopped=$cleanupFailures.Count -eq 0
}
@{heldPort=$heldPort;allocation=$receipt;returnedPortRebound=$returnedPortRebound;independentListenersStopped=$stopped;failure=$failure;cleanupFailures=$cleanupFailures}|ConvertTo-Json -Depth 4 -Compress
if($failure -or $cleanupFailures.Count -gt 0){exit 1}`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000 });
  writeFileSync(join(evidence,'native.stdout.log'),run.stdout);
  writeFileSync(join(evidence,'native.stderr.log'),run.stderr);
  writeFileSync(join(evidence,'native.executed.ps1'),script);
  const nativeChildRetirement = {code:run.status,signal:run.signal,error:run.error?.message ?? null};
  writeFileSync(join(evidence,'native.retirement.json'),JSON.stringify(nativeChildRetirement));
  context.diagnostic(JSON.stringify({evidence,nativeChildRetirement,stdout:run.stdout,stderr:run.stderr}));
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  const receipt = JSON.parse(run.stdout.trim());
  context.diagnostic(JSON.stringify({ receipt, nativeChildRetirement: { code: run.status, signal: run.signal } }));
  assert.ok(Number.isSafeInteger(receipt.heldPort) && receipt.heldPort > 0);
  assert.ok(Number.isSafeInteger(receipt.allocation.port) && receipt.allocation.port > 0 && receipt.allocation.port <= 65535);
  assert.notEqual(receipt.allocation.port, receipt.heldPort, 'OS excludes the genuinely held exclusive socket');
  assert.deepEqual({address:receipt.allocation.address,exclusive:receipt.allocation.exclusive,stopped:receipt.allocation.stopped},{address:'127.0.0.1',exclusive:true,stopped:true});
  assert.equal(receipt.returnedPortRebound, true, 'Independent exclusive rebind proves reservation retirement');
  assert.equal(receipt.independentListenersStopped, true);
  assert.equal(receipt.failure,null);assert.deepEqual(receipt.cleanupFailures,[]);
  assert.equal(run.signal, null);
});
