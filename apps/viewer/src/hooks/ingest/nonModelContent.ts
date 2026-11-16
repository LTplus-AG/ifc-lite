/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9523: recognise a file that is an error response saved or served as a model (an HTML page, a JSON or XML
 * error, a text message under an IFC name), so the primary load can refuse it in its preflight, before the
 * scene reset closes the models already open. It never refuses a file a loader would open: only content no
 * model format can be is recognised, and routing stays with the loaders.
 */

import { headIsZip } from './sourceBuffers';

/** Bodies up to this size are read whole to recognise a JSON or XML error response; HTML is looked for in this much of any body. */
export const NON_MODEL_SCAN_BYTES = 64 * 1024;

/** Every reason {@link nonModelContentReason} gives; the invalid-input classifier is built from these. */
export const NON_MODEL_REASONS = {
  html: 'an HTML page',
  json: 'a JSON response',
  ifcxHeader: 'a JSON document without an IFCX header.ifcxVersion',
  xmlError: 'an XML error response',
  notStep: 'text that is neither STEP nor an IFC ZIP',
} as const;
export type NonModelReason = (typeof NON_MODEL_REASONS)[keyof typeof NON_MODEL_REASONS];

/** The message every refusal carries, matched by the invalid-input classifier. */
export function nonModelContentMessage(reason: NonModelReason): string {
  return `The file is ${reason}, not a model.`;
}

/**
 * `text` after its markup prolog: whitespace, processing instructions (`<?xml ?>`), comments and a DOCTYPE
 * other than HTML's (with any internal subset). A linear scan, so no crafted body can make it backtrack.
 * An unterminated item leaves the rest as is.
 */
export function afterProlog(text: string): string {
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    let close: string | null = text.startsWith('<?', at) ? '?>' : text.startsWith('<!--', at) ? '-->' : null;
    if (!close && /^<!doctype/i.test(text.slice(at, at + 9))) {
      if (/^<!doctype\s*html\b/i.test(text.slice(at, at + 1024))) return text.slice(at); // HTML's doctype is the document
      const gt = text.indexOf('>', at), subset = text.indexOf('[', at);
      close = subset !== -1 && (gt === -1 || subset < gt) ? ']>' : '>';
    }
    if (!close) return text.slice(at);
    const end = text.indexOf(close, at + 2);
    if (end === -1) return text.slice(at);
    at = end + close.length;
  }
}

const HTML_START = /^<(?:!doctype\s*html|html|head|body|title|meta|h[1-6]|div|p|pre|span|center|script|style|noscript|a)[\s>]/i;
/** Error-root local names in any case, or ones ending in a capitalised Error/Exception/Fault (S3Error, ows:ExceptionReport, soap:Fault). */
const XML_ERROR_NAMES = new Set(['error', 'errors', 'errorresponse', 'exception', 'exceptionreport', 'fault', 'accessdenied']);
const XML_ERROR_SUFFIX = /(?:Error|Exception|Fault)(?:Report|Response)?$/;

/**
 * Why `file` is an error response rather than a model (`null` when it may be a model). Text only (binary content
 * is left to the loaders): an HTML page; for a small body, JSON that is not an IFCX document (whose
 * `header.ifcxVersion` names IFCX) or XML whose root is an error element; under an IFC name (.ifc, .ifczip),
 * text that never mentions STEP's ISO-10303-21. `scan`, when given, is the file's first
 * {@link NON_MODEL_SCAN_BYTES} bytes, so a caller that already read them is not read twice.
 */
export async function nonModelContentReason(file: File, scan?: ArrayBuffer): Promise<NonModelReason | null> {
  const buffer = scan ?? await file.slice(0, NON_MODEL_SCAN_BYTES).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0 || headIsZip(buffer)) return null;
  // A control byte in the first 512 means binary: no text rule applies (a headerless .splat can start with '<').
  if (bytes.subarray(0, 512).some((b) => b < 9 || (b > 13 && b < 32))) return null;
  const text = new TextDecoder().decode(bytes);
  const body = afterProlog(text);
  if (HTML_START.test(body)) return NON_MODEL_REASONS.html;
  const whole = file.size <= NON_MODEL_SCAN_BYTES;
  if (whole && body.startsWith('<')) {
    const root = (/^<([\w.:-]{1,128})/.exec(body.slice(0, 256))?.[1] ?? '').split(':').pop() ?? '';
    if (XML_ERROR_NAMES.has(root.toLowerCase()) || XML_ERROR_SUFFIX.test(root)) return NON_MODEL_REASONS.xmlError;
  }
  if (whole && /^[{["]/.test(body)) {
    const reason = jsonReason(body);
    if (reason) return reason;
  }
  // Under an IFC name the loader treats unknown content as STEP; every STEP file names ISO-10303-21 near its start.
  if (/\.(?:ifc|ifczip)$/i.test(file.name) && !/^\s*[{[]/.test(text) && !/ISO[- ]10303-21/.test(text)) return NON_MODEL_REASONS.notStep;
  return null;
}

function jsonReason(body: string): NonModelReason | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    console.debug('[ingest] a small body starting like JSON is not JSON; left to the loaders:', err);
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('header' in value)) return NON_MODEL_REASONS.json;
  const header = (value as { header?: { ifcxVersion?: unknown } }).header;
  return typeof header?.ifcxVersion === 'string' && header.ifcxVersion.toLowerCase().includes('ifcx') ? null : NON_MODEL_REASONS.ifcxHeader;
}
