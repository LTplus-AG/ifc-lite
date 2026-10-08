/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writing and formatting IDS for headless callers, with a losslessness guard.
 *
 * The XML writer is injected (`IdsWriter`). In this build it is
 * `writeIdsXml` from `@ifc-lite/rules`, which drops some `info` fields and
 * refuses length/digit and conjunctive restrictions; the total writer of
 * ADR-005 moves into `@ifc-lite/ids` with P-01. Whatever the writer, a
 * headless write never returns XML that reads back with less content than
 * it was given: the output is parsed again and every value the input
 * defines must survive. Anything that does not is reported as `lost`, so
 * `ids fmt --write` cannot silently delete an author or a restriction.
 */

import { parseIDS, type IDSDocument } from '@ifc-lite/ids';
import type { StudioDocument } from '../document/types.js';

/** Serialise an IDS document as IDS 1.0 XML. May throw to refuse. */
export type IdsWriter = (ids: IDSDocument) => string;

export interface WriteFailure {
  ok: false;
  reason: 'parse' | 'refused' | 'lossy';
  message: string;
  /** For `lossy`: paths whose value did not survive the round trip. */
  lost?: string[];
}

export type WriteOutcome = { ok: true; xml: string } | WriteFailure;

export type FormatOutcome = { ok: true; xml: string; changed: boolean } | WriteFailure;

/** Fields that record source spelling or node identity, not content. */
function ignored(key: string): boolean {
  return key === 'id' || key.endsWith('Raw') || key.startsWith('raw');
}

/**
 * Paths where `source` defines a value that `written` does not reproduce.
 * Values only `written` has (defaults a parser fills in) are not losses.
 */
export function lostPaths(source: unknown, written: unknown, path = '', out: string[] = []): string[] {
  if (source === undefined || source === null) return out;
  if (Array.isArray(source)) {
    if (!Array.isArray(written)) {
      out.push(path || '(root)');
      return out;
    }
    source.forEach((item, i) => lostPaths(item, written[i], `${path}[${i}]`, out));
    return out;
  }
  if (typeof source === 'object') {
    if (typeof written !== 'object' || written === null || Array.isArray(written)) {
      out.push(path || '(root)');
      return out;
    }
    const w = written as Record<string, unknown>;
    for (const [key, value] of Object.entries(source)) {
      if (ignored(key)) continue;
      lostPaths(value, w[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  if (source !== written) out.push(path || '(root)');
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Write `ids` and prove the XML reads back with the same content. */
export function writeIdsChecked(ids: IDSDocument, write: IdsWriter): WriteOutcome {
  let xml: string;
  try {
    xml = write(ids);
  } catch (err) {
    return { ok: false, reason: 'refused', message: message(err) };
  }
  let reread: IDSDocument;
  try {
    reread = parseIDS(xml);
  } catch (err) {
    return { ok: false, reason: 'refused', message: `the writer produced XML that does not parse: ${message(err)}` };
  }
  const lost = lostPaths(ids, reread);
  if (lost.length > 0) {
    return {
      ok: false,
      reason: 'lossy',
      message: `the IDS writer in this build cannot represent ${lost.length} value(s) without loss`,
      lost,
    };
  }
  return { ok: true, xml };
}

/** Serialise a Studio document (its `ids` content; the sidecar travels separately). */
export function writeStudioDocument(doc: StudioDocument, write: IdsWriter): WriteOutcome {
  return writeIdsChecked(doc.ids, write);
}

/**
 * Canonical formatting: parse, write, verify. `changed` compares the
 * canonical XML with the input byte for byte (after CRLF → LF).
 */
export function formatIds(xml: string, write: IdsWriter): FormatOutcome {
  let ids: IDSDocument;
  try {
    ids = parseIDS(xml);
  } catch (err) {
    return { ok: false, reason: 'parse', message: message(err) };
  }
  const out = writeIdsChecked(ids, write);
  if (!out.ok) return out;
  return { ok: true, xml: out.xml, changed: xml.replace(/\r\n/g, '\n') !== out.xml };
}
