/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { MAX_AST_DEPTH, walkBounded } from './bounded-walk.js';

function parse(src: string): acorn.Node {
  return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
}

/** `levels` nested `if (1) { … }` blocks around `inner`. */
function nestIf(levels: number, inner: string): string {
  return 'if(1){'.repeat(levels) + inner + '}'.repeat(levels);
}

describe('walkBounded', () => {
  it('visits the same nodes, in the same order, as walk.simple', () => {
    const src = `
      const a = { window: 1, ['self']: 2 };
      function f(x) { return x.process + eval('1'); }
      label: for (const k of [1, 2]) { f(k); }
      class C { document() { return new Function('a'); } }
      import('./x.js');
    `;
    const ast = parse(src);

    const viaAcorn: string[] = [];
    const types = [
      'Identifier',
      'CallExpression',
      'NewExpression',
      'ImportExpression',
      'MemberExpression',
      'Property',
      'BlockStatement',
    ];
    const visitors: Record<string, (n: acorn.Node) => void> = {};
    for (const t of types) {
      visitors[t] = (n) => viaAcorn.push(`${t}@${n.start}-${n.end}`);
    }
    walk.simple(ast as acorn.AnyNode, visitors as never);

    const viaBounded: string[] = [];
    const res = walkBounded(ast, (node, type) => {
      if (types.includes(type)) {
        viaBounded.push(`${type}@${node.start as number}-${node.end as number}`);
      }
    });

    expect(res.depthExceeded).toBe(false);
    expect(viaBounded).toEqual(viaAcorn);
    // Guard against the comparison being vacuous.
    expect(viaAcorn.length).toBeGreaterThan(12);
  });

  it('does not visit a non-computed member property, matching acorn-walk', () => {
    const names: string[] = [];
    walkBounded(parse('foo.window;'), (node, type) => {
      if (type === 'Identifier') names.push(node.name as string);
    });
    expect(names).toEqual(['foo']);
  });

  it('does visit a computed member property, matching acorn-walk', () => {
    const names: string[] = [];
    walkBounded(parse('foo[window];'), (node, type) => {
      if (type === 'Identifier') names.push(node.name as string);
    });
    expect(names).toEqual(['foo', 'window']);
  });

  it('completes a deep-but-legal script without reporting depth', () => {
    // 400 source levels -> ~800 AST levels, under the 1000 bound.
    const res = walkBounded(parse(nestIf(400, 'x;')), () => {});
    expect(res.depthExceeded).toBe(false);
  });

  it('reports depth instead of throwing on a script past the bound', () => {
    // 800 source levels -> ~1600 AST levels, over the bound. The
    // recursive acorn-walk this replaced threw RangeError here.
    const res = walkBounded(parse(nestIf(800, 'x;')), () => {});
    expect(res.depthExceeded).toBe(true);
  });

  it('bounds by AST depth, not source depth: two AST levels per if-block', () => {
    // Pins the constant's meaning. A source nesting of just over
    // MAX_AST_DEPTH/2 must trip the bound; just under must not.
    expect(walkBounded(parse(nestIf(MAX_AST_DEPTH / 2 - 20, 'x;')), () => {}).depthExceeded)
      .toBe(false);
    expect(walkBounded(parse(nestIf(MAX_AST_DEPTH / 2 + 20, 'x;')), () => {}).depthExceeded)
      .toBe(true);
  });

  it('a wide-but-shallow AST is never depth-limited', () => {
    // Far more nodes than MAX_AST_DEPTH, all at depth ~3. The bound
    // must be about nesting, not node count.
    const src = Array.from({ length: MAX_AST_DEPTH * 3 }, (_, i) => `a${i};`).join('\n');
    let seen = 0;
    const res = walkBounded(parse(src), (_n, type) => {
      if (type === 'Identifier') seen++;
    });
    expect(res.depthExceeded).toBe(false);
    expect(seen).toBe(MAX_AST_DEPTH * 3);
  });
});
