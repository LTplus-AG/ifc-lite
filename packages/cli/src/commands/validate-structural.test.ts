/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite validate` reports where the physical model and the structural
 * analysis model disagree (#9668). The rules are tested in `@ifc-lite/parser`;
 * this file pins that validate runs them and names the entity. Expected ids
 * come from an independent ifcopenshell pass.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { computeValidationIssues } from './validate.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tests/models/ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc');

describe('validate: structural consistency', () => {
  it('IFC4: reports the six unlinked load-bearing elements of ISSUE_171 as warnings with their GlobalIds', async (ctx) => {
    if (!existsSync(FIXTURE)) ctx.skip('ISSUE_171 fixture missing — run `pnpm fixtures`');
    const bytes = readFileSync(FIXTURE);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const issues = computeValidationIssues(await new IfcParser().parseColumnar(buffer)).filter((issue) => issue.rule.startsWith('structural-'));
    expect(issues.map((issue) => [issue.rule, issue.entityId])).toEqual(
      [49, 1500, 2222, 2837, 3327, 3441].map((id) => ['structural-unlinked-element', id]));
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(issues[0].globalId).toBe('1SbQ76Ea9FQOHIEX6qOPFO');
  });
});
