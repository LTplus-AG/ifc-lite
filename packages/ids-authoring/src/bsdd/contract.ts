/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Readers from the raw bSDD API v1 JSON (the public "Dictionaries" API
 * contracts: DictionaryContractV1, ClassContractV1, ClassPropertyContractV1,
 * ClassSearchResponseContractV1, PropertyContract) into the normalised
 * shapes of `./types.ts`. Input is untrusted: every field is checked, an
 * unexpected shape degrades to "absent", never to a throw or a cast.
 */

import type {
  BsddAllowedValue,
  BsddClass,
  BsddClassProperty,
  BsddClassRef,
  BsddClassSummary,
  BsddDictionary,
  BsddSearchPage,
  BsddStatus,
} from './types.js';

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(o: Json, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function num(o: Json, key: string): number | undefined {
  const v = o[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function bool(o: Json, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === 'boolean' ? v : undefined;
}

function records(o: Json, key: string): Json[] {
  const v = o[key];
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function strings(o: Json, key: string): string[] {
  const v = o[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Copy of `o` without the keys whose value is undefined. */
function compact<T extends object>(o: T): T {
  const out = { ...o };
  for (const k of Object.keys(out) as (keyof T)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export function readStatus(raw: unknown): BsddStatus {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.trim().toLowerCase();
  return s === 'active' || s === 'preview' || s === 'inactive' ? s : 'unknown';
}

export function readDictionary(o: Json): BsddDictionary | undefined {
  const uri = str(o, 'uri');
  const name = str(o, 'name');
  if (!uri || !name) return undefined;
  return compact({
    uri,
    name,
    version: str(o, 'version') ?? '',
    code: str(o, 'code'),
    organizationCode: str(o, 'organizationCodeOwner'),
    organizationName: str(o, 'organizationNameOwner'),
    languageCode: str(o, 'defaultLanguageCode'),
    status: readStatus(o.status),
    license: str(o, 'license'),
    licenseUrl: str(o, 'licenseUrl'),
    isLatestVersion: bool(o, 'isLatestVersion'),
    isVerified: bool(o, 'isVerified'),
    releaseDate: str(o, 'releaseDate'),
  });
}

export function readDictionaries(o: unknown): BsddDictionary[] {
  if (!isRecord(o)) return [];
  return records(o, 'dictionaries')
    .map(readDictionary)
    .filter((d): d is BsddDictionary => !!d);
}

function readAllowedValue(o: Json): BsddAllowedValue | undefined {
  const code = str(o, 'code') ?? str(o, 'value');
  if (!code) return undefined;
  return compact({ code, value: str(o, 'value') ?? code, uri: str(o, 'uri'), description: str(o, 'description') });
}

export function readAllowedValues(o: Json): BsddAllowedValue[] | undefined {
  const list = records(o, 'allowedValues')
    .map(readAllowedValue)
    .filter((v): v is BsddAllowedValue => !!v);
  return list.length ? list : undefined;
}

export function readClassProperty(o: Json): BsddClassProperty | undefined {
  const code = str(o, 'propertyCode') ?? str(o, 'code') ?? str(o, 'name');
  if (!code) return undefined;
  const units = strings(o, 'units');
  return compact({
    code,
    name: str(o, 'name') ?? code,
    uri: str(o, 'propertyUri') ?? str(o, 'uri'),
    propertySet: str(o, 'propertySet'),
    dataType: str(o, 'dataType'),
    propertyValueKind: str(o, 'propertyValueKind'),
    dimension: str(o, 'dimension'),
    physicalQuantity: str(o, 'physicalQuantity'),
    units: units.length ? units : undefined,
    allowedValues: readAllowedValues(o),
    minInclusive: num(o, 'minInclusive'),
    maxInclusive: num(o, 'maxInclusive'),
    minExclusive: num(o, 'minExclusive'),
    maxExclusive: num(o, 'maxExclusive'),
    pattern: str(o, 'pattern'),
    isRequired: bool(o, 'isRequired'),
    description: str(o, 'definition') ?? str(o, 'description'),
    status: o.propertyStatus === undefined ? undefined : readStatus(o.propertyStatus),
  });
}

function readRef(o: unknown): BsddClassRef | undefined {
  if (!isRecord(o)) return undefined;
  const uri = str(o, 'uri');
  return uri ? compact({ uri, code: str(o, 'code'), name: str(o, 'name') }) : undefined;
}

/** The dictionary URI of a bSDD class/property URI (`…/uri/<org>/<dict>/<version>`). */
export function dictionaryUriOf(uri: string): string | undefined {
  const m = /^(https?:\/\/[^/]+\/uri\/[^/]+\/[^/]+\/[^/]+)\/(class|prop)\//i.exec(uri);
  return m?.[1];
}

export function readClass(o: unknown): BsddClass | undefined {
  if (!isRecord(o)) return undefined;
  const uri = str(o, 'uri');
  const code = str(o, 'code') ?? str(o, 'name');
  if (!uri || !code) return undefined;
  return compact({
    uri,
    code,
    name: str(o, 'name') ?? code,
    definition: str(o, 'definition') ?? str(o, 'description'),
    status: readStatus(o.status),
    classType: str(o, 'classType'),
    dictionaryUri: str(o, 'dictionaryUri') ?? dictionaryUriOf(uri) ?? '',
    relatedIfcEntityNames: strings(o, 'relatedIfcEntityNames'),
    parentClass: readRef(o.parentClassReference),
    childClasses: records(o, 'childClassReferences')
      .map(readRef)
      .filter((r): r is BsddClassRef => !!r),
    properties: records(o, 'classProperties')
      .map(readClassProperty)
      .filter((p): p is BsddClassProperty => !!p),
    replacingObjectCodes: strings(o, 'replacingObjectCodes'),
    synonyms: strings(o, 'synonyms'),
  });
}

export function readClassSummary(o: Json, dictionary?: { uri: string; name?: string }): BsddClassSummary | undefined {
  const uri = str(o, 'uri');
  const code = str(o, 'code') ?? str(o, 'name');
  if (!uri || !code) return undefined;
  return compact({
    uri,
    code,
    name: str(o, 'name') ?? code,
    definition: str(o, 'definition'),
    dictionaryUri: str(o, 'dictionaryUri') ?? dictionary?.uri ?? dictionaryUriOf(uri) ?? '',
    dictionaryName: str(o, 'dictionaryName') ?? dictionary?.name,
    relatedIfcEntityNames: strings(o, 'relatedIfcEntityNames'),
    parentClassCode: str(o, 'parentClassCode'),
    classType: str(o, 'classType'),
    status: o.status === undefined ? undefined : readStatus(o.status),
  });
}

/** One page of `Dictionary/v1/Classes`: its rows and the server's total. */
export function readDictionaryClasses(o: unknown): { classes: BsddClassSummary[]; total: number; name?: string } {
  if (!isRecord(o)) return { classes: [], total: 0 };
  const dict = { uri: str(o, 'uri') ?? '', name: str(o, 'name') };
  const classes = records(o, 'classes')
    .map((c) => readClassSummary(c, dict))
    .filter((c): c is BsddClassSummary => !!c);
  return compact({ classes, total: num(o, 'classesTotalCount') ?? classes.length, name: dict.name });
}

export function readSearchPage(o: unknown, offset: number): BsddSearchPage {
  if (!isRecord(o)) return { classes: [], total: 0, offset };
  const classes = records(o, 'classes')
    .map((c) => readClassSummary(c))
    .filter((c): c is BsddClassSummary => !!c);
  return { classes, total: num(o, 'totalCount') ?? classes.length, offset };
}
