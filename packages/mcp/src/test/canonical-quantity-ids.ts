/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296: derived quantities are export-only records, allocated above the live
 * overlay's id cursor. Undo restores the IFC graph but need not rewind that
 * cursor. Compare their graph by set GlobalId while retaining every attribute,
 * reference, value and all non-quantity entity ids in strict undo assertions.
 * Only used on StepExporter output (one physical line per record).
 */
export function canonicalQuantityIds(content: string | Uint8Array, sourceIds: ReadonlySet<number>): string {
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  const records = new Map<number, { type: string; body: string }>();
  for (const match of text.matchAll(/^#(\d+)=(\w+)\((.*)\);$/gm)) {
    records.set(Number(match[1]), { type: match[2], body: match[3] });
  }
  // Never rewrite # tokens embedded inside IFC string values.
  const refs = (body: string): number[] => [...body.matchAll(/'(?:''|[^'])*'|#(\d+)/g)]
    .flatMap(match => match[1] === undefined ? [] : [Number(match[1])]);
  const sets = [...records].filter(([id, record]) => record.type === 'IFCELEMENTQUANTITY' && !sourceIds.has(id))
    .sort((a, b) => a[1].body.localeCompare(b[1].body));
  const ids = new Map<number, number>();
  const assign = (id: number) => { if (!sourceIds.has(id) && !ids.has(id)) ids.set(id, 0); };
  for (const [id, set] of sets) {
    assign(id);
    for (const child of refs(set.body)) {
      if (records.get(child)?.type.startsWith('IFCQUANTITY')) assign(child);
    }
    for (const [relId, rel] of records) {
      if (rel.type === 'IFCRELDEFINESBYPROPERTIES' && refs(rel.body).at(-1) === id) assign(relId);
    }
  }
  let next = Math.max(0, ...[...records.keys()].filter(id => !ids.has(id))) + 1;
  for (const id of ids.keys()) ids.set(id, next++);
  // Keep physical record ordering stable too; generated ids can cross source ids.
  const rewritten = text.replace(/'(?:''|[^'])*'|#(\d+)/g, (token: string, id: string | undefined) =>
    id === undefined ? token : `#${ids.get(Number(id)) ?? id}`);
  const lines = rewritten.split('\n');
  const entityLines = lines.filter(line => /^#\d+=/.test(line))
    .sort((a, b) => Number(a.slice(1, a.indexOf('='))) - Number(b.slice(1, b.indexOf('='))));
  let index = 0;
  return lines.map(line => /^#\d+=/.test(line) ? entityLines[index++] : line).join('\n');
}
