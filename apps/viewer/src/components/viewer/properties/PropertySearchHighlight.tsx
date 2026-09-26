/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { foldPropertySearchText } from './propertySearch';

export function PropertySearchHighlight({ text, query }: { text: string; query?: string }) {
  if (!query) return text;
  // Locale lowercasing can expand one source character into multiple code
  // units (İ → i + combining dot). Track each folded unit's original span so
  // a match after an expansion still highlights the correct source text.
  let lower = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(offset)!);
    const folded = character.toLocaleLowerCase();
    for (let i = 0; i < folded.length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    lower += folded;
    offset += character.length;
  }
  const foldedQuery = foldPropertySearchText(query);
  const fragments: ReactNode[] = [];
  let start = 0;
  let index = lower.indexOf(foldedQuery, start);
  while (index >= 0) {
    const from = starts[index];
    const to = ends[index + foldedQuery.length - 1];
    if (from >= start) {
      fragments.push(text.slice(start, from));
      fragments.push(<mark key={from} className="bg-yellow-200 text-zinc-900 dark:bg-yellow-700 dark:text-white">{text.slice(from, to)}</mark>);
      start = to;
    }
    index = lower.indexOf(foldedQuery, index + foldedQuery.length);
  }
  fragments.push(text.slice(start));
  return <>{fragments}</>;
}
