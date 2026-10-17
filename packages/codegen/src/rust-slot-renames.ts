/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The same-position rename table behind the slot generator
 * (`schemas/attribute-renames.json`, F3e-0b, #7780): its shape and validation.
 * The semantic checks against the EXPRESS schemas live in the emitter.
 */

/** One row of `attribute-renames.json`. */
export interface AttributeRenameRow {
  /** The canonical name every other spelling resolves to. */
  readonly name: string;
  /** Older spellings of the same attribute at the same position. */
  readonly aliases: readonly string[];
  /** The entities (and all their subtypes) the row applies to. */
  readonly entities: readonly string[];
}

/** An older-release attribute that gets no slot (its name collides with the one it moved to). */
export interface AttributeOmitRow {
  readonly entity: string;
  readonly attribute: string;
}

export interface RenameTable {
  readonly renames: readonly AttributeRenameRow[];
  readonly omit: readonly AttributeOmitRow[];
}

/** Validate a parsed `attribute-renames.json`. */
export function parseRenames(json: unknown): RenameTable {
  const doc = json as { renames?: unknown; omit?: unknown };
  const rows = doc?.renames;
  if (!Array.isArray(rows)) throw new Error('attribute-renames.json: expected a "renames" array');
  const omitRows = doc.omit ?? [];
  if (!Array.isArray(omitRows)) throw new Error('attribute-renames.json: "omit" must be an array');
  const omit = omitRows.map((row, i) => {
    const { entity, attribute } = row as Partial<AttributeOmitRow>;
    if (typeof entity !== 'string' || typeof attribute !== 'string') {
      throw new Error(`attribute-renames.json: omit row ${i} needs entity and attribute`);
    }
    return { entity, attribute };
  });
  const renames = rows.map((row, i) => {
    const { name, aliases, entities } = row as Partial<AttributeRenameRow>;
    if (
      typeof name !== 'string' ||
      !Array.isArray(aliases) ||
      aliases.length === 0 ||
      !Array.isArray(entities) ||
      entities.length === 0 ||
      ![...aliases, ...entities].every((v) => typeof v === 'string')
    ) {
      throw new Error(`attribute-renames.json: row ${i} needs name, aliases[] and entities[]`);
    }
    return { name, aliases, entities };
  });
  return { renames, omit };
}

