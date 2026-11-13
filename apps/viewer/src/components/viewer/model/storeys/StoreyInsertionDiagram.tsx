/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreyLevelPlan, StoreySummary } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import { formatElevation } from '@/lib/storeys/storey-length';

/** #9389: unapplied insertion, with the current and proposed sections side by side. */
export function StoreyInsertionDiagram({ rows, plan, inserted, renames }: {
  rows: readonly StoreySummary[];
  plan: StoreyLevelPlan;
  inserted: { Name: string; Elevation: number };
  renames: readonly { id: number; Name: string }[];
}) {
  const { t } = useTranslation();
  const moves = new Map(plan.storeys.map(move => [move.expressId, move]));
  const max = Math.max(...rows.map(row => moves.get(row.expressId)?.to ?? row.elevation), inserted.Elevation);
  const min = Math.min(...rows.map(row => row.elevation), inserted.Elevation);
  const height = Math.max(100, Math.min(360, (max - min) * 18));
  const y = (elevation: number) => 24 + (max - elevation) / Math.max(1, max - min) * height;
  const proposedName = (row: StoreySummary) => renames.find(rename => rename.id === row.expressId)?.Name ?? row.Name;
  return <figure data-storey-strip aria-label={t('storeyManager.strip.label')}>
    <div className="grid grid-cols-2 gap-2 text-center text-2xs text-foreground">
      <span>{t('storeyManager.insert.before')}</span><span>{t('storeyManager.insert.after')}</span>
    </div>
    <svg aria-label={t('storeyManager.strip.label')}
      viewBox={`0 0 280 ${height + 48}`} className="w-full text-foreground">
      <title>{t('storeyManager.strip.label')}</title>
      {rows.map(row => {
        const move = moves.get(row.expressId);
        const from = y(row.elevation);
        const to = y(move?.to ?? row.elevation);
        return <g key={row.expressId}>
          <path d={`M 4 ${from} H 112`} stroke="currentColor" strokeDasharray={move ? '3 2' : undefined} />
          <text x="4" y={from - 5} fill="currentColor" className="text-2xs">{row.Name} · {formatElevation(row.elevation)}</text>
          {move && <path data-storey-strip-move d={`M 116 ${from} L 160 ${to} M 154 ${to - 3} L 160 ${to} L 154 ${to + 3}`} fill="none" stroke="currentColor" />}
          <path d={`M 168 ${to} H 276`} stroke="currentColor" />
          <text x="168" y={to - 5} fill="currentColor" className="text-2xs">{proposedName(row)} · {formatElevation(move?.to ?? row.elevation)}</text>
        </g>;
      })}
      <g data-storey-strip-inserted className="text-overlay-accent">
        <path d={`M 168 ${y(inserted.Elevation)} H 276`} stroke="currentColor" strokeWidth="2" />
        <text x="168" y={y(inserted.Elevation) - 5} fill="currentColor" className="text-2xs font-medium">{inserted.Name} · {formatElevation(inserted.Elevation)}</text>
      </g>
    </svg>
  </figure>;
}
