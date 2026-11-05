// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportRetainedIsolated, RetainedProcessError } from './process.js';
import { logger } from '../logger.js';

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

it.each(['exit', 'signal'])('#8868 %s after staging cannot overwrite destinations or publish stdout', async (kind, context) => {
  if (kind === 'signal' && process.platform === 'win32') return context.skip();
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

it.each([false, true])('#8868 cancellation wins and reaps the child (ignore SIGTERM: %s)', async ignoresSignal => {
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
