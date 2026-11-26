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
import type { CallToolResult, ToolScope } from '../protocol/index.js';
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
  try {
    if (ctx) for (const model of ctx.registry.list()) ctx.registry.remove(model.id);
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
});

type ScriptTool = 'script_run' | 'script_run_mutate';

async function callScript(name: ScriptTool, args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult> {
  const tool = buildDefaultToolRegistry().get(name);
  if (!tool) throw new Error(`Expected MCP registry to provide ${name}`);
  return tool.handler(args, context);
}

async function run(code: string, extra: Record<string, unknown> = {}, tool: ScriptTool = 'script_run'): Promise<CallToolResult> {
  return callScript(tool, { code, ...extra }, ctx);
}

/** mutation_diff's structured result: the model's pending edits. */
async function pendingEdits(): Promise<{ count: number; mutations: unknown[] }> {
  return (await buildDefaultToolRegistry().get('mutation_diff')!.handler({}, ctx)).structuredContent as { count: number; mutations: unknown[] };
}

/** The captured log lines' text, [] when there are none. */
function logTexts(result: CallToolResult): string[] {
  return ((result.structuredContent?.logs ?? []) as Array<{ text: string }>).map((l) => l.text);
}

async function runError(code: string, extra: Record<string, unknown> = {}, tool: ScriptTool = 'script_run') {
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
    expect(err.hint).toMatch(/timeout_ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails cleanly when the script exceeds memory_mb, and the next call still works', async () => {
    // Big chunks and the full time limit, so a loaded machine still runs out of
    // memory before it runs out of time.
    const err = await runError(`const a = []; for (;;) a.push(new Array(1 << 20).fill(1.5));`, { memory_mb: 8, timeout_ms: 30_000 });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/memory/i);
    expect(err.hint).toMatch(/memory_mb/);
    expect((await run('1 + 1')).structuredContent?.value).toBe(2);
  }, 60_000);

  it('truncates an oversized value instead of returning it', async () => {
    const result = await run(`'x'.repeat(300 * 1024)`);
    expect(result.structuredContent).toMatchObject({ value: null, value_truncated: true });
    const preview = result.structuredContent?.value_preview;
    expect(preview).toMatch(/^"x{1,1999}$/);
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
      '(async () => { await Promise.resolve(); const a = []; for (;;) a.push(new Array(1 << 20).fill(1)); })()',
      { memory_mb: 8, timeout_ms: 30_000 },
    );
    expect(err.code).toBe('INVALID_INPUT');
    expect((await run('2 + 2')).structuredContent?.value).toBe(4);
  }, 60_000);

  it('cannot reshape its result envelope through prototype patches', async () => {
    const result = await run("Object.prototype.toJSON = function () { return { type: 'pending' }; }; String.prototype.toJSON = null; 'ok'");
    expect(result.structuredContent?.value).toBe('ok');
  });

  it('puts the serialised result in the text block for content-only clients', async () => {
    const result = await run("console.log('hi'); bim.query.byType('IfcWall').length");
    const last = result.content[result.content.length - 1] as { text: string };
    expect(JSON.parse(last.text)).toMatchObject({ value: 2, logs: [{ text: 'hi' }] });
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
    const logs = logTexts(result);
    expect(result.structuredContent?.logs_truncated).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0].length).toBe(64 * 1024);
  });

  it('honours a cancel that lands while the sandbox is being created', async () => {
    const ctl = new AbortController();
    const pending = callScript('script_run', { code: 'for (;;) {}' }, { ...ctx, signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', details: { mutations_queued: 0, logs: [] } });
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
    const oversized = await runError("const p = Promise.resolve(1); Object.defineProperty(p, 'constructor', { get() { throw 'x'.repeat(500000); } }); p");
    expect(oversized.message.length).toBeLessThan(4_100);
    const boundary = await runError("throw new Error('a'.repeat(3999) + '\\u{1F600}')");
    expect(boundary.message).toBe(`Script error: ${'a'.repeat(3999)} [truncated]`);
    expect((await run("Object.defineProperty(Promise, Symbol.hasInstance, { value() { return false; } }); (async () => 7)()")).structuredContent?.value).toBe(7);
    expect((await run("Object.defineProperty(Promise, Symbol.hasInstance, { value() { throw 'y'; } }); 1")).structuredContent?.value).toBe(1);
  });

  it('cuts a huge thrown message inside the sandbox', async () => {
    const err = await runError("throw 'x'.repeat(5e6)", { memory_mb: 64 });
    expect(err.message.length).toBeLessThan(4_100);
    expect(err.message.endsWith('[truncated]')).toBe(true);
  });

  it('refuses a deeply nested value instead of overflowing the host stack', async () => {
    const deep = 'var o = {}, c = o; for (var i = 0; i < 5000; i++) { c.a = {}; c = c.a; }';
    expect((await runError(`${deep} o`)).message).toMatch(/nested deeper than 1000 levels/);
    expect((await runError(`${deep} (async () => o)()`)).message).toMatch(/nested deeper than 1000 levels/);
    expect((await run('var o = {}, c = o; for (var i = 0; i < 500; i++) { c.a = {}; c = c.a; } o')).structuredContent?.value_truncated).toBe(false);
    expect((await run('7 + 7')).structuredContent?.value).toBe(14);
  });

  it('serialises values and log arguments itself, so depth tricks stay in the realm', async () => {
    const deep = 'let o = {}; for (let i = 0; i < 5000; i++) o = { a: o };';
    expect((await runError(`({ toJSON() { ${deep} return o; } })`)).message).toMatch(/nested deeper than 1000 levels/);
    // Read once: the getter's second, deep answer is never asked for.
    expect((await run(`let n = 0; ({ get x() { ${deep} return n++ ? o : 1; } })`)).structuredContent?.value).toEqual({ x: 1 });
    const logged = await run(`${deep} console.log(o); 1`);
    expect(logged.structuredContent?.value).toBe(1);
    expect(logTexts(logged)[0]).toMatch(/unserialisable: the value is nested deeper/);
    expect((await run('8 + 8')).structuredContent?.value).toBe(16);
  });

  it('logs errors and BigInts readably and names a cycle as one', async () => {
    const result = await run("console.error(new TypeError('boom')); console.log(10n); 1");
    const logs = logTexts(result);
    expect(logs[0]).toMatch(/^TypeError: boom/);
    expect(logs[1]).toBe('10n');
    expect((await runError("const a = { pad: 'y'.repeat(1000) }; a.self = a; a")).message).toMatch(/not JSON-serialisable: TypeError: the value is cyclic/);
    expect((await run("const f = () => 1; f.toJSON = () => 'fn'; ({ f })")).structuredContent?.value).toEqual({ f: 'fn' });
  });

  it('unwraps boxed primitives and keeps numbers and nested errors readable in logs', async () => {
    expect((await run("({ s: new String('ab'), n: new Number(5), b: new Boolean(false) })")).structuredContent?.value).toEqual({ s: 'ab', n: 5, b: false });
    expect((await run('class Qty extends Number {} new Qty(5)')).structuredContent?.value).toBe(5);
    expect((await run('class Box { constructor() { this.a = 1; } } new Box()')).structuredContent?.value).toEqual({ a: 1 });
    const result = await run("console.log(1 / 0, 0 / 0); console.log({ err: new Error('boom') }); console.error(new Error('x'.repeat(10000))); 1");
    const logs = logTexts(result);
    expect(logs[0]).toBe('Infinity NaN');
    expect(logTexts(await run('console.log(new Date(0)); 1'))[0]).toBe('1970-01-01T00:00:00.000Z');
    expect(logs[1]).toBe('{"err":"boom"}');
    expect(logTexts(await run("console.log({ id: 12n }); 1"))[0]).toBe('{"id":"12n"}');
    expect(logTexts(await run("console.log({ n: Object(5n) }); 1"))[0]).toBe('{"n":"5n"}');
    expect(logs[2].split('\n')[0].endsWith('[truncated]')).toBe(true);
    expect((await runError("throw new Error('out of memory')")).hint).toBeUndefined();
  });

  it('matches native JSON for the shapes it supports', async () => {
    const result = await run(`({ a: [1, undefined, () => 1, 'x'], b: undefined, c: { toJSON() { return 'tj'; } }, d: NaN, e: null, f: [[]], g: {} })`);
    expect(result.structuredContent?.value).toEqual({ a: [1, null, null, 'x'], c: 'tj', d: null, e: null, f: [[]], g: {} });
  });

  it('judges size by the JSON it writes and previews a real JSON prefix', async () => {
    expect((await run("const o = {}; for (let i = 0; i < 300000; i++) o['k' + i] = undefined; o")).structuredContent).toMatchObject({ value: {}, value_truncated: false });
    const big = await run('Array.from({ length: 300000 }, (_, i) => ({ i }))');
    expect(big.structuredContent?.value_truncated).toBe(true);
    expect(String(big.structuredContent?.value_preview).startsWith('[{"i":0},{"i":1}')).toBe(true);
    const keyed = await run("({ ['k'.repeat(300000)]: 1 })");
    expect(String(keyed.structuredContent?.value_preview).startsWith('{"kkk')).toBe(true);
  });

  it('gives no hint to a thrown InternalError look-alike, and lets a script reassign console', async () => {
    expect((await runError("throw { name: 'InternalError', message: 'out of memory' }")).hint).toBeUndefined();
    expect((await runError("throw new Error('InternalError: out of memory')")).hint).toBeUndefined();
    expect((await runError("throw 'InternalError: stack overflow'")).hint).toBeUndefined();
    expect((await runError("throw new Proxy({}, { getPrototypeOf() { throw new Error('interrupted'); } })")).code).toBe('INVALID_INPUT');
    expect((await run('typeof InternalError')).structuredContent?.value).toBe('undefined');
    expect((await run("new Proxy({ a: 1 }, { getPrototypeOf() { throw new Error('x'); } })")).structuredContent?.value).toEqual({ a: 1 });
    // Global scope, as in the other sandbox hosts.
    expect((await run('var g = 5; globalThis.g')).structuredContent?.value).toBe(5);
    expect((await run('typeof arguments')).structuredContent?.value).toBe('undefined');
    expect(logTexts(await run("'use strict'; console.debug = console.log; console.debug('x'); 1"))).toEqual(['x']);
    expect((await run('Object.prototype.toString.call(JSON)')).structuredContent?.value).toBe('[object JSON]');
    expect((await run("[String(JSON), bim.query.byType.name, bim.query.hasOwnProperty('byType')]")).structuredContent?.value).toEqual(['[object JSON]', 'byType', true]);
    const stack = logTexts(await run("console.log(new Error('boom')); 1"))[0];
    expect(stack).toMatch(/^boom/);
    expect(stack).not.toMatch(/internal-script-wrapper|eval \(native\)/);
    const huge = await run("({ a: 'x'.repeat(2e7) })", { memory_mb: 128 });
    expect(huge.structuredContent).toMatchObject({ value_truncated: true });
  });

  it('gives no memory hint for a script that merely says out of memory', async () => {
    expect((await runError("throw new Error('device out of memory budget')")).hint).toBeUndefined();
  });

  it('gives the script a depth-checked JSON', async () => {
    const deep = 'var o = {}, c = o; for (var i = 0; i < 20000; i++) { c.a = {}; c = c.a; }';
    expect((await run(`${deep} try { JSON.stringify(o); 'no' } catch (e) { e.message }`)).structuredContent?.value).toMatch(/nested deeper than 1000 levels/);
    expect((await run("try { JSON.parse('['.repeat(50000) + ']'.repeat(50000)); 'no' } catch (e) { e.name }")).structuredContent?.value).toBe('SyntaxError');
    expect((await run("JSON.stringify({ a: [1, { b: 2 }] }, null, 1)")).structuredContent?.value).toBe(JSON.stringify({ a: [1, { b: 2 }] }, null, 1));
    expect((await run("JSON.parse('{\"a\":[1,\"]\"]}', (k, v) => (k === '0' ? 9 : v))")).structuredContent?.value).toEqual({ a: [9, ']'] });
    // Replacer and indent follow native JSON, and a replacer's return value is walked too.
    for (const code of [
      "JSON.stringify({ a: 1n }, (k, v) => (typeof v === 'bigint' ? String(v) : v))",
      "JSON.stringify({ m: new Map([[1, 2]]) }, (k, v) => (v instanceof Map ? [...v] : v))",
      "JSON.stringify({ a: undefined, b: [undefined] }, (k, v) => (v === undefined ? 'U' : v))",
      "JSON.stringify({ a: 1, b: 2, c: { a: 3, d: 4 } }, ['a', 'c'], 2)",
      "JSON.stringify([[], {}, [1, [2]], { x: { y: 1 } }], null, '--')",
      "JSON.stringify({ d: new Date(0), n: new Number(3) }, null, 4)",
    ]) {
      // eslint-disable-next-line no-eval -- the native reference result for the same expression
      expect((await run(code)).structuredContent?.value).toBe(eval(code));
    }
    expect((await run(`${deep} try { JSON.stringify(1, (k, v) => (k === '' ? o : v)); 'no' } catch (e) { e.message }`)).structuredContent?.value).toMatch(/nested deeper than 1000 levels/);
    expect((await run('var a = [{ toJSON() { a.push(a[0]); return 1; } }]; JSON.stringify(a)')).structuredContent?.value).toBe('[1]');
    // A BigInt toJSON that returns a BigInt first cannot get a deep value past the check on its second call.
    expect((await run(`${deep} var calls = 0; BigInt.prototype.toJSON = () => (++calls === 1 ? 1n : o); try { JSON.stringify(1n); 'no' } catch (e) { e.name + ' ' + calls }`)).structuredContent?.value).toBe('TypeError 1');
    expect((await run('JSON.stringify(new Proxy([1, 2, 3], { get: (t, k) => (k === "length" ? 1.5 : t[k]) }))')).structuredContent?.value).toBe('[1]');
    expect((await run("new String('x'.repeat(400000))")).structuredContent?.value_truncated).toBe(true);
    expect((await run('typeof bim.lens')).structuredContent?.value).toBe('undefined');
    // A deep bim argument is refused in the realm instead of overflowing the bridge's dump.
    expect((await run(`${deep} try { bim.cost.evaluateItem(o); 'no' } catch (e) { e.message }`)).structuredContent?.value).toMatch(/^bim\.cost\.evaluateItem: .*nested deeper than 1000 levels/);
    expect((await run("bim.query.byType('IfcWall').length")).structuredContent?.value).toBe(2);
    // A string argument keeps its toString coercion: only dumped positions are bounded.
    expect((await run("bim.query.byType({ toString() { return 'IfcWall'; } }).length")).structuredContent?.value).toBe(2);
    expect((await run('9 + 9')).structuredContent?.value).toBe(18);
  });

  it('keeps recursion through QuickJS natives inside the realm', async () => {
    for (const code of [
      'const o = { toString() { return String(o); } }; String(o)',
      'const o = { get x() { return o.x; } }; o.x',
    ]) {
      const err = await runError(code);
      expect(err.message).toMatch(/stack overflow/);
      expect(err.hint).toMatch(/recursed too deep/);
    }
    const printing = await runError('const e = { get message() { const f = () => f(); return f(); } }; throw e;');
    expect(printing.message).toBe('Script error: stack overflow while printing the error');
    expect((await run('6 + 6')).structuredContent?.value).toBe(12);
  });

  it('reports runaway recursion as a script error and keeps the sandbox healthy', async () => {
    const err = await runError('function f() { return f(); } f()');
    expect(err).toMatchObject({ code: 'INVALID_INPUT', details: { kind: 'script' } });
    expect(err.hint).toMatch(/recursed too deep/);
    expect((await run('5 + 5')).structuredContent?.value).toBe(10);
  });

  it('hints at script_run_mutate for every namespace read mode lacks', async () => {
    expect((await runError("bim.create.project({})")).hint).toMatch(/script_run_mutate/);
  });

  it('keeps the error type and says when a thrown value has no string form', async () => {
    expect((await runError('null.x')).message).toMatch(/^Script error: TypeError: /);
    const err = await runError('throw Object.create(null)');
    expect(err.message).toBe('Script error: a thrown value with no string form');
    expect((await runError("throw ''")).message).toBe('Script error: an empty string was thrown');
    expect(err.hint).toBeUndefined();
  });

  it('tags a script failure apart from bad arguments', async () => {
    expect((await runError("throw new Error('no walls')")).details?.kind).toBe('script');
  });

  it('reports wrapper-clipped logs on successful and failed scripts', async () => {
    const log = "console.log({ blob: 'x'.repeat(100000) }); console.info('after');";
    const result = await run(log);
    expect(result.structuredContent?.logs_truncated).toBe(true);
    const last = result.content.at(-1) as { text: string };
    expect(JSON.parse(last.text)).toMatchObject({ logs_truncated: true });
    expect(logTexts(result)).toEqual([expect.stringMatching(/ \[truncated\]$/), 'after']);
    expect((await runError(log + "throw new Error('stop')")).details).toMatchObject({
      logs_truncated: true,
      logs: [{ text: expect.stringMatching(/ \[truncated\]$/) }, { text: 'after' }],
    });
  });

  it('coerces boxed numbers and strings using native JSON rules', async () => {
    const result = await run(`
      const number = new Number(1);
      number.valueOf = () => 3;
      number.toString = () => 'renamed';
      const string = new String('old');
      string.toString = () => 'new';
      [
        JSON.stringify([number, string]),
        JSON.stringify({ old: 1, new: 2, renamed: 3 }, [string, number]),
        JSON.stringify({ a: 1 }, null, number),
        JSON.stringify({ a: 1 }, null, string),
      ];
    `);
    expect(result.structuredContent?.value).toEqual([
      '[3,"new"]',
      '{"new":2,"renamed":3}',
      '{\n   "a": 1\n}',
      '{\nnew"a": 1\n}',
    ]);
  });

  it('serializes bridge arguments once and delivers their nested data', async () => {
    const result = await run(`
      let calls = 0;
      const input = { ref: { modelId: 'm', expressId: 72 } };
      Object.defineProperty(Object.prototype, 'toJSON', {
        value() { calls++; return this; },
        configurable: true,
      });
      const attributes = bim.query.attributes(input);
      delete Object.prototype.toJSON;
      ({ calls, hasAttributes: attributes.length > 0 });
    `);
    expect(result.structuredContent?.value).toEqual({ calls: 2, hasAttributes: true });
  });

  it('marks logs truncated when the sandbox itself dropped output', async () => {
    const result = await run("console.log('x'.repeat(5e6)); 1");
    expect(result.structuredContent?.logs_truncated).toBe(true);
  });

  it('does not let a script fake the sandbox truncation marker', async () => {
    const result = await run("console.warn('[log output truncated: limit reached]'); console.log('after'); 1");
    expect(result.structuredContent).toMatchObject({ logs_truncated: false });
    expect(logTexts(result)).toHaveLength(2);
  });

  it('caps concurrent scripts per session and per process, and frees the slots', async () => {
    // The slot is taken before the handler's first await, so calls started
    // together overlap even with trivial scripts.
    const as = (id: string) => ({ ...ctx, session: { id } });
    const rateLimited = (r: PromiseSettledResult<unknown>) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'RATE_LIMITED';
    const values = (batch: PromiseSettledResult<CallToolResult>[]) =>
      batch.flatMap((r) => r.status === 'fulfilled' ? [r.value.structuredContent?.value] : []);
    const sameSession = await Promise.allSettled([run('1'), run('2')]);
    expect(sameSession.filter(rateLimited)).toHaveLength(1);
    expect(values(sameSession)).toEqual([1]);
    const settled = await Promise.allSettled(['a', 'b', 'c'].map((id) => callScript('script_run', { code: '1' }, as(id))));
    expect(settled.filter(rateLimited)).toHaveLength(1);
    expect(values(settled)).toEqual([1, 1]);
    // Two servers in one process (no session id) each get their own slot.
    const other = { ...ctx, registry: new InMemoryModelRegistry(), session: undefined };
    other.registry.add(ctx.registry.get('m')!);
    const servers = await Promise.allSettled([run('1'), callScript('script_run', { code: '2' }, other)]);
    expect(values(servers)).toEqual([1, 2]);
    expect((await run('4')).structuredContent?.value).toBe(4);
  }, 30_000);

  it('refuses out-of-range limits', async () => {
    await expect(run('1', { timeout_ms: 10 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run('1', { memory_mb: 4096 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('honours a cancelled request', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(callScript('script_run', { code: '1' }, { ...ctx, signal: ctl.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('script_run_mutate', () => {
  it('queues edits through the shared mutation view', async () => {
    const result = await run(`
      const wall = bim.query.byType('IfcWall')[0];
      bim.mutate.setProperty(wall, 'Pset_WallCommon', 'IsExternal', true);
      bim.mutate.setAttribute(wall, 'Name', 'Renamed');
      bim.query.byType('IfcWall').map((w) => w.Name).sort();
    `, {}, 'script_run_mutate');
    expect(result.structuredContent).toMatchObject({ mode: 'mutate', value: ['Renamed', 'Wall B'], mutations_queued: 2 });
    const diff = await pendingEdits();
    expect(diff.count).toBe(2);
    expect(diff.mutations).toContainEqual(expect.objectContaining({
      psetName: 'Pset_WallCommon', propName: 'IsExternal', newValue: true,
    }));
  });
});

describe('script_run_mutate on timeout', () => {
  it('says how many edits stayed queued', async () => {
    const err = await runError(`
      bim.mutate.setAttribute(bim.query.byType('IfcDoor')[0], 'Name', 'Edited');
      for (;;) {}
    `, { timeout_ms: 200 }, 'script_run_mutate');
    expect(err.code).toBe('TIMEOUT');
    expect(err.details?.mutations_queued).toBe(1);
  });
});

describe('script_run_mutate on a script error', () => {
  it('says how many edits stayed queued before the throw', async () => {
    const err = await runError(`
      bim.mutate.setAttribute(bim.query.byType('IfcDoor')[0], 'Description', 'Edited');
      throw new Error('stop');
    `, {}, 'script_run_mutate');
    expect(err).toMatchObject({ code: 'INVALID_INPUT', message: 'Script error: stop', details: { mutations_queued: 1 } });
  });
});

describe('script_run_mutate after undo', () => {
  it('still counts the edit (headless undo reverts nothing)', async () => {
    const before = (await pendingEdits()).count;
    const result = await run(`
      bim.mutate.setAttribute(bim.query.byType('IfcDoor')[0], 'Tag', 'Now');
      bim.mutate.undo('m')
    `, {}, 'script_run_mutate');
    expect(result.structuredContent).toMatchObject({ mutations_queued: 1 });
    expect((await pendingEdits()).count).toBe(before + 1);
  });
});

describe('script_run_mutate when the model is unloaded mid-run', () => {
  it('drops the count and the persist advice', async () => {
    const model = ctx.registry.get('m')!;
    const unloading = { ...ctx, registry: new InMemoryModelRegistry() };
    // Resolves the model for the call (no model_id: resolve()), but get()
    // already answers as if model_unload had removed it.
    unloading.registry.count = () => 1;
    unloading.registry.get = () => null;
    unloading.registry.resolve = () => model;
    const result = await callScript(
      'script_run_mutate',
      { code: "bim.mutate.setAttribute(bim.query.byType('IfcWall')[1], 'Description', 'gone'); 1" }, unloading,
    );
    expect(result.structuredContent?.mutations_queued).toBeUndefined();
    expect((result.content[0] as { text: string }).text).not.toMatch(/persist/);
  });
});

describe('script_run_mutate scope', () => {
  it('needs read, and grants bim.export only with the export scope', async () => {
    const mutateOnly = { ...ctx, scope: { scopes: ['mutate'] as ToolScope[] } };
    await expect(callScript('script_run_mutate', { code: '1' }, mutateOnly)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const noExport = { ...ctx, scope: { scopes: ['read', 'mutate'] as ToolScope[] } };
    const result = await callScript('script_run_mutate', { code: '[typeof bim.export, typeof bim.mutate]' }, noExport);
    expect(result.structuredContent?.value).toEqual(['undefined', 'object']);
    await expect(callScript('script_run_mutate', { code: 'bim.export.csv([], [])' }, noExport)).rejects.toMatchObject({ hint: expect.stringMatching(/export scope/) });
  });
});

describe('script_run under --read-only', () => {
  it.each([
    { scope: readOnlyScope(), code: 'PERMISSION_DENIED' },
    { scope: fullScope(), code: 'READ_ONLY' },
  ])('hides and refuses script_run_mutate under read-only config ($code)', async ({ scope, code }) => {
    const server = new MCPServer({
      // The pairing the CLI builds for --read-only (cli.ts).
      version: '0.0.0-test', registry: ctx.registry, scope,
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
    expect(JSON.parse(texts[texts.length - 1])).toMatchObject({ code });
    const failed = await transport.send({
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'script_run', arguments: { code: 'throw new Error("x")' } },
    }) as { result: { isError: boolean; structuredContent?: unknown; content: Array<{ text: string }> } };
    expect(failed.result.structuredContent).toBeUndefined();
    expect(JSON.parse(failed.result.content[failed.result.content.length - 1].text)).toMatchObject({ code: 'INVALID_INPUT', message: 'Script error: x' });
  });
});
