/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Expand with related" section of `AnonymizedExportDialog`: one `Switch` +
 * live count badge per `RelatedEntityOptions` toggle, a depth `Select` for
 * the bounded `IfcRelConnectsPathElements` walk. The spatial containment
 * chain (`IfcRelContainedInSpatialStructure` / `IfcRelAggregates` "spatial
 * ancestor" role) has no row: `useAnonymizedExportSet` always includes it.
 */

import type { RelatedEntities, RelatedEntityOptions } from '@ifc-lite/export';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface RelationTogglePanelProps {
  options: RelatedEntityOptions;
  onChange: (patch: Partial<RelatedEntityOptions>) => void;
  related: RelatedEntities | null;
}

/** Unique express ids across every group whose relationship is in `relationships`. */
function groupCount(related: RelatedEntities | null, relationships: readonly string[]): number {
  if (!related) return 0;
  const ids = new Set<number>();
  for (const group of related.groups) {
    if (!relationships.includes(group.relationship)) continue;
    for (const id of group.expressIds) ids.add(id);
  }
  return ids.size;
}

const CONNECT_DEPTH_CHOICES = [1, 2, 3] as const;

export function RelationTogglePanel({ options, onChange, related }: RelationTogglePanelProps) {
  const voidsOn = options.IfcRelVoidsElement ?? true;
  const fillsOn = options.IfcRelFillsElement ?? true;
  const aggregatesOn = (options.IfcRelAggregates ?? 'both') !== 'none';
  const typeOn = options.IfcRelDefinesByType ?? true;
  const materialOn = options.IfcRelAssociatesMaterial ?? true;
  const psetsOn = options.IfcRelDefinesByProperties ?? false;
  const connectDepth = options.IfcRelConnectsPathElementsDepth ?? 0;

  const rows: { key: string; label: string; on: boolean; count: number; onToggle: (checked: boolean) => void }[] = [
    {
      key: 'voids', label: 'Openings', on: voidsOn,
      count: groupCount(related, ['IfcRelVoidsElement']),
      onToggle: (checked) => onChange({ IfcRelVoidsElement: checked }),
    },
    {
      key: 'fills', label: 'Fillings & host', on: fillsOn,
      count: groupCount(related, ['IfcRelFillsElement']),
      onToggle: (checked) => onChange({ IfcRelFillsElement: checked }),
    },
    {
      key: 'aggregates', label: 'Aggregates & nesting (parents/children)', on: aggregatesOn,
      count: groupCount(related, ['IfcRelAggregates', 'IfcRelNests']),
      onToggle: (checked) => onChange(
        checked ? { IfcRelAggregates: 'both', IfcRelNests: 'down' } : { IfcRelAggregates: 'none', IfcRelNests: 'none' },
      ),
    },
    {
      key: 'type', label: 'Type objects', on: typeOn,
      count: groupCount(related, ['IfcRelDefinesByType']),
      onToggle: (checked) => onChange({ IfcRelDefinesByType: checked }),
    },
    {
      key: 'material', label: 'Materials', on: materialOn,
      count: groupCount(related, ['IfcRelAssociatesMaterial']),
      onToggle: (checked) => onChange({ IfcRelAssociatesMaterial: checked }),
    },
    {
      key: 'psets', label: 'Property sets (source)', on: psetsOn,
      count: groupCount(related, ['IfcRelDefinesByProperties']),
      onToggle: (checked) => onChange({ IfcRelDefinesByProperties: checked }),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Expand with related
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
        {rows.map((row) => (
          <label key={row.key} className="flex items-center justify-between gap-2 min-w-0">
            <span className="flex items-center gap-2 min-w-0">
              <Switch checked={row.on} onCheckedChange={row.onToggle} aria-label={row.label} />
              <span className="text-sm truncate">{row.label}</span>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">{row.count}</span>
          </label>
        ))}

        <div className="flex items-center justify-between gap-2 sm:col-span-2">
          <span className="flex items-center gap-2 min-w-0">
            <Switch
              checked={connectDepth > 0}
              onCheckedChange={(checked) => onChange({ IfcRelConnectsPathElementsDepth: checked ? 1 : 0 })}
              aria-label="Connected elements"
            />
            <span className="text-sm">Connected, depth</span>
            <Select
              value={String(connectDepth > 0 ? connectDepth : 1)}
              onValueChange={(v) => onChange({ IfcRelConnectsPathElementsDepth: Number(v) })}
              disabled={connectDepth === 0}
            >
              <SelectTrigger className="h-7 w-16 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONNECT_DEPTH_CHOICES.map((d) => (
                  <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {groupCount(related, ['IfcRelConnectsPathElements'])}
          </span>
        </div>
      </div>
    </div>
  );
}
