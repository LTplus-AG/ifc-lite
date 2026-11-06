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
  const needle = query.trim().toLocaleLowerCase();
  const at = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
  // Lower-casing can change length (e.g. 'İ'), so a slice by the needle's
  // length is only safe when the haystack kept its length.
  if (at < 0 || text.toLocaleLowerCase().length !== text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark data-match="" className="bg-transparent font-semibold text-active">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
