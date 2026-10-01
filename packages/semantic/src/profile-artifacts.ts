/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DataFactory, Writer } from 'n3';
import type { ContextDefinition } from 'jsonld';
import { assertProfile, DEFAULT_PROFILE, type ProfileDefinition, type ProfileField } from './profiles.js';
import { profileToDictionary } from './dictionary.js';
const { namedNode: n, literal: l, blankNode: b } = DataFactory;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const datatype = (field: ProfileField) => field.kind === 'language' ? RDF + 'langString' : XSD + (field.kind === 'number' ? 'double' : field.kind === 'integer' ? 'integer' : field.kind === 'boolean' ? 'boolean' : 'string');
// JSON-LD 1.1 serializes double values in canonical scientific notation. sh:in
// uses RDF term equality, so enums must use the identical lexical representation.
const rdfValue = (field: ProfileField, value: string | number | boolean) => field.kind === 'iri' ? n(String(value))
  : l(field.kind === 'number' && typeof value === 'number' ? value.toExponential(15).replace(/(\d)0*e\+?/, '$1E') : String(value), n(datatype(field)));
const valueBounds = (field: ProfileField) => ({
  minimum: field.minimum ?? (field.kind === 'integer' ? Number.MIN_SAFE_INTEGER : undefined),
  maximum: field.maximum ?? (field.kind === 'integer' ? Number.MAX_SAFE_INTEGER : undefined),
});
function scalarSchema(field: ProfileField) {
  const bounds = valueBounds(field);
  return field.kind === 'language' ? { type: 'object', minProperties: 1, additionalProperties: false,
    patternProperties: { '^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$': { type: 'string', maxLength: 65536 } } }
    : { type: field.kind === 'iri' ? 'string' : field.kind, ...(['iri', 'string'].includes(field.kind) ? { maxLength: 65536 } : {}), ...(field.kind === 'iri' ? { format: 'uri' } : {}),
      ...(field.enum ? { enum: field.enum } : {}), ...(field.pattern ? { pattern: field.pattern } : {}),
      ...(bounds.minimum !== undefined ? { minimum: bounds.minimum } : {}), ...(bounds.maximum !== undefined ? { maximum: bounds.maximum } : {}) };
}
export function resourceSchema(type: string, profile = DEFAULT_PROFILE, structural = false) {
  assertProfile(profile);
  const definition = profile.types[type];
  if (!definition) throw new Error(`Unknown resource type: ${type}`);
  return { type: 'object', additionalProperties: false, required: [...new Set(['id', 'type', 'label',
    ...(!structural ? Object.entries(definition.fields).filter(([, count]) => (count.minCount ?? 0) > 0).map(([key]) => key) : [])])],
    properties: { id: { type: 'string', format: 'uri' }, type: { const: type },
      ...Object.fromEntries(Object.entries(definition.fields).map(([key, count]) => {
        const original = profile.fields[key];
        const scalar = scalarSchema(structural ? { iri: original.iri, kind: original.kind } : original);
        return [key, (count.maxCount ?? 1) > 1 ? { type: 'array', uniqueItems: true, items: scalar, maxItems: count.maxCount,
          ...(!structural ? { minItems: count.minCount ?? 0 } : {}) } : scalar];
      })) } };
}
export function exchangeSchema(profile = DEFAULT_PROFILE, structural = false) {
  assertProfile(profile);
  return { $id: profile.id, type: 'object', additionalProperties: false, required: ['profile', 'source', 'completeness', 'resources'],
    properties: { profile: { const: profile.id }, source: { type: 'string', format: 'uri' }, completeness: { enum: ['complete', 'partial'] },
      resources: { type: 'array', maxItems: 5000, items: { oneOf: Object.keys(profile.types).map(type => resourceSchema(type, profile, structural)) } } } };
}
export function profileContext(profile = DEFAULT_PROFILE): ContextDefinition {
  assertProfile(profile);
  return { id: '@id', type: '@type', ...Object.fromEntries(Object.entries(profile.types).map(([key, value]) => [key, value.iri])),
    ...Object.fromEntries(Object.entries(profile.fields).map(([key, field]) => [key,
      field.kind === 'iri' ? { '@id': field.iri, '@type': '@id' }
        : field.kind === 'language' ? { '@id': field.iri, '@container': '@language' }
          : field.kind === 'string' ? field.iri : { '@id': field.iri, '@type': datatype(field) }])) };
}
const finish = (writer: Writer): Promise<string> => new Promise((resolve, reject) => writer.end((error, value) => error ? reject(error) : resolve(value)));
export async function shapesTurtle(profile = DEFAULT_PROFILE): Promise<string> {
  assertProfile(profile);
  const writer = new Writer({ prefixes: { sh: SH, rdf: RDF, xsd: XSD } });
  const add = (subject: ReturnType<typeof n> | ReturnType<typeof b>, predicate: string, object: ReturnType<typeof n> | ReturnType<typeof b> | ReturnType<typeof l>) => writer.addQuad(subject, n(predicate), object);
  const list = (values: (ReturnType<typeof n> | ReturnType<typeof l>)[]) => {
    const cells = values.map(() => b());
    cells.forEach((cell, i) => { add(cell, RDF + 'first', values[i]); add(cell, RDF + 'rest', cells[i + 1] ?? n(RDF + 'nil')); });
    return cells[0] ?? n(RDF + 'nil');
  };
  for (const [key, definition] of Object.entries(profile.types)) {
    const shape = n(profile.vocabulary + key + 'Shape');
    add(shape, RDF + 'type', n(SH + 'NodeShape')); add(shape, SH + 'targetClass', n(definition.iri));
    add(shape, SH + 'closed', l('true', n(XSD + 'boolean'))); add(shape, SH + 'ignoredProperties', list([n(RDF + 'type')]));
    for (const [name, count] of Object.entries(definition.fields)) {
      const field = profile.fields[name]; const property = b();
      const bounds = valueBounds(field);
      add(shape, SH + 'property', property); add(property, SH + 'path', n(field.iri));
      add(property, SH + 'minCount', l(count.minCount ?? 0));
      if (field.kind !== 'language') add(property, SH + 'maxCount', l(count.maxCount ?? 1));
      else add(property, SH + 'uniqueLang', l('true', n(XSD + 'boolean')));
      add(property, field.kind === 'iri' ? SH + 'nodeKind' : SH + 'datatype', n(field.kind === 'iri' ? SH + 'IRI' : datatype(field)));
      if (field.targetType) add(property, SH + 'class', n(profile.types[field.targetType].iri));
      if (field.pattern) add(property, SH + 'pattern', l(field.pattern));
      if (bounds.minimum !== undefined) add(property, SH + 'minInclusive', l(String(bounds.minimum), n(datatype(field))));
      if (bounds.maximum !== undefined) add(property, SH + 'maxInclusive', l(String(bounds.maximum), n(datatype(field))));
      if (field.enum) add(property, SH + 'in', list(field.enum.map(value => rdfValue(field, value))));
    }
  }
  return finish(writer);
}
export async function vocabularyTurtle(profile = DEFAULT_PROFILE): Promise<string> {
  assertProfile(profile);
  const writer = new Writer({ prefixes: { rdf: RDF, rdfs: RDFS, xsd: XSD } });
  for (const [name, type] of Object.entries(profile.types)) {
    writer.addQuad(n(type.iri), n(RDF + 'type'), n(RDFS + 'Class'));
    for (const [language, label] of Object.entries(type.labels ?? { en: name })) writer.addQuad(n(type.iri), n(RDFS + 'label'), l(label, language));
  }
  for (const [name, field] of Object.entries(profile.fields)) {
    writer.addQuad(n(field.iri), n(RDF + 'type'), n(RDF + 'Property'));
    for (const [language, label] of Object.entries(field.labels ?? { en: name })) writer.addQuad(n(field.iri), n(RDFS + 'label'), l(label, language));
    writer.addQuad(n(field.iri), n(RDFS + 'range'), n(field.kind === 'iri' ? RDFS + 'Resource' : datatype(field)));
  }
  return finish(writer);
}
export async function generateArtifacts(profile: ProfileDefinition = DEFAULT_PROFILE) {
  const [shapes, vocabulary] = await Promise.all([shapesTurtle(profile), vocabularyTurtle(profile)]);
  return { schema: exchangeSchema(profile), context: profileContext(profile), shapes, vocabulary, dictionary: profileToDictionary(profile) };
}
