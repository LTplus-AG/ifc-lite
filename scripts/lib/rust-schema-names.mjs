/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Uppercase names `IfcType::from_str` resolves to a real variant. */
export function generatedNames(schemaSource) {
  const start = schemaSource.indexOf('pub fn from_str');
  if (start === -1) return new Set();
  const next = schemaSource.indexOf('pub fn ', start + 'pub fn from_str'.length);
  const body = schemaSource.slice(start, next === -1 ? undefined : next);
  return new Set(
    [...body.matchAll(/^\s+"(IFC[A-Z0-9]+)"\s*=>\s*(?:\{\s*)?Self::/gm)].map(
      (match) => match[1],
    ),
  );
}

/** Names in the canonical schema catalog, excluding supplemental variants. */
export function canonicalGeneratedNames(schemaSource) {
  const allStart = schemaSource.indexOf('pub static ALL:');
  if (allStart === -1) return new Set();
  const allEnd = schemaSource.indexOf('];', allStart);
  if (allEnd === -1) return new Set();
  const variants = new Set(
    [...schemaSource.slice(allStart, allEnd).matchAll(/IfcType::(Ifc[A-Za-z0-9]+)/g)].map(
      (match) => match[1],
    ),
  );
  return new Set(
    [
      ...schemaSource.matchAll(
        /"(IFC[A-Z0-9]+)"\s*=>\s*(?:\{\s*)?Self::(Ifc[A-Za-z0-9]+)/g,
      ),
    ]
      .filter((match) => variants.has(match[2]))
      .map((match) => match[1]),
  );
}
