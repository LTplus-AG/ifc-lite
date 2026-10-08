/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Shared Windows Job protocol. Marker/path ownership remains in ChromeOwner.
 * Source preparation only: this controller has not qualified a Chrome launch. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface JobPrepared {
  jobName: string;
  rootPid: number;
  rootCreated: string;
  supervisorPid: number;
  supervisorCreated: string;
}
export interface JobProcessIdentity { pid: number; started: string }
export interface JobLaunchOptions {
  token: string;
  executable: string;
  commandLine: string;
  supervisorWin: string;
  jobModuleWin: string;
  inputModuleWin: string;
  requestMs: number;
  cleanupMs: number;
  lifetimeSeconds: number;
  /** Durably bind marker + ledger + source SHA before any root instruction. */
  persistPrepared(prepared: JobPrepared): Promise<void>;
}
type Packet = Record<string, unknown>;
interface ExitStatus { code: number | null; signal: NodeJS.Signals | null }
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
function object(value: unknown): Packet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Job supervisor packet');
  return value as Packet;
}
function pid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw Error('Invalid owned Windows PID');
  return value;
}
function created(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw Error('Missing exact Windows creation stamp');
  return value;
}
function prepared(packet: Packet, token: string): JobPrepared {
  const name = `Local\\ifclite-owned-${token}`;
  if (packet.event !== 'prepared' || packet.jobName !== name) throw Error('Job preparation identity changed');
  return { jobName: name, rootPid: pid(packet.rootPid), rootCreated: created(packet.rootCreated),
    supervisorPid: pid(packet.supervisorPid), supervisorCreated: created(packet.supervisorCreated) };
}

class JobProtocol {
  readonly receipts: Packet[] = [];
  private stderr = '';
  private failure: Error | null = null;
  private packets: Packet[] = [];
  private waiters: Array<{ resolve(packet: Packet): void; reject(error: Error): void }> = [];
  retirement: ExitStatus | null = null;
  readonly closed: Promise<ExitStatus>;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65536); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        if (line.length > 1048576) throw Error('Oversized Job supervisor packet');
        const packet = object(JSON.parse(line));
        this.receipts.push(packet);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(packet); else this.packets.push(packet);
      } catch (error) { this.fail(new Error(`Invalid Job output: ${String(error)}`)); }
    });
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    this.closed = new Promise(resolve => child.once('close', (code, signal) => {
      this.retirement = { code, signal };
      this.fail(new Error(`Job supervisor closed (${code}/${signal}): ${this.stderr}`));
      resolve({ code, signal });
    }));
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  async next(timeoutMs: number): Promise<Packet> {
    const packet = this.packets.shift();
    if (packet) return packet;
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (value: Packet) => { clearTimeout(timer); resolve(value); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(Error('Owned Job protocol deadline exceeded'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  async endAndWait(timeoutMs: number): Promise<ExitStatus> {
    this.child.stdin.end(); // EOF invokes the canonical supervisor's bounded Job cleanup.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Job supervisor retirement remains unknown')), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

export interface OwnedJobController {
  prepared: JobPrepared;
  receipts: readonly Packet[];
  snapshot(): Promise<JobProcessIdentity[]>;
  dispose(): Promise<void>;
}
export class OwnedJobProtocolError extends AggregateError {
  constructor(errors: unknown[], readonly receipts: readonly Packet[], readonly retirement: ExitStatus | null) {
    super(errors, `Owned Job refused: ${errors.map(String).join('; ')}. Retain ownership ledger.`);
    this.name = 'OwnedJobProtocolError';
  }
}
/** One prepared-root handshake and one ordered protocol; no startup retries. */
export async function launchOwnedJob(options: JobLaunchOptions): Promise<OwnedJobController> {
  if (!/^[a-f0-9]{32}$/.test(options.token)) throw Error('Invalid owned Job token');
  for (const value of [options.requestMs, options.cleanupMs, options.lifetimeSeconds]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid Job deadline');
  }
  if (options.cleanupMs > 60000 || options.lifetimeSeconds > 1800) throw Error('Job deadline exceeds supervisor bound');
  const script = `$ErrorActionPreference='Stop'; & ${literal(options.supervisorWin)} -Token ${literal(options.token)} -Executable ${literal(options.executable)} -CommandLine ${literal(options.commandLine)} -JobModule ${literal(options.jobModuleWin)} -InputModule ${literal(options.inputModuleWin)} -CleanupMs ${options.cleanupMs} -DeadlineSeconds ${options.lifetimeSeconds}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'pipe' });
  const protocol = new JobProtocol(child);
  async function refuseAndRetire(error: unknown): Promise<never> {
    try { await protocol.endAndWait(options.cleanupMs + 1000); }
    catch (cleanup) { throw new OwnedJobProtocolError([error, cleanup], [...protocol.receipts], protocol.retirement); }
    throw new OwnedJobProtocolError([error], [...protocol.receipts], protocol.retirement);
  }
  let sequence = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const request = (action: string): Promise<Packet> => {
    const operation = tail.then(async () => {
      if (disposed) throw Error('Job already disposed');
      const id = ++sequence;
      child.stdin.write(`${JSON.stringify({ id, action })}\n`);
      const packet = await protocol.next(options.requestMs);
      if (packet.id !== id || packet.jobName !== `Local\\ifclite-owned-${options.token}`) {
        throw Error('Job acknowledgement belongs to another operation');
      }
      return packet;
    });
    tail = operation;
    return operation;
  };
  try {
    const owner = prepared(await protocol.next(options.requestMs), options.token);
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([options.persistPrepared(owner), new Promise<never>((_, reject) => {
        persistTimer = setTimeout(() => reject(Error('Durable Job ownership acknowledgement timed out')), options.requestMs);
      })]);
    } finally { if (persistTimer) clearTimeout(persistTimer); }
    const resumed = await request('resume');
    if (resumed.event !== 'resumed') throw Error('Owned root resume unproved');
    return {
      prepared: owner, receipts: protocol.receipts,
      async snapshot() {
        try {
        const packet = await request('snapshot');
        if (packet.event !== 'snapshot' || !Array.isArray(packet.identities)) throw Error('Missing authoritative Job snapshot');
        const identities = packet.identities.map(value => {
          const item = object(value);
          return { pid: pid(item.pid), started: created(item.started) };
        });
        if (new Set(identities.map(item => item.pid)).size !== identities.length) throw Error('Duplicate authoritative Job PID');
        return identities;
        } catch (error) { return refuseAndRetire(error); }
      },
      async dispose() {
        try {
        const packet = await request('dispose');
        if (packet.event !== 'disposed' || packet.activeProcesses !== 0) throw Error('Owned Job active-zero proof missing');
        disposed = true;
        const terminal = await protocol.next(options.cleanupMs);
        if (terminal.event !== 'terminal' || terminal.ok !== true || terminal.disposed !== true) throw Error('Job handle retirement failed');
        const status = await protocol.endAndWait(options.cleanupMs);
        if (status.code !== 0 || status.signal !== null) throw Error(`Job supervisor retirement status failed (${status.code}/${status.signal})`);
        } catch (error) { return refuseAndRetire(error); }
      },
    };
  } catch (error) {
    return refuseAndRetire(error);
  }
}
