/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MaterialInfo } from '@ifc-lite/parser';

/** Every material-name string exposed by one material association. */
export function materialNamesOf(info: MaterialInfo | null): string[] {
  if (!info) return [];
  const names: string[] = [];
  const push = (s: string | undefined) => { if (s) names.push(s); };
  push(info.name);
  for (const l of info.layers ?? []) { push(l.materialName); push(l.name); }
  for (const c of info.constituents ?? []) { push(c.materialName); push(c.name); }
  for (const p of info.profiles ?? []) { push(p.materialName); push(p.name); }
  for (const m of info.materials ?? []) push(m.name);
  return names;
}
