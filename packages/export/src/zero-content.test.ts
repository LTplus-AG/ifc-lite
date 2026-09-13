/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for the JSON-LD / STEP content counters (#4659), mirroring
 * `obj.test.ts` and `glb.test.ts`. The cases that matter are the ones the CLI
 * guard depends on: a document that is well-formed and non-empty as BYTES but
 * carries no entities must count zero.
 */

import { describe, it, expect } from 'vitest';
import { countJsonldNodes, countStepEntities } from './zero-content.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('countJsonldNodes', () => {
  it('counts the @graph nodes', () => {
    expect(
      countJsonldNodes(bytes('{"@context":{},"@graph":[{"@id":"ifc:1"},{"@id":"ifc:2"}]}')),
    ).toBe(2);
  });

  it('returns 0 for a valid document with an empty graph', () => {
    // The exact shape the Rust exporter emits for an active-but-empty
    // isolation set: 100+ bytes, valid JSON, and no entities.
    const empty = '{"@context":{"@vocab":"https://example.org/OWL#"},"@graph":[]}';
    expect(empty.length).toBeGreaterThan(0);
    expect(countJsonldNodes(bytes(empty))).toBe(0);
  });

  it('does not count nested @id occurrences as nodes', () => {
    // One node carrying a property set that also has an `@id`: a textual
    // `"@id"` tally would report 2 and let a one-entity export look bigger.
    const doc = '{"@graph":[{"@id":"ifc:1","ifc:hasPropertySets":[{"@id":"ifc:9"}]}]}';
    expect(countJsonldNodes(bytes(doc))).toBe(1);
  });

  it('returns 0 for a missing or non-array graph, malformed JSON, and non-UTF-8 bytes', () => {
    expect(countJsonldNodes(bytes('{"@context":{}}'))).toBe(0);
    expect(countJsonldNodes(bytes('{"@graph":{"@id":"ifc:1"}}'))).toBe(0);
    expect(countJsonldNodes(bytes('[]'))).toBe(0);
    expect(countJsonldNodes(bytes('not json'))).toBe(0);
    expect(countJsonldNodes(new Uint8Array(0))).toBe(0);
    expect(countJsonldNodes(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(0);
  });
});

describe('countStepEntities', () => {
  const HEADER =
    "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
  const FOOTER = 'ENDSEC;\nEND-ISO-10303-21;\n';

  it('counts entity instances', () => {
    expect(
      countStepEntities(bytes(`${HEADER}#1=IFCWALL($);\n#2=IFCSLAB($);\n${FOOTER}`)),
    ).toBe(2);
  });

  it('returns 0 for a header-only file with an empty DATA section', () => {
    // What the STEP writer emits for an active-but-empty isolation set: a
    // valid, several-hundred-byte file describing nothing.
    const empty = HEADER + FOOTER;
    expect(empty.length).toBeGreaterThan(0);
    expect(countStepEntities(bytes(empty))).toBe(0);
  });

  it('does not count `#id` references inside an attribute list', () => {
    // One instance referencing three others that are not themselves written.
    expect(
      countStepEntities(bytes(`${HEADER}#1=IFCWALL(#2,#3,#4);\n${FOOTER}`)),
    ).toBe(1);
  });

  it('returns 0 for empty and non-UTF-8 bytes', () => {
    expect(countStepEntities(new Uint8Array(0))).toBe(0);
    expect(countStepEntities(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(0);
  });
});
