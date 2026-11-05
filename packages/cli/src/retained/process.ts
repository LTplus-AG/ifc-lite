// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { getFlag } from '../output.js';

/** A worker thread cannot contain a native fault in its Node host (#8868). */
export class RetainedProcessError extends Error {
  readonly code = 'RETAINED_PROCESS_FAILED';
  constructor(readonly pid: number | undefined, readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null, readonly stderr: string, readonly cancelled: boolean,
    options?: ErrorOptions) {
    super(`RETAINED_PROCESS_FAILED: retained export process ${pid ?? '(not started)'} ` +
      `${cancelled ? 'cancelled' : signal ? `terminated by ${signal}` : `exited (${exitCode})`}; ` +
      `nothing published${stderr ? `\n${stderr}` : ''}`, options);
    this.name = 'RetainedProcessError';
  }
}

/** Preserve explicit heap limits and fatal-error diagnostics in the process
 * doing the work. Eval programs, loaders and debugger ports belong to the parent. */
function childRuntimeArgs(): string[] {
  const valued = new Set(['--max-old-space-size', '--max-semi-space-size', '--stack-size',
    '--report-directory', '--report-filename']);
  const switches = new Set(['--report-on-fatalerror', '--report-compact', '--report-exclude-env',
    '--report-exclude-network', '--enable-source-maps']);
  const parentOperands = new Set(['-e', '--eval', '-p', '--print', '-r', '--require',
    '--import', '--loader', '--experimental-loader', '--conditions']);
  const forwarded: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i], key = arg.split('=')[0].replaceAll('_', '-');
    if (valued.has(key)) {
      forwarded.push(arg);
      if (!arg.includes('=') && i + 1 < process.execArgv.length) forwarded.push(process.execArgv[++i]);
    } else if (switches.has(key)) forwarded.push(arg);
    else if (parentOperands.has(key) && !arg.includes('=')) i++;
  }
  return forwarded;
}

/** Wait for process closure, including late native faults after staged writes.
 * Never treat a result message or a completed file as successful termination. */
async function runChild(entry: URL, config: string, abort?: AbortSignal): Promise<string> {
  const child = spawn(process.execPath, [...childRuntimeArgs(), fileURLToPath(entry), config], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = Buffer.alloc(0), cancelled = false, spawnError: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-8192);
  });
  child.on('error', error => { spawnError = error; });
  const terminate = () => {
    if (cancelled) return;
    cancelled = true;
    child.kill('SIGTERM');
    escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
    escalation.unref();
  };
  const killOnExit = () => { child.kill('SIGKILL'); };
  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  process.once('exit', killOnExit);
  abort?.addEventListener('abort', terminate, { once: true });
  // Register before testing abort so even immediate cancellation is reaped.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (abort?.aborted) terminate();
  try {
    const { code, signal } = await closed;
    if (spawnError || cancelled || signal || code !== 0) {
      throw new RetainedProcessError(child.pid, code, signal, stderr.toString('utf8'), cancelled,
        spawnError ? { cause: spawnError } : undefined);
    }
    return stderr.toString('utf8');
  } finally {
    clearTimeout(escalation);
    process.off('SIGINT', terminate);
    process.off('SIGTERM', terminate);
    process.off('exit', killOnExit);
    abort?.removeEventListener('abort', terminate);
  }
}

/** Only the retained path uses this boundary. The child runs exportCommand's
 * canonical parsing/filtering/export path and never writes user destinations. */
export async function exportRetainedIsolated(args: string[], options: {
  entry?: URL; signal?: AbortSignal;
} = {}): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-retained-export-'));
  try {
    const obj = join(directory, 'model.obj'), report = join(directory, 'report.json');
    const outPath = getFlag(args, '--out'), reportPath = getFlag(args, '--retained-report');
    const stagedArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--out' || args[i] === '--retained-report') i++;
      else stagedArgs.push(args[i]);
    }
    stagedArgs.push('--out', obj);
    if (reportPath) stagedArgs.push('--retained-report', report);
    const config = join(directory, 'request.json');
    await writeFile(config, JSON.stringify({ args: stagedArgs, level: logger.level() }));
    const stderr = await runChild(options.entry ?? new URL('./process-child.js', import.meta.url), config, options.signal);
    // Validate every expected artifact before opening any user destination.
    for (const path of reportPath ? [obj, report] : [obj]) {
      const info = await lstat(path);
      if (!info.isFile() || !info.size) throw new Error('Retained process produced no complete artifact');
    }
    if (options.signal?.aborted) throw new RetainedProcessError(undefined, null, null, '', true);
    if (reportPath) await copyFile(report, reportPath);
    if (outPath) await copyFile(obj, outPath);
    else {
      for await (const chunk of createReadStream(obj)) {
        if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
      }
    }
    // The child logged private staging paths; report the caller's paths only.
    process.stderr.write(stderr.replaceAll(obj, outPath ?? 'stdout').replaceAll(report, reportPath ?? 'report'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
