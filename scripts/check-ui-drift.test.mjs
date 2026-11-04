/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8802: real source snippets and CLI runs over committed temporary git trees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, scanTree } from './lib/ui-drift.mjs';

const cli = fileURLToPath(new URL('./check-ui-drift.mjs', import.meta.url));
const sourcePath = 'apps/viewer/src/example.tsx';
const scan = (text, path = sourcePath) => scanSource(text, { path });

function tree(t, files = { [sourcePath]: '<button className="bg-zinc-800" />' }) {
  const root = mkdtempSync(join(tmpdir(), 'ui-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  mkdirSync(join(root, 'scripts'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [path, text] of Object.entries(files)) write(path, text);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8' });
  const baselinePath = join(root, 'scripts/ui-drift-baseline.json');
  return { root, write, run, baselinePath };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('#8802 comments, URL fragments and string comment markers', () => {
  const counts = scan(`
    // issue #5479 and '#abc' bg-red-500 <button
    /* issue #5479 and '#abcdef' */
    const colour = '#ff00aa';
    const url = "https://x.y/#abc";
    const slashes = '// still a string #abc';
    const after = '#12345678';
  `);
  assert.equal(counts['hex-literal'], 3);
  assert.equal(counts['palette-class'], 0);
  assert.equal(counts['native-control'], 0);
});

test('#8802 an apostrophe in JSX text does not hide later comments', () => {
  const counts = scan("const a = <p>Don't panic</p>;\n// see #5479 and #abc\nconst b = 'bg-zinc-800 #ff00aa';\n");
  assert.equal(counts['hex-literal'], 1);
  assert.equal(counts['palette-class'], 1);
});

test('#8802 templates preserve raw text, escaped quotes and nested expressions', () => {
  // eslint-disable-next-line no-template-curly-in-string -- scanner input: literal template syntax in the SOURCE UNDER TEST
  const text = 'const x = `https://x/ // #abc ${ /* #def */ ({x: `#123 ${ "#456" }`}).x }`;\n'
    + 'const y = "escaped \\" // #789"; // #aaa\n'
    + "const z = '#abcdef';";
  assert.equal(scan(text)['hex-literal'], 5);
});

test('#8802 palette variants, repeats, boundaries and semantic colours', () => {
  const counts = scan('dark:bg-zinc-800 hover:text-blue-500/80 bg-primary text-white '
    + 'text-white border-s-red-950 ring-offset-sky-50 xbg-red-500 bg-red-500-extra');
  assert.equal(counts['palette-class'], 4);
  assert.equal(counts['bw-class'], 2);
  assert.equal(scan('bg-primary')['palette-class'], 0);
});

test('#8802 arbitrary design values exclude non-design properties', () => {
  assert.equal(scan('w-[37px] text-[11px] z-[60] grid-cols-[1fr_2fr]')['arbitrary-value'], 3);
  assert.equal(scan('-mt-[2px] hover:gap-x-[3px] rounded-tr-[4px]')['arbitrary-value'], 3);
});

test('#8802 native JSX and hex literals apply only to TSX', () => {
  const text = '<button/><Button/><input /><select><textarea> "#abc"';
  assert.equal(scan('<button/><Button/>')['native-control'], 1);
  assert.equal(scan(text)['native-control'], 4);
  const ts = scan(text + ' bg-red-500', 'apps/viewer/src/file.ts');
  assert.equal(ts['native-control'], 0);
  assert.equal(ts['hex-literal'], 0);
  assert.equal(ts['palette-class'], 1);
  assert.equal(scan("'#abcde' '#abcdefg' '/#abc' '#1234' '#12345678'")['hex-literal'], 2);
});

test('#8802 tree scope excludes primitives, tests, declarations and untracked files', (t) => {
  const content = '<button className="bg-red-500" />';
  const included = [sourcePath, 'apps/viewer/src/logic.ts'];
  const excluded = ['apps/viewer/src/components/ui/button.tsx', 'apps/viewer/src/example.test.tsx',
    'apps/viewer/src/example.spec.tsx', 'apps/viewer/src/example.test.ts',
    'apps/viewer/src/example.spec.ts', 'apps/viewer/src/types.d.ts',
    'apps/viewer/src/test/fixture.tsx', 'apps/viewer/src/styles.css', 'packages/other.tsx'];
  const fixture = tree(t, Object.fromEntries([...included, ...excluded].map((path) => [path, content])));
  fixture.write('apps/viewer/src/untracked.tsx', content);
  const result = scanTree(fixture.root);
  assert.deepEqual(Object.keys(result.files).sort(), included.sort());
  assert.equal(result.totals['palette-class'], 2);
  assert.equal(result.totals['native-control'], 1);
});

test('#8802 CLI increase fails; update refuses without override and writes with it', (t) => {
  const f = tree(t);
  success(f.run('--update'));
  const before = readFileSync(f.baselinePath, 'utf8');
  f.write(sourcePath, '<button className="bg-red-500 bg-blue-500" />');
  const check = f.run();
  assert.equal(check.status, 1);
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(check.stderr, /palette-class: baseline 1, current 2, delta \+1/);
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(check.stdout, /apps\/viewer\/src\/example.tsx/);
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(check.stderr, /design tokens\/primitives/);
  assert.equal(f.run('--update').status, 1);
  assert.equal(readFileSync(f.baselinePath, 'utf8'), before);
  success(f.run('--update', '--allow-increase'));
  const updated = JSON.parse(readFileSync(f.baselinePath, 'utf8'));
  assert.equal(updated.totals['palette-class'], 2);
  assert.deepEqual(Object.keys(updated), ['version', 'totals']);
  assert.deepEqual(Object.keys(updated.totals), Object.keys(updated.totals).sort());
  // @source-text-assertion-ok generated baseline JSON formatting, not source text
  assert.ok(readFileSync(f.baselinePath, 'utf8').endsWith('\n'));
  success(f.run());
});

test('#8802 CLI decrease notices, report and JSON do not require a baseline', (t) => {
  const f = tree(t);
  const json = JSON.parse(success(f.run('--json', '--report')));
  assert.equal(json.grandTotal, 2);
  assert.deepEqual(json.topFiles['palette-class'], [{ path: sourcePath, count: 1 }]);
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(success(f.run('--report')), /Grand total: 2/);
  success(f.run('--update'));
  f.write(sourcePath, '<Button className="bg-primary" />');
  const output = success(f.run());
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(output, /drift went down by 1 in palette-class; lock it in with `pnpm ui-drift:update`/);
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(output, /drift went down by 1 in native-control/);
  success(f.run('--update'));
  assert.equal(JSON.parse(readFileSync(f.baselinePath, 'utf8')).totals['palette-class'], 0);
});

test('#8802 CLI fails closed on category mismatch in either direction', (t) => {
  const f = tree(t);
  success(f.run('--update'));
  const baseline = JSON.parse(readFileSync(f.baselinePath, 'utf8'));
  delete baseline.totals['bw-class'];
  baseline.totals.obsolete = 0;
  f.write('scripts/ui-drift-baseline.json', JSON.stringify(baseline));
  const result = f.run();
  assert.equal(result.status, 1);
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(result.stderr, /bw-class missing from baseline/);
  // @source-text-assertion-ok CLI stdout/stderr behaviour, not source text
  assert.match(result.stderr, /obsolete missing from tree/);
  assert.equal(f.run('--update', '--allow-increase').status, 1);
});
