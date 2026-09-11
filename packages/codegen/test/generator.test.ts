/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the top-level generator orchestration (generateFromSchema).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFromSchema } from '../src/generator.js';

describe('generateFromSchema — CRLF line endings (#4220)', () => {
  let outputDir: string;

  afterEach(() => {
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
  });

  it('should not leak a stray \\r into generated code for a CRLF-sourced schema', () => {
    // Built programmatically (not committed as a file) so no editor or git
    // normalization can strip the \r before it reaches the generator under
    // test — a CRLF .exp file read straight off disk, before it is ever
    // `git add`-ed, is exactly the case this reproduces.
    const crlfSchema = [
      'SCHEMA TEST;',
      '',
      'TYPE IfcActionRequestTypeEnum = ENUMERATION OF',
      '  (EMAIL',
      '  ,FAX',
      '  ,USERDEFINED',
      '  ,NOTDEFINED);',
      'END_TYPE;',
      '',
      'ENTITY IfcWall',
      '  SUBTYPE OF (IfcElement);',
      'END_ENTITY;',
      '',
      'END_SCHEMA;',
    ].join('\r\n');
    expect(crlfSchema).toContain('\r\n');

    outputDir = mkdtempSync(join(tmpdir(), 'ifc-codegen-4220-'));
    const code = generateFromSchema(crlfSchema, outputDir, { skipCollisionCheck: true });

    expect(code.schemaRegistry).toContain('IfcActionRequestTypeEnum');
    expect(code.schemaRegistry).not.toContain('\r');
    expect(code.entities).not.toContain('\r');
    expect(code.types).not.toContain('\r');
  });

  it('should produce identical output for LF and CRLF versions of the same schema', () => {
    const lfSchema = [
      'SCHEMA TEST;',
      '',
      'TYPE IfcActionRequestTypeEnum = ENUMERATION OF',
      '  (EMAIL',
      '  ,FAX',
      '  ,USERDEFINED',
      '  ,NOTDEFINED);',
      'END_TYPE;',
      '',
      'ENTITY IfcWall',
      '  SUBTYPE OF (IfcElement);',
      'END_ENTITY;',
      '',
      'END_SCHEMA;',
    ].join('\n');
    const crlfSchema = lfSchema.replace(/\n/g, '\r\n');

    const lfOut = mkdtempSync(join(tmpdir(), 'ifc-codegen-4220-lf-'));
    const crlfOut = mkdtempSync(join(tmpdir(), 'ifc-codegen-4220-crlf-'));
    try {
      const lfCode = generateFromSchema(lfSchema, lfOut, { skipCollisionCheck: true });
      const crlfCode = generateFromSchema(crlfSchema, crlfOut, { skipCollisionCheck: true });

      expect(crlfCode.schemaRegistry).toBe(lfCode.schemaRegistry);
      expect(crlfCode.entities).toBe(lfCode.entities);
      expect(crlfCode.types).toBe(lfCode.types);
      expect(crlfCode.enums).toBe(lfCode.enums);
      expect(crlfCode.selects).toBe(lfCode.selects);
    } finally {
      rmSync(lfOut, { recursive: true, force: true });
      rmSync(crlfOut, { recursive: true, force: true });
    }
  });
});
