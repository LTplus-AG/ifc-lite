/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical exclusively owned Windows Chrome lifecycle for native browser rigs. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
export function findWindowsChrome(override?: string | null): string {
  const found = [override, ...CHROME_CANDIDATES].find((path): path is string => Boolean(path) && existsSync(path!));
  if (!found) throw new Error('Windows Chrome not found; pass --chrome /mnt/c/.../chrome.exe');
  return found;
}

export interface ChromeLaunchLimits {
  commandMs?: number;
  startupMs?: number;
  requestMs?: number;
  pollMs?: number;
  cleanupMs?: number;
  signal?: AbortSignal;
}
interface Limits { commandMs: number; startupMs: number; requestMs: number; pollMs: number; cleanupMs: number; signal?: AbortSignal }
function limits(options: ChromeLaunchLimits): Limits {
  const result = { commandMs: 5_000, startupMs: 30_000, requestMs: 1_000, pollMs: 500, cleanupMs: 15_000, ...options };
  for (const key of ['commandMs', 'startupMs', 'requestMs', 'pollMs', 'cleanupMs'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`Invalid Chrome lifecycle deadline ${key}`);
  }
  return result;
}
function run(command: string, args: string[], timeout: number): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) throw new Error(`${command} failed within ${timeout}ms: ${result.error?.message ?? result.stderr}`);
  return result.stdout.replace(/\r/g, '').trim();
}

/** Connection deadlines are owned here, rather than abandoned by an outer race. */
export async function randomUnusedPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 25000);
    const answered = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' });
      const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
      socket.setTimeout(500, () => finish(true)); // Unknown is not evidence of an unused port.
      socket.once('connect', () => finish(true));
      socket.once('error', error => finish(Reflect.get(error, 'code') !== 'ECONNREFUSED'));
    });
    if (!answered) return port;
  }
  throw new Error('no unused port found');
}

export interface ChromeStartupReceipt {
  profileWin: string | null;
  profileWsl: string;
  error: string;
  cleanupError: string | null;
}
export class ChromeStartupError extends Error {
  constructor(message: string, readonly receipt: ChromeStartupReceipt, readonly startupFailures: readonly ChromeStartupReceipt[] = [receipt]) { super(message); this.name = 'ChromeStartupError'; }
}
export interface WindowsChrome {
  cdpUrl: string;
  profileWin: string;
  /** Retained if a diagnostic caller explicitly requests startup retries. */
  startupFailures: ChromeStartupReceipt[];
  dispose(): Promise<string | null>;
}

function removeProfile(profileWsl: string, deadline: number): void {
  run(process.execPath, ['-e', 'const fs=require("node:fs");fs.rmSync(process.argv[1],{recursive:true,force:true});if(fs.existsSync(process.argv[1]))process.exit(2)', profileWsl], deadline);
}
function profileProcessesScript(profileWin: string): string {
  const literal = profileWin.replace(/'/g, "''");
  return `${readFileSync(new URL('./frame-gpu-owned-profile.ps1', import.meta.url), 'utf8')}
$profile='${literal}'; function Owned([switch]$BrowserRoot,[switch]$RequireCompleteObservation) { @(Get-OwnedChromeProcesses -Profile $profile -BrowserRoot:$BrowserRoot -RequireCompleteObservation:$RequireCompleteObservation) };`;
}
interface RootWitness { pid: number; created: string }
function verifyEndpointOwner(profileWin: string, port: number, deadline: number): RootWitness {
  const script = `$ErrorActionPreference='Stop'; ${profileProcessesScript(profileWin)}
    $owners=@(Owned -BrowserRoot -RequireCompleteObservation);
    if($owners.Count -ne 1 -or -not ([IfcChromeArgs]::Split($owners[0].CommandLine) -contains '--remote-debugging-port=${port}')) { throw 'Owned browser endpoint process missing' }
    $listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop);
    if($listeners.Count -eq 0 -or @($listeners | Where-Object {$_.OwningProcess -ne $owners[0].ProcessId}).Count -ne 0) { throw 'CDP endpoint is not owned by allocated profile' }
    @{pid=$owners[0].ProcessId;created=$owners[0].CreationDate.Ticks.ToString()} | ConvertTo-Json -Compress`;
  const witness: unknown = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], deadline));
  if (!witness || typeof witness !== 'object') throw Error('Missing observed browser root identity');
  const pid: unknown = Reflect.get(witness, 'pid'), created: unknown = Reflect.get(witness, 'created');
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof created !== 'string' || !/^[1-9][0-9]*$/.test(created)) throw Error('Invalid observed browser root identity');
  return { pid, created };
}

async function disposeProfile(profileWin: string, profileWsl: string, deadline: number, witness: RootWitness | null): Promise<string | null> {
  try {
    const script = `$ErrorActionPreference='Stop'; ${profileProcessesScript(profileWin)}
      Invoke-OwnedChromeCleanup -Profile $profile -DeadlineMs ${deadline} -ObservedRootPid ${witness?.pid ?? 0} -ObservedRootCreated '${witness?.created ?? ''}'`;
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], deadline);
    // A separate owned deletion process gives filesystem cleanup a real deadline.
    removeProfile(profileWsl, deadline);
    return null;
  } catch (error) { return `Owned profile cleanup failed (${profileWsl}): ${String(error)}`; }
}

/** A failed timing sample is not silently replaced. Explicit diagnostic retries retain receipts. */
export async function launchWindowsChrome(exe: string, attempts = 1, options: ChromeLaunchLimits = {}): Promise<WindowsChrome> {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Invalid bounded Chrome startup attempts');
  const policy = limits(options), failures: ChromeStartupReceipt[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    policy.signal?.throwIfAborted();
    try { const chrome = await launchOnce(exe, policy); chrome.startupFailures = failures; return chrome; }
    catch (error) {
      if (!(error instanceof ChromeStartupError)) throw error;
      failures.push(error.receipt);
      console.error(`frame-gpu-chrome: startup attempt ${attempt}/${attempts}: ${error.message}`);
      // Never create another profile while a prior allocated owner may still be live.
      if (error.receipt.cleanupError || attempt === attempts || policy.signal?.aborted) throw new ChromeStartupError(error.message, error.receipt, [...failures]);
    }
  }
  throw new Error('Chrome startup ended without a receipt');
}

async function launchOnce(exe: string, policy: Limits): Promise<WindowsChrome> {
  policy.signal?.throwIfAborted();
  const tempWin = `${run('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], policy.commandMs)}\\Temp`;
  const profileWsl = join(run('wslpath', ['-u', tempWin], policy.commandMs), `ifclite-frame-rig-${randomBytes(6).toString('hex')}`);
  mkdirSync(profileWsl, { recursive: true });
  let profileWin: string | null = null, spawned = false;
  let rootWitness: RootWitness | null = null;
  try {
    policy.signal?.throwIfAborted();
    profileWin = run('wslpath', ['-w', profileWsl], policy.commandMs);
    const port = await randomUnusedPort();
    policy.signal?.throwIfAborted();
    const child = spawn(exe, [
      `--remote-debugging-port=${port}`, `--user-data-dir=${profileWin}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--enable-unsafe-webgpu', '--window-size=1280,800', '--window-position=0,0',
      '--disable-features=BatterySaverModeAvailable,HighEfficiencyModeAvailable', 'about:blank',
    ], { detached: true, stdio: 'ignore' });
    let spawnError: Error | null = null;
    let spawnSucceeded = false;
    child.once('spawn', () => { spawnSucceeded = true; });
    child.once('error', error => {
      spawnError = error;
      // Only a failed OS spawn with neither a spawn event nor a PID proves
      // there was no child. Errors after spawn retain owned cleanup (#7180).
      if (!spawnSucceeded && child.pid === undefined) spawned = false;
    });
    child.unref(); spawned = true;
    const ownedWin = profileWin;
    const chrome: WindowsChrome = { cdpUrl: `http://127.0.0.1:${port}`, profileWin, startupFailures: [],
      dispose: () => disposeProfile(ownedWin, profileWsl, policy.cleanupMs, rootWitness) };
    let lastError: unknown = null;
    const until = Date.now() + policy.startupMs;
    while (Date.now() < until) {
      policy.signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      try {
        const signals = [AbortSignal.timeout(Math.min(policy.requestMs, Math.max(1, until - Date.now())))];
        if (policy.signal) signals.push(policy.signal);
        const response = await fetch(`${chrome.cdpUrl}/json/version`, { signal: AbortSignal.any(signals) });
        if (response.ok) { rootWitness = verifyEndpointOwner(ownedWin, port, policy.commandMs); policy.signal?.throwIfAborted(); return chrome; }
        lastError = `HTTP ${response.status}`;
      } catch (error) { lastError = error; }
      await sleep(Math.min(policy.pollMs, Math.max(1, until - Date.now())));
    }
    throw new Error(`Windows Chrome did not open its owned endpoint: ${String(lastError)}`);
  } catch (error) {
    let cleanupError: string | null = null;
    if (spawned && profileWin) cleanupError = await disposeProfile(profileWin, profileWsl, policy.cleanupMs, rootWitness);
    else {
      try { removeProfile(profileWsl, policy.cleanupMs); }
      catch (cleanup) { cleanupError = `Allocated profile removal failed: ${String(cleanup)}`; }
    }
    const receipt = { profileWin, profileWsl, error: String(error), cleanupError };
    throw new ChromeStartupError(receipt.error, receipt);
  }
}
