/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcPresentationStyleAssignment` flattening for an IFC2X3 or IFC4 source
 * converted to IFC4X3 (#7742, D57).
 *
 * IFC4X3 dropped the assignment: `IfcStyledItem.Styles` takes
 * `IfcPresentationStyle` members directly. Refusing it (non-rooted, absent from
 * the IFC4X3 registry) would fail most real IFC2X3 files, so the conversion
 * flattens instead: every `Styles` entry of an `IfcStyledItem` (or subtype)
 * naming an assignment is replaced by that assignment's own members, in order,
 * each kept once, and the assignment records are not written.
 *
 * Complete by the schemas' own rules: in IFC2X3 and IFC4 the only legal
 * referrer of an assignment is `IfcStyledItem.Styles`. It is a pre-pass because
 * an assignment may follow the styled item that names it. Twin of
 * `rust/export/src/schema_style_flatten.rs`, pinned for both by
 * `rust/export/tests/fixtures/schema_style_flatten_vectors.json`.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { decodeRange } from './source-ref-bounds.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';

const ASSIGNMENT = 'IFCPRESENTATIONSTYLEASSIGNMENT';
/** Deepest list nesting {@link StyleFlatten.strip} reads (IFC nests three). */
const MAX_DEPTH = 8;

function listMembers(arg: string): string[] | null {
  const t = arg.trim();
  if (t.startsWith('(') && t.endsWith(')')) {
    const items = splitTopLevelStepArguments(t.slice(1, -1));
    return items === null ? null : items.map((m) => m.trim());
  }
  return [t];
}

function refId(token: string): number | null {
  const m = /^#\s*(\d+)$/.exec(token.trim());
  return m ? Number(m[1]) : null;
}

/** The `#n` ids of a `Styles` value, or null when a member is not a reference. */
function styleRefs(value: string): number[] | null {
  const ids = listMembers(value)?.map(refId) ?? null;
  return ids === null || ids.includes(null) ? null : (ids as number[]);
}

function isStyledItem(entityType: string): boolean {
  return entityType === 'IFCSTYLEDITEM' || getInheritanceChainAcrossSchemas(entityType).includes('IfcStyledItem');
}

export class StyleFlatten {
  private readonly members = new Map<number, readonly string[]>();
  /**
   * Styled items whose `Styles` names records only, by those ids: the ones
   * that can flatten to nothing. Read from the store once an assignment holds
   * nothing IFC4X3 can name (`collected`); noted lines always.
   */
  private readonly styled = new Map<number, readonly number[]>();
  private collected = false;
  /**
   * Styled items whose flattened `Styles` is empty (`SET [1:?]` in IFC4X3, so
   * `()` is not a file): not written, and every reference to one is removed (a
   * list member) or written `$` (a single slot).
   */
  private emptied = new Set<number>();

  /** True for the one conversion that flattens: IFC2X3 or IFC4 source, IFC4X3 target. */
  static applies(from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
    return to === 'IFC4X3' && (from === 'IFC2X3' || from === 'IFC4');
  }

  /** An empty table for a conversion that flattens; undefined for one that does not. */
  static create(from: IfcSchemaVersion, to: IfcSchemaVersion): StyleFlatten | undefined {
    return StyleFlatten.applies(from, to) ? new StyleFlatten() : undefined;
  }

  /** Register an assignment record by its text (source, created, copied or edited; the last record with an id wins). */
  note(expressId: number, text: string): void {
    const attrs = /^\s*#\d+\s*=\s*\w+\s*\((.*)\)\s*;?\s*$/s.exec(text)?.[1];
    const args = attrs === undefined ? null : splitTopLevelStepArguments(attrs);
    const list = args && args.length > 0 ? listMembers(args[0]) : null;
    // IFC4X3's `Styles` takes IfcPresentationStyle entities only: the typed
    // `IFCNULLSTYLE(.NULL.)` of IFC2X3/IFC4 has no place there and is dropped.
    if (list) this.members.set(expressId, list.filter((m) => !/^IFCNULLSTYLE\s*\(/i.test(m)));
    else this.members.delete(expressId);
  }

  /** {@link note}, for any record line: an assignment or a styled item is registered. Call {@link settle} after. */
  noteLine(line: string): void {
    const m = RECORD.exec(line);
    if (!m) return;
    const type = m[3].toUpperCase();
    if (type === ASSIGNMENT) this.note(Number(m[2]), line);
    else if (isStyledItem(type)) {
      const args = splitTopLevelStepArguments(m[5]);
      const refs = args && args.length > 1 ? styleRefs(args[1]) : null;
      if (refs) this.styled.set(Number(m[2]), refs);
      else this.styled.delete(Number(m[2]));
    }
  }

  /** From record lines (assignments and styled items are read, the rest ignored). */
  static fromRecords(records: Iterable<string>): StyleFlatten {
    const flat = new StyleFlatten();
    for (const text of records) flat.noteLine(text);
    flat.collected = true;
    flat.settle();
    return flat;
  }

  /** Read every assignment of a parsed store; undefined when the conversion does not flatten. */
  static fromStore(
    store: Pick<IfcDataStore, 'entityIndex' | 'source'>,
    from: IfcSchemaVersion,
    to: IfcSchemaVersion,
  ): StyleFlatten | undefined {
    const flat = StyleFlatten.create(from, to);
    if (!flat || !store.source) return flat;
    // @raw-entity-enumeration-ok the flatten reads SOURCE records; edits arrive through noteEdited and created records through noteLine
    for (const id of store.entityIndex.byType.get(ASSIGNMENT) ?? []) {
      // @raw-entity-enumeration-ok the flatten reads SOURCE records; edits arrive through noteEdited and created records through noteLine
      const ref = store.entityIndex.byId.get(id);
      if (ref) flat.note(id, decodeRange(store.source, ref.byteOffset, ref.byteOffset + ref.byteLength));
    }
    flat.settle(store);
    return flat;
  }

  /**
   * Edited source assignments: each id's record text after the session's
   * edits (`edited(id)`, null when unchanged), so a styled item flattens to
   * the members the user set, not the source ones.
   */
  noteEdited(store: Pick<IfcDataStore, 'entityIndex' | 'source'>, edited: (id: number, text: string) => string | null): void {
    if (!store.source) return;
    // @raw-entity-enumeration-ok the flatten reads SOURCE records; edits arrive through noteEdited and created records through noteLine
    for (const id of store.entityIndex.byType.get(ASSIGNMENT) ?? []) {
      // @raw-entity-enumeration-ok the flatten reads SOURCE records; edits arrive through noteEdited and created records through noteLine
      const ref = store.entityIndex.byId.get(id);
      const text = ref ? edited(id, decodeRange(store.source, ref.byteOffset, ref.byteOffset + ref.byteLength)) : null;
      if (text !== null) this.note(id, text);
    }
    this.settle(store);
  }

  /** Decide which styled items flatten to nothing, reading the store's styled items once an assignment holds nothing. */
  settle(store?: Pick<IfcDataStore, 'entityIndex' | 'source'>): void {
    const source = store?.source;
    if (source && !this.collected && [...this.members.values()].some((m) => m.length === 0)) {
      this.collected = true;
      // @raw-entity-enumeration-ok the flatten reads SOURCE records; edits arrive through noteEdited and created records through noteLine
      for (const [type, ids] of store.entityIndex.byType) {
        if (!isStyledItem(type.toUpperCase())) continue;
        for (const id of ids) {
          // @raw-entity-enumeration-ok the flatten reads SOURCE records; edits arrive through noteEdited and created records through noteLine
          const ref = store.entityIndex.byId.get(id);
          if (ref && !this.styled.has(id)) this.noteLine(decodeRange(source, ref.byteOffset, ref.byteOffset + ref.byteLength));
        }
      }
    }
    const empty = (r: number) => this.members.get(r)?.length === 0;
    this.emptied = new Set([...this.styled].filter(([, refs]) => refs.length > 0 && refs.every(empty)).map(([id]) => id));
  }

  /** A record that is not written: an assignment, or a styled item whose `Styles` flattens to nothing. */
  drops(expressId: number): boolean {
    return this.members.has(expressId) || this.emptied.has(expressId);
  }

  /**
   * The flattened `Styles` members, or null when this is not a styled item
   * naming an assignment. `args` is the validated split.
   */
  private flattened(entityType: string, args: readonly string[]): string[] | null {
    if (args.length < 2) return null;
    const styles = listMembers(args[1]);
    if (!styles || !styles.some((m) => {
      const id = refId(m);
      return id !== null && this.members.has(id);
    })) return null;
    if (!isStyledItem(entityType)) return null;
    const flat: string[] = [];
    for (const member of styles) {
      const id = refId(member);
      for (const m of (id !== null ? this.members.get(id) : undefined) ?? [member]) {
        if (!flat.includes(m)) flat.push(m);
      }
    }
    return flat;
  }

  /** `arg` without its references to an emptied styled item; null when `arg` is one. */
  private strip(arg: string, depth: number): string | null {
    const t = arg.trim();
    const id = refId(t);
    if (id !== null && this.emptied.has(id)) return null;
    const items = depth < MAX_DEPTH && t.startsWith('(') && t.endsWith(')') ? splitTopLevelStepArguments(t.slice(1, -1)) : null;
    if (items) {
      const kept = items.map((m) => this.strip(m, depth + 1));
      if (kept.some((k, i) => k !== items[i])) return `(${kept.filter((k): k is string => k !== null).join(',')})`;
    }
    return arg;
  }

  /**
   * The attribute list with its `Styles` entries flattened and its references
   * to an emptied styled item removed; `'drop'` when the record is a styled
   * item left with no style; null when nothing changes. `args` is the validated split.
   */
  flatten(entityType: string, args: readonly string[]): string | 'drop' | null {
    const out = [...args];
    let changed = false;
    const flat = this.flattened(entityType, args);
    if (flat !== null) {
      if (flat.length === 0) return 'drop';
      out[1] = `(${flat.join(',')})`;
      changed = true;
    }
    if (this.emptied.size > 0) {
      for (let i = 0; i < out.length; i++) {
        if (!out[i].includes('#')) continue;
        const stripped = this.strip(out[i], 0) ?? '$';
        if (stripped !== out[i]) {
          out[i] = stripped;
          changed = true;
        }
      }
    }
    return changed ? out.join(',') : null;
  }

  /**
   * One record through the flatten: null for an assignment or an emptied
   * styled item (not written), the rewritten line for a record naming either,
   * else `line`.
   */
  apply(line: string): string | null {
    const m = RECORD.exec(line);
    if (!m) return line;
    const type = m[3].toUpperCase();
    if (type === ASSIGNMENT && this.drops(Number(m[2]))) return null;
    const split = splitTopLevelStepArguments(m[5]);
    const flat = split === null ? null : this.flatten(type, split);
    if (flat === 'drop') return null;
    return flat === null ? line : `${m[1]}${m[3]}${m[4]}(${flat});`;
  }
}

const RECORD = /^(\s*#(\d+)\s*=\s*)(\w+)(\s*)\(([\s\S]*)\)\s*;?\s*$/;

/**
 * `convertStepLine`, with `styles` applied first (see {@link StyleFlatten.apply}).
 * Without `styles` it is `convertStepLine` itself.
 */
export function convertStepLineFlattening(
  styles: StyleFlatten | undefined,
  ...args: Parameters<typeof convertStepLine>
): string | null {
  const [line, ...rest] = args;
  const flat = styles ? styles.apply(line) : line;
  return flat === null ? null : convertStepLine(flat, ...rest);
}
