/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Express-id remapping for the merged exporter: rewrite every `#N` reference of
 * one model's STEP line into the merged file's id space.
 *
 * Split out of `merged-exporter.ts` (it never used `this`) so the id-rewriting
 * rule lives in one small module next to the other merge-time line surgery
 * (`merged-empty-containers.ts`, `merged-subcontext.ts`).
 */

/**
 * Remap all #ID references in a STEP entity line.
 * Applies offset to all IDs, then overrides with specific remappings.
 *
 * Only `#<digits>` tokens in code positions are rewritten; tokens inside
 * single-quoted STEP strings (e.g. a 'Room #205' Name or a 'http://x#42'
 * URL) are left untouched so string attribute values are not corrupted.
 */
export function remapEntityText(
  entityText: string,
  offset: number,
  sharedRemap: ReadonlyMap<number, number>,
): string {
  const remapId = (originalId: number): string => {
    // Check if this ID has a specific remap (project, shared infrastructure)
    const remapped = sharedRemap.get(originalId);
    if (remapped !== undefined) {
      return `#${remapped}`;
    }
    // Apply offset
    return `#${originalId + offset}`;
  };

  let out = '';
  let inString = false;
  for (let i = 0; i < entityText.length; i++) {
    const char = entityText[i];

    if (inString) {
      out += char;
      if (char === "'") {
        // STEP escapes a literal quote by doubling it ('').
        if (entityText[i + 1] === "'") {
          out += entityText[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (char === "'") {
      inString = true;
      out += char;
      continue;
    }

    if (char === '#' && entityText[i + 1] >= '0' && entityText[i + 1] <= '9') {
      let j = i + 1;
      while (j < entityText.length && entityText[j] >= '0' && entityText[j] <= '9') j++;
      const originalId = parseInt(entityText.slice(i + 1, j), 10);
      out += remapId(originalId);
      i = j - 1;
      continue;
    }

    out += char;
  }
  return out;
}
