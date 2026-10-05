// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6959: the perf-ratchet comparison, file validation and report.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

// Guarded imports (the scripts/perf pattern from #6516): with the production
// modules removed, every test fails on the presence assertion below instead
// of the file dying at import with no assertion evaluated.
async function load(rel) {
  const url = new URL(rel, import.meta.url);
  return existsSync(url) ? import(url.href) : null;
}
const compare = await load('./compare.mjs');
const ceilings = await load('./ceilings.mjs');
const report = await load('./report.mjs');
function rt(name, body) {
  test(name, () => {
    assert.ok(compare && ceilings && report, 'the perf-ratchet modules are absent');
    return body();
  });
}

const PROV = { commit: 'abcdef1234567', measuredAt: '2026-10-05T00:00:00.000Z' };
function entry(id, ceiling, tolerance = { kind: 'relative', value: 0.005 }) {
  return { id, metric: 'brotli-bytes', unit: 'bytes', ceiling, tolerance, provenance: PROV };
}
function family(entries) {
  return { family: 'bundle', entries };
}
function measured(metrics) {
  return { family: 'bundle', commit: 'f00dfeed1234', measuredAt: '2026-10-05T01:00:00.000Z', metrics };
}

rt('relative tolerance admits ceiling * (1 + value), floored; exact admits the ceiling only', () => {
  assert.equal(compare.allowedMax(entry('a', 1000)), 1005);
  // 1001 * 1.005 = 1006.005: an integer metric cannot pass on the fraction.
  assert.equal(compare.allowedMax(entry('a', 1001)), 1006);
  assert.equal(compare.allowedMax(entry('c', 7, { kind: 'exact', value: 0 })), 7);
});

rt('each status is assigned at its boundary', () => {
  const ceil = family([
    entry('over', 1000), entry('edge', 1000), entry('inside', 1000), entry('same', 1000), entry('down', 1000),
    entry('count', 7, { kind: 'exact', value: 0 }), entry('gone', 10),
  ]);
  const { rows, failed } = compare.compareFamily(ceil, measured([
    { id: 'over', value: 1006 }, { id: 'edge', value: 1005 }, { id: 'inside', value: 1001 },
    { id: 'same', value: 1000 }, { id: 'down', value: 990 }, { id: 'count', value: 8 }, { id: 'new', value: 3 },
  ]));
  const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.deepEqual(status, {
    over: compare.REGRESSION,
    edge: compare.WITHIN_TOLERANCE,
    inside: compare.WITHIN_TOLERANCE,
    same: compare.UNCHANGED,
    down: compare.IMPROVEMENT,
    count: compare.REGRESSION,
    gone: compare.MISSING,
    new: compare.UNRATCHETED,
  });
  assert.equal(failed, true);
});

rt('a family entirely at or under its ceilings passes', () => {
  const { failed } = compare.compareFamily(family([entry('a', 100), entry('b', 5, { kind: 'exact', value: 0 })]),
    measured([{ id: 'a', value: 100 }, { id: 'b', value: 4 }]));
  assert.equal(failed, false);
});

rt('an unmeasured ceiling fails: absence is never read as a pass', () => {
  const { failed, rows } = compare.compareFamily(family([entry('a', 100)]), measured([{ id: 'b', value: 1 }]));
  assert.equal(failed, true);
  assert.deepEqual(rows.map((r) => r.status), [compare.MISSING, compare.UNRATCHETED]);
});

rt('a family mismatch throws rather than comparing unrelated ids', () => {
  assert.throws(() => compare.compareFamily(family([entry('a', 1)]), { ...measured([{ id: 'a', value: 1 }]), family: 'copies' }), /family mismatch/);
});

rt('shouldLower: exact lowers on any drop, relative only once the drop clears the band', () => {
  const exact = entry('c', 7, { kind: 'exact', value: 0 });
  assert.equal(compare.shouldLower(exact, 6), true);
  assert.equal(compare.shouldLower(exact, 7), false);
  const rel = entry('r', 1000);
  assert.equal(compare.shouldLower(rel, 996), false, 'inside the 0.5% band: noise, not a win');
  assert.equal(compare.shouldLower(rel, 995), true);
  assert.equal(compare.shouldLower(rel, 1001), false);
});

rt('validateCeilingFile accepts a well-formed file and names every problem in a bad one', () => {
  assert.deepEqual(ceilings.validateCeilingFile(family([entry('a', 1)])), []);
  const problems = ceilings.validateCeilingFile({
    family: 'Bundle',
    entries: [
      { id: 'a', metric: 'x', ceiling: -1, tolerance: { kind: 'relative', value: 5 }, provenance: { commit: 'nope', measuredAt: 'never' } },
      { ...entry('b', 1), tolerance: { kind: 'exact', value: 0.1 } },
      entry('b', 1),
    ],
  });
  const text = problems.join('\n');
  for (const needle of ['`family`', '`ceiling`', 'relative', 'provenance.commit', 'provenance.measuredAt', 'exact', 'duplicate id']) {
    assert.ok(text.includes(needle), `expected a problem mentioning ${needle}; got:\n${text}`);
  }
});

rt('an empty ceiling file or measurement is invalid, not vacuously passing', () => {
  assert.ok(ceilings.validateCeilingFile({ family: 'bundle', entries: [] }).length > 0);
  assert.ok(ceilings.validateMeasuredFile({ family: 'bundle', commit: 'x', measuredAt: PROV.measuredAt, metrics: [] }).length > 0);
  assert.ok(ceilings.validateMeasuredFile({ family: 'bundle', commit: 'x', measuredAt: PROV.measuredAt, metrics: [{ id: 'a', value: NaN }] }).length > 0);
});

rt('the report lists only moved metrics, flags failure, and notes improvements', () => {
  const ceil = family([entry('up', 1000), entry('same', 50), entry('down', 1000)]);
  const res = compare.compareFamily(ceil, measured([{ id: 'up', value: 1100 }, { id: 'same', value: 50 }, { id: 'down', value: 900 }]));
  const md = report.formatReport([res], { commit: 'f00dfeed1234' });
  assert.ok(md.startsWith(report.REPORT_MARKER), 'sticky-comment marker must lead the body');
  assert.match(md, /a ceiling was exceeded/);
  assert.match(md, /`bundle\/up`.*\| 1,100 \| \+100 \(\+10\.00%\) \| FAIL/);
  assert.match(md, /`bundle\/down`.*improved/);
  assert.doesNotMatch(md, /`bundle\/same`/);
  assert.match(md, /1 other metric\(s\) unchanged/);
  assert.match(md, /1 of them cleared the tolerance band/);
  assert.match(md, /docs\/guide\/performance\.md/);
});

rt('an all-unchanged report says so in one line', () => {
  const res = compare.compareFamily(family([entry('a', 10)]), measured([{ id: 'a', value: 10 }]));
  const md = report.formatReport([res]);
  assert.match(md, /all metrics within their ceilings/);
  assert.match(md, /All 1 metric\(s\) equal their ceilings/);
});
