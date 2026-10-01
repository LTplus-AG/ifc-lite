/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it, expect } from 'vitest';
import { Parser } from 'n3';
import { parseGraph } from './graph-import.js';
import { createValidationReport } from './validation-report.js';
import { DEFAULT_PROFILE } from './profiles.js';
import { validateGraph } from './validation.js';
import { LIMITS } from './types.js';

it('charter #6643 review: explicit SHACL targets validate absent nodes and reject invalid work limits', async () => {
  const data = '<urn:unrelated> <urn:p> "x".';
  const shapes = '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:s> a sh:NodeShape;sh:targetNode <urn:absent>;sh:property [sh:path <urn:required>;sh:minCount 1].';
  expect(await validateGraph(data, { shapes })).toEqual([expect.objectContaining({ resourceId: 'urn:absent', path: 'urn:required', severity: 'Violation' })]);
  for (const invalid of [NaN, Infinity, -1, 0, 0.5]) {
    for (const key of ['maxBytes', 'maxQuads', 'maxErrors'] as const) await expect(validateGraph(data, { shapes, [key]: invalid })).rejects.toThrow('positive integers');
  }
  await expect(validateGraph(data, { shapes, maxErrors: LIMITS.findings + 1 })).rejects.toThrow('supported bounds');
});
it('charter #6643 review: local RDFS subclass membership matches SHACL class targets without OWL inference', async () => {
  const data = '@prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>. <urn:Child> rdfs:subClassOf <urn:Parent>. <urn:a> a <urn:Child>.';
  const shapes = '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:s> a sh:NodeShape;sh:targetClass <urn:Parent>;sh:property [sh:path <urn:required>;sh:minCount 1].';
  expect(await validateGraph(data, { shapes })).toEqual([expect.objectContaining({ resourceId: 'urn:a', path: 'urn:required', severity: 'Violation' })]);
  expect(await validateGraph(data + '<urn:a> <urn:required> "present".', { shapes })).toEqual([]);
});
it('charter #6643 review: subclass cycles, deep chains, exponential DAG walks and implicit class shapes fail explicitly', async () => {
  const shapes = '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:s> a sh:NodeShape;sh:targetClass <urn:Parent>;sh:property [sh:path <urn:required>;sh:minCount 1].';
  const prefix = '@prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>.';
  await expect(validateGraph(prefix + '<urn:Parent> rdfs:subClassOf <urn:Child>. <urn:Child> rdfs:subClassOf <urn:Parent>. <urn:a> a <urn:Child>.', { shapes })).rejects.toThrow('Cyclic RDFS');
  const deep = Array.from({ length: 65 }, (_, i) => `<urn:c${i}> rdfs:subClassOf <urn:c${i + 1}>.`).join('');
  await expect(validateGraph(prefix + deep, { shapes })).rejects.toThrow('depth');
  const dag = Array.from({ length: 17 }, (_, i) => `<urn:a${i}> rdfs:subClassOf <urn:a${i + 1}>,<urn:b${i + 1}>. <urn:b${i}> rdfs:subClassOf <urn:a${i + 1}>,<urn:b${i + 1}>.`).join('');
  await expect(validateGraph(prefix + dag, { shapes })).rejects.toThrow('work budget');
  const implicit = '@prefix sh:<http://www.w3.org/ns/shacl#>. @prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>. <urn:Parent> a sh:NodeShape,rdfs:Class;sh:property [sh:path <urn:required>;sh:minCount 1].';
  await expect(validateGraph('<urn:a> a <urn:Parent>.', { shapes: implicit })).rejects.toThrow('Implicit class shapes');
});
it('charter #6643 review: malformed constraint lists reject missing first entries even when no values would exercise the constraint', async () => {
  for (const predicate of ['in', 'ignoredProperties', 'languageIn']) {
    const shapes = `@prefix sh:<http://www.w3.org/ns/shacl#>. @prefix rdf:<http://www.w3.org/1999/02/22-rdf-syntax-ns#>.
      <urn:s> a sh:NodeShape;sh:targetNode <urn:a>;sh:property [sh:path <urn:absent>;sh:${predicate} _:a]. _:a rdf:rest _:a.`;
    await expect(validateGraph('<urn:a> <urn:p> "x".', { shapes })).rejects.toThrow('Malformed SHACL RDF list');
  }
});

it('charter #6643: Turtle and inline JSON-LD imports retain literal tags, datatypes, multi-values and named graphs', async () => {
  const turtle = await parseGraph('<urn:a> <urn:p> "English"@en, "Deutsch"@de; <urn:value> 2.5; <urn:related> _:related. _:related <urn:p> "Evidence".', { format: 'text/turtle' });
  expect(turtle.quadCount).toBe(5); expect(new Parser({ format: 'N-Quads' }).parse(turtle.graph).filter(q => q.object.termType === 'BlankNode')).toHaveLength(1);
  const json = { '@context': { label: 'urn:p' }, '@id': 'urn:graph', '@graph': [{ '@id': 'urn:a', label: [{ '@value': 'English', '@language': 'en' }, { '@value': 'Deutsch', '@language': 'de' }] }] };
  const imported = await parseGraph(json, { format: 'application/ld+json' });
  expect(imported.quadCount).toBe(2);
  const quads = new Parser({ format: 'N-Quads' }).parse(imported.graph);
  expect(quads.every(quad => quad.graph.value === 'urn:graph')).toBe(true);
  expect(quads.map(quad => quad.object)).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'English', language: 'en' }), expect.objectContaining({ value: 'Deutsch', language: 'de' })]));
  expect(await parseGraph(imported.graph, { format: 'application/n-quads' })).toEqual(imported);
});
it('charter #6643: graph import rejects remote/scoped contexts, imports and bounded input overflow before graph validation', async () => {
  for (const input of [{ '@context': 'https://example.org/context' }, { '@context': { term: { '@id': 'urn:p', '@context': 'https://example.org/context' } } }, { '@context': { '@import': 'https://example.org/context' } }]) {
    await expect(parseGraph(input, { format: 'application/ld+json' })).rejects.toThrow(/disabled|inline/);
  }
  await expect(parseGraph('<urn:a> <urn:p> "x".', { format: 'text/turtle', maxBytes: 2 })).rejects.toThrow('byte limit');
  await expect(parseGraph('<urn:a> <urn:p> "x", "y".', { format: 'text/turtle', maxQuads: 1 })).rejects.toThrow('quad limit');
});
it('charter #6643: validation reports carry profile/version, scope, completeness, focus/path/severity and bounded findings', async () => {
  const rdf = '<urn:a> <urn:p> "x".';
  const shapes = '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:shape> a sh:NodeShape; sh:targetNode <urn:a>; sh:property [sh:path <urn:required>;sh:minCount 1;sh:severity sh:Warning].';
  const findings = await validateGraph(rdf, { shapes });
  expect(findings[0]).toMatchObject({ resourceId: 'urn:a', path: 'urn:required', severity: 'Warning' });
  const report = createValidationReport({ profile: DEFAULT_PROFILE, scope: 'graph', completeness: 'partial', source: 'urn:source', findings, engines: ['SHACL'] });
  expect(report).toMatchObject({ profile: { id: DEFAULT_PROFILE.id, version: '1.0.0' }, scope: 'graph', completeness: 'partial', conforms: true, counts: { Warning: 1, Violation: 0, Info: 0 } });
  const bounded = createValidationReport({ scope: 'profile', completeness: 'complete', findings: [...findings, { engine: 'links', resourceId: 'urn:b', path: 'urn:r', message: 'Missing' }], limits: { findings: 1 } });
  expect(bounded.findings).toHaveLength(1); expect(bounded.truncated).toBe(true); expect(bounded.conforms).toBe(false); expect(bounded.counts.Violation).toBe(1);
});
