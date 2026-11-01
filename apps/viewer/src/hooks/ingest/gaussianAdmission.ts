// SPDX-License-Identifier: MPL-2.0

/** #8565: admission only. No decoded asset is published until M2 has a renderer contract. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const MAX_SPLATS = 2_000_000;
const REQUIRED = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SCALAR_BYTES: Readonly<Record<string, number>> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

export type GaussianAdmission =
  | { kind: 'ordinary' }
  | { kind: 'disabled'; format: 'gaussian-ply' | 'splat'; count: number; shDegree: number }
  | { kind: 'invalid'; reason: string };

function limits(size: number, count: number, columns: number): string | undefined {
  if (!Number.isSafeInteger(count) || count <= 0) return 'Invalid Gaussian record count.';
  if (size > MAX_SOURCE_BYTES || count > MAX_SPLATS || count * columns * 4 > MAX_DECODED_BYTES) {
    return 'Gaussian input exceeds the admission allocation limit.';
  }
}

// Use the same boundary as parsePlyHeader: first marker, then the following LF.
// In particular, trim whitespace (including form feed) must not hide the marker.
function headerEnd(text: string): number {
  const marker = text.indexOf('end_header');
  return marker < 0 ? 0 : text.indexOf('\n', marker) + 1;
}

/** Reads at most 64 KiB, never the body. Framing checks are not payload decoding/validation. */
export async function inspectGaussianAdmission(file: File, head: ArrayBuffer): Promise<GaussianAdmission> {
  // Decode the bounded probe before checking magic, just like parsePlyHeader.
  // TextDecoder consumes an initial UTF-8 BOM; a three-byte probe can contain
  // only that BOM and miss the following magic. Do not trim arbitrary prefixes.
  const prefix = new TextDecoder().decode(head);
  // Match the existing PLY detector/parser's magic prefix, including padded first lines.
  // Content wins over the suffix: an ordinary PLY named .splat remains a point cloud.
  if (!prefix.startsWith('ply')) {
    if (!/\.splat$/i.test(file.name)) return { kind: 'ordinary' };
    if (!file.size || file.size % 32 !== 0) return { kind: 'invalid', reason: 'Truncated or empty .splat input (32-byte records required).' };
    const count = file.size / 32;
    const reason = limits(file.size, count, 14);
    return reason ? { kind: 'invalid', reason } : { kind: 'disabled', format: 'splat', count, shDegree: 0 };
  }
  // Retain BOM bytes in the header used for the payload lower-bound check.
  const headerDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let text = headerDecoder.decode(head);
  let end = headerEnd(text);
  if (!end && file.size > head.byteLength) {
    text = headerDecoder.decode(await file.slice(0, MAX_HEADER_BYTES).arrayBuffer());
    end = headerEnd(text);
  }
  if (!end || end > MAX_HEADER_BYTES) {
    return { kind: 'invalid', reason: 'PLY header is truncated or exceeds the 64 KiB admission limit.' };
  }
  const lines = text.slice(0, end).split('\n').map(line => line.trim());
  let vertex = false, count = 0, vertexElements = 0, stride = 0, malformed = false;
  let encoding = '';
  const properties = new Set<string>();
  for (const line of lines) {
    // parsePlyHeader ignores tab-only keyword separators, but splits tokens
    // with /\s+/ once the directive's literal-space prefix matches.
    const fields = line.split(/\s+/);
    if (line.startsWith('format ')) encoding = fields[1];
    if (line.startsWith('element ')) {
      vertex = fields[1] === 'vertex';
      if (vertex) {
        count = Number(fields[2]); vertexElements++;
        if (!/^\d+$/.test(fields[2] ?? '') || fields.length !== 3) malformed = true;
      }
    }
    if (!line.startsWith('property ') || !vertex) continue;
    const list = fields[1] === 'list';
    const name = fields[list ? 4 : 2];
    if (!name) { malformed = true; continue; }
    if (properties.has(name)) malformed = true;
    properties.add(name);
    const width = SCALAR_BYTES[fields[1]];
    if (list || typeof width !== 'number' || fields.length !== 3) malformed = true;
    else stride += width;
  }
  // Only vertex properties count; comments and similarly named face properties do not.
  const gaussian = [...properties].some(name => /^(?:f_dc_|f_rest_)\d+$/.test(name))
    || (properties.has('opacity') && properties.has('scale_0') && properties.has('rot_0'));
  if (!gaussian) return { kind: 'ordinary' };
  if (malformed || vertexElements !== 1 || REQUIRED.some(name => !properties.has(name))) {
    return { kind: 'invalid', reason: 'Malformed Gaussian PLY vertex schema.' };
  }
  const rest = [...properties].filter(name => name.startsWith('f_rest_'));
  const shDegree = [0, 9, 24, 45].indexOf(rest.length);
  if (shDegree < 0 || rest.some((_, i) => !properties.has(`f_rest_${i}`))) {
    return { kind: 'invalid', reason: 'Unsupported or incomplete Gaussian PLY spherical harmonics.' };
  }
  const reason = limits(file.size, count, properties.size);
  if (reason) return { kind: 'invalid', reason };
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(encoding)) {
    return { kind: 'invalid', reason: 'Unsupported Gaussian PLY encoding.' };
  }
  // ASCII body size is variable: only a decoder can validate its records.
  const bodyBytes = file.size - new TextEncoder().encode(text.slice(0, end)).byteLength;
  if (bodyBytes <= 0 || (encoding !== 'ascii' && bodyBytes < count * stride)) {
    return { kind: 'invalid', reason: 'Truncated Gaussian PLY vertex payload.' };
  }
  return { kind: 'disabled', format: 'gaussian-ply', count, shDegree };
}
