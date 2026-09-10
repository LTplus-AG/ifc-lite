/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Loaded copies remain separate even when filenames and source bytes match. */
export function modelDisplayLabels(models: ReadonlyMap<string, { name: string }>, maxLength = Infinity): Map<string, string> {
  const counts = new Map<string, number>();
  for (const model of models.values()) counts.set(model.name, (counts.get(model.name) ?? 0) + 1);
  return new Map([...models].map(([id, model], index) => {
    const suffix = (counts.get(model.name) ?? 0) > 1 ? ` · Model ${index + 1}` : '';
    const limit = Math.max(1, maxLength - suffix.length);
    const name = model.name.length > limit ? `${model.name.slice(0, limit - 1)}…` : model.name;
    return [id, name + suffix];
  }));
}
