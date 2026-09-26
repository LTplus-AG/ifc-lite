/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fetched check evidence behind a manifest check (08-review.md §8.4):
 * pulls the `ifc-lite ids --json` report from the registry by its
 * content address, summarizes it, and deep-links entity-level failures
 * into the 3D selection. Layer data is path-keyed and the composition
 * path IS the IFC GUID, so the report's `globalId` resolves through
 * `layerStackPathToId` — never through the report's own expressIds,
 * which were minted in a different parse.
 */

import { trackExportCompleted } from '@/lib/analytics';
import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { LayerRegistryClient } from '@/lib/layers/registry-client';
import { downloadBlob } from '@/lib/export/download';

interface ReportEntity {
  entityType: string;
  entityName?: string;
  globalId?: string;
  passed: boolean;
  requirementResults?: Array<{ status?: string; failureReason?: string }>;
}

interface ReportSpecification {
  specification?: { name?: string };
  status?: string;
  failedCount?: number;
  entityResults?: ReportEntity[];
}

interface IdsReportJson {
  summary?: { totalSpecifications?: number; failedSpecifications?: number; totalEntitiesFailed?: number };
  report?: { specificationResults?: ReportSpecification[] };
}

const FAILURE_ROW_LIMIT = 50;

function failureReasonOf(entity: ReportEntity): string | undefined {
  return entity.requirementResults?.find((r) => r.failureReason)?.failureReason;
}

export function LayerCheckEvidence({ digest }: { digest: string }) {
  const { t } = useTranslation();
  const collabToken = useViewerStore((s) => s.collabSelfToken);
  const pathToId = useViewerStore((s) => s.layerStackPathToId);
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'offline' }
    | { kind: 'missing' }
    | { kind: 'error'; message: string }
    | { kind: 'loaded'; raw: string; parsed: IdsReportJson | null }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const client = LayerRegistryClient.fromCollabConfig(collabToken ?? undefined);
    if (!client) {
      setState({ kind: 'offline' });
      return;
    }
    setState({ kind: 'loading' });
    client
      .getReport(digest)
      .then((raw) => {
        if (cancelled) return;
        if (raw === null) {
          setState({ kind: 'missing' });
          return;
        }
        let parsed: IdsReportJson | null = null;
        try {
          parsed = JSON.parse(raw) as IdsReportJson;
        } catch {
          parsed = null; // spec XML or foreign evidence: still downloadable
        }
        setState({ kind: 'loaded', raw, parsed });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [digest, collabToken]);

  const selectEntity = useCallback((globalId: string) => {
    const store = useViewerStore.getState();
    const expressId = store.layerStackPathToId?.get(globalId);
    if (expressId !== undefined) store.setSelectedEntityIds([expressId]);
  }, []);

  const download = useCallback(() => {
    if (state.kind !== 'loaded') return;
    // The shared helper also emits the file-download analytics/tour event.
    downloadBlob(
      new Blob([state.raw], { type: 'application/json' }),
      `${digest.replace(/^blake3:/, '').slice(0, 12)}-report.json`,
    );
    trackExportCompleted({ format: 'json', surface: 'layer_evidence' });
  }, [state, digest]);

  if (state.kind === 'loading') {
    return <p className="text-2xs text-muted-foreground">{t('layersPanel.checkEvidence.loading')}</p>;
  }
  if (state.kind === 'offline') {
    return <p className="text-2xs text-muted-foreground">{t('layersPanel.checkEvidence.offline')}</p>;
  }
  if (state.kind === 'missing') {
    return <p className="text-2xs text-muted-foreground">{t('layersPanel.checkEvidence.missing')}</p>;
  }
  if (state.kind === 'error') return <p className="text-2xs text-red-500">{state.message}</p>;

  const specs = state.parsed?.report?.specificationResults ?? [];
  const failures = specs.flatMap((spec) =>
    (spec.entityResults ?? [])
      .filter((entity) => !entity.passed)
      .map((entity) => ({ spec: spec.specification?.name, entity })),
  );
  const shown = failures.slice(0, FAILURE_ROW_LIMIT);

  return (
    <div className="flex flex-col gap-0.5 pt-0.5">
      <div className="flex items-center gap-1 text-2xs text-muted-foreground">
        {state.parsed?.summary ? (
          <span>
            {t('layersPanel.checkEvidence.summary', {
              failed: state.parsed.summary.failedSpecifications ?? 0,
              total: state.parsed.summary.totalSpecifications ?? 0,
              count: failures.length,
            })}
          </span>
        ) : (
          <span>{t('layersPanel.checkEvidence.notIdsReport')}</span>
        )}
        <button
          type="button"
          onClick={download}
          className="ml-auto inline-flex items-center gap-0.5 rounded px-1 hover:bg-muted/60"
          aria-label={t('layersPanel.checkEvidence.downloadAriaLabel')}
        >
          <Download className="size-2.5" aria-hidden />
          {t('layersPanel.checkEvidence.downloadLabel')}
        </button>
      </div>
      {shown.map(({ spec, entity }, i) => {
        const linkable = entity.globalId !== undefined && pathToId?.has(entity.globalId);
        const reason = failureReasonOf(entity);
        return (
          <button
            key={`${entity.globalId ?? entity.entityName ?? 'entity'}-${i}`}
            type="button"
            disabled={!linkable}
            onClick={() => entity.globalId && selectEntity(entity.globalId)}
            className={`rounded border bg-card/40 px-1 py-0.5 text-left text-2xs ${
              linkable ? 'hover:bg-muted/60' : 'cursor-default opacity-70'
            }`}
            title={
              linkable
                ? t('layersPanel.checkEvidence.selectTitle')
                : t('layersPanel.checkEvidence.notInCompositionTitle')
            }
          >
            <span className="font-medium">{entity.entityName ?? entity.globalId ?? entity.entityType}</span>
            <span className="text-muted-foreground"> · {entity.entityType}</span>
            {spec && <span className="text-muted-foreground"> · {spec}</span>}
            {reason && <span className="block truncate text-muted-foreground">{reason}</span>}
          </button>
        );
      })}
      {failures.length > shown.length && (
        <p className="text-2xs text-muted-foreground">
          {t('layersPanel.checkEvidence.moreFailures', { count: failures.length - shown.length })}
        </p>
      )}
    </div>
  );
}
