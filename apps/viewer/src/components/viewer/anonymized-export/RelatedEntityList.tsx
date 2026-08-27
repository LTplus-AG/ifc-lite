/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grouped, checkable list of the "RESULT" section of `AnonymizedExportDialog`
 * — one section per seed group / `RelatedEntityGroup`, a tri-state header
 * checkbox per section, and native `<input type="checkbox">` rows (the repo
 * has no `Checkbox` primitive — see `apps/viewer/AGENTS.md`'s house pattern
 * for this dialog). Virtualizes with `@tanstack/react-virtual` once the
 * flattened row count passes ~200, matching `HierarchyPanel.tsx`.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RelatedEntities } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';

interface RelatedEntityListProps {
  dataStore: IfcDataStore | null;
  seeds: readonly number[];
  related: RelatedEntities | null;
  excludedIds: ReadonlySet<number>;
  lockedIds: ReadonlySet<number>;
  onSetExcluded: (id: number, excluded: boolean) => void;
}

interface Section {
  key: string;
  label: string;
  ids: number[];
}

type FlatRow =
  | { kind: 'header'; section: Section }
  | { kind: 'item'; section: Section; id: number };

const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 28;

function buildSections(seeds: readonly number[], related: RelatedEntities | null): Section[] {
  const sections: Section[] = [{ key: 'seeds', label: 'Seeds', ids: [...seeds] }];
  if (!related) return sections;
  for (const group of related.groups) {
    if (group.expressIds.length === 0) continue;
    sections.push({
      key: `${group.relationship}|${group.role}`,
      label: `${group.relationship} (${group.role})`,
      ids: group.expressIds,
    });
  }
  return sections;
}

function flatten(sections: Section[]): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const section of sections) {
    rows.push({ kind: 'header', section });
    for (const id of section.ids) rows.push({ kind: 'item', section, id });
  }
  return rows;
}

function entityLabel(dataStore: IfcDataStore | null, id: number): string {
  const type = dataStore?.entities.getTypeName(id) ?? 'Entity';
  const name = dataStore?.entities.getName(id);
  return name ? `${type} ${name}` : `${type} #${id}`;
}

/**
 * `indeterminate` is a DOM-only property with no React attribute, so it has
 * to be set imperatively. A ref CALLBACK only reruns when React remounts the
 * element or the callback's identity changes, not on every re-render of the
 * same node — under virtualization that self-corrects when the row scrolls
 * out and back in, but in the non-virtualized path the header would keep a
 * stale flag after e.g. one row gets unchecked. A stable ref + effect fixes
 * the flag on every render instead.
 */
function SectionHeaderCheckbox({
  allIncluded,
  noneIncluded,
  locked,
  ariaLabel,
  onToggle,
}: {
  allIncluded: boolean;
  noneIncluded: boolean;
  locked: boolean;
  ariaLabel: string;
  onToggle: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !allIncluded && !noneIncluded;
  }, [allIncluded, noneIncluded]);
  return (
    <input
      type="checkbox"
      ref={ref}
      checked={allIncluded}
      disabled={locked}
      onChange={(e) => onToggle(e.target.checked)}
      aria-label={ariaLabel}
    />
  );
}

export function RelatedEntityList({
  dataStore,
  seeds,
  related,
  excludedIds,
  lockedIds,
  onSetExcluded,
}: RelatedEntityListProps) {
  const sections = useMemo(() => buildSections(seeds, related), [seeds, related]);
  const flatRows = useMemo(() => flatten(sections), [sections]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const shouldVirtualize = flatRows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? flatRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const renderHeader = (section: Section) => {
    const selectableIds = section.ids.filter((id) => !lockedIds.has(id));
    const includedCount = selectableIds.filter((id) => !excludedIds.has(id)).length;
    const allIncluded = selectableIds.length === 0 || includedCount === selectableIds.length;
    const noneIncluded = selectableIds.length > 0 && includedCount === 0;
    const locked = selectableIds.length === 0 && section.ids.length > 0;
    return (
      <div className="flex items-center gap-2 py-1 text-xs font-medium text-muted-foreground">
        <SectionHeaderCheckbox
          allIncluded={allIncluded}
          noneIncluded={noneIncluded}
          locked={locked}
          ariaLabel={`Toggle all ${section.label}`}
          onToggle={(next) => {
            for (const id of selectableIds) onSetExcluded(id, !next);
          }}
        />
        <span className="truncate">{section.label}</span>
        <span className="ml-auto tabular-nums">{section.ids.length}</span>
        {locked && <span className="text-[10px] uppercase tracking-wide">locked</span>}
      </div>
    );
  };

  const renderItem = (section: Section, id: number) => {
    const locked = lockedIds.has(id);
    const checked = locked || !excludedIds.has(id);
    return (
      <label className="flex items-center gap-2 py-0.5 pl-5 text-sm min-w-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={locked}
          onChange={(e) => onSetExcluded(id, !e.target.checked)}
        />
        <span className="truncate">{entityLabel(dataStore, id)}</span>
      </label>
    );
  };

  if (flatRows.length <= 1) {
    return <div className="text-sm text-muted-foreground py-2">No entities to export yet.</div>;
  }

  if (!shouldVirtualize) {
    return (
      <div ref={scrollRef} className="max-h-64 overflow-y-auto pr-1">
        {sections.map((section) => (
          <div key={section.key}>
            {renderHeader(section)}
            {section.ids.map((id) => (
              <div key={`${section.key}:${id}`}>{renderItem(section, id)}</div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="max-h-64 overflow-y-auto pr-1">
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = flatRows[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {row.kind === 'header' ? renderHeader(row.section) : renderItem(row.section, row.id)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
