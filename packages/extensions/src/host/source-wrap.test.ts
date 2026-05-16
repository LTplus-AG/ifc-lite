/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { wrapEntrySource } from './source-wrap.js';

describe('wrapEntrySource — happy', () => {
  it('wraps a simple activate function', () => {
    const r = wrapEntrySource(
      'function activate(ctx) { return 42; }',
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toContain('function activate(ctx)');
      expect(r.value).toContain('activate(__ifclite_ctx__)');
      expect(r.value).toMatch(/^;\(\(\) => \{/); // starts with IIFE
    }
  });

  it('wraps async functions', () => {
    const r = wrapEntrySource(
      'async function activate(ctx) { return await Promise.resolve(1); }',
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(true);
  });

  it('aliases bim from ctx', () => {
    const r = wrapEntrySource(
      'function activate(ctx) {}',
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toContain('const bim = __ifclite_ctx__.bim;');
    }
  });

  it('renames the entry function correctly', () => {
    const r = wrapEntrySource(
      'function customHandler(ctx) {}',
      { entryFnName: 'customHandler' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain('customHandler(__ifclite_ctx__)');
  });

  it('preserves user source verbatim', () => {
    const source = 'function activate(ctx) {\n  // important comment\n  return 1;\n}';
    const r = wrapEntrySource(source, { entryFnName: 'activate' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain(source);
  });
});

describe('wrapEntrySource — banned constructs', () => {
  it('rejects ES module imports', () => {
    const r = wrapEntrySource(
      "import foo from 'bar';\nfunction activate(ctx) {}",
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes('import'))).toBe(true);
    }
  });

  it('rejects export default', () => {
    const r = wrapEntrySource(
      'export default function activate(ctx) {}',
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes('export'))).toBe(true);
    }
  });

  it('rejects named exports', () => {
    const r = wrapEntrySource(
      'export function activate(ctx) {}',
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(false);
  });

  it('rejects export *', () => {
    const r = wrapEntrySource(
      "export * from './foo';\nfunction activate(ctx) {}",
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(false);
  });
});

describe('wrapEntrySource — parse errors', () => {
  it('reports syntax errors with line/column', () => {
    const r = wrapEntrySource('function activate( {', { entryFnName: 'activate' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toMatch(/^\[\d+:\d+\]$/);
      expect(r.errors[0].code).toBe('invalid_format');
    }
  });

  it('rejects empty source', () => {
    const r = wrapEntrySource('', { entryFnName: 'activate' });
    expect(r.ok).toBe(false);
  });

  it('rejects non-string source', () => {
    const r = wrapEntrySource(42 as unknown as string, { entryFnName: 'activate' });
    expect(r.ok).toBe(false);
  });
});

describe('wrapEntrySource — entryFnName validation', () => {
  it('rejects invalid identifier with spaces', () => {
    const r = wrapEntrySource('function activate(ctx) {}', { entryFnName: 'bad name' });
    expect(r.ok).toBe(false);
  });

  it('rejects identifier starting with a digit', () => {
    const r = wrapEntrySource('function activate(ctx) {}', { entryFnName: '1bad' });
    expect(r.ok).toBe(false);
  });

  it('accepts identifiers with $ and _', () => {
    const r = wrapEntrySource('function $_handler(ctx) {}', { entryFnName: '$_handler' });
    expect(r.ok).toBe(true);
  });
});
