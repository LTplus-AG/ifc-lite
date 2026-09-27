/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatBytes } from './playground-files';
import { effectiveTypeCounts } from './playground-effective';
import type { LoadedPlaygroundModel } from './playground-dispatcher';

const PAPER = '#ede4d3';
const PAPER_DIM = 'rgba(237, 228, 211, 0.55)';
const ACCENT = '#d6ff3f';
const mono = { fontFamily: '"JetBrains Mono", ui-monospace, monospace' };

/** The sidebar's live view of the same model that chat tools mutate. */
export function ModelSummary({ model, revision }: { model: LoadedPlaygroundModel; revision: number }): ReactNode {
  const { t } = useTranslation();
  const summary = useMemo(() => {
    const counts = [...effectiveTypeCounts(model)];
    const entityCount = counts.reduce((total, [, count]) => total + count, 0);
    counts.sort((a, b) => b[1] - a[1]);
    return { entityCount, top: counts.slice(0, 8).map(([type, count]) => ({ type, count })) };
  }, [model, revision]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <FileText size={12} style={{ color: ACCENT }} />
        <span className="text-xs" style={{ color: PAPER }}>
          {model.name}
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-2xs" style={{ ...mono, color: PAPER_DIM }}>
        <div>
          <dt className="text-2xs uppercase tracking-[0.2em]">{t('mcp.mcpPlayground.schema')}</dt>
          <dd style={{ color: PAPER }}>{model.store.schemaVersion}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-[0.2em]">{t('mcp.mcpPlayground.entities')}</dt>
          <dd style={{ color: PAPER }}>{summary.entityCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-[0.2em]">{t('mcp.mcpPlayground.file')}</dt>
          <dd style={{ color: PAPER }}>{formatBytes(model.fileSize)}</dd>
        </div>
      </dl>

      <div className="mt-1 border-t border-white/10 pt-2">
        <div className="mb-1 text-2xs uppercase tracking-[0.22em]" style={{ ...mono, color: PAPER_DIM }}>
          {t('mcp.mcpPlayground.topEntityTypes')}
        </div>
        <ul className="flex flex-col gap-0.5">
          {summary.top.map((row) => (
            <li key={row.type} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate" style={{ ...mono, color: PAPER_DIM }}>
                {row.type}
              </span>
              <span style={{ ...mono, color: PAPER }}>{row.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
