/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Studio outline (IDS-031) as flat rows for a virtualised tree, plus the
 * tree keyboard model (UX spec §7: ↑↓ move, →← expand/collapse or go to the
 * parent/first child, Home/End). Pure; the component renders and focuses.
 */

import type { Section, StudioDocument, Uuid } from '@ifc-lite/ids-authoring';
import type { IDSFacet, RequirementOptionality } from '@ifc-lite/ids';

export type OutlineRow =
  | { kind: 'spec'; id: Uuid; depth: 1; specIndex: number; expandable: true }
  | { kind: 'section'; id: string; depth: 2; specId: Uuid; section: Section; count: number; expandable: boolean }
  | {
      kind: 'facet';
      id: Uuid;
      depth: 3;
      specId: Uuid;
      section: Section;
      index: number;
      facet: IDSFacet;
      optionality?: RequirementOptionality;
      expandable: false;
    };

/** A section row's id: one per spec and section, never a document node id. */
export function sectionRowId(specId: Uuid, section: Section): string {
  return `${specId}/${section}`;
}

function matches(text: string | undefined, needle: string): boolean {
  return !!text && text.toLowerCase().includes(needle);
}

/**
 * Rows for every specification whose name, identifier or description
 * contains `filter` (case-insensitive). Rows under a collapsed id are left
 * out; ids in `collapsed` may be spec ids or section row ids.
 */
export function outlineRows(doc: StudioDocument, collapsed: ReadonlySet<string>, filter = ''): OutlineRow[] {
  const needle = filter.trim().toLowerCase();
  const rows: OutlineRow[] = [];
  doc.ids.specifications.forEach((spec, specIndex) => {
    if (needle && !matches(spec.name, needle) && !matches(spec.identifier, needle) && !matches(spec.description, needle)) return;
    const nodes = doc.nodes.specs[specIndex];
    rows.push({ kind: 'spec', id: nodes.id, depth: 1, specIndex, expandable: true });
    if (collapsed.has(nodes.id)) return;
    const sections: Array<[Section, number]> = [['applicability', spec.applicability.facets.length], ['requirements', spec.requirements.length]];
    for (const [section, count] of sections) {
      const id = sectionRowId(nodes.id, section);
      rows.push({ kind: 'section', id, depth: 2, specId: nodes.id, section, count, expandable: count > 0 });
      if (collapsed.has(id)) continue;
      if (section === 'applicability') {
        spec.applicability.facets.forEach((facet, index) => rows.push({
          kind: 'facet', id: nodes.applicability[index].id, depth: 3, specId: nodes.id, section, index, facet, expandable: false,
        }));
      } else {
        spec.requirements.forEach((requirement, index) => rows.push({
          kind: 'facet', id: nodes.requirements[index].id, depth: 3, specId: nodes.id, section, index,
          facet: requirement.facet, optionality: requirement.optionality, expandable: false,
        }));
      }
    }
  });
  return rows;
}

/** What a key press in the tree does. */
export type OutlineKeyAction =
  | { kind: 'focus'; id: string }
  | { kind: 'collapse'; id: string }
  | { kind: 'expand'; id: string }
  | { kind: 'none' };

/** The WAI-ARIA tree pattern over flat rows. `active` is the focused row id. */
export function outlineKey(rows: readonly OutlineRow[], active: string | null, key: string, collapsed: ReadonlySet<string>): OutlineKeyAction {
  if (rows.length === 0) return { kind: 'none' };
  const at = active === null ? -1 : rows.findIndex((row) => row.id === active);
  const row = at >= 0 ? rows[at] : undefined;
  switch (key) {
    case 'ArrowDown': return { kind: 'focus', id: rows[Math.min(rows.length - 1, at + 1)].id };
    case 'ArrowUp': return { kind: 'focus', id: rows[Math.max(0, at - 1)].id };
    case 'Home': return { kind: 'focus', id: rows[0].id };
    case 'End': return { kind: 'focus', id: rows[rows.length - 1].id };
    case 'ArrowRight': {
      if (!row) return { kind: 'focus', id: rows[0].id };
      if (!row.expandable) return { kind: 'none' };
      if (collapsed.has(row.id)) return { kind: 'expand', id: row.id };
      const child = rows[at + 1];
      return child && child.depth > row.depth ? { kind: 'focus', id: child.id } : { kind: 'none' };
    }
    case 'ArrowLeft': {
      if (!row) return { kind: 'none' };
      if (row.expandable && !collapsed.has(row.id)) return { kind: 'collapse', id: row.id };
      for (let i = at - 1; i >= 0; i--) if (rows[i].depth < row.depth) return { kind: 'focus', id: rows[i].id };
      return { kind: 'none' };
    }
    default: return { kind: 'none' };
  }
}
