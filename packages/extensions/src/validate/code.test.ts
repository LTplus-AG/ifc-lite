/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as walk from 'acorn-walk';
import { validateCode, type CodeValidationResult } from './code.js';

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

  // `self` is the one worker-realm alias of the global object, and it was
  // the only entry in BANNED_GLOBALS with no test: removing it from the
  // set left the whole suite green while re-opening the exact escape the
  // other four close.
  it('rejects self, the worker-realm alias of the global object', () => {
    const r = validateCode(`self.postMessage('x');`);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('self');
  });

  // Guards the whole set at once, per name, so a future edit that drops
  // any single entry fails here rather than silently widening the gate.
  it.each(['globalThis', 'window', 'process', 'document', 'self'])(
    'names "%s" in the banned-global diagnostic',
    (name) => {
      const r = validateCode(`const x = ${name};`);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.message.includes(`"${name}"`))).toBe(true);
    },
  );

  it('leaves an unrelated identifier alone', () => {
    expect(validateCode(`const x = ctx.bim;`).ok).toBe(true);
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

describe('validateCode — deeply nested sources are bounded, not fatal', () => {
  /** `levels` nested `if (1) { … }` blocks around `inner`. */
  function nestIf(levels: number, inner: string): string {
    return 'if(1){'.repeat(levels) + inner + '}'.repeat(levels);
  }

  it('still walks a deep-but-legal source to completion', () => {
    // 400 source levels is ~800 AST levels — under the bound, so the
    // violation buried at the bottom is still found, and nothing else
    // is reported.
    const r = validateCode(nestIf(400, 'eval("1");'));
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('Banned call');
  });

  it('accepts a deep-but-legal clean source', () => {
    const r = validateCode(nestIf(400, 'const x = 1;'));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports a depth error instead of throwing past the bound', () => {
    // Before the bound this threw `RangeError: Maximum call stack size
    // exceeded` out of acorn-walk, escaping validateCode's contract.
    let r!: CodeValidationResult;
    expect(() => {
      r = validateCode(nestIf(800, 'eval("1");'));
    }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /nested more than \d+ AST levels/.test(e.message))).toBe(true);
  });

  it('does not report ok for a too-deep source with no visible violation', () => {
    // The dangerous shape: nothing banned above the cut-off. A
    // truncated walk must not be mistaken for a clean bill of health.
    const r = validateCode(nestIf(800, 'const x = 1;'));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /nested more than \d+ AST levels/.test(e.message))).toBe(true);
  });

  it('gives the same verdict however much stack the caller has left', () => {
    // The reason we bound rather than catching RangeError: the same
    // source must be judged identically from any call depth.
    const source = nestIf(800, 'const x = 1;');
    const shallow = validateCode(source);
    const recurse = (n: number): CodeValidationResult =>
      n === 0 ? validateCode(source) : recurse(n - 1);
    const deep = recurse(2000);
    expect(deep.ok).toBe(shallow.ok);
    expect(deep.errors.map((e) => e.message)).toEqual(shallow.errors.map((e) => e.message));
  });
});

describe('validateCode — a subtree the walker cannot descend', () => {
  /**
   * acorn and acorn-walk version independently, and every new syntax
   * (class static blocks, import attributes, `await using`) reaches
   * the parser before the walker. Rather than wait for an upgrade to
   * produce that skew, remove one `base` entry for the duration of the
   * call: a node type acorn still emits becomes one the walker has no
   * way to descend.
   */
  function withoutBase<T>(type: string, run: () => T): T {
    const base = walk.base as unknown as Record<string, unknown>;
    const saved = base[type];
    expect(saved).toBeTypeOf('function');
    delete base[type];
    try {
      return run();
    } finally {
      base[type] = saved;
    }
  }

  it('refuses the source instead of passing it as clean', () => {
    // `eval(...)` is banned and sits inside the subtree the walker
    // cannot enter. A scan that never looked must not report "clean".
    const r = withoutBase('TryStatement', () =>
      validateCode('try { eval("payload"); } catch (e) {}'),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /cannot traverse/.test(e.message))).toBe(true);
    expect(r.errors.some((e) => /TryStatement/.test(e.message))).toBe(true);
  });

  it('names the failure even when nothing banned is visible', () => {
    // The subtler half: no banned construct anywhere, so the only
    // signal that the scan was incomplete is the walker's own report.
    const r = withoutBase('TryStatement', () => validateCode('try { const x = 1; } catch (e) {}'));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['invalid_value']);
  });

  it('still passes the same source once the walker can descend it', () => {
    // Pins that the rejection comes from the missing base, not from
    // the source: unmodified, this is a clean script.
    expect(validateCode('try { const x = 1; } catch (e) {}').ok).toBe(true);
  });
});
