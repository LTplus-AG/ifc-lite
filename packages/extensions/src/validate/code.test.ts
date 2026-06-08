/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validateCode } from './code.js';

describe('validateCode — clean sources pass', () => {
  it('accepts a plain function declaration', () => {
    const r = validateCode(`async function activate(ctx) { return ctx.bim.query.byType('IfcWall'); }`);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts top-level await', () => {
    const r = validateCode(`const x = await Promise.resolve(1);`);
    expect(r.ok).toBe(true);
  });
});

describe('validateCode — banned globals', () => {
  it('rejects globalThis', () => {
    const r = validateCode(`globalThis.foo = 1;`);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('globalThis');
  });

  it('rejects window', () => {
    const r = validateCode(`const x = window.location;`);
    expect(r.ok).toBe(false);
  });

  it('rejects process', () => {
    const r = validateCode(`if (process.env.NODE_ENV === 'prod') {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects document', () => {
    const r = validateCode(`document.body.innerHTML = '';`);
    expect(r.ok).toBe(false);
  });
});

describe('validateCode — banned calls', () => {
  it('rejects eval', () => {
    const r = validateCode(`const x = eval('1 + 1');`);
    expect(r.ok).toBe(false);
  });

  it('rejects Function constructor call', () => {
    const r = validateCode(`const f = Function('return 1');`);
    expect(r.ok).toBe(false);
  });

  it('rejects new Function', () => {
    const r = validateCode(`const f = new Function('return 1');`);
    expect(r.ok).toBe(false);
  });
});

describe('validateCode — dynamic imports', () => {
  it('rejects dynamic import with non-literal specifier', () => {
    const r = validateCode(`const m = await import(getModuleName());`);
    expect(r.ok).toBe(false);
  });

  it('rejects dynamic import of unauthorised specifier', () => {
    const r = validateCode(`const m = await import('./other.js');`);
    expect(r.ok).toBe(false);
  });

  it('accepts dynamic import of allow-listed specifier', () => {
    const r = validateCode(
      `const m = await import('./internal.js');`,
      { allowedDynamicImports: new Set(['./internal.js']) },
    );
    expect(r.ok).toBe(true);
  });
});

describe('validateCode — parse errors', () => {
  it('reports a parse error with line / column', () => {
    const r = validateCode(`function activate( {`);
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toMatch(/^\[\d+:\d+\]$/);
    expect(r.errors[0].code).toBe('invalid_format');
  });
});

describe('validateCode — banned patterns report real line / column', () => {
  it('reports the offending line:column for a banned global on a multi-line input', () => {
    // Line 1: comment, line 2: blank, line 3: violation at column 0.
    const r = validateCode(`// header\n\nglobalThis.foo = 1;`);
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe('[3:0]');
  });

  it('reports distinct lines for violations on different lines', () => {
    const r = validateCode(`const a = window.x;\nconst b = process.env.Y;`);
    expect(r.ok).toBe(false);
    const lines = r.errors.map((e) => e.path);
    expect(lines).toContain('[1:10]');
    expect(lines).toContain('[2:10]');
  });
});
