/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical exclusively owned Windows Chrome lifecycle for native browser rigs. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createChromeOwner, decodeChromeOwner, launchOwnedProfileJob, type ChromeOwner, type OwnedProfileJob } from './frame-gpu-chrome-owner.js';
import { OwnedJobProtocolError } from './frame-gpu-job-controller.js';

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
  jobRequestMs?: number;
  lifetimeSeconds?: number;
  runBudgetMs?: number;
  ledger?: string;
  signal?: AbortSignal;
}
interface Limits { commandMs: number; startupMs: number; requestMs: number; pollMs: number; cleanupMs: number; jobRequestMs: number; lifetimeSeconds: number; runBudgetMs: number; ledger?: string; signal?: AbortSignal }
function limits(options: ChromeLaunchLimits): Limits {
  const result = { commandMs: 5_000, startupMs: 30_000, requestMs: 1_000, pollMs: 500, cleanupMs: 15_000,
    jobRequestMs: 15_000, lifetimeSeconds: 900, runBudgetMs: 600_000, ...options };
  for (const key of ['commandMs', 'startupMs', 'requestMs', 'pollMs', 'cleanupMs', 'jobRequestMs', 'lifetimeSeconds', 'runBudgetMs'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`Invalid Chrome lifecycle deadline ${key}`);
  }
  if (result.jobRequestMs > 60000 || result.cleanupMs > 60000 || result.lifetimeSeconds > 1800
    || result.lifetimeSeconds * 1000 <= result.startupMs + 3 * result.jobRequestMs + result.runBudgetMs + 2 * result.cleanupMs) {
    throw new Error('Job lifetime does not cover the declared run and shutdown budget');
  }
  return result;
}
function run(command: string, args: string[], timeout: number): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) throw new Error(`${command} failed within ${timeout}ms: ${result.error?.message ?? result.stderr}`);
  return result.stdout.replace(/\r/g, '').trim();
}

/** Allocate in the Windows socket domain where the owned browser will bind. */
export async function randomUnusedPort(): Promise<number> {
  const source = readFileSync(new URL('./frame-gpu-native-port.ps1', import.meta.url), 'utf8');
  const script = `$ErrorActionPreference='Stop'; ${source}\nGet-IfcUnusedLoopbackPort | ConvertTo-Json -Compress`;
  const value: unknown = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], 5000));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing native loopback allocation receipt');
  const port: unknown = Reflect.get(value, 'port');
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || Reflect.get(value, 'address') !== '127.0.0.1' || Reflect.get(value, 'exclusive') !== true
    || Reflect.get(value, 'stopped') !== true) throw new Error('Invalid native loopback allocation receipt');
  // Releasing the reservation permits Chrome to bind. A foreign intervening
  // listener still fails the exact held-handle Job/endpoint ownership gate.
  return port;
}

export interface ChromeStartupReceipt {
  profileWin: string | null;
  profileWsl: string;
  error: string;
  cleanupError: string | null;
  owner?: ChromeOwner;
  jobFailure?: { packets: readonly Record<string, unknown>[]; retirement: { code: number | null; signal: NodeJS.Signals | null } | null; supervisorNoStart: OwnedJobProtocolError['supervisorNoStart'] };
}
export class ChromeStartupError extends Error {
  constructor(message: string, readonly receipt: ChromeStartupReceipt, readonly startupFailures: readonly ChromeStartupReceipt[] = [receipt]) { super(message); this.name = 'ChromeStartupError'; }
}
export interface WindowsChrome {
  cdpUrl: string;
  profileWin: string;
  /** Retained if a diagnostic caller explicitly requests startup retries. */
  startupFailures: ChromeStartupReceipt[];
  owner: ChromeOwner;
  job: OwnedProfileJob;
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
async function verifyEndpointOwner(job: OwnedProfileJob, port: number, deadline: number): Promise<void> {
  const contained = await job.controller.snapshot();
  const identities = JSON.stringify(contained).replace(/'/g, "''");
  const profileWin = job.owner.profileWin;
  const identityModule = run('wslpath', ['-w', fileURLToPath(new URL('./frame-gpu-process-identity.cs', import.meta.url))], deadline).replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; Add-Type -Path '${identityModule}'; ${profileProcessesScript(profileWin)}
    $owners=@(Owned -BrowserRoot -RequireCompleteObservation);
    if($owners.Count -ne 1 -or -not ([IfcChromeArgs]::Split($owners[0].CommandLine) -contains '--remote-debugging-port=${port}')) { throw 'Owned browser endpoint process missing' }
    $contained=ConvertFrom-Json '${identities}';
    $member=@($contained | Where-Object {$_.pid -eq $owners[0].ProcessId});
    if($member.Count -ne 1){throw 'Browser endpoint outside the owned kernel Job'}
    $root=[Diagnostics.Process]::GetProcessById([int]$owners[0].ProcessId);
    try {
      $null=$root.Handle;
      if([IfcProcessIdentity]::Creation($root.Handle) -ne $member[0].started -or $root.HasExited){throw 'Browser native creation identity differs from the owned Job'}
      # Keep this native process handle alive across fresh metadata and listener
      # checks; an exited/replaced PID is never adopted from a prior CIM row.
      $again=@(Owned -BrowserRoot -RequireCompleteObservation);
      if($again.Count -ne 1 -or $again[0].ProcessId -ne $root.Id -or $again[0].CommandLine -cne $owners[0].CommandLine -or
        -not ([IfcChromeArgs]::Split($again[0].CommandLine) -contains '--remote-debugging-port=${port}')){throw 'Owned browser metadata changed during endpoint admission'}
      $listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop);
      if($listeners.Count -eq 0 -or @($listeners | Where-Object {$_.OwningProcess -ne $root.Id}).Count -ne 0){throw 'CDP endpoint is not owned by allocated profile'}
      if($root.HasExited){throw 'Owned browser exited during endpoint admission'}
    } finally {$root.Dispose()}
`;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], deadline);
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

/** Only an actual owned OS error before birth can prove no supervisor existed. */
function supervisorNeverStarted(error: unknown): boolean {
  if (!(error instanceof OwnedJobProtocolError) || error.receipts.length !== 0
    || error.retirement?.signal !== null) return false;
  const proof = error.supervisorNoStart;
  return proof !== null && proof.executable === 'powershell.exe' && proof.syscall === 'spawn powershell.exe'
    && ((proof.code === 'ENOENT' && proof.errno === -2) || (proof.code === 'EACCES' && proof.errno === -13))
    && error.retirement.code === proof.errno;
}

/** Constructor cleanup proof belongs to this exact supervisor protocol, not absence. */
function retiredStartupFailure(error: unknown, owner: ChromeOwner): boolean {
  if (!(error instanceof OwnedJobProtocolError) || error.retirement?.code !== 1 || error.retirement.signal !== null
    || error.receipts.length !== 1) return false;
  const terminal = error.receipts[0];
  if (terminal.event !== 'terminal' || terminal.ok !== false || terminal.disposed !== false) return false;
  const failure = terminal.failure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false;
  const value = (key: string): unknown => Reflect.get(failure, key);
  if (value('resumed') !== false || value('startupCleanupProved') !== true
    || value('jobName') !== `Local\\ifclite-owned-${owner.token}`
    || typeof value('error') !== 'string' || !value('error')
    || value('cleanupError') !== undefined || value('closeError') !== undefined) return false;
  const pid = value('rootPid'), stamp = value('rootCreated');
  return (pid === 0 && stamp === null)
    || (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
      && typeof stamp === 'string' && /^[1-9][0-9]*$/.test(stamp));
}

async function launchOnce(exe: string, policy: Limits): Promise<WindowsChrome> {
  policy.signal?.throwIfAborted();
  const owner = createChromeOwner(policy.ledger);
  const { profileWsl, profileWin } = owner;
  let job: OwnedProfileJob | undefined, jobStartAttempted = false;
  try {
    policy.signal?.throwIfAborted();
    const port = await randomUnusedPort();
    policy.signal?.throwIfAborted();
    const executableWin = run('wslpath', ['-w', exe], policy.commandMs);
    jobStartAttempted = true;
    job = await launchOwnedProfileJob(owner, executableWin, [
      `--remote-debugging-port=${port}`, `--user-data-dir=${profileWin}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--enable-unsafe-webgpu', '--window-size=1280,800', '--window-position=0,0',
      '--disable-features=BatterySaverModeAvailable,HighEfficiencyModeAvailable', 'about:blank',
    ], { requestMs: policy.jobRequestMs, cleanupMs: policy.cleanupMs, lifetimeSeconds: policy.lifetimeSeconds, signal: policy.signal });
    policy.signal?.throwIfAborted();
    const ownedJob = job;
    const chrome: WindowsChrome = { cdpUrl: `http://127.0.0.1:${port}`, profileWin, startupFailures: [],
      owner, job, dispose: () => ownedJob.dispose() };
    let lastError: unknown = null;
    const until = Date.now() + policy.startupMs;
    while (Date.now() < until) {
      policy.signal?.throwIfAborted();
      try {
        const signals = [AbortSignal.timeout(Math.min(policy.requestMs, Math.max(1, until - Date.now())))];
        if (policy.signal) signals.push(policy.signal);
        const response = await fetch(`${chrome.cdpUrl}/json/version`, { signal: AbortSignal.any(signals) });
        if (response.ok) { await verifyEndpointOwner(ownedJob, port, policy.commandMs); policy.signal?.throwIfAborted(); return chrome; }
        lastError = `HTTP ${response.status}`;
      } catch (error) { lastError = error; }
      await sleep(Math.min(policy.pollMs, Math.max(1, until - Date.now())));
    }
    throw new Error(`Windows Chrome did not open its owned endpoint: ${String(lastError)}`);
  } catch (error) {
    let cleanupError: string | null = null;
    if (job) cleanupError = await job.dispose();
    else if (jobStartAttempted && !supervisorNeverStarted(error) && !retiredStartupFailure(error, owner)) cleanupError = 'Job startup retirement unproved; retain owner marker and profile';
    else {
      try { decodeChromeOwner(owner); removeProfile(profileWsl, policy.cleanupMs); }
      catch (cleanup) { cleanupError = `Allocated profile removal failed: ${String(cleanup)}`; }
    }
    const receipt: ChromeStartupReceipt = { profileWin, profileWsl, owner, error: String(error), cleanupError,
      ...(error instanceof OwnedJobProtocolError ? { jobFailure: { packets: error.receipts, retirement: error.retirement, supervisorNoStart: error.supervisorNoStart } } : {}) };
    throw new ChromeStartupError(receipt.error, receipt);
  }
}
