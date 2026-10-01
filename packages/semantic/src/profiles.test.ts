/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { assertProfile, DEFAULT_PROFILE, type ProfileDefinition } from './profiles.js';
import { generateArtifacts } from './profile-artifacts.js';
import { parseProfileDocument, validateJson, validateLinks, toRdf, validateGraph } from './validation.js';
import { profileToDictionary, dictionaryToProfile } from './dictionary.js';
import { profileFromBsdd } from './bsdd.js';
import { LIMITS } from './types.js';
const profile = (): ProfileDefinition => ({ id: 'https://example.org/profile/2', version: '2', vocabulary: 'https://example.org/vocab#',
  fields: { label: { iri: 'https://example.org/vocab#label', kind: 'string' },
    labels: { iri: 'https://example.org/vocab#labels', kind: 'language' },
    value: { iri: 'https://example.org/vocab#value', kind: 'number', minimum: 0, maximum: 10, unit: 'm' },
    tags: { iri: 'https://example.org/vocab#tags', kind: 'string', enum: ['a', 'b'] },
    enabled: { iri: 'https://example.org/vocab#enabled', kind: 'boolean' },
    link: { iri: 'https://example.org/vocab#link', kind: 'iri', targetType: 'Thing' } },
  types: { Thing: { iri: 'https://example.org/vocab#Thing', fields: { label: { minCount: 1 }, labels: {}, value: { minCount: 1 }, tags: { minCount: 1, maxCount: 2 }, enabled: {}, link: {} } } } });
const document = () => ({ profile: profile().id, source: 'https://example.org/data', completeness: 'complete' as const,
  resources: [{ id: 'https://example.org/a', type: 'Thing', label: 'A', labels: { en: 'English', de: 'Deutsch' }, value: 2.5, tags: ['a', 'b'], enabled: true }] });
describe('charter #6643 shared profile standards', () => {
  it('review: rejects unknown profile members and inconsistent common label cardinalities', () => {
    const original = profile();
    for (const invalid of [
      { ...original, bearer: 'secret' },
      { ...original, fields: { ...original.fields, value: { ...original.fields.value, secret: 'token' } } },
      { ...original, types: { Thing: { ...original.types.Thing, inferredRelations: [] } } },
      { ...original, types: { Thing: { ...original.types.Thing, fields: { ...original.types.Thing.fields, label: { minCount: 0 } } } } },
      { ...original, types: { Thing: { ...original.types.Thing, fields: { ...original.types.Thing.fields, label: { minCount: 1, maxCount: 2 } } } } },
      { ...original, types: { Thing: { ...original.types.Thing, fields: { ...original.types.Thing.fields, value: { minCount: 1, unsupported: true } } } } },
    ]) expect(() => assertProfile(invalid)).toThrow(/Unsupported|exactly one/);
  });
  it('review: caps JSON and link findings before aggregation on bounded large submissions', () => {
    const p = profile(); const doc = parseProfileDocument({ ...document(), resources: Array.from({ length: 1500 }, (_, index) => ({
      id: `https://example.org/${index}`, type: 'Thing', label: 'Item', link: 'https://example.org/missing' })) }, p);
    expect(validateJson(doc, p)).toHaveLength(LIMITS.findings);
    expect(validateLinks(doc, p)).toHaveLength(LIMITS.findings);
  });
  it('review: narrow integer profile values stay within exact JSON numbers and valid RDF integer lexical forms', async () => {
    const p = profile(); p.fields.count = { iri: p.vocabulary + 'count', kind: 'integer' }; p.types.Thing.fields.count = {};
    const valid = parseProfileDocument({ ...document(), resources: [{ ...document().resources[0], count: Number.MAX_SAFE_INTEGER }] }, p);
    expect(validateJson(valid, p)).toEqual([]);
    const validRdf = await toRdf(valid, p);
    expect(await validateGraph(validRdf, p)).toEqual([]);
    expect(await validateGraph(validRdf.replace(String(Number.MAX_SAFE_INTEGER), '9007199254740992'), p)).toEqual([expect.objectContaining({ path: p.fields.count.iri })]);
    for (const count of [1e21, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(() => parseProfileDocument({ ...document(), resources: [{ ...document().resources[0], count }] }, p)).toThrow();
    }
    expect(() => assertProfile({ ...p, fields: { ...p.fields, count: { ...p.fields.count, maximum: 1e21 } } })).toThrow('safe integers');
    expect(() => assertProfile({ ...p, fields: { ...p.fields, count: { ...p.fields.count, enum: [1e21] } } })).toThrow('Enum values');
  });
  it('generates equivalent bounded JSON/RDF constraints, preserves language tags and primitive datatypes', async () => {
    const p = profile(); const doc = parseProfileDocument(document(), p); expect(validateJson(doc, p)).toEqual([]);
    const rdf = await toRdf(doc, p); expect(await validateGraph(rdf, p)).toEqual([]);
    const quads = new Parser().parse(rdf);
    expect(quads.filter(q => q.predicate.value.endsWith('#labels')).map(q => q.object)).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: 'en', value: 'English' }), expect.objectContaining({ language: 'de', value: 'Deutsch' })]));
    expect(quads.find(q => q.predicate.value.endsWith('#enabled'))?.object).toMatchObject({ datatype: { value: 'http://www.w3.org/2001/XMLSchema#boolean' } });
    const artifacts = await generateArtifacts(p); expect(artifacts.dictionary.version).toBe('2');
    expect(new Parser().parse(artifacts.vocabulary).length).toBeGreaterThan(5);
  });
  it('reports number bounds and required cardinalities in both engines', async () => {
    const input = document(); input.resources[0].value = -1; input.resources[0].tags = [];
    const doc = parseProfileDocument(input, profile()); expect(validateJson(doc, profile()).map(f => f.path)).toEqual(expect.arrayContaining(['/value', '/tags']));
    const findings = await validateGraph(await toRdf(doc, profile()), profile());
    expect(findings.map(f => f.path)).toEqual(expect.arrayContaining(['https://example.org/vocab#value', 'https://example.org/vocab#tags']));
  });
  it('rejects unknown keys, duplicate identifiers and incorrect primitive types before graph conversion', () => {
    expect(() => parseProfileDocument({ ...document(), resources: [{ ...document().resources[0], unknown: 1 }] }, profile())).toThrow();
    expect(() => parseProfileDocument({ ...document(), resources: [document().resources[0], document().resources[0]] }, profile())).toThrow('Duplicate');
    expect(() => parseProfileDocument({ ...document(), resources: [{ ...document().resources[0], value: '2.5' }] }, profile())).toThrow();
    expect(() => parseProfileDocument({ ...document(), resources: [{ ...document().resources[0], id: 'https://example.org/a>' }] }, profile())).toThrow();
  });
  it('checks internal relation types in partial submissions and absence only for complete submissions', () => {
    const input = { ...document(), resources: [{ ...document().resources[0], link: 'https://example.org/missing' }] };
    expect(validateLinks(parseProfileDocument(input, profile()), profile())).toHaveLength(1);
    expect(validateLinks(parseProfileDocument({ ...input, completeness: 'partial' }, profile()), profile())).toEqual([]);
    const p = profile(); p.types.Other = { iri: p.vocabulary + 'Other', fields: { label: { minCount: 1 } } };
    const doc = parseProfileDocument({ ...input, completeness: 'partial', resources: [...input.resources, { id: 'https://example.org/missing', type: 'Other', label: 'Wrong type' }] }, p);
    expect(validateLinks(doc, p)[0].message).toContain('Expected Thing');
  });
  it('keeps the original DBL/DPP exchange readable and allows the second numeric projection', async () => {
    const doc = parseProfileDocument({ profile: DEFAULT_PROFILE.id, source: 'https://example.org/data', completeness: 'partial', resources: [
      { id: 'https://example.org/product', type: 'Product', label: 'Wall', granularity: 'item', thermalTransmittance: 0.3 }] });
    expect(validateJson(doc)).toEqual([]); expect(await validateGraph(await toRdf(doc))).toEqual([]);
  });
  it('roundtrips supported dictionary constraints and preserves unsupported relationships without inferring IFC links', () => {
    const original = profileToDictionary(profile(), [{ relation: 'arbitrary', target: 'https://example.org/external' }]);
    const result = dictionaryToProfile(original); expect(result.profile).toEqual(profile()); expect(result.raw).toEqual(original);
    expect(result.diagnostics).toHaveLength(1); expect(profileToDictionary(result.profile, result.raw.unsupported)).toEqual(original);
  });
  it('rejects executable shapes, cycles, complex paths, oversized inputs and zero-target validations', async () => {
    const rdf = await toRdf(parseProfileDocument(document(), profile()), profile());
    for (const shapes of [
      '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:s> sh:sparql [sh:select "SELECT * {}"].',
      '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:s> sh:path [sh:inversePath <urn:p>].',
      '@prefix sh:<http://www.w3.org/ns/shacl#>. @prefix rdf:<http://www.w3.org/1999/02/22-rdf-syntax-ns#>. <urn:s> sh:in _:a. _:a rdf:first "x";rdf:rest _:a.',
    ]) await expect(validateGraph(rdf, { profile: profile(), shapes })).rejects.toThrow();
    await expect(validateGraph(rdf, { profile: profile(), maxBytes: 2 })).rejects.toThrow('byte limit');
    await expect(validateGraph(rdf, { profile: profile(), maxQuads: 2 })).rejects.toThrow('quad limit');
    await expect(validateGraph('<urn:a> <urn:p> "x".', profile())).rejects.toThrow('No targets');
  });
  it('consumes a versioned bSDD provider, keeps unsupported metadata and typed allowed values', async () => {
    const raw = { uri: 'https://example.org/class', code: 'Wall', name: 'Wall', definition: null, parentClassUri: 'https://example.org/parent', relatedIfcEntityNames: ['IfcWall'],
      classProperties: [ { uri: 'https://example.org/height', name: 'height', description: null, dataType: 'Real', propertySet: null, allowedValues: [{ value: '2.5' }], units: ['m'] },
        { uri: 'https://example.org/complex', name: 'complex', description: null, dataType: 'Complex', propertySet: null, allowedValues: null, units: null } ] };
    const result = await profileFromBsdd({ fetchClassByUri: async () => raw }, raw.uri, { id: 'https://example.org/profile/bsdd', version: '1', vocabulary: 'https://example.org/bsdd#' });
    expect(result.raw).toEqual(raw); expect(result.profile.fields.height).toMatchObject({ kind: 'number', enum: [2.5], unit: 'm' });
    expect(result.diagnostics).toHaveLength(2);
    const doc = parseProfileDocument({ profile: result.profile.id, source: raw.uri, completeness: 'partial', resources: [{ id: 'https://example.org/wall', type: 'Wall', label: 'Wall', height: 3 }] }, result.profile);
    expect(validateJson(doc, result.profile)[0].path).toBe('/height');
    const allowed = parseProfileDocument({ ...doc, resources: [{ ...doc.resources[0], height: 2.5 }] }, result.profile);
    expect(await validateGraph(await toRdf(allowed, result.profile), result.profile)).toEqual([]);
    const unsupported = { ...raw, classProperties: [{ ...raw.classProperties[0], dataType: 'Integer', allowedValues: [{ value: '1e21' }, { value: '' }] }] };
    const partial = await profileFromBsdd({ fetchClassByUri: async () => unsupported }, raw.uri, { id: 'https://example.org/profile/bsdd', version: '1', vocabulary: 'https://example.org/bsdd#' });
    expect(partial.profile.fields.height.enum).toBeUndefined();
    expect(partial.raw.classProperties[0].allowedValues).toEqual(unsupported.classProperties[0].allowedValues);
    expect(partial.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining('Unsupported bSDD enumeration')]));
  });
});
