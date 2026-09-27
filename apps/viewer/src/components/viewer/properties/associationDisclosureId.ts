/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Keep IFC metadata out of persistent localStorage keys while retaining a
 * stable identity for the parsed associations, which expose no EXPRESS id. */
function digest(signature: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < signature.length; i += 1) {
    const code = signature.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return [first, second].map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Identical association rows still get distinct preferences by ordinal. */
export function associationDisclosureId<T>(kind: string, info: T, list: readonly T[], index: number): string {
  const signature = JSON.stringify(info);
  const ordinal = list.slice(0, index).filter((prior) => JSON.stringify(prior) === signature).length;
  return `${kind}:${digest(signature)}:${ordinal}`;
}
