/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { capturedEvidence } from '@/lib/assistant/captured-rows';
import { record, type SourceSpan } from './proposal-common';

/** One captured passage of an attached text, with exact offsets into that text. */
export interface Passage { kind: 'passage'; source: string; start: number; end: number; text: string }

const PASSAGE_CHARACTERS = 500;

/**
 * Split a text into paragraph passages of at most 500 characters, keeping
 * exact offsets. Blank lines separate paragraphs; long paragraphs break at the
 * last whitespace before the limit. Offsets are UTF-16 code units, as in JS.
 */
export function passagesOf(source: string, value: string): Passage[] {
  const passages: Passage[] = [];
  const paragraph = /[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g;
  for (const match of value.matchAll(paragraph)) {
    let start = match.index;
    const end = match.index + match[0].length;
    while (start < end) {
      let stop = Math.min(end, start + PASSAGE_CHARACTERS);
      if (stop < end) {
        const space = value.lastIndexOf(' ', stop);
        if (space > start + PASSAGE_CHARACTERS / 2) stop = space + 1;
      }
      // Never split a surrogate pair: the quote must be representable on its own.
      if (stop < end && /[\uD800-\uDBFF]/.test(value[stop - 1])) stop--;
      passages.push({ kind: 'passage', source, start, end: stop, text: value.slice(start, stop) });
      start = stop;
    }
  }
  return passages;
}

/** Passages that were actually frozen into an evidence payload (what the assistant saw). */
export function capturedPassages(payload: string): Passage[] {
  const captured = capturedEvidence(payload);
  if (!captured) return [];
  const passages: Passage[] = [];
  for (const data of captured.rows.values()) {
    if (record(data) && data.kind === 'passage' && typeof data.source === 'string' && typeof data.text === 'string'
      && Number.isSafeInteger(data.start) && Number.isSafeInteger(data.end)
      && (data.end as number) - (data.start as number) === data.text.length) {
      passages.push({ kind: 'passage', source: data.source, start: data.start as number, end: data.end as number, text: data.text });
    }
  }
  return passages.sort((a, b) => a.source.localeCompare(b.source) || a.start - b.start);
}

export type SpanCheck =
  | { status: 'verified' }
  /** The offsets are captured, but the text there differs; `foundAt` is only a hint, never a correction. */
  | { status: 'mismatch'; actual: string; foundAt?: number }
  /** The offsets fall outside every captured passage of that source. */
  | { status: 'not-captured' };

/** A span verifies only if the captured text at its exact offsets equals its quote. */
export function verifySpan(span: SourceSpan, passages: readonly Passage[]): SpanCheck {
  const own = passages.filter(passage => passage.source === span.source);
  let cursor = span.start;
  let actual = '';
  while (cursor < span.end) {
    const passage = own.find(candidate => candidate.start <= cursor && cursor < candidate.end);
    // Whitespace between captured paragraphs was never shown either.
    if (!passage) return { status: 'not-captured' };
    const stop = Math.min(span.end, passage.end);
    actual += passage.text.slice(cursor - passage.start, stop - passage.start);
    cursor = stop;
  }
  if (actual === span.quote) return { status: 'verified' };
  const hits = own.flatMap(passage => {
    const index = passage.text.indexOf(span.quote);
    return index >= 0 && passage.text.indexOf(span.quote, index + 1) < 0 ? [passage.start + index] : index >= 0 ? [-1, -1] : [];
  });
  return hits.length === 1 && hits[0] >= 0 ? { status: 'mismatch', actual, foundAt: hits[0] } : { status: 'mismatch', actual };
}
