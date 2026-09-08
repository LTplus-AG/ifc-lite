/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { validateCode } from '../validate/code.js';
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

describe('wrapEntrySource — nested banned constructs', () => {
  it('rejects dynamic import() hidden inside a function body', () => {
    const r = wrapEntrySource(
      'function activate(ctx) { import("node:fs").then(fs => console.log(fs)); }',
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.toLowerCase().includes('import'))).toBe(true);
    }
  });
});

describe('wrapEntrySource — deeply nested entry scripts', () => {
  const nested = (levels: number) =>
    `${'if (1) {'.repeat(levels)}function activate(ctx) {}${'}'.repeat(levels)}`;

  it('reports a validation error instead of throwing on a deeply nested script', () => {
    // 900 nested `if` blocks is ~1800 AST levels — past MAX_AST_DEPTH,
    // but still shallow enough that acorn itself parses it, so this
    // exercises the walk's own bound rather than the parser's.
    const r = wrapEntrySource(nested(900), { entryFnName: 'activate' });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.code).toBe('invalid_value');
      expect(r.errors[0]!.message).toBe('Entry script is nested more than 1000 AST levels deep.');
    }
  });

  it('still wraps a script nested well inside the bound', () => {
    // 400 nested `if` blocks is ~800 AST levels — under MAX_AST_DEPTH.
    const r = wrapEntrySource(nested(400), { entryFnName: 'activate' });
    expect(r.ok).toBe(true);
  });

  it('still flags a banned construct buried under deep-but-legal nesting', () => {
    const levels = 200;
    const r = wrapEntrySource(
      `${'if (1) {'.repeat(levels)}import('node:fs');${'}'.repeat(levels)}function activate(ctx) {}`,
      { entryFnName: 'activate' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes('Dynamic `import(...)`'))).toBe(true);
    }
  });
});

describe('wrapEntrySource — one depth bound, shared with validateCode', () => {
  // `wrapEntrySource` and `validateCode` used to run two hand-written
  // traversals with two private copies of the depth constant. They now
  // share `walkBounded`; this pins the agreement so a re-divergence is
  // a failing test rather than a latent one.
  const ifs = (n: number) => `${'if (1) {'.repeat(n)}function activate(ctx) {}${'}'.repeat(n)}`;
  const arrows = (n: number) => `function activate(ctx) { const f = ${'() => '.repeat(n)}1; }`;

  const verdictsFor = (make: (n: number) => string, depths: readonly number[]) =>
    depths.map((n) => {
      const source = make(n);
      return {
        n,
        wrap: wrapEntrySource(source, { entryFnName: 'activate' }).ok,
        validate: validateCode(source).ok,
      };
    });

  // Deliberately spans the accept/reject boundary: the test would be
  // vacuous if every depth landed on the same side, so the straddle is
  // asserted below rather than assumed.
  const IF_DEPTHS = [10, 200, 400, 450, 475, 490, 499, 500, 501, 600, 900];

  it('accepts and rejects the same if-block depths as validateCode', () => {
    const verdicts = verdictsFor(ifs, IF_DEPTHS);

    for (const v of verdicts) {
      expect(`${v.n}:${v.wrap}`).toBe(`${v.n}:${v.validate}`);
    }
    // The range really does straddle the bound.
    expect(verdicts.some((v) => v.wrap)).toBe(true);
    expect(verdicts.some((v) => !v.wrap)).toBe(true);
  });

  // An arrow chain CANNOT straddle the bound, and the same depth list
  // must not be reused for it. `MAX_AST_DEPTH` counts AST levels, and
  // one arrow link costs one where one `if (1) {}` costs two (pinned by
  // the ratio test below), so the bound needs ~1000 links — while acorn
  // runs out of stack parsing this shape far earlier. Measured here: 400
  // links parse, 425 fail with "Not enough stack space to parse input",
  // and the exact crossover moves with the host's remaining stack (the
  // very dependency `MAX_AST_DEPTH` exists to keep out of the verdict),
  // so it is not pinned. Reusing IF_DEPTHS made the arrow half assert a
  // straddle it reached only by PARSE failure at 450+, not by the bound
  // — the same verdict for an unrelated reason, and flaky with it.
  //
  // So the honest claim, and the one asserted: within what acorn parses,
  // every arrow depth is accepted, and both entry points agree on that.
  const ARROW_DEPTHS = [10, 100, 200, 300];

  it('accepts every parseable arrow-chain depth, and agrees with validateCode', () => {
    const verdicts = verdictsFor(arrows, ARROW_DEPTHS);

    for (const v of verdicts) {
      expect(`${v.n}:${v.wrap}`).toBe(`${v.n}:${v.validate}`);
    }
    // Not a straddle — the bound is unreachable for this shape. Pin the
    // uniformity so a future run that starts rejecting these is a
    // failure to look at rather than a silently narrower test.
    expect(verdicts.map((v) => `${v.n}:${v.wrap}`)).toEqual(
      ARROW_DEPTHS.map((n) => `${n}:true`),
    );
  });

  it('an arrow link costs one AST level where an `if (1) {}` block costs two', () => {
    // The reason the two shapes need different depth lists, pinned
    // directly instead of left as prose. Measured with an independent
    // iterative crawl over acorn's tree — deliberately not `walkBounded`,
    // which is the thing under test, and iterative so this helper cannot
    // overflow the stack it is reasoning about.
    const astDepth = (source: string): number => {
      const root = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      let max = 0;
      const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
      while (stack.length > 0) {
        const { value, depth } = stack.pop()!;
        if (Array.isArray(value)) {
          for (const item of value) stack.push({ value: item, depth });
          continue;
        }
        if (typeof value !== 'object' || value === null) continue;
        const isNode = typeof (value as { type?: unknown }).type === 'string';
        const childDepth = isNode ? depth + 1 : depth;
        if (isNode && childDepth > max) max = childDepth;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'type' || key === 'start' || key === 'end') continue;
          stack.push({ value: child, depth: childDepth });
        }
      }
      return max;
    };

    // Differences, so the constant prologue of each shape cancels.
    expect(astDepth(ifs(200)) - astDepth(ifs(100))).toBe(200);
    expect(astDepth(arrows(200)) - astDepth(arrows(100))).toBe(100);
  });
});

describe('wrapEntrySource — every banned construct, in a nested position', () => {
  // Migrating this scan onto `acorn-walk`'s `base` narrowed which child
  // positions are descended (non-computed member properties, plain
  // object keys, labels and pattern `Property` wrappers are no longer
  // reported as nodes). One case per banned construct, each buried
  // where the old generic property-crawl was the only obvious way to
  // reach it, so a coverage loss shows up here.
  const cases: Array<[string, string]> = [
    ['ImportDeclaration', 'import fs from "node:fs";\nfunction activate(ctx) {}'],
    ['ExportNamedDeclaration', 'export const a = 1;\nfunction activate(ctx) {}'],
    ['ExportDefaultDeclaration', 'export default 1;\nfunction activate(ctx) {}'],
    ['ExportAllDeclaration', 'export * from "node:fs";\nfunction activate(ctx) {}'],
    ['ImportExpression in a class static block', 'class C { static { import("node:fs"); } }\nfunction activate(ctx) {}'],
    ['ImportExpression in a computed key', 'const o = { [import("node:fs")]: 1 };\nfunction activate(ctx) {}'],
    ['ImportExpression in an object value', 'const o = { k: import("node:fs") };\nfunction activate(ctx) {}'],
    ['ImportExpression in a default parameter', 'function activate(ctx, a = import("node:fs")) {}'],
    ['ImportExpression in a destructuring default', 'function activate(ctx) { const { a = import("node:fs") } = ctx; }'],
    [
      'ImportExpression in a template literal',
      `function activate(ctx) { return \`\${import("node:fs")}\`; }`,
    ],
    ['ImportExpression behind optional chaining', 'function activate(ctx) { return ctx?.a?.[import("node:fs")]; }'],
    ['ImportExpression in a class field initialiser', 'class C { p = import("node:fs"); }\nfunction activate(ctx) {}'],
    ['ImportExpression in a getter body', 'const o = { get a() { return import("node:fs"); } };\nfunction activate(ctx) {}'],
    ['ImportExpression under a label', 'function activate(ctx) { outer: { import("node:fs"); } }'],
    ['ImportExpression in a catch clause', 'function activate(ctx) { try {} catch (e) { import("node:fs"); } }'],
    ['ImportExpression with import attributes', 'function activate(ctx) { import("node:fs", { with: { type: "json" } }); }'],
  ];

  for (const [name, source] of cases) {
    it(`rejects ${name}`, () => {
      const r = wrapEntrySource(source, { entryFnName: 'activate' });
      expect(r.ok).toBe(false);
    });
  }

  it('reports each banned construct exactly once', () => {
    // `walkBounded` reports statements and expressions twice — once
    // under acorn-walk's synthetic key, once under the real type. The
    // visitor switches on the supplied key for that reason; switching
    // on `node.type` would double every diagnostic.
    const r = wrapEntrySource('function activate(ctx) { import("node:fs"); }', {
      entryFnName: 'activate',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(1);
  });
});

describe('wrapEntrySource — a subtree the walker cannot descend', () => {
  /** See `validate/code.test.ts`: simulates an acorn/acorn-walk skew. */
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

  it('refuses to wrap a script it could not fully check', () => {
    const source = 'function activate(ctx) { try { import("node:fs"); } catch (e) {} }';
    // Unmodified, the buried `import()` is found — so the rejection
    // below is about the missing base, not about this source.
    expect(wrapEntrySource(source, { entryFnName: 'activate' }).ok).toBe(false);

    const r = withoutBase('TryStatement', () =>
      wrapEntrySource(source, { entryFnName: 'activate' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes('cannot traverse'))).toBe(true);
      expect(r.errors.some((e) => e.message.includes('TryStatement'))).toBe(true);
    }
  });

  it('does not wrap a clean-looking script whose subtree went unscanned', () => {
    const source = 'function activate(ctx) { try { ctx.bim.query.byType("IfcWall"); } catch (e) {} }';
    expect(wrapEntrySource(source, { entryFnName: 'activate' }).ok).toBe(true);

    const r = withoutBase('TryStatement', () =>
      wrapEntrySource(source, { entryFnName: 'activate' }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('wrapEntrySource — realistic extension sources still wrap', () => {
  // The other direction of the fail-closed change: tightening the
  // walker must not start rejecting ordinary extension code.
  const REALISTIC = `
const STOREY_TYPE = 'IfcBuildingStorey';

async function collectWalls(ctx) {
  const walls = await ctx.bim.query.byType('IfcWall');
  return walls.filter((w) => w?.properties?.LoadBearing === true);
}

class WallReport {
  #rows = [];
  static HEADER = ['GlobalId', 'Name'];
  static { WallReport.created = 0; }
  add(wall) {
    this.#rows.push([wall.globalId, wall.name ?? '(unnamed)']);
  }
  get rows() { return this.#rows; }
}

async function activate(ctx) {
  const report = new WallReport();
  try {
    for (const wall of await collectWalls(ctx)) report.add(wall);
    const { rows = [] } = report;
    label: for (const row of rows) {
      if (row.length === 0) continue label;
      ctx.bim.log?.info?.(\`row \${row.join(', ')}\`);
    }
    const byStorey = { [STOREY_TYPE]: rows.length, total: rows.length };
    return byStorey;
  } catch (err) {
    ctx.bim.log?.error?.(String(err));
    return null;
  }
}
`;

  it('wraps a realistic extension entry script with no errors', () => {
    const r = wrapEntrySource(REALISTIC, { entryFnName: 'activate' });
    if (!r.ok) throw new Error(`unexpected errors: ${JSON.stringify(r.errors)}`);
    expect(r.ok).toBe(true);
  });

  it('validateCode also passes that same source', () => {
    const r = validateCode(REALISTIC);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
