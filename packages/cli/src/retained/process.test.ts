// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { copyFile, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { childRuntimeArgs, exportRetainedIsolated, RetainedProcessError } from './process.js';
import { logger } from '../logger.js';

// Keep real filesystem behavior, with hooks to deliver cancellation exactly at
// the post-child validation/publication boundary instead of racing a timer.
vi.mock('node:fs/promises', { spy: true });

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  logger.configure({ level: 'info' });
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'retained-process-test-'));
  dirs.push(directory);
  const entry = join(directory, 'child.mjs');
  const observation = join(directory, 'observation.json');
  await writeFile(entry, `
    import { readFile, writeFile } from 'node:fs/promises';
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const { args, level } = config;
    const flag = name => args[args.indexOf(name) + 1];
    await writeFile(${JSON.stringify(observation)}, JSON.stringify({ config, request: process.argv[2], pid: process.pid }));
    ${body}
  `);
  const obj = join(directory, 'destination.obj'), report = join(directory, 'destination.json');
  const args = ['input.ifc', '--kernel', 'retained', '--format', 'obj', '--out', obj, '--retained-report', report];
  return { directory, entry: pathToFileURL(entry), observation, obj, report, args };
}

const staged = `
  await writeFile(flag('--out'), 'complete obj\\n');
  if (args.includes('--retained-report')) await writeFile(flag('--retained-report'), 'complete report\\n');
`;

for (const kind of ['exit', 'signal']) {
  it.skipIf(kind === 'signal' && process.platform === 'win32')(`#8868 ${kind} after staging cannot overwrite destinations or publish stdout`, async () => {
    const f = await fixture(staged + (kind === 'signal' ? "process.kill(process.pid, 'SIGSEGV');" : 'process.exit(139);'));
    await writeFile(f.obj, 'original obj');
    await writeFile(f.report, 'original report');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    let failure: unknown;
    try { await exportRetainedIsolated(f.args, { entry: f.entry }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RetainedProcessError);
    expect(failure).toMatchObject({ code: 'RETAINED_PROCESS_FAILED', signal: kind === 'signal' ? 'SIGSEGV' : null,
      exitCode: kind === 'signal' ? null : 139, cancelled: false });
    expect(await readFile(f.obj, 'utf8')).toBe('original obj');
    expect(await readFile(f.report, 'utf8')).toBe('original report');
    expect(stdout).not.toHaveBeenCalled();
    const { request, pid } = JSON.parse(await readFile(f.observation, 'utf8'));
    await expect(readFile(request)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);
}

it('#8868 success publishes identical staged bytes only after exit and preserves filters and verbosity', async () => {
  const f = await fixture(staged + `process.stdout.write('must never leak'); process.stderr.write('retained summary\\n');`);
  logger.configure({ level: 'error' });
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await exportRetainedIsolated([...f.args, '--type', 'IfcWall', '--limit', '3', '--out', '/unused-duplicate'], { entry: f.entry });
  expect(await readFile(f.obj, 'utf8')).toBe('complete obj\n');
  expect(await readFile(f.report, 'utf8')).toBe('complete report\n');
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith('retained summary\n');
  const { config, request } = JSON.parse(await readFile(f.observation, 'utf8'));
  expect(config.level).toBe('error');
  expect(config.args).toEqual(['input.ifc', '--kernel', 'retained', '--format', 'obj',
    '--type', 'IfcWall', '--limit', '3', '--out', join(dirname(request), 'model.obj'),
    '--retained-report', join(dirname(request), 'report.json')]);
  await expect(readFile(request)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('#8868 stdout uses staged bytes without a final destination file', async () => {
  const f = await fixture(staged);
  const chunks: Buffer[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(Buffer.from(chunk)); return true; });
  await exportRetainedIsolated(f.args.slice(0, 5), { entry: f.entry });
  expect(Buffer.concat(chunks).toString()).toBe('complete obj\n');
  expect(await readdir(f.directory)).toEqual(['child.mjs', 'observation.json']);
});

it('#8868 a missing report after clean exit cannot publish an otherwise valid OBJ', async () => {
  const f = await fixture(`await writeFile(flag('--out'), 'obj');`);
  await expect(exportRetainedIsolated(f.args, { entry: f.entry })).rejects.toThrow();
  await expect(readFile(f.obj)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32').each([false, true])('#8868 cancellation wins and reaps the child (ignore SIGTERM: %s)', async ignoresSignal => {
  const f = await fixture(staged + `
    process.on('SIGTERM', () => { ${ignoresSignal ? '' : 'process.exit(0);'} });
    setInterval(() => {}, 100);
    await writeFile(process.argv[2] + '.ready', 'ready');
  `);
  const controller = new AbortController();
  const operation = exportRetainedIsolated(f.args, { entry: f.entry, signal: controller.signal });
  const settled = operation.then(() => null, (error: unknown) => error);
  let ready = false, pid: number | undefined;
  try {
    for (let n = 0; n < 300; n++) {
      try {
        const observation = JSON.parse(await readFile(f.observation, 'utf8'));
        pid = observation.pid;
        await readFile(observation.request + '.ready');
        ready = true;
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } finally {
    controller.abort();
  }
  const failure = await settled;
  expect(ready).toBe(true);
  expect(failure).toMatchObject({ code: 'RETAINED_PROCESS_FAILED', cancelled: true,
    exitCode: ignoresSignal ? null : 0, signal: ignoresSignal ? 'SIGKILL' : null });
  await expect(readFile(f.obj)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(f.report)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid!, 0)).toThrow();
});

it('#8868 a missing child entry fails with bounded diagnostics and no artifacts', async () => {
  const f = await fixture('');
  await expect(exportRetainedIsolated(f.args, { entry: new URL('./absent.mjs', f.entry) })).rejects.toMatchObject({
    code: 'RETAINED_PROCESS_FAILED', exitCode: 1, signal: null,
  });
  await expect(readFile(f.obj)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('#8868 retains only the final 8 KiB of a failed child diagnostic', async () => {
  const f = await fixture(`process.stderr.write('prefix' + 'x'.repeat(12000) + 'fatal tail', () => process.exit(1));`);
  const failure = await exportRetainedIsolated(f.args, { entry: f.entry }).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(RetainedProcessError);
  expect(failure).toMatchObject({ stderr: 'x'.repeat(8192 - 'fatal tail'.length) + 'fatal tail' });
});

it.each(['validation', 'publication'])('#8868 owns repeated parent signals through %s and cleanup', async phase => {
  const f = await fixture(staged);
  await writeFile(f.obj, 'original obj');
  await writeFile(f.report, 'original report');
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const interrupt = () => {
    expect(process.emit('SIGTERM')).toBe(true);
    expect(process.emit('SIGINT')).toBe(true);
    expect(process.emit('SIGTERM')).toBe(true);
  };
  if (phase === 'validation') {
    vi.mocked(lstat).mockImplementationOnce((...args) => {
      interrupt();
      return original.lstat(...args);
    });
  } else {
    vi.mocked(copyFile).mockImplementationOnce((...args) => {
      interrupt();
      return original.copyFile(...args);
    });
  }
  const operation = exportRetainedIsolated(f.args, { entry: f.entry });
  if (phase === 'validation') {
    await expect(operation).rejects.toMatchObject({ code: 'RETAINED_PROCESS_FAILED', cancelled: true });
    expect(await readFile(f.obj, 'utf8')).toBe('original obj');
    expect(await readFile(f.report, 'utf8')).toBe('original report');
  } else {
    await operation;
    expect(await readFile(f.obj, 'utf8')).toBe('complete obj\n');
    expect(await readFile(f.report, 'utf8')).toBe('complete report\n');
  }
  const { request, pid } = JSON.parse(await readFile(f.observation, 'utf8'));
  await expect(readFile(request)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(() => process.kill(pid, 0)).toThrow();
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
});

it.each([{ heapFlags: ['--max-old-space-size', '128'] }, { heapFlags: ['--max_old_space_size=128'] }])(
  '#8868 explicit heap and diagnostic flags reach the actual child ($heapFlags)', async ({ heapFlags }) => {
    const f = await fixture(staged + `
      const { getHeapStatistics } = await import('node:v8');
      await writeFile(flag('--runtime-observation'), JSON.stringify({
        execArgv: process.execArgv, heap: getHeapStatistics().heap_size_limit,
      }));
    `);
    const observation = join(f.directory, 'runtime.json');
    const previous = process.execArgv;
    try {
      process.execArgv = ['--eval', "throw new Error('parent program must not execute in child')",
        ...heapFlags, '--report-on-fatalerror'];
      await exportRetainedIsolated([...f.args, '--runtime-observation', observation], { entry: f.entry });
    } finally { process.execArgv = previous; }
    const runtime = JSON.parse(await readFile(observation, 'utf8'));
    expect(runtime.execArgv).toEqual([...heapFlags, '--report-on-fatalerror',
      ...(process.versions.node.startsWith('24.') ? ['--no-wasm-code-gc'] : [])]);
    expect(runtime.heap).toBeLessThan(512 * 1024 * 1024);
    expect(await readFile(f.obj, 'utf8')).toBe('complete obj\n');
  },
);


it.each(['20.6.0', '22.23.0', '24.22.0', '26.10.0'])(
  '#8868 scopes the V8 workaround to Node 24 (%s)', version => {
    expect(childRuntimeArgs(['--wasm-code-gc', '--max-old-space-size=256'], version))
      .toEqual(['--max-old-space-size=256', ...(version.startsWith('24.') ? ['--no-wasm-code-gc'] : [])]);
  });

it('#8868 retained child starts a real worker with inherited runtime flags', async () => {
  const f = await fixture(`
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(\`
      const { parentPort } = require('node:worker_threads');
      WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(module => {
        parentPort.postMessage({ valid: module instanceof WebAssembly.Module, flags: process.execArgv });
      });
    \`, { eval: true });
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    await writeFile(flag('--out'), JSON.stringify(result));
    await writeFile(flag('--retained-report'), 'worker started');
  `);
  await exportRetainedIsolated(f.args, { entry: f.entry });
  const result = JSON.parse(await readFile(f.obj, 'utf8'));
  expect(result.valid).toBe(true);
  expect(result.flags.includes('--no-wasm-code-gc')).toBe(process.versions.node.startsWith('24.'));
});
