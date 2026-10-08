/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS authoring tools, batch 2 (IDS-119), through the real MCP server:
 * `ids_diff` works; the model-loop and test-suite tools answer
 * UNSUPPORTED_OPERATION with their final input schemas.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import { liveToolSession } from '../test/live-tool-session.js';

let session: Awaited<ReturnType<typeof liveToolSession>>;
beforeAll(async () => {
  session = await liveToolSession(1);
});

const BEFORE = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>t</title></info><specifications>
<specification name="Walls are named" ifcVersion="IFC4"><applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements><attribute cardinality="optional"><name><simpleValue>Name</simpleValue></name></attribute></requirements></specification>
</specifications></ids>`;

const structured = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

describe('ids_diff', () => {
  it('reports one change for a requirement made required', async () => {
    const r = await session.call('ids_diff', { before_xml: BEFORE, after_xml: BEFORE.replace('cardinality="optional"', 'cardinality="required"') });
    expect(r.isError).toBeFalsy();
    expect(structured(r).identical).toBe(false);
    expect(structured(r).entries).toEqual([
      expect.objectContaining({ change: 'changed', field: 'optionality', before: 'optional', after: 'required', path: 'specifications[0].requirements[0]' }),
    ]);
  });

  it('reports identical documents', async () => {
    const r = await session.call('ids_diff', { before_xml: BEFORE, after_xml: BEFORE });
    expect(structured(r)).toMatchObject({ identical: true, entries: [] });
  });

  it('names the side that does not parse', async () => {
    const r = await session.call('ids_diff', { before_xml: BEFORE, after_xml: '<ids' });
    expect(r.isError).toBe(true);
    expect(structured(r)).toMatchObject({ code: 'PARSE_FAILED' });
    expect(structured(r).message).toMatch(/after IDS/);
  });

  it('asks for both sides', async () => {
    const r = await session.call('ids_diff', { before_xml: BEFORE });
    expect(r.isError).toBe(true);
    expect(structured(r).message).toMatch(/after_xml or after_path/);
  });
});

describe('model-loop and test-suite tools', () => {
  it.each([
    ['ids_preview', { ids_xml: BEFORE }],
    ['ids_infer', { select: 'IfcWall' }],
    ['ids_coverage', { ids_xml: BEFORE }],
    ['ids_test', { idsz_path: 'suite.idsz' }],
  ])('%s says it is not available yet', async (name, args) => {
    const r = await session.call(name, args);
    expect(r.isError).toBe(true);
    expect(structured(r).code).toBe('UNSUPPORTED_OPERATION');
    expect(structured(r).message).toMatch(/not available in this release/);
  });
});
