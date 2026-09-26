/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Parsed association rows do not expose their EXPRESS id. Use all displayed
 * metadata plus the ordinal among identical rows, so same-named cards do not
 * share a disclosure preference while selection/reload keeps a stable key. */
export function associationDisclosureId<T>(kind: string, info: T, list: readonly T[], index: number): string {
  const signature = JSON.stringify(info);
  const ordinal = list.slice(0, index).filter((prior) => JSON.stringify(prior) === signature).length;
  return `${kind}:${signature}:${ordinal}`;
}
