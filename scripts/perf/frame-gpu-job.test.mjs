/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// #7036: actual Win32 Job APIs and exclusively owned CPU PowerShell fixtures.
// No Chrome, renderer, GPU, or performance workload is launched by this test.
const fixtureCleanup = `using System; using System.Runtime.InteropServices; public static class IfcCpuCleanup { [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code); [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout); public static void Retire(IntPtr handle) { if(!TerminateProcess(handle,1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); if(WaitForSingleObject(handle,5000)!=0) throw new TimeoutException("Owned CPU fixture cleanup unproved"); } }`;
const source = readFileSync(new URL('./frame-gpu-job.cs', import.meta.url), 'utf8');
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 });
const skip = probe.error || probe.status !== 0 ? 'Actual Windows Job execution unavailable; lifetime containment unqualified' : false;
const literal = value => "'" + value.replaceAll("'", "''") + "'";
for (const mode of ['failed-start-receipt', 'existing-job-refusal', 'root-exit-orphan', 'kill-on-last-close']) {
  test(`#7036 actual owned CPU Job contains children after parent exit (${mode})`, { skip, timeout: 45000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifc-owned-job-cpu-'));
    const conversion = spawnSync('wslpath', ['-w', dir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(conversion.status, 0, conversion.stderr);
    const win = conversion.stdout.trim();
    writeFileSync(join(dir, 'frame-gpu-job.cs'), source);
    writeFileSync(join(dir, 'fixture-cleanup.cs'), fixtureCleanup);
    const marker = `${win}\\child.pid`;
    const rootMarker = `${win}\\root.started`;
    const child = `${win}\\child.ps1`;
    writeFileSync(join(dir, 'child.ps1'), `[IO.File]::WriteAllText(${literal(marker)},$PID.ToString()); Start-Sleep -Seconds 60`);
    writeFileSync(join(dir, 'root.ps1'), `[IO.File]::WriteAllText(${literal(rootMarker)},$PID.ToString()); $child=Start-Process -FilePath ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${child}"') -PassThru; $until=[datetime]::UtcNow.AddSeconds(10); while(-not (Test-Path ${literal(marker)}) -and [datetime]::UtcNow -lt $until){Start-Sleep -Milliseconds 20}; if(-not(Test-Path ${literal(marker)})){exit 2}`);
    const script = `$ErrorActionPreference='Stop'; Add-Type -Path ${literal(win + '\\frame-gpu-job.cs')}; Add-Type -Path ${literal(win + '\\fixture-cleanup.cs')};
$job=$null; $childProcess=$null; $receipt=@{mode='${mode}'};
try {
 $exe=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;
 if('${mode}' -eq 'failed-start-receipt') {
  $failedName='Local\\ifclite-failed-cpu-'+[guid]::NewGuid().ToString('N');
  try {$bad=[IfcOwnedJob]::new($failedName,'${win}\\missing.exe','missing.exe',$null,5000);$bad.Dispose();$receipt.expectedFailure=$false}
  catch {$failure=$_.Exception.InnerException;$receipt.expectedFailure=$true;$receipt.failedJobName=$failure.Data['jobName'];$receipt.failedRootPid=$failure.Data['rootPid'];$receipt.sourceNativeCode=$failure.NativeErrorCode}
  $receipt.markerAbsent=-not(Test-Path ${literal(rootMarker)});$receipt.ok=$receipt.expectedFailure
 } else {
 $command='"'+$exe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${win}\\root.ps1"';
 $job=[IfcOwnedJob]::new('Local\\ifclite-cpu-'+[guid]::NewGuid().ToString('N'),$exe,$command,$null,5000);
 $receipt.rootPid=$job.RootId; $receipt.rootCreated=$job.RootCreated;
 $receipt.suspendedMarkerAbsent=-not(Test-Path ${literal(rootMarker)});
 $receipt.suspendedMembers=@($job.ActiveIds());
 if('${mode}' -eq 'existing-job-refusal') {
  try {$other=[IfcOwnedJob]::new($job.Name,$exe,$command,$null,5000);$other.Dispose();$receipt.collisionRefused=$false}
  catch {$receipt.collisionRefused=$true}
  $receipt.originalAfterCollision=@($job.ActiveIds());
 }
 $job.Resume();
 $clock=[Diagnostics.Stopwatch]::StartNew();
 while(-not(Test-Path ${literal(marker)}) -and $clock.ElapsedMilliseconds -lt 12000){Start-Sleep -Milliseconds 20}
 if(-not(Test-Path ${literal(marker)})){throw 'Owned child never acknowledged startup'}
 $childId=[int][IO.File]::ReadAllText(${literal(marker)}); $childProcess=[Diagnostics.Process]::GetProcessById($childId); $null=$childProcess.Handle;
 $receipt.childPid=$childId;
 while(($job.ActiveIds() -contains $job.RootId) -and $clock.ElapsedMilliseconds -lt 15000){Start-Sleep -Milliseconds 20}
 $receipt.afterRootExit=@($job.ActiveIds());
 $receipt.observedIdentities=@([IfcOwnedJob]::QueryIdentities($job.Name));
 if('${mode}' -eq 'kill-on-last-close'){$job.Dispose();$job=$null; $receipt.closedLastHandle=$true}
 else {$job.TerminateAndWait(10000);$receipt.activeAfterTerminate=@($job.ActiveIds());}
 $receipt.childTerminated=$childProcess.WaitForExit(5000);
 $receipt.ok=$true;
 }
} catch {
 $failure=$_.Exception.InnerException;$receipt.ok=$false;$receipt.error=$_.Exception.ToString();$receipt.nativeErrorCode=$failure.NativeErrorCode;
 $receipt.failedJobName=$failure.Data['jobName'];$receipt.failedRootPid=$failure.Data['rootPid'];$receipt.failedRootCreated=$failure.Data['rootCreated'];$receipt.startupCleanupProved=$failure.Data['startupCleanupProved'];
 $receipt.markerAbsent=-not(Test-Path ${literal(rootMarker)});
 if($receipt.failedRootPid -gt 0 -and $receipt.failedRootCreated) {
  $same=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+$receipt.failedRootPid)|Where-Object {$_.CreationDate -is [datetime] -and $_.CreationDate.ToUniversalTime().Ticks.ToString() -eq $receipt.failedRootCreated});
  $receipt.failedRootStillAlive=$same.Count -ne 0
 }
}
finally {
 if($null -ne $job){try{$job.TerminateAndWait(5000)}catch{$receipt.cleanupError=$_.Exception.ToString()}finally{$job.Dispose()}}
 if($null -ne $childProcess){
  try {if(-not $childProcess.HasExited){[IfcCpuCleanup]::Retire($childProcess.Handle);$receipt.exactHandleFixtureCleanup=$true}}
  catch {$receipt.fixtureCleanupError=$_.Exception.ToString()}
  finally {$childProcess.Dispose()}
 }
 $receipt|ConvertTo-Json -Depth 5 -Compress
}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 35000 });
    // Preserve every failed setup/cleanup fixture rather than erase its evidence.
    const rawReceipt = JSON.stringify({ mode, fixtureDirectory: dir, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2);
    writeFileSync(join(dir, 'receipt.json'), rawReceipt);
    const evidence = process.env.IFC_JOB_EVIDENCE_DIR;
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, mode + '.json'), rawReceipt, { flag: 'wx' }); }
    assert.equal(result.status, 0, `Retained ${dir}: ${result.stderr}`);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.ok, true, `Retained ${dir}: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.fixtureCleanupError, undefined, `Retained ${dir}: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.cleanupError, undefined, `Retained ${dir}: ${JSON.stringify(receipt)}`);
    if (mode === 'failed-start-receipt') {
      assert.equal(receipt.expectedFailure, true);
      assert.equal(receipt.failedRootPid, 0);
      assert.match(receipt.failedJobName, /^Local\\ifclite-failed-cpu-[a-f0-9]{32}$/);
      assert.ok([2, 3].includes(receipt.sourceNativeCode), JSON.stringify(receipt));
      assert.equal(receipt.markerAbsent, true);
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    assert.equal(receipt.suspendedMarkerAbsent, true);
    assert.deepEqual(receipt.suspendedMembers, [receipt.rootPid]);
    if (mode === 'existing-job-refusal') {
      assert.equal(receipt.collisionRefused, true);
      assert.deepEqual(receipt.originalAfterCollision, [receipt.rootPid]);
    }
    assert.equal(receipt.afterRootExit.includes(receipt.rootPid), false);
    assert.equal(receipt.afterRootExit.includes(receipt.childPid), true);
    const childIdentity = receipt.observedIdentities.find(identity => identity.pid === receipt.childPid);
    assert.ok(childIdentity, JSON.stringify(receipt));
    assert.match(childIdentity.started, /^[1-9][0-9]+$/);
    assert.equal(receipt.childTerminated, true);
    if (mode !== 'kill-on-last-close') assert.deepEqual(receipt.activeAfterTerminate, []);
    rmSync(dir, { recursive: true, force: true });
  });
}
