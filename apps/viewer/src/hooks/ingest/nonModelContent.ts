/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9523: recognise a file that is an error response saved or served as a model (an HTML page, a JSON or XML
 * error, a text message under an IFC name), so the primary load can refuse it in its preflight, before the
 * scene reset closes the models already open. It never refuses a file a loader would open: only content no
 * model format can be is recognised, and routing stays with the loaders.
 */

/** Bodies up to this size are read whole to recognise a JSON or XML error response; HTML is looked for in this much of any body. */
export const NON_MODEL_SCAN_BYTES = 64 * 1024;

/** The message every refusal from {@link nonModelContentReason} carries, matched by the invalid-input classifier. */
export function nonModelContentMessage(reason: string): string {
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
      if (/^<!doctype\s*html\b/i.test(text.slice(at, at + 64))) return text.slice(at); // HTML's doctype is the document
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
 * Why `file` is an error response rather than a model (`null` when it may be a model). An HTML page; for a small
 * body, JSON that is not an IFCX document (whose `header.ifcxVersion` names IFCX) or XML whose root is an
 * error element; under an IFC name (.ifc, .ifczip), text that is neither STEP nor a ZIP archive.
 */
export async function nonModelContentReason(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.slice(0, NON_MODEL_SCAN_BYTES).arrayBuffer());
  if (bytes.length === 0) return null;
  const text = new TextDecoder().decode(bytes);
  const body = afterProlog(text);
  if (HTML_START.test(body)) return 'an HTML page';
  const whole = file.size <= NON_MODEL_SCAN_BYTES;
  if (whole && body.startsWith('<')) {
    const root = (/^<([\w.:-]{1,128})/.exec(body.slice(0, 256))?.[1] ?? '').split(':').pop() ?? '';
    if (XML_ERROR_NAMES.has(root.toLowerCase()) || XML_ERROR_SUFFIX.test(root)) return 'an XML error response';
  }
  if (whole && /^[{["]/.test(body)) {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch (err) {
      console.debug('[ingest] a small body starting like JSON is not JSON; left to the loaders:', err);
      value = undefined;
    }
    if (value !== undefined) {
      const header = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { header?: { ifcxVersion?: unknown } }).header : undefined;
      if (!(typeof header?.ifcxVersion === 'string' && header.ifcxVersion.toLowerCase().includes('ifcx'))) return 'a JSON response';
    }
  }
  // Under an IFC name, the loader treats unknown content as STEP: refuse what is plainly neither STEP nor ZIP.
  if (/\.(?:ifc|ifczip)$/i.test(file.name)) {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    const isBinary = bytes.subarray(0, 512).some((b) => b < 9 || (b > 13 && b < 32));
    const lead = text.trimStart();
    if (!isZip && !isBinary && lead.length > 0 && !lead.startsWith('ISO-10303-21') && !lead.startsWith('{')) return 'text that is neither STEP nor an IFC ZIP';
  }
  return null;
}
