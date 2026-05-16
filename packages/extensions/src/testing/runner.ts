/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bundle test runner.
 *
 * Drives the `manifest.tests` array against an activated bundle.
 * For each declared test:
 *
 *   1. Resolve the named command handler from `entry.commands`.
 *   2. Wrap the entry source via `wrapEntrySource`.
 *   3. Inject the test args as a global the wrapped function picks up
 *      (`__ifclite_test_args__`).
 *   4. Run inside the sandbox owned by the supplied `ExtensionRuntime`.
 *   5. Apply `expect` matchers (mimeType / byte range / regex /
 *      jsonShape) to the return value.
 *
 * The runner is host-agnostic: callers plug in an activated
 * `ExtensionRuntime` and a `Bundle`. CLI + viewer both go through
 * this path so behaviour stays identical across surfaces.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §7.
 */

import type {
  Bundle,
  Capability,
  ManifestTest,
  ManifestTestExpect,
} from '../types.js';
import type { ExtensionRuntime } from '../host/runtime.js';
import { wrapEntrySource } from '../host/source-wrap.js';

export interface TestRunResult {
  name: string;
  passed: boolean;
  durationMs: number;
  /** Reason the test failed, or undefined on pass. */
  error?: string;
  /** Sandbox logs captured during the run. */
  logs?: { level: string; message: string }[];
}

export interface TestRunSummary {
  results: TestRunResult[];
  passed: number;
  failed: number;
  totalDurationMs: number;
}

export interface RunBundleTestsOptions {
  runtime: ExtensionRuntime;
  bundle: Bundle;
  grants: readonly Capability[];
  /**
   * Stop on first failure. Default false — running all tests gives
   * the user a fuller picture.
   */
  bail?: boolean;
  /**
   * Resolve the named fixture into a ctx the wrapped entry sees as
   * `__ifclite_ctx__`. Called once per test. If omitted the runner
   * falls back to an empty `{ bim: {} }` stub so library tests can
   * exercise the runner without spinning up a real IfcDataStore.
   *
   * Hosts wire this to whichever fixture loader they ship — the CLI
   * may stream a tests/models/<name>.ifc off disk; the viewer may
   * resolve it from an in-memory fixture map shipped with the app.
   */
  loadFixture?: (name: string) => Promise<unknown>;
}

const DECODER = new TextDecoder();

/**
 * Run every test declared in `bundle.manifest.tests` against the
 * supplied runtime + bundle. Bundles with no tests return a summary
 * with zero results — callers can treat that as "manifest opted out
 * of automated coverage" rather than a failure.
 */
export async function runBundleTests(
  opts: RunBundleTestsOptions,
): Promise<TestRunSummary> {
  const tests = opts.bundle.manifest.tests ?? [];
  const results: TestRunResult[] = [];
  const overallStart = performance.now();

  for (const test of tests) {
    const startedAt = performance.now();
    try {
      await opts.runtime.activate(opts.bundle.manifest.id, opts.grants, opts.bundle);
      const result = await runSingleTest(opts.runtime, opts.bundle, test, opts.loadFixture);
      results.push({
        name: test.name,
        passed: result.passed,
        durationMs: performance.now() - startedAt,
        error: result.error,
        logs: result.logs,
      });
      if (!result.passed && opts.bail) break;
    } catch (err) {
      results.push({
        name: test.name,
        passed: false,
        durationMs: performance.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (opts.bail) break;
    }
  }

  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    totalDurationMs: performance.now() - overallStart,
  };
}

interface SingleResult {
  passed: boolean;
  error?: string;
  logs?: { level: string; message: string }[];
}

async function runSingleTest(
  runtime: ExtensionRuntime,
  bundle: Bundle,
  test: ManifestTest,
  loadFixture?: (name: string) => Promise<unknown>,
): Promise<SingleResult> {
  const entry = bundle.manifest.entry.commands?.[test.command];
  const declared = bundle.manifest.contributes?.commands?.some((c) => c.id === test.command);
  if (!entry || !declared) {
    return { passed: false, error: `Command "${test.command}" not declared / no entry mapping.` };
  }
  const file = bundle.files.get(entry);
  if (!file) {
    return { passed: false, error: `Entry "${entry}" missing from bundle files.` };
  }
  const source = file.text ?? DECODER.decode(file.bytes);
  const wrapped = wrapEntrySource(source, { entryFnName: 'run', filename: entry });
  if (!wrapped.ok) {
    return {
      passed: false,
      error: `Entry did not wrap: ${wrapped.errors[0]?.message ?? 'unknown error'}`,
    };
  }

  const record = runtime.activate
    ? await runtime.activate(bundle.manifest.id, [], bundle).catch(() => undefined)
    : undefined;
  if (!record) {
    return { passed: false, error: 'Runtime did not produce an activation record.' };
  }

  let bim: unknown = {};
  if (loadFixture) {
    try {
      bim = await loadFixture(test.fixture);
    } catch (err) {
      return {
        passed: false,
        error: `Fixture "${test.fixture}" failed to load: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    // The wrapper reads `globalThis.__ifclite_ctx__.bim`. Tests don't
    // need a real BIM — install a stub so the access doesn't throw.
    // Hosts (the viewer) inject the real ctx before each command run.
    await record.sandbox.setGlobal('__ifclite_ctx__', { bim });
    await record.sandbox.setGlobal('__ifclite_test_args__', test.args ?? {});
  } catch (err) {
    return {
      passed: false,
      error: `Failed to inject test args: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const runResult = await record.sandbox.run(wrapped.value, { filename: entry });
  const value = await Promise.resolve(runResult.value);
  const matcher = applyExpectations(value, test.expect);
  return {
    passed: matcher.passed,
    error: matcher.error,
    logs: runResult.logs.map((l) => ({ level: l.level, message: l.message })),
  };
}

/**
 * Apply each declared expectation to the test's return value.
 * Expectations accumulate — every failed matcher is reported in the
 * error string so authors don't have to fix-and-rerun for each one.
 */
function applyExpectations(value: unknown, expect: ManifestTestExpect): SingleResult {
  const reasons: string[] = [];

  if (expect.mimeType !== undefined) {
    const mime = readField(value, 'mimeType');
    if (mime !== expect.mimeType) {
      reasons.push(`mimeType: expected ${expect.mimeType}, got ${formatValue(mime)}`);
    }
  }

  const byteLength = readByteLength(value);
  if (expect.minBytes !== undefined) {
    if (byteLength === undefined) {
      reasons.push(`minBytes: result has no measurable byte length`);
    } else if (byteLength < expect.minBytes) {
      reasons.push(`minBytes: expected >=${expect.minBytes}, got ${byteLength}`);
    }
  }
  if (expect.maxBytes !== undefined) {
    if (byteLength === undefined) {
      reasons.push(`maxBytes: result has no measurable byte length`);
    } else if (byteLength > expect.maxBytes) {
      reasons.push(`maxBytes: expected <=${expect.maxBytes}, got ${byteLength}`);
    }
  }

  if (expect.regex !== undefined) {
    const text = readText(value);
    if (text === undefined) {
      reasons.push(`regex: result has no text representation`);
    } else {
      try {
        const re = new RegExp(expect.regex);
        if (!re.test(text)) {
          reasons.push(`regex: pattern ${expect.regex} did not match`);
        }
      } catch (err) {
        reasons.push(`regex: invalid pattern ${expect.regex}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (expect.jsonShape !== undefined) {
    const mismatch = compareJsonShape(value, expect.jsonShape, '$');
    if (mismatch) {
      reasons.push(`jsonShape: ${mismatch}`);
    }
  }

  if (reasons.length === 0) return { passed: true };
  return { passed: false, error: reasons.join('; ') };
}

function readField(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[field];
}

function readByteLength(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.byteLength === 'number') return obj.byteLength;
  if (obj.bytes instanceof Uint8Array) return obj.bytes.byteLength;
  if (typeof obj.text === 'string') return new TextEncoder().encode(obj.text).byteLength;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  return undefined;
}

function readText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (obj.bytes instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(obj.bytes);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Recursively check that every key in `expected` exists in `actual`
 * with a matching shape. Values in `expected` describe shape:
 *
 *   - primitive literal → strict equality
 *   - {type: "string"|"number"|...} → typeof check
 *   - nested object → recurse
 *   - array → check actual is array, optionally check first-element
 *     shape if expected[0] is provided.
 *
 * Returns undefined if it matches; otherwise a single-line reason
 * describing the first mismatch encountered (depth-first).
 */
function compareJsonShape(actual: unknown, expected: unknown, path: string): string | undefined {
  if (isShapeDescriptor(expected)) {
    const want = expected.type;
    const got = jsonTypeOf(actual);
    if (got !== want) return `${path} expected type ${want}, got ${got}`;
    return undefined;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path} expected array, got ${jsonTypeOf(actual)}`;
    if (expected.length === 0) return undefined;
    for (let i = 0; i < actual.length; i++) {
      const reason = compareJsonShape(actual[i], expected[0], `${path}[${i}]`);
      if (reason) return reason;
    }
    return undefined;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      return `${path} expected object, got ${jsonTypeOf(actual)}`;
    }
    const a = actual as Record<string, unknown>;
    for (const [key, val] of Object.entries(expected as Record<string, unknown>)) {
      if (!(key in a)) return `${path}.${key} is missing`;
      const reason = compareJsonShape(a[key], val, `${path}.${key}`);
      if (reason) return reason;
    }
    return undefined;
  }
  if (actual !== expected) {
    return `${path} expected ${formatValue(expected)}, got ${formatValue(actual)}`;
  }
  return undefined;
}

function isShapeDescriptor(value: unknown): value is { type: string } {
  return (
    value !== null
    && typeof value === 'object'
    && typeof (value as { type?: unknown }).type === 'string'
    && Object.keys(value as Record<string, unknown>).length === 1
  );
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
