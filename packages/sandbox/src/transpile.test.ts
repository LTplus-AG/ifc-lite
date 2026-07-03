/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { transpileTypeScript, naiveTypeStrip, getLastTranspileMode } from './transpile.js';

describe('transpileTypeScript', () => {
  it('strips interface declarations', async () => {
    const code = `
interface Foo {
  bar: string;
}
const x = 42;
`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('interface Foo');
    expect(result).toContain('const x = 42');
  });

  it('strips type alias declarations', async () => {
    const code = `
type ID = string;
const x = 42;
`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('type ID');
    expect(result).toContain('const x = 42');
  });

  it('strips type annotations from variables', async () => {
    const code = `const x: number = 42;`;
    const result = await transpileTypeScript(code);
    expect(result).toContain('const x');
    expect(result).toContain('42');
  });

  it('strips as casts', async () => {
    const code = `const x = y as string`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain(' as string');
    expect(result).toContain('const x = y');
  });

  it('passes plain JavaScript through unchanged', async () => {
    const code = `const x = 42;\nconsole.log(x);`;
    const result = await transpileTypeScript(code);
    expect(result).toContain('const x = 42');
    expect(result).toContain('console.log(x)');
  });
});

describe('transpileTypeScript (type annotations)', () => {
  it('handles export interface', async () => {
    const code = `
export interface Config {
  name: string;
}
const c = { name: 'test' };
`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('export interface');
    expect(result).toContain("const c = { name: 'test' }");
  });

  it('strips function return type annotations', async () => {
    const code = `function foo(): string {\n  return 'bar';\n}`;
    const result = await transpileTypeScript(code);
    expect(result).toContain('function foo()');
    expect(result).not.toContain(': string {');
  });

  it('strips generic type parameters', async () => {
    const code = `const x = foo<string>()`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('<string>');
    expect(result).toContain('foo()');
  });
});

describe('naiveTypeStrip (fallback)', () => {
  it('strips tuple type annotations: [string, number][]', () => {
    const code = `const sorted: [string, number][] = Object.entries(counts)`;
    const result = naiveTypeStrip(code);
    expect(result).not.toContain('[string, number]');
    expect(result).toContain('const sorted');
    expect(result).toContain('= Object.entries(counts)');
  });

  it('strips complex tuple: [string, BimEntity[]][]', () => {
    const code = `const sorted: [string, BimEntity[]][] = Object.entries(groups)`;
    const result = naiveTypeStrip(code);
    expect(result).not.toContain('[string, BimEntity');
    expect(result).toContain('const sorted');
    expect(result).toContain('= Object.entries(groups)');
  });

  it('strips Array<{ ... }> with semicolons inside', () => {
    const code = `const batches: Array<{ entities: BimEntity[]; color: string }> = []`;
    const result = naiveTypeStrip(code);
    expect(result).not.toContain('Array<');
    expect(result).not.toContain('BimEntity');
    expect(result).toContain('const batches');
    expect(result).toContain('= []');
  });

  it('strips Record<string, number> annotation', () => {
    const code = `const counts: Record<string, number> = {}`;
    const result = naiveTypeStrip(code);
    expect(result).not.toContain('Record<');
    expect(result).toContain('const counts');
    expect(result).toContain('= {}');
  });

  it('strips uninitialized variable annotations', () => {
    const code = `let scanned: number`;
    const result = naiveTypeStrip(code);
    expect(result).not.toContain(': number');
    expect(result).toContain('let scanned');
  });

  it('handles multiple annotated variables in sequence', () => {
    const code = [
      `const a: string = 'hello'`,
      `const b: [string, number][] = []`,
      `const c: Array<{ x: number; y: string }> = []`,
      `let d: number`,
    ].join('\n');
    const result = naiveTypeStrip(code);
    expect(result).not.toContain(': string');
    expect(result).not.toContain('[string, number]');
    expect(result).not.toContain('Array<');
    expect(result).not.toContain(': number');
    expect(result).toContain(`const a = 'hello'`);
    expect(result).toContain('const b = []');
    expect(result).toContain('const c = []');
    expect(result).toContain('let d');
  });

  it('preserves plain JS BIM object literals', () => {
    const code = `
const slab = bim.create.addIfcSlab(h, s0, {
  Position: [0, 0, 0],
  Width: 10,
  Depth: 8,
  Thickness: 0.3
});
`;
    const result = naiveTypeStrip(code);
    expect(result).toMatch(/Position\s*:\s*\[0,\s*0,\s*0\]/);
    expect(result).toMatch(/Width\s*:\s*10/);
    expect(result).toMatch(/Depth\s*:\s*8/);
    expect(result).toMatch(/Thickness\s*:\s*0\.3/);
  });

  it('preserves nested Placement object literals for addElement', () => {
    const code = `
const proxy = bim.create.addElement(h, s0, {
  IfcType: "IFCBUILDINGELEMENTPROXY",
  Placement: {
    Location: [0, 0, 3],
    Axis: [0, 0, 1],
    RefDirection: [1, 0, 0]
  },
  Profile: { ProfileType: "AREA", XDim: 1, YDim: 1 },
  Depth: 5
});
`;
    const result = naiveTypeStrip(code);
    expect(result).toMatch(/Placement\s*:\s*\{/);
    expect(result).toMatch(/Location\s*:\s*\[0,\s*0,\s*3\]/);
    expect(result).toMatch(/ProfileType\s*:\s*"AREA"/);
    expect(result).toMatch(/Depth\s*:\s*5/);
  });

  it('preserves roof geometry keys in plain JavaScript', () => {
    const code = `
const roof = bim.create.addIfcRoof(h, s0, {
  Position: [0, 0, 3],
  Width: 10,
  Depth: 8,
  Thickness: 0.2,
  Slope: 0.35
});
`;
    const result = naiveTypeStrip(code);
    expect(result).toMatch(/Position\s*:\s*\[0,\s*0,\s*3\]/);
    expect(result).toMatch(/Width\s*:\s*10/);
    expect(result).toMatch(/Depth\s*:\s*8/);
    expect(result).toMatch(/Thickness\s*:\s*0\.2/);
    expect(result).toMatch(/Slope\s*:\s*0\.35/);
  });
});

describe('transpileTypeScript (module syntax stripping — QuickJS has no module system)', () => {
  it('strips a named import and the remaining code still runs', async () => {
    const code = `
import { foo, bar } from './utils.js';
const x = 1;
`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('import');
    expect(result).not.toContain('./utils.js');
    expect(result).toContain('const x = 1');
    // eslint-disable-next-line no-new-func
    expect(new Function(`${result}\nreturn x;`)()).toBe(1);
  });

  it('strips a namespace import (`import * as x`) and the remaining code still runs', async () => {
    const code = `
import * as utils from './utils.js';
const y = 2;
`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('import');
    expect(result).not.toContain('* as utils');
    expect(result).toContain('const y = 2');
    // eslint-disable-next-line no-new-func
    expect(new Function(`${result}\nreturn y;`)()).toBe(2);
  });

  it('strips a side-effect-only import (`import "x"`) and the remaining code still runs', async () => {
    const code = `
import './setup.js';
const z = 3;
`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('import');
    expect(result).not.toContain('./setup.js');
    expect(result).toContain('const z = 3');
    // eslint-disable-next-line no-new-func
    expect(new Function(`${result}\nreturn z;`)()).toBe(3);
  });

  it('strips `export const` and the declaration still runs', async () => {
    const code = `export const total = 40 + 2;`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('export');
    expect(result).toContain('const total');
    // eslint-disable-next-line no-new-func
    expect(new Function(`${result}\nreturn total;`)()).toBe(42);
  });

  it('strips `export default` and the expression still evaluates', async () => {
    const code = `export default 99;`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('export');
    expect(result).not.toContain('default');
    // eslint-disable-next-line no-new-func
    expect(new Function(`return ${result}`)()).toBe(99);
  });

  it('strips `export { a, b } from "x"` re-export lists and the remaining code still runs', async () => {
    const code = `
export { a, b } from './other.js';
const done = true;
`;
    const result = await transpileTypeScript(code);
    expect(result).not.toContain('export');
    expect(result).not.toContain('./other.js');
    expect(result).toContain('const done = true');
    // eslint-disable-next-line no-new-func
    expect(new Function(`${result}\nreturn done;`)()).toBe(true);
  });
});

describe('transpile observability', () => {
  it('records transpile mode and preserves BIM keys in JS', async () => {
    const code = `
const wall = bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3
});
`;
    const result = await transpileTypeScript(code);
    expect(result).toMatch(/Start\s*:\s*\[0,\s*0,\s*0\]/);
    expect(result).toMatch(/End\s*:\s*\[5,\s*0,\s*0\]/);
    expect(result).toMatch(/Thickness\s*:\s*0\.2/);
    expect(result).toMatch(/Height\s*:\s*3/);
    expect(['esbuild', 'fallback-ts', 'fallback-js']).toContain(getLastTranspileMode());
  });
});
