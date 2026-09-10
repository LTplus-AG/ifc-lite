/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PDFPageProxy } from 'pdfjs-dist';
import { PdfAppearanceError } from './types.js';
import type { PdfAffine, PdfVectorOperator, PdfVectorPage, PdfVectorPaint, PdfVectorRequest } from './vector-types.js';
export interface PdfVectorDecoder { version: string; ops: Readonly<Record<string, number>> }
const MAX_OPERATIONS = 100_000, MAX_NUMBERS = 2_000_000;
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
function rgb(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return;
  return [parseInt(value.slice(1,3),16)/255, parseInt(value.slice(3,5),16)/255, parseInt(value.slice(5,7),16)/255];
}
/** Only nonpainting text setup/resource hints can be ignored. Painted text,
 * clipping, groups, forms, optional content and unknown state always survive as
 * blocking diagnostics. Counting paths never establishes conversion fidelity. */
const NON_PAINTING = new Set([
  'dependency', 'beginText', 'endText', 'setCharSpacing', 'setWordSpacing',
  'setHScale', 'setLeading', 'setFont', 'setTextRenderingMode', 'setTextRise',
  'moveText', 'setLeadingMoveText', 'setTextMatrix', 'nextLine',
]);
const PAINTS: Readonly<Record<string, PdfVectorPaint>> = {
  stroke: 'stroke', closeStroke: 'closeStroke', fill: 'fill', eoFill: 'evenOddFill',
  fillStroke: 'fillStroke', eoFillStroke: 'evenOddFillStroke', closeFillStroke: 'closeFillStroke',
  closeEOFillStroke: 'closeEvenOddFillStroke', endPath: 'endPath',
};
function decode(name: string, raw: unknown, names: Map<number,string>): PdfVectorOperator | undefined {
  if (NON_PAINTING.has(name)) return;
  if (name === 'save' || name === 'restore') return { kind: name };
  const args = raw == null ? [] : array(raw);
  switch (name) {
    case 'transform': return { kind: 'transform', matrix: numbers(args,6) as PdfAffine };
    case 'setFillRGBColor': case 'setStrokeRGBColor': {
      const color = rgb(args[0]);
      return color ? { kind: name === 'setFillRGBColor' ? 'fillColor' : 'strokeColor', rgb: color }
        : unsupported(name);
    }
    case 'setLineWidth': return { kind: 'lineWidth', width: scalar(args[0]) };
    case 'setLineCap': return { kind: 'lineCap', cap: scalar(args[0]) };
    case 'setLineJoin': return { kind: 'lineJoin', join: scalar(args[0]) };
    case 'setMiterLimit': return { kind: 'miterLimit', limit: scalar(args[0]) };
    case 'setDash': return { kind: 'dash', lengths: numbers(args[0]), phase: scalar(args[1]) };
    case 'constructPath': {
      const paintName = names.get(scalar(args[0])) ?? 'unknownPaint';
      const paint = PAINTS[paintName];
      if (!paint) return unsupported(`constructPath:${paintName}`);
      const data = array(args[1]);
      if (data.length !== 1) return unsupported('constructPath:layout');
      // A fresh operator list has numeric DrawOPS; a previously rendered list
      // may have been mutated to Path2D by CanvasGraphics. Never accept that.
      const commands = data[0] == null ? [] : numbers(data[0]);
      return { kind: 'path', paint, commands };
    }
    default: return unsupported(name);
  }
}
export async function decodePdfVectorPage(
  page: PDFPageProxy, source: Uint8Array, request: PdfVectorRequest,
  decoder: PdfVectorDecoder, signal?: AbortSignal,
): Promise<PdfVectorPage> {
  if (decoder.version !== '6.3.289')
    throw new PdfAppearanceError('unsupported', 'This PDF decoder version has not been qualified for vectors.');
  const list = await page.getOperatorList({ intent: 'display' });
  if (signal?.aborted) throw new PdfAppearanceError('cancelled', 'PDF vector preparation cancelled.');
  if (list.fnArray.length > MAX_OPERATIONS || list.fnArray.length !== list.argsArray.length)
    throw new PdfAppearanceError('budget', 'PDF page exceeds the bounded vector operator budget.');
  const names = new Map(Object.entries(decoder.ops).map(([name,value]) => [value,name]));
  const operations: PdfVectorPage['operations'] = [];
  let numberCount = 0;
  for (let ordinal = 0; ordinal < list.fnArray.length; ordinal++) {
    const name = names.get(list.fnArray[ordinal]!) ?? `unknown-${list.fnArray[ordinal]}`;
    const operation = decode(name, list.argsArray[ordinal], names);
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
    decoderVersion: decoder.version, viewBox: view as [number,number,number,number],
    userUnit: page.userUnit, intrinsicRotation: page.rotate, operations,
  };
}
