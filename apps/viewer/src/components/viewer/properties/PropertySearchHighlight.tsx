/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';

export function PropertySearchHighlight({ text, query }: { text: string; query?: string }) {
  if (!query) return text;
  const lower = text.toLocaleLowerCase();
  const fragments: ReactNode[] = [];
  let start = 0;
  let index = lower.indexOf(query, start);
  while (index >= 0) {
    fragments.push(text.slice(start, index));
    fragments.push(<mark key={index} className="bg-yellow-200 text-zinc-900 dark:bg-yellow-700 dark:text-white">{text.slice(index, index + query.length)}</mark>);
    start = index + query.length;
    index = lower.indexOf(query, start);
  }
  fragments.push(text.slice(start));
  return <>{fragments}</>;
}
