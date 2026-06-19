/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bSDD (buildingSMART Data Dictionary) API client.
 *
 * Fetches IFC class definitions, property sets, and properties from the
 * bSDD REST API so that users can discover schema-conform properties
 * for a selected IFC entity type and add them in one click.
 *
 * API docs: https://app.swaggerhub.com/apis/buildingSMART/Dictionaries/v1
 */

// Proxy through our own origin to avoid CORS issues.
// In dev Vite proxies /api/bsdd → https://api.bsdd.buildingsmart.org,
// in production Vercel rewrites do the same.
const BSDD_API = '/api/bsdd';
const IFC_DICTIONARY_URI =
  'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3';

/**
 * The buildingSMART IFC 4.3 dictionary — the default source the bSDD card
 * reads property templates (Pset_* / Qto_*) and entity attributes from.
 * Other dictionaries (Uniclass, ETIM, a company's own published bSDD, …)
 * are discovered per entity type via {@link discoverDictionaries}.
 */
export const IFC_DICTIONARY: BsddDictionary = {
  uri: IFC_DICTIONARY_URI,
  name: 'IFC 4.3',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BsddClassProperty {
  /** Property name, e.g. "IsExternal" */
  name: string;
  /** URI of the property definition */
  uri: string;
  /** Human-readable description */
  description: string | null;
  /** bSDD data type, e.g. "Boolean", "Real", "String" */
  dataType: string | null;
  /** Name of the property set this property belongs to */
  propertySet: string | null;
  /** Allowed values (enum constraints) */
  allowedValues: Array<{ uri?: string; value: string; description?: string }> | null;
  /** Units */
  units: string[] | null;
  /** Whether this is from the IFC standard dictionary */
  isIfcStandard: boolean;
}

export interface BsddClassInfo {
  /** Class URI */
  uri: string;
  /** IFC entity code, e.g. "IfcWall" */
  code: string;
  /** Human-readable name */
  name: string;
  /** Description / definition */
  definition: string | null;
  /** Parent class URI */
  parentClassUri: string | null;
  /** Properties defined for this class */
  classProperties: BsddClassProperty[];
  /** Related IFC entity names */
  relatedIfcEntityNames: string[] | null;
}

export interface BsddSearchResult {
  uri: string;
  code: string;
  name: string;
  definition: string | null;
  dictionaryUri: string;
  /** Human-readable name of the dictionary this class belongs to */
  dictionaryName: string;
}

/**
 * A bSDD dictionary the user can read property definitions from.
 * `uri` is the canonical dictionary identifier; `name` is for display.
 */
export interface BsddDictionary {
  uri: string;
  name: string;
}

// ---------------------------------------------------------------------------
// In-memory cache (keyed by class URI)
// ---------------------------------------------------------------------------

const classCache = new Map<string, { data: BsddClassInfo; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCached(key: string): BsddClassInfo | null {
  const entry = classCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  if (entry) classCache.delete(key);
  return null;
}

function setCache(key: string, data: BsddClassInfo) {
  classCache.set(key, { data, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`bSDD API ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

interface BsddSearchApiResult {
  uri?: string;
  code?: string;
  referenceCode?: string;
  name?: string;
  definition?: string | null;
  dictionaryUri?: string;
}

function matchesIfcType(candidate: BsddSearchApiResult, ifcType: string): boolean {
  return candidate.code === ifcType
    || candidate.referenceCode === ifcType
    || candidate.name === ifcType;
}

async function resolveFallbackClassUri(ifcType: string): Promise<string | null> {
  try {
    const raw = await fetchJson<{ classes?: BsddSearchApiResult[] }>(
      `${BSDD_API}/api/Class/Search/v1?SearchText=${encodeURIComponent(ifcType)}&RelatedIfcEntities=${encodeURIComponent(ifcType)}`,
    );
    const classes = raw.classes ?? [];
    if (classes.length === 0) return null;

    const preferred = classes.find((entry) => entry.dictionaryUri === IFC_DICTIONARY_URI && matchesIfcType(entry, ifcType))
      ?? classes.find((entry) => matchesIfcType(entry, ifcType))
      ?? classes.find((entry) => entry.dictionaryUri === IFC_DICTIONARY_URI)
      ?? classes[0];

    return preferred?.uri ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the bSDD class URI for an IFC entity type.
 * e.g. "IfcWall" -> "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall"
 */
export function ifcClassUri(ifcType: string): string {
  // Use the type name as-is.  IFC parsers typically produce PascalCase
  // names (e.g. "IfcWall") which match the bSDD URI scheme directly.
  // Previous best-effort lowercasing corrupted multi-word names like
  // IFCWALLSTANDARDCASE → "IfcWallstandardcase", so we no longer attempt
  // case normalisation — the bSDD API will simply 404 for unknown names
  // and we handle that gracefully.
  return `${IFC_DICTIONARY_URI}/class/${ifcType}`;
}

/**
 * Fetch full class info (including properties) for an IFC entity type.
 *
 * Uses the `/api/Class/v1` endpoint with `IncludeClassProperties=true`
 * (PascalCase parameter names per the bSDD OpenAPI spec).
 * Falls back to the paginated `/api/Class/Properties/v1` endpoint when
 * the inline property list comes back empty.
 */
export async function fetchClassInfo(
  ifcType: string,
): Promise<BsddClassInfo | null> {
  const defaultUri = ifcClassUri(ifcType);
  let uri = defaultUri;
  const cached = getCached(uri);
  if (cached) return cached;

  try {
    // The IFC dictionary is keyed by class name, so we can address the class
    // directly by URI. If that 404s (e.g. an unusual subtype name) fall back
    // to a name search that resolves the canonical class URI.
    let info: BsddClassInfo;
    try {
      info = await fetchClassDetail(uri, true);
    } catch {
      const fallbackUri = await resolveFallbackClassUri(ifcType);
      if (!fallbackUri || fallbackUri === uri) {
        throw new Error('bSDD class lookup failed');
      }
      uri = fallbackUri;
      const fallbackCached = getCached(uri);
      if (fallbackCached) return fallbackCached;
      info = await fetchClassDetail(uri, true);
    }

    setCache(uri, info);
    return info;
  } catch {
    // Silently return null – bSDD may not have data for every type
    return null;
  }
}

/**
 * Fetch a single class (with its properties) by full bSDD URI, regardless of
 * which dictionary it belongs to. Throws on HTTP failure so callers can
 * distinguish "missing" from "errored".
 *
 * `isIfcStandard` flags the resulting properties as coming from the IFC
 * standard dictionary (drives the badge in the UI).
 */
async function fetchClassDetail(
  uri: string,
  isIfcStandard: boolean,
): Promise<BsddClassInfo> {
  // Parameter names must be PascalCase per the bSDD OpenAPI spec
  const raw = await fetchJson<Record<string, unknown>>(
    `${BSDD_API}/api/Class/v1?Uri=${encodeURIComponent(uri)}&IncludeClassProperties=true&IncludeClassRelations=true`,
  );

  let info = mapClassResponse(raw, isIfcStandard);

  // Fallback: if inline classProperties came back empty, try the dedicated
  // paginated properties endpoint. Network failures here are non-fatal — the
  // primary call already succeeded, so keep the (property-less) result.
  if (info.classProperties.length === 0) {
    const propsRaw = await fetchJson<Record<string, unknown>>(
      `${BSDD_API}/api/Class/Properties/v1?ClassUri=${encodeURIComponent(uri)}`,
    ).catch(() => null);

    if (propsRaw) {
      const propsList = propsRaw.classProperties as Array<Record<string, unknown>> | undefined;
      if (propsList && propsList.length > 0) {
        info = {
          ...info,
          classProperties: propsList.map((p) => mapProperty(p, isIfcStandard)),
        };
      }
    }
  }

  return info;
}

/**
 * Fetch full class info (including properties) by full bSDD class URI.
 * Used for non-IFC dictionaries (Uniclass, ETIM, a company's own bSDD, …)
 * where classes are addressed by URI rather than by IFC type name.
 */
export async function fetchClassByUri(
  classUri: string,
  isIfcStandard = false,
): Promise<BsddClassInfo | null> {
  const cached = getCached(classUri);
  if (cached) return cached;
  try {
    const info = await fetchClassDetail(classUri, isIfcStandard);
    setCache(classUri, info);
    return info;
  } catch {
    return null;
  }
}

/**
 * Search bSDD for classes related to a given IFC entity type across all
 * dictionaries (not just the IFC dictionary).
 *
 * Uses `/api/Class/Search/v1` with a RelatedIfcEntities filter.
 * Returns lightweight results. Call `fetchClassByUri` on a specific result
 * to get full properties.
 */
export async function searchRelatedClasses(
  ifcType: string,
): Promise<BsddSearchResult[]> {
  try {
    const raw = await fetchJson<{
      classes?: Array<Record<string, unknown>>;
    }>(
      `${BSDD_API}/api/Class/Search/v1?SearchText=${encodeURIComponent(ifcType)}&RelatedIfcEntities=${encodeURIComponent(ifcType)}`,
    );
    return (raw.classes ?? []).map(mapSearchResult);
  } catch {
    return [];
  }
}

function mapSearchResult(c: Record<string, unknown>): BsddSearchResult {
  return {
    uri: String(c.uri ?? ''),
    code: String(c.code ?? c.referenceCode ?? c.name ?? ''),
    name: String(c.name ?? ''),
    definition: c.definition ? String(c.definition) : null,
    dictionaryUri: String(c.dictionaryUri ?? ''),
    dictionaryName: String(c.dictionaryName ?? c.dictionaryUri ?? ''),
  };
}

/** One page of a dictionary's class list. */
export interface BsddClassPage {
  classes: BsddSearchResult[];
  /** Total number of classes in the dictionary (for the whole list). */
  total: number;
  /** Offset this page started at. */
  offset: number;
}

/**
 * List a dictionary's classes, paginated, for browsing (issue #1219).
 *
 * Uses `/api/Dictionary/v1/Classes`, which — unlike the free-text search
 * endpoint — accepts `Offset`/`Limit` and reports `classesTotalCount`. This
 * lets the bSDD card show a scrollable list the user pages through (a single
 * dictionary can hold thousands of classes, so we never fetch them all at
 * once). For text filtering use {@link searchDictionaryClasses} instead.
 */
export async function listDictionaryClasses(
  dictionaryUri: string,
  offset: number,
  limit: number,
): Promise<BsddClassPage> {
  try {
    const raw = await fetchJson<{
      classes?: Array<Record<string, unknown>>;
      classesTotalCount?: number;
      classesOffset?: number;
    }>(
      `${BSDD_API}/api/Dictionary/v1/Classes?Uri=${encodeURIComponent(dictionaryUri)}&Offset=${offset}&Limit=${limit}`,
    );
    return {
      // The list endpoint omits dictionaryUri on each class; fold it back in.
      classes: (raw.classes ?? []).map((c) => mapSearchResult({ dictionaryUri, ...c })),
      total: Number(raw.classesTotalCount ?? 0),
      offset: Number(raw.classesOffset ?? offset),
    };
  } catch {
    return { classes: [], total: 0, offset };
  }
}

/**
 * Search a single dictionary's classes by free text.
 *
 * Backs the bSDD card's class filter for non-IFC dictionaries: the user types
 * to narrow the browsable list to matching classes. The free-text search
 * endpoint does not honour `Offset`/`Limit`, so this returns the API's single
 * (large) result page; browsing the full unfiltered list is paginated via
 * {@link listDictionaryClasses} (issue #1219).
 */
export async function searchDictionaryClasses(
  dictionaryUri: string,
  query: string,
): Promise<BsddSearchResult[]> {
  try {
    const raw = await fetchJson<{ classes?: Array<Record<string, unknown>> }>(
      `${BSDD_API}/api/Class/Search/v1?SearchText=${encodeURIComponent(query)}&DictionaryUris=${encodeURIComponent(dictionaryUri)}`,
    );
    return (raw.classes ?? []).map(mapSearchResult);
  } catch {
    return [];
  }
}

// Session cache for the dictionary catalogue — it changes rarely and a full
// fetch is ~400 entries, so we keep it for the lifetime of the page.
let dictionaryCatalogue: BsddDictionary[] | null = null;

/**
 * Fetch the full catalogue of bSDD dictionaries for the source-dictionary
 * picker. IFC 4.3 is pinned first; the rest follow sorted by display name
 * (name + version, so multiple versions of one dictionary stay distinct).
 * Falls back to just the IFC dictionary if the catalogue can't be loaded.
 */
export async function fetchAllDictionaries(): Promise<BsddDictionary[]> {
  if (dictionaryCatalogue) return dictionaryCatalogue;
  try {
    const raw = await fetchJson<{ dictionaries?: Array<Record<string, unknown>> }>(
      `${BSDD_API}/api/Dictionary/v1?Limit=1000`,
    );
    const seen = new Set<string>([IFC_DICTIONARY_URI]);
    const others: BsddDictionary[] = [];
    for (const d of raw.dictionaries ?? []) {
      const uri = String(d.uri ?? '');
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      const name = String(d.name ?? uri);
      const version = d.version ? String(d.version) : '';
      others.push({ uri, name: version ? `${name} ${version}` : name });
    }
    others.sort((a, b) => a.name.localeCompare(b.name));
    dictionaryCatalogue = [IFC_DICTIONARY, ...others];
    return dictionaryCatalogue;
  } catch {
    return [IFC_DICTIONARY];
  }
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

function mapProperty(
  p: Record<string, unknown>,
  isIfcStandard: boolean,
): BsddClassProperty {
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

function mapClassResponse(
  raw: Record<string, unknown>,
  isIfcStandard: boolean,
): BsddClassInfo {
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

/**
 * Map bSDD dataType string to a human-friendly label.
 */
export function bsddDataTypeLabel(dt: string | null): string {
  if (!dt) return 'String';
  const lower = dt.toLowerCase();
  if (lower === 'boolean') return 'Boolean';
  if (lower === 'real' || lower === 'number') return 'Real';
  if (lower === 'integer') return 'Integer';
  if (lower === 'string' || lower === 'character') return 'String';
  return dt;
}
