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
import { detectFormat } from '@ifc-lite/parser';
import { detectPointCloudFormat } from './pointCloudFormat';
import { FORMAT_HEAD_BYTES, headIsZip } from './sourceBuffers';

/** Scan complete small JSON bodies and sniff HTML or XML roots within this prefix. */
const NON_MODEL_SCAN_BYTES = 64 * 1024;

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

const HTML_DOCUMENT_START = /^<(?:!doctype\s*html|html)[\s/>]/i;
// Error pages can start with an HTML fragment, with no doctype or document wrapper.
const HTML_ELEMENTS = new Set([
  'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption center',
  'cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption',
  'figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr i iframe img input ins kbd label legend li link',
  'main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q',
  'rp rt ruby s samp script search section select slot small source span strong style sub summary sup table',
  'tbody td template textarea tfoot th thead time title tr track u ul var video wbr',
].join(' ').split(' '));
const MARKUP_ROOT = /^<([\w.:-]{1,128})(?=[\s/>])/;
/** Error-root local names in any case, or ones ending in a capitalised Error/Exception/Fault (S3Error, ows:ExceptionReport, soap:Fault). */
const XML_ERROR_NAMES = new Set(['error', 'errors', 'errorresponse', 'exception', 'exceptionreport', 'fault', 'accessdenied']);
const XML_ERROR_SUFFIX = /(?:Error|Exception|Fault)(?:Report|Response)?$/;

/** The STEP opening identifier (case-insensitive, with or without the hyphen). */
const STEP_MARKER = /^ISO[- ]?10303-21/i;

/**
 * Why the loaders could not open `file` (`null` when they may): an error response saved or served as a model,
 * or text the IFC path cannot read. An HTML page, XML whose root is an error element, or a small JSON reply
 * without an IFCX or glTF header. Under an IFC name (.ifc,
 * .ifczip), content the format router would send to the STEP parser although it cannot read it: not STEP, or
 * any UTF-16 text (the parser reads single-byte text). UTF-16 is judged decoded by the same rules: an HTML,
 * JSON or XML error keeps its reason, STEP saved as UTF-16 gets its own, anything else is not STEP. Formats the
 * router recognises by content (ZIP, GLB, 3DM, IFCX JSON, point-cloud magic) are always left to their loaders.
 *
 * `head` is the first 4 KiB the caller already read. More (up to {@link NON_MODEL_SCAN_BYTES}) is read only when
 * the head looks like text that is not plainly a model, so an ordinary STEP or binary model costs no extra read.
 */
export async function nonModelContentReason(file: File, head?: ArrayBuffer): Promise<NonModelReason | null> {
  const first = head ?? await file.slice(0, FORMAT_HEAD_BYTES).arrayBuffer();
  const bytes = new Uint8Array(first);
  if (headIsZip(first)) return null;
  const routed = detectFormat(first);
  if (routed === 'glb' || routed === '3dm') return null;
  const ifcName = /\.(?:ifc|ifczip)$/i.test(file.name);
  // A UTF-16 document (an IIS/.NET error page) has NUL bytes but is text: it is judged decoded.
  const utf16 = utf16Encoding(bytes);
  const decode = (buffer: ArrayBuffer) => new TextDecoder(utf16 ?? 'utf-8').decode(buffer); // drops the BOM
  const headText = decode(first);
  // Binary: a control byte in the first 512 (the first 256 code units, for UTF-16); a headerless .splat can start with '<a '.
  // Never under an IFC name, where the router sends everything to the STEP parser: judge it as text there.
  const binary = !ifcName && (utf16 ? headHasControl(headText) : bytes.subarray(0, 512).some(isControl));
  const firstChar = headText.trimStart()[0] ?? '';
  const headLead = afterStepComments(headText);
  const headIsStep = classifyStepHeader(headLead) === 'step';
  const ifcNotStep = ifcName && !headIsStep;
  // Only content that could be an error response (or is all blank so far), or IFC-named content that is not
  // plainly STEP, is read further.
  const couldBeText = firstChar === '' || firstChar === '<' || (!binary && /[{["]/.test(firstChar));
  // No loader opens UTF-16 under an IFC name, so it is always judged in full (and refused below).
  const utf16Ifc = utf16 !== null && ifcName;
  if (!couldBeText && !ifcNotStep && !utf16Ifc) return null;

  const scan = await readScan(file, first);
  const text = scan === first ? headText : decode(scan);
  const body = afterProlog(text);
  const qualifiedRoot = binary ? undefined : MARKUP_ROOT.exec(body)?.[1];
  if (HTML_DOCUMENT_START.test(body) || (qualifiedRoot && HTML_ELEMENTS.has(qualifiedRoot.toLowerCase()))) {
    return NON_MODEL_REASONS.html;
  }
  if (qualifiedRoot) {
    const root = qualifiedRoot.split(':').pop() ?? '';
    if (XML_ERROR_NAMES.has(root.toLowerCase()) || XML_ERROR_SUFFIX.test(root)) return NON_MODEL_REASONS.xmlError;
  }
  const whole = file.size <= scan.byteLength;
  if (!binary && whole && /^[{["]/.test(body)) {
    const reason = jsonReason(body, /\.ifcx$/i.test(file.name));
    if (reason) return reason;
  }
  if (utf16Ifc) {
    // Not an error response: STEP to re-save as UTF-8, or neither.
    return textStartsLikeStep(text) ? NON_MODEL_REASONS.utf16Step : NON_MODEL_REASONS.notStep;
  }
  if (!ifcNotStep || routed === 'ifcx' || detectPointCloudFormat('content', first)) return null;
  // Leave incomplete headers to the loader only when the scan stops short of EOF.
  const lead = text === headText ? headLead : afterStepComments(text);
  const header = classifyStepHeader(lead);
  return header === 'step' || (header === 'incomplete' && !whole) ? null : NON_MODEL_REASONS.notStep;
}

/** Whether `text`, after whitespace and STEP comments, starts like STEP: the one rule the preflight's IFC admission shares. */
export function textStartsLikeStep(text: string): boolean {
  return classifyStepHeader(afterStepComments(text)) === 'step';
}

/** The identifier is only a STEP header when terminated by a semicolon after optional trivia. */
function classifyStepHeader(lead: string | null): 'step' | 'incomplete' | 'other' {
  if (!lead) return 'incomplete';
  const marker = STEP_MARKER.exec(lead);
  if (!marker) return 'other';
  const tail = afterStepComments(lead.slice(marker[0].length));
  if (!tail || tail === '/') return 'incomplete';
  return tail.startsWith(';') ? 'step' : 'other';
}

/** A C0 control other than tab, line feed, vertical tab, form feed or carriage return. */
const isControl = (code: number) => code < 9 || (code > 13 && code < 32);
function headHasControl(text: string): boolean {
  for (let i = 0; i < Math.min(256, text.length); i++) if (isControl(text.charCodeAt(i))) return true;
  return false;
}

function utf16Encoding(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  return bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
}

/** Up to {@link NON_MODEL_SCAN_BYTES} of `file`: the head itself when it already holds all of it. */
async function readScan(file: File, head: ArrayBuffer): Promise<ArrayBuffer> {
  return file.size > head.byteLength && head.byteLength < NON_MODEL_SCAN_BYTES ? file.slice(0, NON_MODEL_SCAN_BYTES).arrayBuffer() : head;
}

/** `text` after leading whitespace and STEP comments (`null` when a comment is unterminated); linear. */
function afterStepComments(text: string): string | null {
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (!text.startsWith('/*', at)) return text.slice(at);
    const end = text.indexOf('*/', at + 2);
    if (end === -1) return null;
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NON_MODEL_REASONS.json;
  // A glTF document is JSON with asset.version: a model, however small, never an error response.
  if (typeof (value as { asset?: { version?: unknown } }).asset?.version === 'string') return null;
  if (!('header' in value)) return NON_MODEL_REASONS.json;
  const header = (value as { header?: { ifcxVersion?: unknown } }).header;
  if (typeof header?.ifcxVersion === 'string' && header.ifcxVersion.toLowerCase().includes('ifcx')) return null;
  // Only an .ifcx name makes a header-shaped JSON plausibly a broken IFCX document; anywhere else it is an API envelope.
  return ifcxName ? NON_MODEL_REASONS.ifcxHeader : NON_MODEL_REASONS.json;
}
