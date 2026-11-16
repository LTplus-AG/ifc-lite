/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9523: recognise a file that is an error response saved or served as a model (an HTML page, a JSON or XML
 * error, a text message under an IFC name), so the primary load can refuse it in its preflight, before the
 * scene reset closes the models already open. It never refuses a file a loader would open: only content no
 * model format can be is recognised, and routing stays with the loaders.
 */

import { NON_MODEL_REASONS, type NonModelReason } from '@/lib/non-model-reasons';
import { headIsZip } from './sourceBuffers';

/** Bodies up to this size are read whole to recognise a JSON or XML error response; HTML is looked for in this much of any body. */
export const NON_MODEL_SCAN_BYTES = 64 * 1024;

export { NON_MODEL_REASONS, nonModelContentMessage, type NonModelReason } from '@/lib/non-model-reasons';

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
      let name = at + 9;
      while (name < text.length && /\s/.test(text[name])) name++;
      if (/^html\b/i.test(text.slice(name, name + 5))) return text.slice(at); // HTML's doctype is the document
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
 * text that does not start (after whitespace and comments) like STEP. `scan`, when given, is the file's first
 * {@link NON_MODEL_SCAN_BYTES} bytes, so a caller that already read them is not read twice.
 */
export async function nonModelContentReason(file: File, scan?: ArrayBuffer): Promise<NonModelReason | null> {
  const buffer = scan ?? await file.slice(0, NON_MODEL_SCAN_BYTES).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0 || headIsZip(buffer)) return null;
  const text = new TextDecoder().decode(bytes);
  const body = afterProlog(text);
  // A control byte in the first 512 means binary, so only a full HTML document start (doctype or <html>) counts:
  // a headerless .splat can start with '<a '.
  const binary = bytes.subarray(0, 512).some((b) => b < 9 || (b > 13 && b < 32));
  if (binary ? /^<(?:!doctype\s*html|html)[\s>]/i.test(body) : HTML_START.test(body)) return NON_MODEL_REASONS.html;
  if (binary) return null;
  const whole = file.size <= NON_MODEL_SCAN_BYTES;
  if (whole && body.startsWith('<')) {
    const root = (/^<([\w.:-]{1,128})/.exec(body.slice(0, 256))?.[1] ?? '').split(':').pop() ?? '';
    if (XML_ERROR_NAMES.has(root.toLowerCase()) || XML_ERROR_SUFFIX.test(root)) return NON_MODEL_REASONS.xmlError;
  }
  if (whole && /^[{["]/.test(body)) {
    const reason = jsonReason(body, /\.ifcx$/i.test(file.name));
    if (reason) return reason;
  }
  // Under an IFC name the loader treats unknown content as STEP. STEP starts with ISO (the format router's own
  // test), after whitespace and any comments; JSON goes to the IFCX loader; blank content is the loader's to judge.
  const lead = afterStepComments(text);
  if (/\.(?:ifc|ifczip)$/i.test(file.name) && lead.length > 0 && !/^iso/i.test(lead) && !/^[{[]/.test(lead)) return NON_MODEL_REASONS.notStep;
  return null;
}

/** `text` after leading whitespace and STEP comments; linear. */
function afterStepComments(text: string): string {
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (!text.startsWith('/*', at)) return text.slice(at);
    const end = text.indexOf('*/', at + 2);
    if (end === -1) return '';
    at = end + 2;
  }
}

function jsonReason(body: string, ifcxName: boolean): NonModelReason | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    console.debug('[ingest] a small body starting like JSON is not JSON; left to the loaders:', err);
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('header' in value)) return NON_MODEL_REASONS.json;
  const header = (value as { header?: { ifcxVersion?: unknown } }).header;
  if (typeof header?.ifcxVersion === 'string' && header.ifcxVersion.toLowerCase().includes('ifcx')) return null;
  // Only an .ifcx name makes a header-shaped JSON plausibly a broken IFCX document; anywhere else it is an API envelope.
  return ifcxName ? NON_MODEL_REASONS.ifcxHeader : NON_MODEL_REASONS.json;
}
