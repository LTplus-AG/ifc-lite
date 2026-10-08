/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BsddSource` over the public bSDD REST API (v1 contracts), following the
 * conventions of the SDK client (`@ifc-lite/sdk` `bim.bsdd`): JSON over
 * `fetch`, 404 means "does not exist", any other HTTP failure is a
 * `BsddHttpError` carrying `Retry-After`. In the viewer, `apiBase` is the
 * same-origin proxy `/api/bsdd`. `fetch` is injectable so tests replay
 * recorded responses offline.
 */

import {
  dictionaryUriOf,
  isRecord,
  readAllowedValues,
  readClass,
  readDictionaries,
  readDictionaryClasses,
  readSearchPage,
  readStatus,
  str,
} from './contract.js';
import {
  BsddHttpError,
  type BsddClass,
  type BsddClassSummary,
  type BsddDictionary,
  type BsddSource,
  type BsddUriRecord,
} from './types.js';

export const BSDD_API_BASE = 'https://api.bsdd.buildingsmart.org';

export interface HttpBsddSourceOptions {
  /** Default: the public API. The viewer passes its proxy, `/api/bsdd`. */
  apiBase?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** UI language for labels (IDS values use codes and URIs, never labels). */
  languageCode?: string;
  /** Clock for `checkedAt`. */
  now?: () => number;
}

const PAGE = 1000;
/** Upper bound on pages fetched for one dictionary (a bounded walk over server-supplied totals). */
const MAX_PAGES = 50;

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : undefined;
}

function query(params: Record<string, string | number | boolean | readonly string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) q.append(k, item);
    else q.append(k, String(v));
  }
  return q.toString();
}

export function createHttpBsddSource(options: HttpBsddSourceOptions = {}): BsddSource {
  const base = (options.apiBase ?? BSDD_API_BASE).replace(/\/$/, '');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const languageCode = options.languageCode;
  const now = options.now ?? Date.now;
  const dictionaryNames = new Map<string, Promise<string | undefined>>();

  /** GET JSON; `null` on 404. */
  async function get(path: string): Promise<unknown> {
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new BsddHttpError(res.status, url, parseRetryAfter(res.headers.get('retry-after')));
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getDictionary(uri: string): Promise<BsddDictionary | null> {
    const raw = await get(`/api/Dictionary/v1?${query({ Uri: uri })}`);
    return readDictionaries(raw).find((d) => d.uri === uri) ?? null;
  }

  function dictionaryName(dictUri: string): Promise<string | undefined> {
    let p = dictionaryNames.get(dictUri);
    if (!p) {
      p = getDictionary(dictUri).then((d) => d?.name);
      dictionaryNames.set(dictUri, p);
      // Forget a failed lookup so the next check retries; the rejection still reaches the awaiting caller.
      p.catch(() => dictionaryNames.delete(dictUri));
    }
    return p;
  }

  async function getClass(uri: string, opts: { languageCode?: string } = {}): Promise<BsddClass | null> {
    const raw = await get(
      `/api/Class/v1?${query({ Uri: uri, IncludeClassProperties: true, IncludeChildClassReferences: true, languageCode: opts.languageCode ?? languageCode })}`,
    );
    return readClass(raw) ?? null;
  }

  async function resolveClass(uri: string): Promise<BsddUriRecord> {
    const cls = await getClass(uri);
    const checkedAt = now();
    if (!cls) return { uri, state: 'notFound', kind: 'class', checkedAt };
    const dictUri = cls.dictionaryUri || dictionaryUriOf(uri);
    const name = dictUri ? await dictionaryName(dictUri) : undefined;
    const replacedBy = dictUri ? cls.replacingObjectCodes.map((c) => `${dictUri}/class/${encodeURIComponent(c)}`) : [];
    return {
      uri,
      state: cls.status === 'unknown' ? 'active' : cls.status,
      kind: 'class',
      ...(name ? { dictionaryName: name } : {}),
      ...(replacedBy.length ? { replacedBy } : {}),
      checkedAt,
    };
  }

  async function resolveProperty(uri: string): Promise<BsddUriRecord> {
    const raw = await get(`/api/Property/v4?${query({ uri, languageCode })}`);
    const checkedAt = now();
    if (!isRecord(raw)) return { uri, state: 'notFound', kind: 'property', checkedAt };
    const status = readStatus(raw.status);
    const dictUri = str(raw, 'dictionaryUri') ?? dictionaryUriOf(uri);
    const values = readAllowedValues(raw)?.map((v) => v.code);
    const replacing = Array.isArray(raw.replacingObjectCodes) ? raw.replacingObjectCodes.filter((c): c is string => typeof c === 'string') : [];
    const name = dictUri ? await dictionaryName(dictUri) : undefined;
    return {
      uri,
      state: status === 'unknown' ? 'active' : status,
      kind: 'property',
      ...(name ? { dictionaryName: name } : {}),
      ...(dictUri && replacing.length ? { replacedBy: replacing.map((c) => `${dictUri}/prop/${encodeURIComponent(c)}`) } : {}),
      ...(values?.length ? { allowedValues: values } : {}),
      checkedAt,
    };
  }

  return {
    async listDictionaries() {
      const out: BsddDictionary[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const raw = await get(`/api/Dictionary/v1?${query({ IncludeTestDictionaries: false, Offset: page * PAGE, Limit: PAGE })}`);
        const rows = readDictionaries(raw);
        out.push(...rows);
        const total = isRecord(raw) && typeof raw.totalCount === 'number' ? raw.totalCount : out.length;
        if (rows.length === 0 || out.length >= total) break;
      }
      return out;
    },
    getDictionary,
    async listClasses(dictionaryUri) {
      const out: BsddClassSummary[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const raw = await get(
          `/api/Dictionary/v1/Classes?${query({ Uri: dictionaryUri, UseNestedClasses: false, ClassType: 'Class', Offset: page * PAGE, Limit: PAGE, languageCode })}`,
        );
        if (raw === null) return [];
        const { classes, total } = readDictionaryClasses(raw);
        out.push(...classes);
        if (classes.length === 0 || out.length >= total) break;
      }
      return out;
    },
    async searchClasses(q) {
      const offset = q.offset ?? 0;
      const raw = await get(
        `/api/Class/Search/v1?${query({
          SearchText: q.text,
          DictionaryUris: q.dictionaryUris,
          RelatedIfcEntities: q.relatedIfcEntity,
          languageCode: q.languageCode ?? languageCode,
          Offset: offset,
          Limit: q.limit ?? 50,
        })}`,
      );
      return readSearchPage(raw, offset);
    },
    getClass,
    async resolveUri(uri) {
      if (/\/class\/[^/]+\/prop\//i.test(uri)) {
        // A class-property URI: its status lives on the class property.
        const classUri = uri.replace(/\/prop\/.*$/i, '');
        const code = decodeURIComponent(uri.slice(uri.toLowerCase().lastIndexOf('/prop/') + '/prop/'.length));
        const cls = await getClass(classUri);
        const prop = cls?.properties.find((p) => p.code === code);
        const checkedAt = now();
        if (!prop) return { uri, state: 'notFound', kind: 'property', checkedAt };
        const values = prop.allowedValues?.map((v) => v.code);
        const status = prop.status ?? 'active';
        return { uri, state: status === 'unknown' ? 'active' : status, kind: 'property', ...(values?.length ? { allowedValues: values } : {}), checkedAt };
      }
      if (/\/class\//i.test(uri)) return resolveClass(uri);
      if (/\/prop\//i.test(uri)) return resolveProperty(uri);
      const dict = await getDictionary(uri);
      const checkedAt = now();
      if (!dict) return { uri, state: 'notFound', kind: 'dictionary', checkedAt };
      return { uri, state: dict.status === 'unknown' ? 'active' : dict.status, kind: 'dictionary', dictionaryName: dict.name, checkedAt };
    },
  };
}
