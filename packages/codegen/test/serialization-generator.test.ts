/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The STEP serializer LOGIC lives once in `@ifc-lite/data`. The per-schema
 * bundle that codegen emits must be a thin re-export + registry binding, never
 * an inlined copy — otherwise the copies can silently drift (which is exactly
 * the bug this refactor removed). These tests fail if anyone re-inlines logic.
 */

import { describe, it, expect } from 'vitest';
import type { ExpressSchema } from '../src/express-parser.js';
import { generateSerializers } from '../src/serialization-generator.js';

const STUB_SCHEMA: ExpressSchema = {
  name: 'IFC_TEST_SCHEMA',
  entities: [],
  types: [],
  enums: [],
  selects: [],
};

describe('generateSerializers', () => {
  const out = generateSerializers(STUB_SCHEMA);

  it('re-exports the shared serializer from @ifc-lite/data', () => {
    expect(out).toContain("from '@ifc-lite/data'");
    expect(out).toContain('toStepLineWithRegistry');
    expect(out).toContain('generateStepFileWithRegistry');
  });

  it('binds the bundle SCHEMA_REGISTRY to the registry-coupled helpers', () => {
    expect(out).toContain("import { SCHEMA_REGISTRY } from './schema-registry.js'");
    expect(out).toContain('toStepLineWithRegistry(SCHEMA_REGISTRY, entity)');
  });

  it('still surfaces the full public serializer API', () => {
    for (const sym of [
      'serializeValue',
      'generateHeader',
      'parseStepValue',
      'ref',
      'enumVal',
      'isEntityRef',
      'isEnumValue',
      'toStepLine',
      'generateStepFile',
    ]) {
      expect(out).toContain(sym);
    }
  });

  it('does NOT inline serializer logic (must stay a thin re-export)', () => {
    // The header/escape/parse implementations belong to @ifc-lite/data only.
    expect(out).not.toContain('function escapeStepString');
    expect(out).not.toContain('FILE_DESCRIPTION');
    expect(out).not.toContain("'.T.'"); // serializeValue boolean branch
    expect(out).not.toContain('function parseStepList');
  });

  it('stamps the schema name in the banner', () => {
    expect(out).toContain('Generated from EXPRESS schema: IFC_TEST_SCHEMA');
  });
});
