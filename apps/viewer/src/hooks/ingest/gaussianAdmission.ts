// SPDX-License-Identifier: MPL-2.0

import { captureLimitBreach, shDegreeForRestColumns, type GaussianLimitBreach } from './gaussianLaunchLimits.js';

/** #8565/#8568: content admission and the published launch limits, before any decode. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const REQUIRED = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SCALAR_BYTES: Readonly<Record<string, number>> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};
// The complete pinned readHeader vocabulary; anything else throws upstream.
const DECODE_DIRECTIVES = ['ply', 'format', 'element', 'property', 'comment', 'end_header'];
const DECODE_TYPES = ['char', 'uchar', 'short', 'ushort', 'int', 'uint', 'float', 'double'];

export type GaussianAdmission =
  | { kind: 'ordinary' }
  | { kind: 'capture'; format: 'gaussian-ply' | 'splat'; count: number; shDegree: number }
  /** `breach` names the launch limit a well-formed capture exceeds, for a translated refusal.
   * `format` is what the content claimed to be (PLY magic or not), for diagnostics. */
  | { kind: 'invalid'; reason: string; breach?: GaussianLimitBreach; format?: 'gaussian-ply' | 'splat' };

type Invalid = Extract<GaussianAdmission, { kind: 'invalid' }>;
const BREACH_REASON: Readonly<Record<GaussianLimitBreach['limit'], string>> = {
  'capture-bytes': 'Gaussian capture exceeds the capture size limit.',
  'capture-splats': 'Gaussian capture exceeds the scene splat limit.',
  'sh-degree': 'Gaussian capture exceeds the spherical harmonics degree limit.',
};

function limits(size: number, count: number, columns: number, shDegree: number): Invalid | undefined {
  if (!Number.isSafeInteger(count) || count <= 0) return { kind: 'invalid', reason: 'Invalid Gaussian record count.' };
  const breach = captureLimitBreach(size, count, shDegree);
  if (breach) return { kind: 'invalid', reason: BREACH_REASON[breach.limit], breach };
  if (count * columns * 4 > MAX_DECODED_BYTES) return { kind: 'invalid', reason: 'Gaussian input exceeds the admission allocation limit.' };
}

// Use the same boundary as parsePlyHeader: first marker, then the following LF.
// In particular, trim whitespace (including form feed) must not hide the marker.
function headerEnd(text: string): number {
  const marker = text.indexOf('end_header');
  return marker < 0 ? 0 : text.indexOf('\n', marker) + 1;
}

type GaussianDecodeAdmission = Exclude<GaussianAdmission, { kind: 'capture' }>
  | (Extract<GaussianAdmission, { kind: 'capture' }> & { recordStride: number });

/** Keep the public admission result stable; decode uses the same validated layout. */
export async function inspectGaussianAdmission(file: File, head: ArrayBuffer): Promise<GaussianAdmission> {
  const result = await inspectGaussianLayout(file, head, false);
  if (result.kind === 'invalid') return { ...result, format: new TextDecoder().decode(head).startsWith('ply') ? 'gaussian-ply' : 'splat' };
  if (result.kind !== 'capture') return result;
  const { kind, format, count, shDegree } = result;
  return { kind, format, count, shDegree };
}

/** Reads at most 64 KiB, never the body. Framing checks are not payload decoding/validation. */
export async function inspectGaussianDecodeAdmission(file: File, head: ArrayBuffer): Promise<GaussianDecodeAdmission> {
  return inspectGaussianLayout(file, head, true);
}

function decodeHeaderEnd(text: string): number {
  // Pinned readPly searches these exact bytes, not a substring in a comment/name.
  const marker = text.indexOf('\nend_header\n');
  return marker < 0 ? 0 : marker + '\nend_header\n'.length;
}

async function inspectGaussianLayout(file: File, head: ArrayBuffer, decode: boolean): Promise<GaussianDecodeAdmission> {
  // Decode the bounded probe before checking magic, just like parsePlyHeader.
  // TextDecoder consumes an initial UTF-8 BOM; a three-byte probe can contain
  // only that BOM and miss the following magic. Do not trim arbitrary prefixes.
  const prefix = new TextDecoder().decode(head);
  // Match the existing PLY detector/parser's magic prefix, including padded first lines.
  // Content wins over the suffix: an ordinary PLY named .splat remains a point cloud.
  if (!prefix.startsWith('ply')) {
    if (!/\.splat$/i.test(file.name)) return { kind: 'ordinary' };
    const oversize = captureLimitBreach(file.size, 0, 0);
    if (oversize) return { kind: 'invalid', reason: BREACH_REASON[oversize.limit], breach: oversize };
    if (!file.size || file.size % 32 !== 0) return { kind: 'invalid', reason: 'Truncated or empty .splat input (32-byte records required).' };
    const count = file.size / 32;
    return limits(file.size, count, 14, 0) ?? { kind: 'capture', format: 'splat', count, shDegree: 0, recordStride: 32 };
  }
  // Retain BOM bytes in the header used for the payload lower-bound check.
  const headerDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let text = headerDecoder.decode(head);
  const findEnd = decode ? decodeHeaderEnd : headerEnd;
  let end = findEnd(text);
  if (!end && file.size > head.byteLength) {
    text = headerDecoder.decode(await file.slice(0, MAX_HEADER_BYTES).arrayBuffer());
    end = findEnd(text);
  }
  if (!end || end > MAX_HEADER_BYTES) {
    return { kind: 'invalid', reason: 'PLY header is truncated or exceeds the 64 KiB admission limit.' };
  }
  const header = text.slice(0, end);
  // Decode only the ASCII/space/LF subset that upstream's TextDecoder('ascii')
  // reads identically. Ordinary dispatch retains parsePlyHeader's BOM, Unicode
  // trim and whitespace compatibility above.
  if (decode && (!header.startsWith('ply\n') || /[^\x20-\x7e\n]/.test(header))) {
    return { kind: 'invalid', reason: 'Unsupported Gaussian decoder header whitespace or magic.' };
  }
  // Decoder lines and words are pinned readHeader's split('\n') and split(' '),
  // each without empty entries: repeated, leading and trailing spaces (such as
  // space-padded counts) are its grammar, not shifted tokens.
  const lines = decode ? header.split('\n').filter(Boolean) : header.split('\n').map(line => line.trim());
  let vertex = false, count = 0, elements = 0, vertexElements = 0, stride = 0, malformed = false;
  let encoding = '';
  let precedingElement = false;
  const properties = new Set<string>();
  for (const line of lines) {
    // parsePlyHeader ignores tab-only keyword separators, but splits tokens
    // with /\s+/ once the directive's literal-space prefix matches.
    const fields = decode ? line.split(' ').filter(Boolean) : line.split(/\s+/);
    const keyword = decode ? fields[0] : ['format', 'element', 'property'].find(word => line.startsWith(`${word} `));
    if (decode) {
      // readHeader throws on any other first word (none: a space-only line),
      // on element/property arity, list or alias types, and orphan properties.
      if (!DECODE_DIRECTIVES.includes(keyword ?? '')) {
        return { kind: 'invalid', reason: 'Unsupported Gaussian decoder header directive.' };
      }
      if ((keyword === 'element' && fields.length !== 3)
        || (keyword === 'property' && (!elements || fields.length !== 3 || !DECODE_TYPES.includes(fields[1])))) {
        return { kind: 'invalid', reason: 'Unsupported Gaussian decoder element or property declaration.' };
      }
      // Its comment text is line.substring(8): indentation shifts the words
      // that select a render model (SplatRenderMode, antialiased) out of view.
      if (keyword === 'comment' && !line.startsWith('comment')) {
        return { kind: 'invalid', reason: 'Unsupported indented Gaussian decoder header comment.' };
      }
    }
    if (keyword === 'format') encoding = fields[1] ?? '';
    if (keyword === 'element') {
      elements++;
      vertex = fields[1] === 'vertex';
      if (!vertex && vertexElements === 0) precedingElement = true;
      if (vertex) {
        count = Number(fields[2]); vertexElements++;
        if (!/^\d+$/.test(fields[2] ?? '') || fields.length !== 3) malformed = true;
      }
    }
    if (keyword !== 'property' || !vertex) continue;
    const list = fields[1] === 'list';
    const name = fields[list ? 4 : 2];
    if (!name) { malformed = true; continue; }
    if (properties.has(name)) malformed = true;
    properties.add(name);
    const width = SCALAR_BYTES[fields[1]];
    if (list || typeof width !== 'number' || fields.length !== 3) malformed = true;
    else stride += width;
  }
  // Pinned readPly selects its separate compressed reader on this vertex
  // property alone, even alongside all ordinary Gaussian channels. Its chunk
  // bounds allocate from a different element count, outside our stride budget.
  // Launch scope is uncompressed PLY: refuse before opening any upstream reader.
  if (decode && properties.has('packed_position')) {
    return { kind: 'invalid', reason: 'Unsupported compressed Gaussian PLY (packed_position).' };
  }
  // Only vertex properties count; comments and similarly named face properties do not.
  // Opacity alone, or with an unrelated scale/rotation scalar, is ordinary
  // point-cloud metadata. Only the full 3DGS transform signature claims capture.
  const signature = ['opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  if (!signature.every(name => properties.has(name))) return { kind: 'ordinary' };
  // Upstream starts vertex records at headerBytes, without skipping earlier
  // elements. Public admission keeps reporting these captures as disabled.
  if (decode && precedingElement) {
    return { kind: 'invalid', reason: 'Unsupported Gaussian PLY element before vertex.' };
  }
  if (malformed || vertexElements !== 1 || REQUIRED.some(name => !properties.has(name))) {
    return { kind: 'invalid', reason: 'Malformed Gaussian PLY vertex schema.' };
  }
  const rest = [...properties].filter(name => name.startsWith('f_rest_'));
  // A complete higher degree is well formed but over the launch limit: say so.
  const shDegree = shDegreeForRestColumns(rest.length);
  if (shDegree < 0 || rest.some((_, i) => !properties.has(`f_rest_${i}`))) {
    return { kind: 'invalid', reason: 'Unsupported or incomplete Gaussian PLY spherical harmonics.' };
  }
  const refused = limits(file.size, count, properties.size, shDegree);
  if (refused) return refused;
  if (!(decode ? ['binary_little_endian', 'binary_big_endian'] : ['ascii', 'binary_little_endian', 'binary_big_endian']).includes(encoding)) {
    return { kind: 'invalid', reason: 'Unsupported Gaussian PLY encoding.' };
  }
  // ASCII body size is variable: only a decoder can validate its records.
  const bodyBytes = file.size - new TextEncoder().encode(text.slice(0, end)).byteLength;
  if (bodyBytes <= 0 || (encoding !== 'ascii' && bodyBytes < count * stride)) {
    return { kind: 'invalid', reason: 'Truncated Gaussian PLY vertex payload.' };
  }
  return { kind: 'capture', format: 'gaussian-ply', count, shDegree, recordStride: stride };
}
