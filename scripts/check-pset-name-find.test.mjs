/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the same-named-property-set `.find()` gate. Everything runs
 * against synthetic TS written into an `mkdtemp` tree, not against the repo,
 * so a change elsewhere in packages/ or apps/ can never make these
 * vacuously green.
 *
 * Run: `node --test scripts/check-pset-name-find.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runCheck, scanText } from './check-pset-name-find.mjs';

/**
 * Build a temp `{packages,apps}/...` tree from `files` and run the gate
 * against it.
 * @param {Record<string, string>} files
 * @param {object} [opts]
 */
function check(files, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pset-find-gate-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return runCheck(dir, opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('flags the two-step .find(pset) -> .find(property) shape, via an intermediate variable', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function getProp(props, setName, propName) {
  const pset = props.find(p => p.name === setName);
  if (!pset) return null;
  const prop = pset.properties.find(p => p.name === propName);
  return prop ?? null;
}
`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].rel, /a\.ts$/);
});

test('flags the same shape for quantities', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function getQty(qsets, setName, qtyName) {
  const qset = qsets.find(q => q.name === setName);
  if (!qset) return null;
  const qty = qset.quantities.find(q => q.name === qtyName);
  return qty ?? null;
}
`,
  });
  assert.equal(r.ok, false);
});

test('flags a same-line chained .find(...).find(...)', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function getProp(props, setName, propName) {
  return props.find(p => p.name === setName)?.properties.find(p => p.name === propName)?.value ?? null;
}
`,
  });
  assert.equal(r.ok, false);
});

test('flags a chain split across method-chain continuation lines', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function getQty(baseQsets, qsetName, quantName) {
  const baseQuantity = baseQsets
    .find(q => q.name === qsetName)
    ?.quantities.find(q => q.name === quantName);
  return baseQuantity ?? null;
}
`,
  });
  assert.equal(r.ok, false);
});

test('flags the two-step shape when the callback parameter is TYPE-ANNOTATED', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function resolve(props: any, setName: string, propName: string) {
  const pset = props.find((p: any) => p.name === setName);
  if (pset) {
    const prop = pset.properties.find((p: any) => p.name === propName);
    if (prop?.value != null) return prop.value;
  }
  return null;
}
`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
});

test('flags a type-annotated quantity lookup reached through optional chaining', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function resolve(qsets: QuantitySet[], setName: string, qtyName: string) {
  const qset = qsets.find((q: QuantitySet) => q.name === setName);
  const qty = qset?.quantities?.find((q: Quantity) => q.name === qtyName);
  return qty?.value ?? null;
}
`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
});

test('flags a same-line chain whose both callbacks are type-annotated', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function getProp(props: PropertySet[], setName: string, propName: string) {
  return props.find((p: PropertySet) => p.name === setName)?.properties.find((p: Property) => p.name === propName)?.value ?? null;
}
`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
});

test('does not flag a for-loop that scans every same-named set (the correct shape)', () => {
  const r = check({
    'packages/foo/src/a.ts': `
function getProp(props, setName, propName) {
  for (const pset of props) {
    if (pset.name !== setName) continue;
    const prop = pset.properties.find(p => p.name === propName);
    if (prop) return prop.value;
  }
  return null;
}
`,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('does not flag a single .find on a unique-by-construction definition list', () => {
  const r = check({
    'packages/foo/src/definitions.ts': `
const COMMON_SCALES = [{ name: '1:100', value: 100 }, { name: '1:50', value: 50 }];
export function scaleFor(name) {
  return COMMON_SCALES.find(s => s.name === name);
}
`,
  });
  assert.equal(r.ok, true);
});

test('does not flag a .find whose receiver name is not plausibly an entity pset/qset collection', () => {
  const r = check({
    'packages/foo/src/lookup.ts': `
function findUser(users, id) {
  const user = users.find(u => u.name === id);
  if (!user) return null;
  const detail = user.properties.find(p => p.name === 'email');
  return detail;
}
`,
  });
  assert.equal(r.ok, true);
});

test('a type-annotated parameter does not make a non-pset receiver risky', () => {
  const r = check({
    'packages/foo/src/lookup.ts': `
function findUser(users: User[], id: string) {
  const user = users.find((u: User) => u.name === id);
  const detail = user?.properties?.find((p: Prop) => p.name === 'email');
  return detail;
}
`,
  });
  assert.equal(r.ok, true);
});

test('does not flag *.test.ts fixture assertions', () => {
  const r = check({
    'packages/foo/src/a.test.ts': `
test('x', () => {
  const pset = props.find(p => p.name === 'Pset_Foo');
  const prop = pset.properties.find(p => p.name === 'Bar');
  assert.ok(prop);
});
`,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.scanned, []);
});

test('does not flag a file listed in knownUnfixed, but still scans it', () => {
  const r = check(
    {
      'packages/query/src/entity-node.ts': `
property(psetName, propName) {
  const props = this.store.getProperties(this.expressId);
  const pset = props.find(p => p.name === psetName);
  return pset?.properties.find(p => p.name === propName)?.value ?? null;
}
`,
    },
    { knownUnfixed: new Set(['packages/query/src/entity-node.ts']) },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.scanned, ['packages/query/src/entity-node.ts']);
});

test('a file NOT in knownUnfixed with the same shape still fails', () => {
  const r = check(
    {
      'packages/query/src/entity-node.ts': `
property(psetName, propName) {
  const props = this.store.getProperties(this.expressId);
  const pset = props.find(p => p.name === psetName);
  return pset?.properties.find(p => p.name === propName)?.value ?? null;
}
`,
    },
    { knownUnfixed: new Set() },
  );
  assert.equal(r.ok, false);
});

test('skips node_modules/dist and other build-output directories', () => {
  const r = check({
    'packages/foo/node_modules/bar/src/a.ts': `
const pset = props.find(p => p.name === x);
const prop = pset.properties.find(p => p.name === y);
`,
    'packages/foo/dist/a.ts': `
const pset = props.find(p => p.name === x);
const prop = pset.properties.find(p => p.name === y);
`,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.scanned, []);
});

test('an unreadable search root throws rather than reporting a silent pass', () => {
  assert.throws(() => runCheck('/nonexistent/path/for/this/gate/__probe__'));
});

test('scanText: the same shape scanned directly, outside a real filesystem walk', () => {
  const violations = scanText(
    'packages/foo/src/a.ts',
    `
const pset = props.find(p => p.name === setName);
const prop = pset.properties.find(p => p.name === propName);
`,
    { knownUnfixed: new Set() },
  );
  assert.equal(violations.length, 1);
});
