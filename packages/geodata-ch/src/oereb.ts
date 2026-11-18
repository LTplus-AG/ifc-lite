/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve where a parcel's ÖREB extract lives. This builds URLs; it does not
 * fetch or parse extracts.
 *
 * First choice is the federal availability register
 * (`ch.swisstopo-vd.stand-oerebkataster`), which carries, per parcel, the
 * canton's extract URL. Only when the register has no record does the
 * static per-canton table answer, flagged as such. A register record without
 * a usable URL throws `OerebExtractUnavailableError`.
 */

import { featureProps, findExact, identify, str, type Api3Feature } from './api3.js';
import { attributionFor } from './attribution.js';
import type { Attribution } from './contracts.js';
import type { HttpClient } from './http.js';
import { cantonOerebService, type CantonOerebService } from './oereb-cantons.js';
import { assertLv95Point } from './lv95.js';
import { isEgrid, parcelByEgrid } from './parcel.js';

export const OEREB_REGISTER_LAYER = 'ch.swisstopo-vd.stand-oerebkataster';

export type OerebFormat = 'json' | 'xml' | 'pdf' | 'url';

export interface OerebExtractRef {
  egrid: string;
  /** Two-letter canton code when known. */
  canton: string | null;
  municipality: string | null;
  /** The register's status text (German), e.g. "ÖREB-Kataster eingeführt"; `null` from the table. */
  status: string | null;
  serviceBase: string;
  /** `{base}/extract/{format}/?EGRID=…` per the ÖREB v2 web service spec. */
  urls: Record<OerebFormat, string>;
  source: 'federal-register' | 'canton-table';
  /** The static table's entry for the canton, for comparison, or `null`. */
  tableEntry: CantonOerebService | null;
  attribution: Attribution[];
}

/** `https://x/oereb/extract/url/?EGRID=…` → `https://x/oereb`. */
export function serviceBaseFromExtractUrl(url: string): string | null {
  const m = /^(https?:\/\/.+?)\/extract\/(?:url|pdf|json|xml)\/?\?/i.exec(url);
  return m ? m[1] : null;
}

export function extractUrls(base: string, egrid: string): Record<OerebFormat, string> {
  const b = base.replace(/\/+$/, '');
  const q = `?EGRID=${encodeURIComponent(egrid)}`;
  return {
    json: `${b}/extract/json/${q}`,
    xml: `${b}/extract/xml/${q}`,
    pdf: `${b}/extract/pdf/${q}`,
    url: `${b}/extract/url/${q}`,
  };
}

/**
 * The federal register lists the EGRID but has no usable extract URL for it.
 * Thrown instead of returning `null` ("not found") or a canton-table guess.
 */
export class OerebExtractUnavailableError extends Error {
  constructor(
    readonly egrid: string,
    /** The register's status text (German), when present. */
    readonly status: string | null,
    readonly canton: string | null,
  ) {
    super(
      `the ÖREB register lists ${egrid}${status ? ` (status: ${status})` : ''} but has no usable extract URL; ` +
        'the canton table is not used because it may point to a service that has no extract for this parcel',
    );
    this.name = 'OerebExtractUnavailableError';
  }
}

function fromRegister(f: Api3Feature): OerebExtractRef | null {
  const a = featureProps(f);
  const egrid = str(a.egris_egrid);
  const extractUrl = str(a.oereb_extract_url);
  const base = extractUrl ? serviceBaseFromExtractUrl(extractUrl) : null;
  if (!egrid || !base) return null;
  const entry = str(a.kanton) ? (cantonOerebService(String(a.kanton)) ?? null) : null;
  return {
    egrid,
    canton: entry?.canton ?? null,
    municipality: str(a.gemeindename),
    status: str(a.oereb_status_de),
    serviceBase: base,
    urls: extractUrls(base, egrid),
    source: 'federal-register',
    tableEntry: entry,
    attribution: [attributionFor('oerebAvailability')],
  };
}

export async function oerebExtractForEgrid(
  http: HttpClient,
  egrid: string,
  options: { signal?: AbortSignal } = {},
): Promise<OerebExtractRef | null> {
  const id = egrid.trim().toUpperCase();
  if (!isEgrid(id)) throw new RangeError(`not an EGRID: ${JSON.stringify(egrid)}`);
  const hits = await findExact(http, {
    layer: OEREB_REGISTER_LAYER,
    field: 'egris_egrid',
    value: id,
    returnGeometry: false,
    signal: options.signal,
  });
  let recordWithoutUrl: Api3Feature | null = null;
  for (const h of hits) {
    const ref = fromRegister(h);
    if (ref && ref.egrid === id) return ref;
    if (str(featureProps(h).egris_egrid) === id) recordWithoutUrl = h;
  }
  // The register knows this parcel but gives no usable extract URL. That is not
  // "no record": the canton table must not stand in for it and make an
  // unavailable extract look available.
  if (recordWithoutUrl) {
    const a = featureProps(recordWithoutUrl);
    throw new OerebExtractUnavailableError(id, str(a.oereb_status_de), str(a.kanton));
  }
  // Not in the register: fall back to the canton table via the parcel's canton.
  const parcel = await parcelByEgrid(http, id, options);
  const entry = parcel?.canton ? cantonOerebService(parcel.canton) : undefined;
  if (!entry) return null;
  return {
    egrid: id,
    canton: entry.canton,
    municipality: null,
    status: null,
    serviceBase: entry.base,
    urls: extractUrls(entry.base, id),
    source: 'canton-table',
    tableEntry: entry,
    attribution: [attributionFor('oerebAvailability')],
  };
}

/** A parcel the register lists at a point but for which it gives no usable extract URL. */
export interface OerebExtractUnavailable {
  egrid: string | null;
  /** The register's status text (German), when present. */
  status: string | null;
  canton: string | null;
}

/**
 * Outcome of an ÖREB lookup at a point. `extracts` empty AND `unavailable`
 * empty is the only "the register has no record here"; a listed parcel
 * without a usable URL is in `unavailable`, never dropped.
 */
export interface OerebExtractsAtPoint {
  extracts: OerebExtractRef[];
  unavailable: OerebExtractUnavailable[];
}

/** Extract references for every parcel at a point, from the register only. */
export async function oerebExtractsAtPoint(
  http: HttpClient,
  x: number,
  y: number,
  options: { signal?: AbortSignal } = {},
): Promise<OerebExtractsAtPoint> {
  assertLv95Point(x, y);
  const hits = await identify(http, {
    layer: OEREB_REGISTER_LAYER,
    geometry: { kind: 'point', x, y },
    returnGeometry: false,
    signal: options.signal,
  });
  const extracts: OerebExtractRef[] = [];
  const unavailable: OerebExtractUnavailable[] = [];
  for (const h of hits) {
    const ref = fromRegister(h);
    if (ref) {
      extracts.push(ref);
      continue;
    }
    const a = featureProps(h);
    unavailable.push({ egrid: str(a.egris_egrid), status: str(a.oereb_status_de), canton: str(a.kanton) });
  }
  return { extracts, unavailable };
}
