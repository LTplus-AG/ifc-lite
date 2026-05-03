/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.bsdd — buildingSMART Data Dictionary (bSDD) integration
 *
 * Provides access to the bSDD REST API for discovering schema-defined
 * property sets, properties, and classifications for IFC entity types.
 *
 * The bSDD is the canonical source for IFC property definitions,
 * quantity sets, and related dictionaries (Uniclass, OmniClass, etc.).
 *
 * @see https://app.swaggerhub.com/apis/buildingSMART/Dictionaries/v1
 */

// ============================================================================
// Types
// ============================================================================

/** A property definition from the bSDD for a given IFC class */
export interface BsddClassProperty {
  /** Property name, e.g. "IsExternal" */
  name: string;
  /** URI of the property definition */
  uri: string;
  /** Human-readable description */
  description: string | null;
  /** bSDD data type, e.g. "Boolean", "Real", "String" */
  dataType: string | null;
  /** Name of the property set this property belongs to (null = entity attribute) */
  propertySet: string | null;
  /** Allowed values (enum constraints) */
  allowedValues: Array<{ uri?: string; value: string; description?: string }> | null;
  /** Units (e.g. ["m"], ["m²"]) */
  units: string[] | null;
  /** Whether this property is from the IFC standard dictionary */
  isIfcStandard: boolean;
}

/** Full class information from the bSDD */
export interface BsddClassInfo {
  /** Class URI */
  uri: string;
  /** IFC entity code, e.g. "IfcWall" */
  code: string;
  /** Human-readable name */
  name: string;
  /** Class description / definition */
  definition: string | null;
  /** Parent class URI */
  parentClassUri: string | null;
  /** Properties defined for this class */
  classProperties: BsddClassProperty[];
  /** Related IFC entity names */
  relatedIfcEntityNames: string[] | null;
}

/** Lightweight search result from bSDD */
export interface BsddSearchResult {
  uri: string;
  code: string;
  name: string;
  definition: string | null;
  dictionaryUri: string;
}

export interface BsddOptions {
  /**
   * Base URL for the bSDD API.
   * Default: 'https://api.bsdd.buildingsmart.org'
   *
   * Override this if you use a proxy (e.g. '/api/bsdd' for same-origin proxy).
   */
  apiBase?: string;
  /** Cache TTL in milliseconds. Default: 600000 (10 minutes) */
  cacheTtlMs?: number;
}

// ============================================================================
// Internal cache & helpers
// ============================================================================

const IFC_DICTIONARY_URI =
  'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3';

// Cache helpers — operate on instance-scoped cache passed as argument

function getCached(cache: Map<string, { data: BsddClassInfo; ts: number }>, key: string, ttl: number): BsddClassInfo | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCache(cache: Map<string, { data: BsddClassInfo; ts: number }>, key: string, data: BsddClassInfo): void {
  cache.set(key, { data, ts: Date.now() });
}

/**
 * HTTP error thrown by the bSDD client. Carries the status code so callers
 * can distinguish "missing class" (404) from "rate-limited" (429) from
 * unexpected upstream failures.
 */
export class BsddHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly retryAfterSeconds?: number;
  constructor(status: number, statusText: string, url: string, retryAfterSeconds?: number) {
    super(`bSDD API ${status}: ${statusText}`);
    this.name = 'BsddHttpError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return seconds;
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  return undefined;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new BsddHttpError(
      res.status,
      res.statusText,
      url,
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }
  return res.json() as Promise<T>;
}

function mapProperty(p: Record<string, unknown>, isIfcStandard: boolean): BsddClassProperty {
  return {
    name: String(p.name ?? p.propertyCode ?? ''),
    uri: String(p.propertyUri ?? p.uri ?? ''),
    description: p.description ? String(p.description) : null,
    dataType: p.dataType ? String(p.dataType) : null,
    propertySet: p.propertySet ? String(p.propertySet) : null,
    allowedValues: Array.isArray(p.allowedValues)
      ? p.allowedValues.map((v: Record<string, unknown>) => ({
          uri: v.uri ? String(v.uri) : undefined,
          value: String(v.value ?? ''),
          description: v.description ? String(v.description) : undefined,
        }))
      : null,
    units: Array.isArray(p.units) ? (p.units as string[]) : null,
    isIfcStandard,
  };
}

function mapClassResponse(raw: Record<string, unknown>, isIfcStandard: boolean): BsddClassInfo {
  const props = raw.classProperties as Array<Record<string, unknown>> | undefined;
  return {
    uri: String(raw.uri ?? ''),
    code: String(raw.code ?? raw.name ?? ''),
    name: String(raw.name ?? ''),
    definition: raw.definition ? String(raw.definition) : null,
    parentClassUri: raw.parentClassReference
      ? String((raw.parentClassReference as Record<string, unknown>).uri ?? '')
      : null,
    relatedIfcEntityNames: raw.relatedIfcEntityNames as string[] | null,
    classProperties: (props ?? []).map((p) => mapProperty(p, isIfcStandard)),
  };
}

// ============================================================================
// BsddNamespace
// ============================================================================

/**
 * bim.bsdd — buildingSMART Data Dictionary lookup
 *
 * Discover schema-defined properties, quantities, and classifications
 * for any IFC entity type from the bSDD REST API.
 *
 * ```ts
 * const info = await bim.bsdd.fetchClassInfo('IfcWall');
 * for (const prop of info.classProperties) {
 *   console.log(prop.propertySet, prop.name, prop.dataType);
 * }
 * ```
 */
export class BsddNamespace {
  private apiBase: string;
  private cache = new Map<string, { data: BsddClassInfo; ts: number }>();
  private cacheTtl: number;

  constructor(options?: BsddOptions) {
    this.apiBase = options?.apiBase ?? 'https://api.bsdd.buildingsmart.org';
    this.cacheTtl = options?.cacheTtlMs ?? 10 * 60 * 1000;
  }

  // --------------------------------------------------------------------------
  // URI helpers
  // --------------------------------------------------------------------------

  /** Build the bSDD class URI for an IFC entity type. */
  ifcClassUri(ifcType: string): string {
    return `${IFC_DICTIONARY_URI}/class/${ifcType}`;
  }

  /** Build the bSDD search URL for an IFC entity type (for browser links). */
  ifcClassUrl(ifcType: string): string {
    return `https://search.bsdd.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/${ifcType}`;
  }

  // --------------------------------------------------------------------------
  // Class info
  // --------------------------------------------------------------------------

  /**
   * Fetch full class info (including properties) for an IFC entity type.
   *
   * Results are cached for 10 minutes (configurable).
   * Returns null if bSDD has no data for this type (HTTP 404). Other HTTP
   * failures — most importantly 429 rate-limits — are re-thrown as
   * `BsddHttpError` so callers can react instead of silently treating them
   * as "missing".
   */
  async fetchClassInfo(ifcType: string): Promise<BsddClassInfo | null> {
    const uri = this.ifcClassUri(ifcType);
    const cached = getCached(this.cache, uri, this.cacheTtl);
    if (cached) return cached;

    let raw: Record<string, unknown>;
    try {
      raw = await fetchJson<Record<string, unknown>>(
        `${this.apiBase}/api/Class/v1?Uri=${encodeURIComponent(uri)}&IncludeClassProperties=true&IncludeClassRelations=true`,
      );
    } catch (err) {
      if (err instanceof BsddHttpError && err.status === 404) return null;
      throw err;
    }

    let info = mapClassResponse(raw, true);

    // Fallback: if inline classProperties came back empty, try paginated endpoint.
    // Network failures on the fallback are non-fatal — keep the partial result.
    if (info.classProperties.length === 0) {
      try {
        const propsRaw = await fetchJson<Record<string, unknown>>(
          `${this.apiBase}/api/Class/Properties/v1?ClassUri=${encodeURIComponent(uri)}`,
        );
        const propsList = propsRaw.classProperties as Array<Record<string, unknown>> | undefined;
        if (propsList && propsList.length > 0) {
          info = { ...info, classProperties: propsList.map((p) => mapProperty(p, true)) };
        }
      } catch {
        // ignore — primary call already succeeded
      }
    }

    setCache(this.cache, uri, info);
    return info;
  }

  /**
   * Fetch class info by full bSDD URI (not just IFC type name).
   * Useful for non-IFC dictionaries (Uniclass, OmniClass, etc.).
   */
  async fetchClassByUri(classUri: string): Promise<BsddClassInfo | null> {
    const cached = getCached(this.cache, classUri, this.cacheTtl);
    if (cached) return cached;

    try {
      const raw = await fetchJson<Record<string, unknown>>(
        `${this.apiBase}/api/Class/v1?Uri=${encodeURIComponent(classUri)}&IncludeClassProperties=true`,
      );
      const info = mapClassResponse(raw, false);
      setCache(this.cache, classUri, info);
      return info;
    } catch (err) {
      if (err instanceof BsddHttpError && err.status === 404) return null;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  /**
   * Search bSDD for classes related to an IFC entity type across all dictionaries.
   *
   * Returns lightweight results. Use `fetchClassByUri()` on a specific result
   * to get full property details.
   */
  async searchRelatedClasses(ifcType: string): Promise<BsddSearchResult[]> {
    try {
      const raw = await fetchJson<{ classes?: Array<Record<string, unknown>> }>(
        `${this.apiBase}/api/Class/Search/v1?SearchText=${encodeURIComponent(ifcType)}&RelatedIfcEntities=${encodeURIComponent(ifcType)}`,
      );
      return (raw.classes ?? []).map((c) => ({
        uri: String(c.uri ?? ''),
        code: String(c.code ?? c.name ?? ''),
        name: String(c.name ?? ''),
        definition: c.definition ? String(c.definition) : null,
        dictionaryUri: String(c.dictionaryUri ?? ''),
      }));
    } catch (err) {
      if (err instanceof BsddHttpError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * Free-text search across all bSDD dictionaries.
   */
  async search(query: string): Promise<BsddSearchResult[]> {
    try {
      const raw = await fetchJson<{ classes?: Array<Record<string, unknown>> }>(
        `${this.apiBase}/api/Class/Search/v1?SearchText=${encodeURIComponent(query)}`,
      );
      return (raw.classes ?? []).map((c) => ({
        uri: String(c.uri ?? ''),
        code: String(c.code ?? c.name ?? ''),
        name: String(c.name ?? ''),
        definition: c.definition ? String(c.definition) : null,
        dictionaryUri: String(c.dictionaryUri ?? ''),
      }));
    } catch (err) {
      if (err instanceof BsddHttpError && err.status === 404) return [];
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Property helpers
  // --------------------------------------------------------------------------

  /**
   * Get only the property sets (Pset_*) for an IFC type.
   * Groups properties by their propertySet name.
   */
  async getPropertySets(ifcType: string): Promise<Map<string, BsddClassProperty[]>> {
    const info = await this.fetchClassInfo(ifcType);
    if (!info) return new Map();

    const result = new Map<string, BsddClassProperty[]>();
    for (const prop of info.classProperties) {
      const pset = prop.propertySet;
      if (!pset || pset.startsWith('Qto_')) continue;
      const list = result.get(pset);
      if (list) list.push(prop);
      else result.set(pset, [prop]);
    }
    return result;
  }

  /**
   * Get only the quantity sets (Qto_*) for an IFC type.
   * Groups quantities by their propertySet name.
   */
  async getQuantitySets(ifcType: string): Promise<Map<string, BsddClassProperty[]>> {
    const info = await this.fetchClassInfo(ifcType);
    if (!info) return new Map();

    const result = new Map<string, BsddClassProperty[]>();
    for (const prop of info.classProperties) {
      const pset = prop.propertySet;
      if (!pset || !pset.startsWith('Qto_')) continue;
      const list = result.get(pset);
      if (list) list.push(prop);
      else result.set(pset, [prop]);
    }
    return result;
  }

  /**
   * Get entity-level attributes (properties with no propertySet).
   */
  async getEntityAttributes(ifcType: string): Promise<BsddClassProperty[]> {
    const info = await this.fetchClassInfo(ifcType);
    if (!info) return [];
    return info.classProperties.filter((p) => p.propertySet === null);
  }

  // --------------------------------------------------------------------------
  // Data type helpers
  // --------------------------------------------------------------------------

  /** Map bSDD dataType string to a human-friendly label. */
  dataTypeLabel(dt: string | null): string {
    if (!dt) return 'String';
    const lower = dt.toLowerCase();
    if (lower === 'boolean') return 'Boolean';
    if (lower === 'real' || lower === 'number') return 'Real';
    if (lower === 'integer') return 'Integer';
    if (lower === 'string' || lower === 'character') return 'String';
    return dt;
  }

  // --------------------------------------------------------------------------
  // Cache management
  // --------------------------------------------------------------------------

  /** Clear the bSDD cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Get cache statistics. */
  cacheStats(): { entries: number; oldestMs: number } {
    let oldest = Date.now();
    for (const entry of this.cache.values()) {
      if (entry.ts < oldest) oldest = entry.ts;
    }
    return { entries: this.cache.size, oldestMs: this.cache.size > 0 ? Date.now() - oldest : 0 };
  }
}
