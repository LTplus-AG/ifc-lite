/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * script_run / script_run_mutate (MCP overhaul P5a): sandboxed SDK scripts.
 * The security claims are tested as behaviour: the read tool has no write
 * namespaces, neither tool reaches network/files/host globals, the limits
 * stop a runaway script, and --read-only hides the mutate tool.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import {
  DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext,
} from '../context.js';
import { fullScope, readOnlyScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { MCPServer } from '../server.js';
import { InProcessTransport } from '../transport/in-process.js';
import { ResourceRegistry } from '../resources/index.js';
import { PromptRegistry } from '../prompts/index.js';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import { buildDefaultToolRegistry } from './index.js';
import { scriptRunMutateTool, scriptRunTool } from './script-run.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0000PROJ00000000000000',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#72= IFCWALL('0000WALA00000000000000',$,'Wall A',$,$,#40,$,$,$);
#73= IFCWALL('0000WALB00000000000000',$,'Wall B',$,$,#40,$,$,$);
#74= IFCDOOR('0000DOOR00000000000000',$,'Door',$,$,#40,$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let ctx: ToolContext;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mcp-script-run-'));
  const path = join(tmp, 'm.ifc');
  await writeFile(path, IFC, 'utf-8');
  const registry = new InMemoryModelRegistry();
  registry.add(await loadIfcModel(path, { modelId: 'm' }));
  ctx = {
    registry, scope: fullScope(), progress: NOOP_PROGRESS, log: SILENT_LOGGER,
    signal: new AbortController().signal, config: { ...DEFAULT_CONFIG },
  };
});

afterAll(async () => {
  for (const model of ctx.registry.list()) ctx.registry.remove(model.id);
  await rm(tmp, { recursive: true, force: true });
});

async function run(code: string, extra: Record<string, unknown> = {}, tool = scriptRunTool): Promise<CallToolResult> {
  return tool.handler({ code, ...extra }, ctx);
}

async function runError(code: string, extra: Record<string, unknown> = {}, tool = scriptRunTool) {
  const err = await run(code, extra, tool).then(
    () => { throw new Error('expected the script to fail'); },
    (e: unknown) => e as { code: string; message: string; details?: Record<string, unknown>; hint?: string },
  );
  return err;
}

describe('script_run', () => {
  it('is registered with read and mutate variants', () => {
    const registry = buildDefaultToolRegistry();
    expect(registry.get('script_run')?.scope).toBe('read');
    expect(registry.get('script_run_mutate')?.scope).toBe('mutate');
    expect(registry.get('script_run')?.outputSchema).toBeDefined();
  });

  it('returns the last expression and captured console output', async () => {
    const result = await run(`
      const walls = bim.query.byType('IfcWall');
      console.log('walls', walls.length);
      walls.map((w) => w.Name).sort();
    `);
    expect(result.structuredContent).toMatchObject({
      model_id: 'm', mode: 'read', value: ['Wall A', 'Wall B'], value_truncated: false,
      logs: [{ level: 'log', text: 'walls 2' }], mutations_queued: 0,
    });
  });

  it('has no write namespaces in read mode and queues nothing', async () => {
    const result = await run('[typeof bim.mutate, typeof bim.store, typeof bim.create, typeof bim.export, typeof bim.query]');
    expect(result.structuredContent?.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'object']);
    const err = await runError(`bim.mutate.setAttribute(bim.query.byType('IfcWall')[0], 'Name', 'x')`);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.hint).toMatch(/script_run_mutate/);
    expect(err.details?.mutations_queued).toBe(0);
  });

  it('exposes no network, files, viewer, timers or host globals', async () => {
    const result = await run(`[typeof bim.network, typeof bim.files, typeof bim.viewer, typeof fetch,
      typeof require, typeof process, typeof setTimeout, typeof globalThis.Deno]`);
    expect(result.structuredContent?.value).toEqual(Array(8).fill('undefined'));
  });

  it('cannot reach the host realm through a Function constructor', async () => {
    const result = await run(`[
      (function () {}).constructor('return typeof process')(),
      bim.query.byType.constructor('return typeof require')(),
    ]`);
    expect(result.structuredContent?.value).toEqual(['undefined', 'undefined']);
  });

  it('interrupts an endless loop at timeout_ms', async () => {
    const started = Date.now();
    const err = await runError('for (;;) {}', { timeout_ms: 200 });
    expect(err.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails cleanly when the script exceeds memory_mb, and the next call still works', async () => {
    const err = await runError(`const a = []; for (;;) a.push(new Array(1 << 16).fill(1.5));`, { memory_mb: 8, timeout_ms: 10_000 });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/memory/i);
    expect(err.hint).toMatch(/memory_mb/);
    expect((await run('1 + 1')).structuredContent?.value).toBe(2);
  }, 30_000);

  it('truncates an oversized value instead of returning it', async () => {
    const result = await run(`'x'.repeat(300 * 1024)`);
    expect(result.structuredContent).toMatchObject({ value: null, value_truncated: true });
    expect(String(result.structuredContent?.value_preview).length).toBeLessThanOrEqual(2_000);
  });

  it('returns the resolved value of a returned promise', async () => {
    expect((await run('(async () => 7)()')).structuredContent?.value).toBe(7);
    expect((await run("({ type: 'fulfilled', value: 3 })")).structuredContent?.value).toEqual({ type: 'fulfilled', value: 3 });
    await expect(run('new Promise(() => {})')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/never settled/) });
    await expect(run("(async () => { throw new Error('boom') })()")).rejects.toMatchObject({ message: expect.stringMatching(/boom/) });
  });

  it('reports a non-JSON value as a script error with its logs', async () => {
    const err = await runError("console.log('before'); 1n");
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/not JSON-serialisable/);
    expect(err.details?.logs).toEqual([{ level: 'log', text: 'before' }]);
  });

  it('reports a cyclic value and keeps logs from a script that throws', async () => {
    expect((await runError('const a = {}; a.self = a; a')).message).toMatch(/not JSON-serialisable/);
    const err = await runError("console.log('step 1'); throw new Error('bad input')");
    expect(err.message).toBe('Script error: bad input');
    expect(err.details?.logs).toEqual([{ level: 'log', text: 'step 1' }]);
  });

  it('keeps its result wrapper out of the script\'s reach', async () => {
    expect((await run('function env(x) { return 1; } 42')).structuredContent?.value).toBe(42);
    expect((await run('env = 1; msg = 2; 43')).structuredContent?.value).toBe(43);
    expect((await run('Promise = null; JSON.stringify = null; 44')).structuredContent?.value).toBe(44);
    expect((await runError('var fail = 0; throw new Error("boom")')).message).toBe('Script error: boom');
    expect((await runError('function msg() { return "x"; } throw new Error("real")')).message).toBe('Script error: real');
  });

  it('maps an out-of-memory inside an async job to a script error', async () => {
    const err = await runError(
      '(async () => { await Promise.resolve(); const a = []; for (;;) a.push(new Array(1 << 16).fill(1)); })()',
      { memory_mb: 8 },
    );
    expect(err.code).toBe('INVALID_INPUT');
    expect((await run('2 + 2')).structuredContent?.value).toBe(4);
  }, 30_000);

  it('cannot reshape its result envelope through prototype patches', async () => {
    const result = await run("Object.prototype.toJSON = function () { return { type: 'pending' }; }; String.prototype.toJSON = null; 'ok'");
    expect(result.structuredContent?.value).toBe('ok');
  });

  it('puts the serialised result in the text block for content-only clients', async () => {
    const result = await run("console.log('hi'); bim.query.byType('IfcWall').length");
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toMatchObject({ value: 2, logs: [{ text: 'hi' }] });
  });

  it('flags truncated logs on an error result', async () => {
    const err = await runError("for (let i = 0; i < 300; i++) console.log(i); throw new Error('x')");
    expect(err.details).toMatchObject({ logs_truncated: true });
    expect(err.details?.logs).toHaveLength(200);
  });

  it('does not let a script fake a timeout', async () => {
    expect((await runError("throw new Error('interrupted')")).code).toBe('INVALID_INPUT');
    const flipping = "let n = 0; const e = { get message() { return n++ === 0 ? 'x' : { toString() { throw new Error('interrupted'); } }; } }; throw e;";
    expect((await runError(flipping)).code).toBe('INVALID_INPUT');
    expect((await runError(`(async () => { ${flipping} })()`)).code).toBe('INVALID_INPUT');
  });

  it('gives a never-settled promise no memory hint', async () => {
    expect((await runError('new Promise(() => {})')).hint).toBeUndefined();
  });

  it('clips an oversized log line instead of dropping it', async () => {
    const result = await run("console.log('a'.repeat(70000)); console.log('small'); 1");
    const logs = result.structuredContent?.logs as Array<{ text: string }>;
    expect(result.structuredContent?.logs_truncated).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0].text.length).toBe(64 * 1024);
  });

  it('honours a cancel that lands while the sandbox is being created', async () => {
    const ctl = new AbortController();
    const pending = scriptRunTool.handler({ code: 'for (;;) {}' }, { ...ctx, signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('never ends a truncated preview on half a surrogate pair', async () => {
    const result = await run("'a'.repeat(1998) + '\\u{1F600}'.repeat(200000)");
    const preview = String(result.structuredContent?.value_preview);
    expect(preview.length).toBe(1999);
    expect(/[\uD800-\uDBFF]$/.test(preview)).toBe(false);
  });

  it('keeps the value cap when the script patches call, slice or species', async () => {
    const big = "JSON.stringify('x'.repeat(400000))";
    for (const code of [
      `Function.prototype.call = function () { return 'J' + ${big}; }; Promise.resolve(1)`,
      `String.prototype.slice = function () { return ${big}; }; 'y'.repeat(300000)`,
      `class Evil extends Promise { static get [Symbol.species]() { return function (ex) { ex(() => {}, () => {}); return 'J' + ${big}; }; } }; Evil.resolve(1)`,
    ]) {
      const result = await run(code);
      expect(JSON.stringify(result.structuredContent).length).toBeLessThan(10_000);
    }
  });

  it('bounds error messages a script controls, and sees through a patched hasInstance', async () => {
    for (const code of [
      "const p = Promise.resolve(1); Object.defineProperty(p, 'constructor', { get() { throw 'x'.repeat(500000); } }); p",
      "throw new Error('a'.repeat(3999) + '\\u{1F600}')",
    ]) {
      const err = await runError(code);
      expect(err.message.length).toBeLessThan(4_100);
      expect(/[\uD800-\uDBFF]$/.test(err.message)).toBe(false);
    }
    expect((await run("Object.defineProperty(Promise, Symbol.hasInstance, { value() { return false; } }); (async () => 7)()")).structuredContent?.value).toBe(7);
    expect((await run("Object.defineProperty(Promise, Symbol.hasInstance, { value() { throw 'y'; } }); 1")).structuredContent?.value).toBe(1);
  });

  it('cuts a huge thrown message inside the sandbox', async () => {
    const err = await runError("throw 'x'.repeat(5e6)", { memory_mb: 64 });
    expect(err.message.length).toBeLessThan(4_100);
    expect(err.message.endsWith('[truncated]')).toBe(true);
  });

  it('reports runaway recursion as a script error and keeps the sandbox healthy', async () => {
    const err = await runError('function f() { return f(); } f()');
    expect(err).toMatchObject({ code: 'INVALID_INPUT', details: { kind: 'script' } });
    expect(err.hint).toMatch(/recursed/);
    expect((await run('5 + 5')).structuredContent?.value).toBe(10);
  });

  it('tags a script failure apart from bad arguments', async () => {
    expect((await runError("throw new Error('no walls')")).details?.kind).toBe('script');
  });

  it('marks logs truncated when the sandbox itself dropped output', async () => {
    const result = await run("console.log('x'.repeat(5e6)); 1");
    expect(result.structuredContent?.logs_truncated).toBe(true);
  });

  it('does not let a script fake the sandbox truncation marker', async () => {
    const result = await run("console.warn('[log output truncated: limit reached]'); console.log('after'); 1");
    expect(result.structuredContent).toMatchObject({ logs_truncated: false });
    expect((result.structuredContent?.logs as unknown[]).length).toBe(2);
  });

  it('caps concurrent scripts and frees the slot afterwards', async () => {
    // The slot is taken before the handler's first await, so three calls
    // started together overlap even with trivial scripts.
    const calls = [run('1'), run('2'), run('3')];
    const settled = await Promise.allSettled(calls);
    expect(settled.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'RATE_LIMITED')).toHaveLength(1);
    expect((await run('4')).structuredContent?.value).toBe(4);
  }, 30_000);

  it('refuses out-of-range limits', async () => {
    await expect(run('1', { timeout_ms: 10 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run('1', { memory_mb: 4096 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('honours a cancelled request', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(scriptRunTool.handler({ code: '1' }, { ...ctx, signal: ctl.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('script_run_mutate', () => {
  it('queues edits through the shared mutation view', async () => {
    const result = await run(`
      const wall = bim.query.byType('IfcWall')[0];
      bim.mutate.setProperty(wall, 'Pset_WallCommon', 'IsExternal', true);
      bim.mutate.setAttribute(wall, 'Name', 'Renamed');
      bim.query.byType('IfcWall').map((w) => w.Name).sort();
    `, {}, scriptRunMutateTool);
    expect(result.structuredContent).toMatchObject({ mode: 'mutate', value: ['Renamed', 'Wall B'], mutations_queued: 2 });
    const diff = await buildDefaultToolRegistry().get('mutation_diff')!.handler({}, ctx);
    expect(diff.structuredContent?.count).toBe(2);
  });
});

describe('script_run_mutate on timeout', () => {
  it('says how many edits stayed queued', async () => {
    const err = await runError(`
      bim.mutate.setAttribute(bim.query.byType('IfcDoor')[0], 'Name', 'Edited');
      for (;;) {}
    `, { timeout_ms: 200 }, scriptRunMutateTool);
    expect(err.code).toBe('TIMEOUT');
    expect(err.details?.mutations_queued).toBe(1);
  });
});

describe('script_run_mutate on a script error', () => {
  it('says how many edits stayed queued before the throw', async () => {
    const err = await runError(`
      bim.mutate.setAttribute(bim.query.byType('IfcDoor')[0], 'Description', 'Edited');
      throw new Error('stop');
    `, {}, scriptRunMutateTool);
    expect(err).toMatchObject({ code: 'INVALID_INPUT', message: 'Script error: stop', details: { mutations_queued: 1 } });
  });
});

describe('script_run_mutate after undo', () => {
  it('never reports a negative count', async () => {
    const result = await run('bim.mutate.undo("m"); bim.mutate.undo("m"); 1', {}, scriptRunMutateTool);
    expect(result.structuredContent?.mutations_queued).toBe(0);
  });
});

describe('script_run under --read-only', () => {
  it('hides and refuses script_run_mutate but keeps script_run', async () => {
    const server = new MCPServer({
      // The pairing the CLI builds for --read-only (cli.ts).
      version: '0.0.0-test', registry: ctx.registry, scope: readOnlyScope(),
      config: { ...DEFAULT_CONFIG, readOnly: true }, tools: buildDefaultToolRegistry(),
      resources: new ResourceRegistry(), prompts: new PromptRegistry(),
    });
    const transport = new InProcessTransport();
    void transport.connect(server);
    await transport.send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    const list = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string; outputSchema?: unknown }> } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain('script_run');
    expect(names).not.toContain('script_run_mutate');
    expect(list.result.tools.find((t) => t.name === 'script_run')?.outputSchema).toBeDefined();
    const call = await transport.send({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'script_run_mutate', arguments: { code: '1' } },
    }) as { result: { isError: boolean; structuredContent: { code: string } } };
    // Error envelopes leave structuredContent so clients validating it against
    // outputSchema do not reject the error itself; the envelope is in the text.
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent).toBeUndefined();
    const texts = (call.result as unknown as { content: Array<{ text: string }> }).content.map((c) => c.text);
    // readOnlyScope has no mutate, so the scope gate answers before the read-only one.
    expect(JSON.parse(texts[texts.length - 1])).toMatchObject({ code: 'PERMISSION_DENIED' });
    const failed = await transport.send({
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'script_run', arguments: { code: 'throw new Error("x")' } },
    }) as { result: { isError: boolean; structuredContent?: unknown; content: Array<{ text: string }> } };
    expect(failed.result.structuredContent).toBeUndefined();
    expect(JSON.parse(failed.result.content[failed.result.content.length - 1].text)).toMatchObject({ code: 'INVALID_INPUT', message: 'Script error: x' });
  });
});
