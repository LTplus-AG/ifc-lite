import { DataFactory, Writer } from 'n3';
import type { ContextDefinition } from 'jsonld';
import { PROFILE_ID, RESOURCE_TYPES, VOCAB, type ResourceType } from './types';

const { namedNode, literal, blankNode, quad } = DataFactory;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';
export const GUID_PATTERN = '^[0-3][0-9A-Za-z_$]{21}$';
export const fields = {
  label: { kind: 'literal' }, buildingId: { kind: 'iri' }, productId: { kind: 'iri' },
  passportId: { kind: 'iri' }, installationId: { kind: 'iri' }, evidenceId: { kind: 'iri' },
  replacesId: { kind: 'iri' }, dictionaryUri: { kind: 'iri' },
  GlobalId: { kind: 'literal', pattern: GUID_PATTERN }, modelRevision: { kind: 'iri' },
  granularity: { kind: 'literal', enum: ['model', 'batch', 'item'] }, fireRating: { kind: 'literal' },
} satisfies Record<string, { kind: string; pattern?: string; enum?: string[] }>;
export type FieldName = keyof typeof fields;
const common: FieldName[] = ['label', 'dictionaryUri', 'evidenceId'];
export const profiles: Record<ResourceType, { fields: FieldName[]; required: FieldName[] }> = {
  Building: { fields: common, required: ['label'] },
  Logbook: { fields: [...common, 'buildingId'], required: ['label', 'buildingId'] },
  Installation: { fields: [...common, 'buildingId', 'productId', 'replacesId', 'GlobalId', 'modelRevision'], required: ['label', 'buildingId', 'productId'] },
  Product: { fields: [...common, 'passportId', 'granularity', 'fireRating'], required: ['label', 'granularity'] },
  Passport: { fields: [...common, 'productId', 'granularity', 'fireRating'], required: ['label', 'productId', 'granularity'] },
  Inspection: { fields: [...common, 'installationId'], required: ['label', 'installationId'] },
};
export const context: ContextDefinition = {
  id: '@id', type: '@type',
  ...Object.fromEntries(RESOURCE_TYPES.map(type => [type, VOCAB + type])),
  ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
    field.kind === 'iri' ? { '@id': VOCAB + key, '@type': '@id' } : VOCAB + key])),
};
export function resourceSchema(type: ResourceType) {
  const profile = profiles[type];
  return {
    type: 'object', additionalProperties: false,
    required: ['id', 'type', ...profile.required],
    properties: {
      id: { type: 'string', format: 'uri' }, type: { const: type },
      ...Object.fromEntries(profile.fields.map(key => {
        const field = fields[key];
        return [key, { type: 'string', ...(field.kind === 'iri' ? { format: 'uri' } : {}),
          ...('pattern' in field ? { pattern: field.pattern } : {}), ...('enum' in field ? { enum: field.enum } : {}) }];
      })),
    },
  };
}
export const exchangeSchema = {
  $id: PROFILE_ID, type: 'object', additionalProperties: false,
  required: ['profile', 'source', 'completeness', 'resources'],
  properties: {
    profile: { const: PROFILE_ID }, source: { type: 'string', format: 'uri' },
    completeness: { enum: ['complete', 'partial'] },
    resources: { type: 'array', maxItems: 5000, items: { oneOf: RESOURCE_TYPES.map(resourceSchema) } },
  },
};

/** Generate SHACL Core from the same field definitions; no reasoning or graph imports. */
export async function shapesTurtle(): Promise<string> {
  const writer = new Writer({ prefixes: { pilot: VOCAB, sh: SH, rdf: RDF } });
  const add = (s: ReturnType<typeof namedNode> | ReturnType<typeof blankNode>, p: string, o: ReturnType<typeof namedNode> | ReturnType<typeof blankNode> | ReturnType<typeof literal>) => writer.addQuad(quad(s, namedNode(p), o));
  for (const type of RESOURCE_TYPES) {
    const shape = namedNode(VOCAB + type + 'Shape');
    add(shape, RDF + 'type', namedNode(SH + 'NodeShape'));
    add(shape, SH + 'targetClass', namedNode(VOCAB + type));
    add(shape, SH + 'closed', literal('true', namedNode('http://www.w3.org/2001/XMLSchema#boolean')));
    const ignored = blankNode();
    add(shape, SH + 'ignoredProperties', ignored);
    add(ignored, RDF + 'first', namedNode(RDF + 'type')); add(ignored, RDF + 'rest', namedNode(RDF + 'nil'));
    for (const key of profiles[type].fields) {
      const property = blankNode(); const field = fields[key];
      add(shape, SH + 'property', property); add(property, SH + 'path', namedNode(VOCAB + key));
      add(property, SH + 'maxCount', literal(1));
      if (profiles[type].required.includes(key)) add(property, SH + 'minCount', literal(1));
      if (field.kind === 'iri') add(property, SH + 'nodeKind', namedNode(SH + 'IRI'));
      else add(property, SH + 'datatype', namedNode('http://www.w3.org/2001/XMLSchema#string'));
      if ('pattern' in field) add(property, SH + 'pattern', literal(field.pattern));
      if ('enum' in field) {
        const cells = field.enum.map(() => blankNode());
        add(property, SH + 'in', cells[0]);
        cells.forEach((cell, i) => { add(cell, RDF + 'first', literal(field.enum[i])); add(cell, RDF + 'rest', cells[i + 1] ?? namedNode(RDF + 'nil')); });
      }
    }
  }
  return new Promise((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result)));
}

/** Descriptive RDFS vocabulary; validation stays in Schema / SHACL. */
export async function vocabularyTurtle(): Promise<string> {
  const rdfs = 'http://www.w3.org/2000/01/rdf-schema#';
  const writer = new Writer({ prefixes: { pilot: VOCAB, rdf: RDF, rdfs } });
  for (const type of RESOURCE_TYPES) {
    writer.addQuad(namedNode(VOCAB + type), namedNode(RDF + 'type'), namedNode(rdfs + 'Class'));
    writer.addQuad(namedNode(VOCAB + type), namedNode(rdfs + 'label'), literal(type));
  }
  for (const [key, field] of Object.entries(fields)) {
    writer.addQuad(namedNode(VOCAB + key), namedNode(RDF + 'type'), namedNode(RDF + 'Property'));
    writer.addQuad(namedNode(VOCAB + key), namedNode(rdfs + 'label'), literal(key));
    writer.addQuad(namedNode(VOCAB + key), namedNode(rdfs + 'range'), namedNode(field.kind === 'iri'
      ? rdfs + 'Resource' : 'http://www.w3.org/2001/XMLSchema#string'));
  }
  return new Promise((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result)));
}

/** A neutral dictionary projection, deliberately not a bSDD import format. */
export const dictionary = Object.entries(fields).map(([name, definition]) => ({
  id: VOCAB + name, name, definition,
  usedBy: RESOURCE_TYPES.filter(type => profiles[type].fields.includes(name as FieldName)),
}));
