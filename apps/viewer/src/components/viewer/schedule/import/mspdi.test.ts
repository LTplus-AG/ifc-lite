/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '../../../../test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseMspdi } from './mspdi.js';

function task(fields: string): string {
  return `<Task>${fields}</Task>`;
}

/**
 * Prefix an XML body with a declaration. A real MSPDI export always starts
 * `<?xml version="1.0"?>`, but the XML spec requires the declaration to be
 * the document's very first characters — no leading whitespace or newline.
 * A template literal with `<?xml ...?>` typed directly as its first line
 * happens to satisfy that today, but is one accidental indent or
 * interpolation away from breaking if the fixture is ever wrapped or
 * reused. Building it through a function makes that guarantee explicit.
 */
function xmlDoc(body: string): string {
  return `<?xml version="1.0"?>${body}`;
}

describe('parseMspdi — basic document shape', () => {
  const xml = xmlDoc(`
<Project>
  <Name>Test Project</Name>
  <Tasks>
    ${task('<UID>0</UID><Name>Project Summary</Name><OutlineLevel>0</OutlineLevel>')}
    ${task(
      '<UID>1</UID><Name>Phase 1</Name><OutlineLevel>1</OutlineLevel>' +
        '<Start>2026-01-05T08:00:00</Start><Finish>2026-01-10T17:00:00</Finish><Duration>PT40H0M0S</Duration>',
    )}
    ${task(
      '<UID>2</UID><Name>Task A</Name><OutlineLevel>2</OutlineLevel>' +
        '<Start>2026-01-05T08:00:00</Start><Finish>2026-01-06T17:00:00</Finish>',
    )}
    ${task(
      '<UID>3</UID><Name>Task B</Name><OutlineLevel>2</OutlineLevel>' +
        '<PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>600</LinkLag></PredecessorLink>',
    )}
  </Tasks>
</Project>`);

  it('produces one row per real task, skipping the UID 0 project-summary row', () => {
    const result = parseMspdi(xml);
    assert.strictEqual(result.rows.length, 3);
    assert.deepStrictEqual(
      result.rows.map(r => r.sourceId),
      ['1', '2', '3'],
    );
  });

  it('reads nesting from OutlineLevel', () => {
    const result = parseMspdi(xml);
    assert.deepStrictEqual(
      result.rows.map(r => r.outlineLevel),
      [1, 2, 2],
    );
  });

  it('reads the project name', () => {
    const result = parseMspdi(xml);
    assert.strictEqual(result.projectName, 'Test Project');
  });

  it('reads a PredecessorLink with type and lag', () => {
    const result = parseMspdi(xml);
    const taskB = result.rows.find(r => r.sourceId === '3')!;
    assert.strictEqual(taskB.dependencies.length, 1);
    assert.strictEqual(taskB.dependencies[0]!.predecessorSourceId, '2');
    assert.strictEqual(taskB.dependencies[0]!.type, 'FINISH_START');
  });

  it('scales LinkLag (tenths of a minute) to seconds: 600 -> 3600', () => {
    const result = parseMspdi(xml);
    const taskB = result.rows.find(r => r.sourceId === '3')!;
    assert.strictEqual(taskB.dependencies[0]!.lagSeconds, 3600);
  });

  it('normalizes PT40H0M0S to PT40H', () => {
    const result = parseMspdi(xml);
    const phase1 = result.rows.find(r => r.sourceId === '1')!;
    assert.strictEqual(phase1.durationIso, 'PT40H');
  });

  it('passes dates through without a timezone shift', () => {
    const result = parseMspdi(xml);
    const phase1 = result.rows.find(r => r.sourceId === '1')!;
    assert.strictEqual(phase1.start, '2026-01-05T08:00:00');
  });
});

describe('parseMspdi — PredecessorLink/Type mapping', () => {
  // Per Microsoft's MSPDI reference: 0 FF, 1 FS, 2 SF, 3 SS. A regression
  // here silently inverts or swaps every dependency in an imported schedule.
  const expected: Record<string, string> = {
    '0': 'FINISH_FINISH',
    '1': 'FINISH_START',
    '2': 'START_FINISH',
    '3': 'START_START',
  };

  for (const [code, sequenceType] of Object.entries(expected)) {
    it(`maps Type ${code} to ${sequenceType}`, () => {
      const xml = `<Project><Tasks>
        ${task('<UID>1</UID><Name>Pred</Name><OutlineLevel>1</OutlineLevel>')}
        ${task(
          `<UID>2</UID><Name>Succ</Name><OutlineLevel>1</OutlineLevel>` +
            `<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>${code}</Type></PredecessorLink>`,
        )}
      </Tasks></Project>`;
      const result = parseMspdi(xml);
      const succ = result.rows.find(r => r.sourceId === '2')!;
      assert.strictEqual(succ.dependencies[0]!.type, sequenceType);
    });
  }
});

describe('parseMspdi — PredecessorLink missing PredecessorUID', () => {
  it('warns and drops the link rather than silently dropping it (regression)', () => {
    // Bug: a PredecessorLink with no PredecessorUID child was skipped with
    // `continue` and no warning at all -- the same "report, don't silently
    // drop data" standard already applied to an unrecognised Type code or
    // an unconvertible percent LagFormat.
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Pred</Name><OutlineLevel>1</OutlineLevel>')}
      ${task(
        '<UID>2</UID><Name>Succ</Name><OutlineLevel>1</OutlineLevel>' +
          '<PredecessorLink><Type>1</Type><LinkLag>600</LinkLag></PredecessorLink>',
      )}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    const succ = result.rows.find(r => r.sourceId === '2')!;
    assert.strictEqual(succ.dependencies.length, 0);
    assert.ok(
      result.warnings.some(w => w.code === 'unparsable-predecessor' && /PredecessorUID/.test(w.message)),
    );
  });
});

describe('parseMspdi — namespaced documents', () => {
  it('reads tasks when the root declares a default MSPDI namespace', () => {
    const xml = `<Project xmlns="http://schemas.microsoft.com/project">
      <Name>Namespaced</Name>
      <Tasks>
        ${task('<UID>1</UID><Name>Only Task</Name><OutlineLevel>1</OutlineLevel>')}
      </Tasks>
    </Project>`;
    const result = parseMspdi(xml);
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0]!.name, 'Only Task');
  });
});

describe('parseMspdi — LagFormat (percent) handling', () => {
  it('drops the lag but keeps the dependency edge for LagFormat 19 (percent)', () => {
    // Regression: LinkLag under LagFormat 19/20 is tenths-of-a-percent of
    // the predecessor's duration, not a time unit — <LinkLag>200</LinkLag>
    // with <LagFormat>19</LagFormat> means 20%, not "200 * 6 seconds".
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Pred</Name><OutlineLevel>1</OutlineLevel>')}
      ${task(
        '<UID>2</UID><Name>Succ</Name><OutlineLevel>1</OutlineLevel>' +
          '<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type>' +
          '<LinkLag>200</LinkLag><LagFormat>19</LagFormat></PredecessorLink>',
      )}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    const succ = result.rows.find(r => r.sourceId === '2')!;
    assert.strictEqual(succ.dependencies.length, 1);
    assert.strictEqual(succ.dependencies[0]!.predecessorSourceId, '1');
    assert.strictEqual(succ.dependencies[0]!.lagSeconds, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-predecessor' && /lag format 19/.test(w.message)));
  });

  it('drops the lag for LagFormat 20 (elapsed percent) too', () => {
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Pred</Name><OutlineLevel>1</OutlineLevel>')}
      ${task(
        '<UID>2</UID><Name>Succ</Name><OutlineLevel>1</OutlineLevel>' +
          '<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type>' +
          '<LinkLag>500</LinkLag><LagFormat>20</LagFormat></PredecessorLink>',
      )}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    const succ = result.rows.find(r => r.sourceId === '2')!;
    assert.strictEqual(succ.dependencies[0]!.lagSeconds, undefined);
  });

  it('drops the lag for LagFormat 51/52 ("estimated" percent variants) too', () => {
    // 51/52 are the same tenths-of-a-percent units as 19/20, just with
    // Project's "estimated" duration flag also set — same conversion
    // problem, easy to miss if only 19/20 are matched.
    for (const lagFormat of ['51', '52']) {
      const xml = `<Project><Tasks>
        ${task('<UID>1</UID><Name>Pred</Name><OutlineLevel>1</OutlineLevel>')}
        ${task(
          '<UID>2</UID><Name>Succ</Name><OutlineLevel>1</OutlineLevel>' +
            '<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type>' +
            `<LinkLag>300</LinkLag><LagFormat>${lagFormat}</LagFormat></PredecessorLink>`,
        )}
      </Tasks></Project>`;
      const result = parseMspdi(xml);
      const succ = result.rows.find(r => r.sourceId === '2')!;
      assert.strictEqual(succ.dependencies.length, 1, `LagFormat ${lagFormat}: dependency edge kept`);
      assert.strictEqual(succ.dependencies[0]!.lagSeconds, undefined, `LagFormat ${lagFormat}: lag dropped`);
      assert.ok(
        result.warnings.some(w => w.code === 'unparsable-predecessor' && w.message.includes(`lag format ${lagFormat}`)),
        `LagFormat ${lagFormat}: warns`,
      );
    }
  });

  it('still converts a normal (non-percent) LagFormat as before', () => {
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Pred</Name><OutlineLevel>1</OutlineLevel>')}
      ${task(
        '<UID>2</UID><Name>Succ</Name><OutlineLevel>1</OutlineLevel>' +
          '<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type>' +
          '<LinkLag>600</LinkLag><LagFormat>7</LagFormat></PredecessorLink>',
      )}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    const succ = result.rows.find(r => r.sourceId === '2')!;
    assert.strictEqual(succ.dependencies[0]!.lagSeconds, 3600);
  });
});

describe('parseMspdi — warning parity with the CSV path', () => {
  it('warns unparsable-date on an unreadable Start value instead of dropping it silently', () => {
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Task A</Name><OutlineLevel>1</OutlineLevel><Start>not-a-date</Start>')}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    assert.strictEqual(result.rows[0]!.start, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-date'));
  });

  it('warns unparsable-date on an unreadable Finish value', () => {
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Task A</Name><OutlineLevel>1</OutlineLevel><Finish>garbage</Finish>')}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    assert.strictEqual(result.rows[0]!.finish, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-date'));
  });

  it('warns unparsable-duration on an unreadable Duration value', () => {
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Task A</Name><OutlineLevel>1</OutlineLevel><Duration>garbage</Duration>')}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    assert.strictEqual(result.rows[0]!.durationIso, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-duration'));
  });

  it('does not warn when Start/Finish/Duration are simply absent', () => {
    const xml = `<Project><Tasks>
      ${task('<UID>1</UID><Name>Task A</Name><OutlineLevel>1</OutlineLevel>')}
    </Tasks></Project>`;
    const result = parseMspdi(xml);
    assert.ok(!result.warnings.some(w => w.code === 'unparsable-date' || w.code === 'unparsable-duration'));
  });
});

describe('parseMspdi — error handling', () => {
  it('throws on malformed XML', () => {
    assert.throws(() => parseMspdi('<Project><Tasks><Task>'), /valid XML/);
  });

  it('throws on a well-formed document with no <Task> elements', () => {
    assert.throws(() => parseMspdi('<Project><Tasks></Tasks></Project>'), /No <Task> elements/);
  });

  it('throws when the file only carries the UID 0 summary row', () => {
    const xml = `<Project><Tasks>${task('<UID>0</UID><Name>Summary</Name>')}</Tasks></Project>`;
    assert.throws(() => parseMspdi(xml), /project summary row/);
  });
});
