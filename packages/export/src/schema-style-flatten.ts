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

export class StyleFlatten {
  private readonly members = new Map<number, readonly string[]>();

  /** True for the one conversion that flattens: IFC2X3 or IFC4 source, IFC4X3 target. */
  static applies(from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
    return to === 'IFC4X3' && (from === 'IFC2X3' || from === 'IFC4');
  }

  /** An empty table for a conversion that flattens; undefined for one that does not. */
  static create(from: IfcSchemaVersion, to: IfcSchemaVersion): StyleFlatten | undefined {
    return StyleFlatten.applies(from, to) ? new StyleFlatten() : undefined;
  }

  /** Register an assignment record by its text (source, created or copied; the last record with an id wins). */
  note(expressId: number, text: string): void {
    const attrs = /^\s*#\d+\s*=\s*\w+\s*\((.*)\)\s*;?\s*$/s.exec(text)?.[1];
    const args = attrs === undefined ? null : splitTopLevelStepArguments(attrs);
    const list = args && args.length > 0 ? listMembers(args[0]) : null;
    // IFC4X3's `Styles` takes IfcPresentationStyle entities only: the typed
    // `IFCNULLSTYLE(.NULL.)` of IFC2X3/IFC4 has no place there and is dropped.
    if (list) this.members.set(expressId, list.filter((m) => !/^IFCNULLSTYLE\s*\(/i.test(m)));
    else this.members.delete(expressId);
  }

  /** {@link note}, for any record line: only an assignment is registered. */
  noteLine(line: string): void {
    const m = RECORD.exec(line);
    if (m && m[3].toUpperCase() === ASSIGNMENT) this.note(Number(m[2]), line);
  }

  /** From assignment records as `[expressId, record text]`. */
  static fromRecords(records: Iterable<readonly [number, string]>): StyleFlatten {
    const flat = new StyleFlatten();
    for (const [id, text] of records) flat.note(id, text);
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
    for (const id of store.entityIndex.byType.get(ASSIGNMENT) ?? []) {
      const ref = store.entityIndex.byId.get(id);
      if (ref) flat.note(id, decodeRange(store.source, ref.byteOffset, ref.byteOffset + ref.byteLength));
    }
    return flat;
  }

  /** An assignment record is not written. */
  drops(expressId: number): boolean {
    return this.members.has(expressId);
  }

  /**
   * The attribute list with its `Styles` entries flattened, or null when this
   * is not a styled item naming an assignment. `args` is the validated split.
   */
  flatten(entityType: string, args: readonly string[]): string | null {
    if (args.length < 2) return null;
    const styles = listMembers(args[1]);
    if (!styles || !styles.some((m) => {
      const id = refId(m);
      return id !== null && this.members.has(id);
    })) return null;
    if (!getInheritanceChainAcrossSchemas(entityType).includes('IfcStyledItem') && entityType !== 'IFCSTYLEDITEM') {
      return null;
    }
    const flat: string[] = [];
    for (const member of styles) {
      const id = refId(member);
      for (const m of (id !== null ? this.members.get(id) : undefined) ?? [member]) {
        if (!flat.includes(m)) flat.push(m);
      }
    }
    const out = [...args];
    out[1] = `(${flat.join(',')})`;
    return out.join(',');
  }

  /**
   * One source record through the flatten: null for an assignment (not
   * written), the flattened line for a styled item naming one, else `line`.
   */
  apply(line: string): string | null {
    const m = RECORD.exec(line);
    if (!m) return line;
    const type = m[3].toUpperCase();
    if (type === ASSIGNMENT && this.drops(Number(m[2]))) return null;
    const split = splitTopLevelStepArguments(m[5]);
    const flat = split === null ? null : this.flatten(type, split);
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
