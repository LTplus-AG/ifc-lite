/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bSDD (buildingSMART Data Dictionary) as IDS authoring sees it
 * (05-bsdd.md). These are normalised shapes: `contract.ts` reads the raw
 * API v1 JSON into them, and everything downstream (pickers, the class →
 * facet insert, the property mapping table, the dictionary generator, URI
 * health) works on these only.
 *
 * `BsddSource` is the port a host implements (or takes from
 * `createHttpBsddSource`, optionally wrapped in `createCachedBsddSource`).
 * Only search terms and URIs ever go to bSDD, never model data.
 */

/** Lifecycle status of a bSDD dictionary, class or property. */
export type BsddStatus = 'active' | 'preview' | 'inactive' | 'unknown';

export interface BsddDictionary {
  uri: string;
  name: string;
  version: string;
  code?: string;
  organizationCode?: string;
  organizationName?: string;
  languageCode?: string;
  status: BsddStatus;
  /** Licence name as published by the dictionary owner, e.g. `CC BY 4.0`. */
  license?: string;
  licenseUrl?: string;
  isLatestVersion?: boolean;
  isVerified?: boolean;
  releaseDate?: string;
}

export interface BsddAllowedValue {
  /** The machine value IDS uses (`code`, falling back to `value`). */
  code: string;
  /** Display label. */
  value: string;
  uri?: string;
  description?: string;
}

/** One property of a class (a bSDD "class property"). */
export interface BsddClassProperty {
  /** Property code: the IDS `baseName` (the EXPRESS name for IFC properties). */
  code: string;
  /** Display name (may contain spaces). */
  name: string;
  /** URI of the property definition (`…/prop/<code>`), when published. */
  uri?: string;
  propertySet?: string;
  /** bSDD data type: Boolean, Character, Integer, Real, String, Time. */
  dataType?: string;
  /** Single, Range, List, Complex or ComplexList. */
  propertyValueKind?: string;
  /** SI dimension exponents `L M T I Θ N J`, e.g. `1 0 0 0 0 0 0` for a length. */
  dimension?: string;
  physicalQuantity?: string;
  units?: string[];
  allowedValues?: BsddAllowedValue[];
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
  /** XSD pattern. */
  pattern?: string;
  /** Whether the class requires the property. */
  isRequired?: boolean;
  description?: string;
  status?: BsddStatus;
}

export interface BsddClassRef {
  uri: string;
  code?: string;
  name?: string;
}

export interface BsddClass {
  uri: string;
  code: string;
  name: string;
  definition?: string;
  status: BsddStatus;
  /** Class, GroupOfProperties, AlternativeUse or Material. */
  classType?: string;
  dictionaryUri: string;
  /** IFC entity names the class relates to, as bSDD publishes them (`IfcWall`, `IfcWallSOLIDWALL`). */
  relatedIfcEntityNames: string[];
  parentClass?: BsddClassRef;
  childClasses: BsddClassRef[];
  properties: BsddClassProperty[];
  /** Codes of classes that replace this one (when deprecated). */
  replacingObjectCodes: string[];
  synonyms: string[];
}

/** A search hit or a row of a dictionary's class list. */
export interface BsddClassSummary {
  uri: string;
  code: string;
  name: string;
  definition?: string;
  dictionaryUri: string;
  dictionaryName?: string;
  relatedIfcEntityNames: string[];
  /** Code of the parent class (dictionary class lists). */
  parentClassCode?: string;
  classType?: string;
  status?: BsddStatus;
}

export interface BsddSearchQuery {
  text: string;
  dictionaryUris?: readonly string[];
  relatedIfcEntity?: string;
  languageCode?: string;
  offset?: number;
  limit?: number;
}

export interface BsddSearchPage {
  classes: BsddClassSummary[];
  total: number;
  offset: number;
}

/** What a bSDD URI resolves to (URI health, BSDD-001…003, GATE-BSDD-001). */
export interface BsddUriRecord {
  uri: string;
  /** `notFound`: bSDD answered 404. */
  state: 'active' | 'preview' | 'inactive' | 'notFound';
  kind: 'class' | 'property' | 'dictionary' | 'other';
  /** Name of the dictionary the URI belongs to (the classification `system`). */
  dictionaryName?: string;
  /** URIs of the replacements of a deprecated class or property. */
  replacedBy?: string[];
  /** Allowed value codes of a property (BSDD-003). */
  allowedValues?: string[];
  /** Epoch milliseconds of the check. */
  checkedAt: number;
}

export interface BsddClassOptions {
  languageCode?: string;
}

/** The port to bSDD. Every method resolves `null` / empty for "does not exist" and rejects on transport failure. */
export interface BsddSource {
  listDictionaries(): Promise<BsddDictionary[]>;
  getDictionary(uri: string): Promise<BsddDictionary | null>;
  /** Every class of a dictionary (flat; `parentClassCode` carries the tree). */
  listClasses(dictionaryUri: string): Promise<BsddClassSummary[]>;
  searchClasses(query: BsddSearchQuery): Promise<BsddSearchPage>;
  getClass(uri: string, options?: BsddClassOptions): Promise<BsddClass | null>;
  /** Resolve any bSDD URI (class, property, dictionary) for URI health. */
  resolveUri(uri: string): Promise<BsddUriRecord>;
}

/** Raised by a source when bSDD answered with an HTTP error other than 404. */
export class BsddHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`bSDD API ${status} for ${url}`);
    this.name = 'BsddHttpError';
  }
}

/** Raised by a cached source when bSDD cannot be reached and nothing is cached. */
export class BsddUnavailableError extends Error {
  constructor(
    readonly key: string,
    options: { cause: unknown },
  ) {
    super(`bSDD is unreachable and ${key} is not cached`, options);
    this.name = 'BsddUnavailableError';
  }
}
