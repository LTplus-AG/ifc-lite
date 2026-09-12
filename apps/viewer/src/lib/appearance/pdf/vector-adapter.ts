/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PDFPageProxy } from 'pdfjs-dist';
import { PdfAppearanceError } from './types.js';
import { PdfTextTracker, type PdfFontObjects } from './vector-text-state.js';
import type { PdfAffine, PdfGraphicsStateOperator, PdfPageRect, PdfVectorOperator, PdfVectorPage, PdfVectorPaint, PdfVectorRequest } from './vector-types.js';
export interface PdfVectorDecoder { version: string; ops: Readonly<Record<string, number>> }
/** Document-level decoder context: optional-content visibility and resolved fonts. */
export interface PdfVectorDecodeContext {
  optionalContent?: { isVisible(group: unknown): unknown } | null;
  fonts?: PdfFontObjects;
}
const MAX_OPERATIONS = 100_000, MAX_NUMBERS = 2_000_000, MAX_PLACEMENTS = 4096;
function unsupported(operator: string): PdfVectorOperator { return { kind: 'unsupported', operator }; }
function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Float32Array || value instanceof Float64Array) {
    if (value.length > MAX_NUMBERS) throw new PdfAppearanceError('budget', 'PDF numeric array exceeds budget.');
    return Array.from(value);
  }
  throw new PdfAppearanceError('unsupported', 'Unexpected pinned PDF operator argument layout.');
}
function numbers(value: unknown, length?: number): number[] {
  const values = array(value);
  if ((length !== undefined && values.length !== length) || values.length > MAX_NUMBERS
    || !values.every((x): x is number => typeof x === 'number' && Number.isFinite(x)))
    throw new PdfAppearanceError('unsupported', 'Invalid or oversized PDF numeric operator arguments.');
  return values;
}
function scalar(value: unknown): number { return numbers([value], 1)[0]!; }
function affine(value: unknown): PdfAffine { return numbers(value, 6) as PdfAffine; }
function rect(value: unknown): PdfPageRect { return numbers(value, 4) as PdfPageRect; }
function optional<T>(value: unknown, read: (value: unknown) => T): T | null { return value == null ? null : read(value); }
function rgb(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return;
  return [parseInt(value.slice(1,3),16)/255, parseInt(value.slice(3,5),16)/255, parseInt(value.slice(5,7),16)/255];
}
/** Operators that paint nothing and change no state the planner or report reads. */
const NON_PAINTING = new Set(['dependency', 'setRenderingIntent', 'setFlatness', 'beginCompat', 'endCompat', 'markPoint', 'markPointProps']);
const PAINTS: Readonly<Record<string, PdfVectorPaint>> = {
  stroke: 'stroke', closeStroke: 'closeStroke', fill: 'fill', eoFill: 'evenOddFill',
  fillStroke: 'fillStroke', eoFillStroke: 'evenOddFillStroke', closeFillStroke: 'closeFillStroke',
  closeEOFillStroke: 'closeEvenOddFillStroke', endPath: 'endPath',
};
/** Unit-square placements of every pinned raster paint operator. */
function imagePlacements(name: string, args: unknown[]): PdfAffine[] | undefined {
  const identity: PdfAffine = [1, 0, 0, 1, 0, 0];
  switch (name) {
    case 'paintImageXObject': case 'paintInlineImageXObject': case 'paintImageMaskXObject': case 'paintSolidColorImageMask':
      return [identity];
    case 'paintImageXObjectRepeat': {
      const [sx, sy, positions] = [scalar(args[1]), scalar(args[2]), numbers(args[3])];
      if (positions.length % 2 || positions.length / 2 > MAX_PLACEMENTS) return;
      return Array.from({ length: positions.length / 2 }, (_, i) => [sx, 0, 0, sy, positions[i * 2]!, positions[i * 2 + 1]!] as PdfAffine);
    }
    case 'paintImageMaskXObjectRepeat': {
      const [sx, kx, ky, sy, positions] = [scalar(args[1]), scalar(args[2] ?? 0), scalar(args[3] ?? 0), scalar(args[4]), numbers(args[5])];
      if (positions.length % 2 || positions.length / 2 > MAX_PLACEMENTS) return;
      return Array.from({ length: positions.length / 2 }, (_, i) => [sx, kx, ky, sy, positions[i * 2]!, positions[i * 2 + 1]!] as PdfAffine);
    }
    case 'paintImageMaskXObjectGroup': case 'paintInlineImageXObjectGroup': {
      const entries = array(name === 'paintImageMaskXObjectGroup' ? args[0] : args[1]);
      if (entries.length > MAX_PLACEMENTS) return;
      return entries.map(entry => affine((entry as { transform?: unknown } | null)?.transform));
    }
    default: return;
  }
}
function graphicsState(pairs: unknown[], text: PdfTextTracker): PdfGraphicsStateOperator {
  const state: PdfGraphicsStateOperator = { kind: 'graphicsState', lineWidth: null, lineCap: null, lineJoin: null, miterLimit: null, dash: null, transparency: [], unsupported: [] };
  for (const pair of pairs) {
    const [key, value] = array(pair);
    switch (key) {
      case 'LW': state.lineWidth = scalar(value); break;
      case 'LC': state.lineCap = scalar(value); break;
      case 'LJ': state.lineJoin = scalar(value); break;
      case 'ML': state.miterLimit = scalar(value); break;
      case 'D': { const [lengths, phase] = array(value); state.dash = [numbers(lengths), scalar(phase)]; break; }
      case 'RI': case 'FL': break;
      case 'Font': { const [name, size] = array(value); text.setFont(name, size); break; }
      case 'CA': case 'ca': if (scalar(value) !== 1) state.transparency.push(key); break;
      // The evaluator normalizes Normal/Compatible to the canvas default.
      case 'BM': if (value !== 'source-over') state.transparency.push(`BM:${String(value)}`); break;
      case 'SMask': if (value) state.transparency.push('SMask'); break;
      case 'TR': if (value != null) state.unsupported.push('TR'); break;
      default: state.unsupported.push(typeof key === 'string' && key ? key : 'unknown');
    }
  }
  return state;
}
class Decoder {
  private readonly text: PdfTextTracker;
  private readonly marked: boolean[] = [];
  private hidden = 0;
  constructor(private readonly names: Map<number, string>, private readonly context: PdfVectorDecodeContext) {
    this.text = new PdfTextTracker(context.fonts);
  }
  private get visible(): boolean { return this.hidden === 0; }
  /** One decoded operation per pinned operator, or nothing for consumed text setup. */
  decode(name: string, raw: unknown): PdfVectorOperator | undefined {
    if (NON_PAINTING.has(name)) return;
    const args = raw == null ? [] : array(raw);
    if (name === 'showText') {
      const run = this.text.showText(args[0], this.visible);
      return run ? { kind: 'text', ...run } : undefined;
    }
    if (name === 'endText') return this.text.endText() ? { kind: 'textClip' } : undefined;
    if (this.text.operate(name, args)) return;
    const images = imagePlacements(name, args);
    if (images) return { kind: 'image', transforms: images };
    switch (name) {
      case 'save': this.text.save(); return { kind: 'save' };
      case 'restore': this.text.restore(); return { kind: 'restore' };
      case 'transform': return { kind: 'transform', matrix: affine(args) };
      case 'setFillRGBColor': case 'setStrokeRGBColor': {
        const color = rgb(args[0]);
        return color ? { kind: name === 'setFillRGBColor' ? 'fillColor' : 'strokeColor', rgb: color } : unsupported(name);
      }
      case 'setLineWidth': return { kind: 'lineWidth', width: scalar(args[0]) };
      case 'setLineCap': return { kind: 'lineCap', cap: scalar(args[0]) };
      case 'setLineJoin': return { kind: 'lineJoin', join: scalar(args[0]) };
      case 'setMiterLimit': return { kind: 'miterLimit', limit: scalar(args[0]) };
      case 'setDash': return { kind: 'dash', lengths: numbers(args[0]), phase: scalar(args[1]) };
      case 'setGState': return graphicsState(array(args[0]), this.text);
      case 'clip': return { kind: 'clip', evenOdd: false };
      case 'eoClip': return { kind: 'clip', evenOdd: true };
      case 'shadingFill': return { kind: 'shading' };
      case 'setFillColorN': return { kind: 'fillPattern' };
      case 'setStrokeColorN': return { kind: 'strokePattern' };
      case 'constructPath': {
        const paintName = this.names.get(scalar(args[0])) ?? 'unknownPaint';
        const paint = PAINTS[paintName];
        if (!paint) return unsupported(`constructPath:${paintName}`);
        const data = array(args[1]);
        if (data.length !== 1) return unsupported('constructPath:layout');
        // A fresh operator list has numeric DrawOPS; a previously rendered list
        // may have been mutated to Path2D by CanvasGraphics. Never accept that.
        const commands = data[0] == null ? [] : numbers(data[0]);
        return { kind: 'path', paint, commands };
      }
      // The pinned canvas saves around forms and groups only while content is visible.
      case 'paintFormXObjectBegin': if (this.visible) this.text.save();
        return { kind: 'formBegin', matrix: optional(args[0], affine), bbox: optional(args[1], rect) };
      case 'paintFormXObjectEnd': if (this.visible) this.text.restore(); return { kind: 'formEnd' };
      case 'beginGroup': {
        const group = (args[0] ?? {}) as Record<string, unknown>;
        if (this.visible) this.text.save();
        const composited = !((!group.needsIsolation || (!group.isolated && !group.hasSoftMask)) && !group.knockout && !group.isGray);
        return { kind: 'groupBegin', composited, matrix: optional(group.matrix, affine), bbox: optional(group.bbox, rect) };
      }
      case 'endGroup': if (this.visible) this.text.restore(); return { kind: 'groupEnd' };
      case 'beginAnnotation': this.text.reset(); return { kind: 'annotationBegin', rect: optional(args[1], rect) };
      case 'endAnnotation': this.text.reset(); return { kind: 'annotationEnd' };
      case 'beginMarkedContent': this.marked.push(true); return { kind: 'markedContent', visible: true };
      case 'beginMarkedContentProps': {
        const visible = args[0] === 'OC' ? this.context.optionalContent?.isVisible(args[1]) !== false : true;
        this.marked.push(visible);
        if (!visible) this.hidden++;
        return { kind: 'markedContent', visible };
      }
      case 'endMarkedContent': if (this.marked.pop() === false) this.hidden--; return { kind: 'endMarkedContent' };
      default: return unsupported(name);
    }
  }
}
export async function decodePdfVectorPage(
  page: PDFPageProxy, source: Uint8Array, request: PdfVectorRequest,
  decoder: PdfVectorDecoder, signal?: AbortSignal, context: PdfVectorDecodeContext = {},
): Promise<PdfVectorPage> {
  if (decoder.version !== '6.3.289')
    throw new PdfAppearanceError('unsupported', 'This PDF decoder version has not been qualified for vectors.');
  const list = await page.getOperatorList({ intent: 'display' });
  if (signal?.aborted) throw new PdfAppearanceError('cancelled', 'PDF vector preparation cancelled.');
  if (list.fnArray.length > MAX_OPERATIONS || list.fnArray.length !== list.argsArray.length)
    throw new PdfAppearanceError('budget', 'PDF page exceeds the bounded vector operator budget.');
  const names = new Map(Object.entries(decoder.ops).map(([name,value]) => [value,name]));
  const decode = new Decoder(names, { fonts: page.commonObjs, ...context });
  const operations: PdfVectorPage['operations'] = [];
  let numberCount = 0;
  for (let ordinal = 0; ordinal < list.fnArray.length; ordinal++) {
    const name = names.get(list.fnArray[ordinal]!) ?? `unknown-${list.fnArray[ordinal]}`;
    const operation = decode.decode(name, list.argsArray[ordinal]);
    if (!operation) continue;
    if (operation.kind === 'path') numberCount += operation.commands.length;
    if (numberCount > MAX_NUMBERS)
      throw new PdfAppearanceError('budget', 'PDF page exceeds two million path numbers.');
    operations.push({ ordinal, operation });
  }
  const view = numbers(page.view,4);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(source)));
  return {
    ...request, pdfSha256: Array.from(hash, byte => byte.toString(16).padStart(2,'0')).join(''),
    decoderVersion: decoder.version, viewBox: view as PdfPageRect,
    userUnit: page.userUnit, intrinsicRotation: page.rotate, operations,
  };
}
