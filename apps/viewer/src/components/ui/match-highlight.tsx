/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A search result's name with the typed query marked (#8802 R4): the first
 * case-insensitive occurrence of the trimmed query is painted in the active
 * ink, semibold, so the eye finds why a row matched. Purely presentational:
 * which results appear, and their order, belong to the caller's ranking.
 * Without an occurrence (a keyword or fuzzy match) the text renders plain.
 */

export interface MatchHighlightProps {
  text: string;
  query: string;
}

export function MatchHighlight({ text, query }: MatchHighlightProps) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  // Match the source text itself rather than a lower-cased copy: lower-casing
  // can change a string's length ('İ' becomes two code units), which would
  // shift every offset after it. The `iu` flags use Unicode's locale-free case
  // folding, so a Turkish locale cannot lose the 'I' in 'IFC' either.
  const hit = new RegExp(needle.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), 'iu').exec(text);
  if (!hit) return <>{text}</>;
  const at = hit.index;
  const end = at + hit[0].length;
  return (
    <>
      {text.slice(0, at)}
      <mark data-match="" className="bg-transparent font-semibold text-active">{text.slice(at, end)}</mark>
      {text.slice(end)}
    </>
  );
}
