/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// #7036: execute the actual Win32 argv parser; no Chrome launch or PID termination.
const source = readFileSync(new URL('./frame-gpu-owned-profile.ps1', import.meta.url), 'utf8');
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 });
const skip = probe.error || probe.status !== 0 ? 'Actual Windows PowerShell unavailable; native ownership qualification held' : false;
for (const quote of ['value', 'whole-argument']) {
  test(`#7036 actual Windows profile ownership requires exact parsed argument (${quote})`, { skip }, () => {
    const profile = "C:\\Temp\\O'Brien owned profile";
    const argument = quote === 'value' ? `--user-data-dir="${profile}"` : `"--user-data-dir=${profile}"`;
    const rows = [
      { ProcessId: 10, CommandLine: `chrome.exe ${argument} --comment="text--type=renderer"` },
      { ProcessId: 11, CommandLine: `chrome.exe "--user-data-dir=${profile}-foreign"` },
      { ProcessId: 12, CommandLine: 'chrome.exe "--user-data-dir=C:\\Temp\\O\'Brien"' },
      { ProcessId: 13, CommandLine: `chrome.exe ${argument} --type=renderer` },
      { ProcessId: 14, CommandLine: `chrome.exe "--comment=--user-data-dir=${profile}"` },
      { ProcessId: 15, CommandLine: null },
    ];
    const json = JSON.stringify({ profile, rows }).replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop';\n${source}\n$fixture=ConvertFrom-Json '${json}';\nfunction Get-CimInstance { return @($fixture.rows) };\n@{all=@(Get-OwnedChromeProcesses -Profile $fixture.profile | ForEach-Object {$_.ProcessId});roots=@(Get-OwnedChromeProcesses -Profile $fixture.profile -BrowserRoot | ForEach-Object {$_.ProcessId})}|ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { all: [10, 13], roots: [10] });
  });
}

for (const mode of ['valid','null-command','missing-command','missing-creation','duplicate']) {
  test(`#7036 actual Windows cleanup absence proof refuses incomplete process observations (${mode})`, { skip }, () => {
    const script = `$ErrorActionPreference='Stop';\n${source}\n$p=@{ProcessId=100;CreationDate=[datetime]::UtcNow;CommandLine='chrome.exe --user-data-dir=C:\\owned'};if('${mode}' -eq 'null-command'){$p.CommandLine=$null};if('${mode}' -eq 'missing-command'){$p.Remove('CommandLine')};if('${mode}' -eq 'missing-creation'){$p.Remove('CreationDate')};$rows=@([pscustomobject]$p);if('${mode}' -eq 'duplicate'){$rows+=([pscustomobject]$p)};function Get-CimInstance {return $rows};try {$owned=@(Get-OwnedChromeProcesses -Profile 'C:\\owned' -RequireCompleteObservation);@{accepted=$true;count=$owned.Count}|ConvertTo-Json -Compress}catch {@{accepted=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress}`;
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout.trim());assert.equal(receipt.accepted,mode==='valid',JSON.stringify(receipt));if(mode==='valid')assert.equal(receipt.count,1);
  });
}
