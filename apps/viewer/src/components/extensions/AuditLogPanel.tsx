/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AuditLogPanel` — local audit log viewer rendered inside the
 * Extensions dock.
 *
 * Reads from the extension host's append-only audit log. Surfaces:
 *   - install / uninstall / update / enable / disable
 *   - activate / deactivate
 *   - capability grant / revoke
 *   - mutation summary / network fetch (when those land)
 *   - health events (unhealthy / killed)
 *
 * The log is local-only. The "Export" button writes a JSON snapshot
 * the user can keep / share. Clearing is one-click; there's no
 * cross-device sync to worry about.
 *
 * Spec: docs/architecture/ai-customization/02-security.md §12.
 */

import { trackExportCompleted } from '@/lib/analytics';
import { useEffect, useState } from 'react';
import { Download, Trash2, FileText, Filter, X } from 'lucide-react';
import type { AuditEvent, AuditEventKind } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { downloadFile } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { useTranslation, type TranslationKey, type UseTranslationResult } from '@/i18n';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { HelpHint } from './HelpHint';
import { formatExtensionDate } from './localized-date';
import { formatLocaleNumber } from '@/i18n/intlFormat';

/** Maps each event kind to its catalogue key — same data-table pattern
 *  `shared-commands.en.ts`'s export/camera registries use: the record
 *  carries keys, renderers call `t(...)`. */
const KIND_LABEL_KEYS: Record<AuditEventKind, TranslationKey> = {
  install: 'extensionsPanels.auditLogPanel.kind.install',
  uninstall: 'extensionsPanels.auditLogPanel.kind.uninstall',
  update: 'extensionsPanels.auditLogPanel.kind.update',
  enable: 'extensionsPanels.auditLogPanel.kind.enable',
  disable: 'extensionsPanels.auditLogPanel.kind.disable',
  capability_grant: 'extensionsPanels.auditLogPanel.kind.capability_grant',
  capability_revoke: 'extensionsPanels.auditLogPanel.kind.capability_revoke',
  activate: 'extensionsPanels.auditLogPanel.kind.activate',
  deactivate: 'extensionsPanels.auditLogPanel.kind.deactivate',
  mutation_summary: 'extensionsPanels.auditLogPanel.kind.mutation_summary',
  network_fetch: 'extensionsPanels.auditLogPanel.kind.network_fetch',
  unhealthy: 'extensionsPanels.auditLogPanel.kind.unhealthy',
  killed: 'extensionsPanels.auditLogPanel.kind.killed',
} as const;

const KIND_TONES: Record<AuditEventKind, string> = {
  install: 'text-emerald-600 dark:text-emerald-400',
  uninstall: 'text-rose-600 dark:text-rose-400',
  update: 'text-sky-600 dark:text-sky-400',
  enable: 'text-emerald-600 dark:text-emerald-400',
  disable: 'text-muted-foreground',
  capability_grant: 'text-amber-600 dark:text-amber-400',
  capability_revoke: 'text-amber-600 dark:text-amber-400',
  activate: 'text-muted-foreground',
  deactivate: 'text-muted-foreground',
  mutation_summary: 'text-sky-600 dark:text-sky-400',
  network_fetch: 'text-cyan-600 dark:text-cyan-400',
  unhealthy: 'text-amber-600 dark:text-amber-400',
  killed: 'text-rose-600 dark:text-rose-400',
};

interface AuditLogPanelProps {
  /** Show only events from this extension id. Omit for all. */
  extensionId?: string;
  /** When in a panel, the close button. */
  onClose?: () => void;
}

export function AuditLogPanel({ extensionId, onClose }: AuditLogPanelProps) {
  const { t, locale } = useTranslation();
  const host = useExtensionHost();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filter, setFilter] = useState<AuditEventKind | 'all'>('all');
  // Per-extension filter applied on top of the props-level filter.
  // The prop scopes the panel; this state is the user's runtime
  // narrow-down ("show only events for this extension").
  const [extensionFilter, setExtensionFilter] = useState<string | undefined>(extensionId);

  useEffect(() => {
    const scope = extensionFilter ?? extensionId;
    setEvents(host.audit.list(scope ? { extensionId: scope } : {}));
    const off = host.onChange(() => {
      setEvents(host.audit.list(scope ? { extensionId: scope } : {}));
    });
    return off;
  }, [host, extensionId, extensionFilter]);

  const filtered = filter === 'all' ? events : events.filter((e) => e.kind === filter);

  // Build the list of distinct extension ids present in the (unfiltered)
  // events for the per-extension chip row.
  const distinctExtensionIds = Array.from(
    new Set(host.audit.list().map((e) => e.extensionId)),
  ).sort();

  const handleExport = () => {
    const json = host.audit.exportJson();
    downloadFile(json, `ifclite-audit-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    trackExportCompleted({ format: 'json', surface: 'extension_panel' });
    toast.success(t('extensionsPanels.auditLogPanel.exportToast'));
  };

  const handleClear = async () => {
    if (!await confirmDialog({ description: t('extensionsPanels.auditLogPanel.clearConfirm'), destructive: true })) return;
    host.audit.clear();
    // Wipe the IDB mirror too — otherwise reload resurrects what the
    // user just asked to forget.
    void host.clearPersistedAuditLog().catch((err) => {
      console.warn('[AuditLogPanel] clear persisted audit failed:', err);
    });
    setEvents([]);
    toast.success(t('extensionsPanels.auditLogPanel.clearToast'));
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <h2 className="text-sm font-semibold">{t('extensionsPanels.auditLogPanel.title')}</h2>
          <span className="text-2xs text-muted-foreground">
            {t('extensionsPanels.auditLogPanel.eventCount', {
              count: events.length,
              filtered: formatLocaleNumber(locale, filtered.length),
              total: formatLocaleNumber(locale, events.length),
            })}
          </span>
          <HelpHint label={t('extensionsPanels.auditLogPanel.helpLabel')}>
            <p>{t('extensionsPanels.auditLogPanel.helpIntro')}</p>
            <p>{t('extensionsPanels.auditLogPanel.helpPersistence')}</p>
            <p>
              {styleInterpolatedValues(t, 'extensionsPanels.auditLogPanel.helpExport', [
                ['export', <strong key="export">{t('extensionsPanels.auditLogPanel.exportButton')}</strong>],
              ])}
            </p>
          </HelpHint>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={handleExport} aria-label={t('extensionsPanels.auditLogPanel.exportAriaLabel')}>
            <Download className="mr-1 h-3.5 w-3.5" />
            {t('extensionsPanels.auditLogPanel.exportButton')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleClear} aria-label={t('extensionsPanels.auditLogPanel.clearAriaLabel')}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t('extensionsPanels.auditLogPanel.clearButton')}
          </Button>
          {onClose && (
            <IconButton label={t('extensionsPanels.auditLogPanel.closeAriaLabel')} onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 border-b px-4 py-2 overflow-x-auto">
        <Filter className="h-3 w-3 text-muted-foreground shrink-0" />
        <FilterChip label={t('extensionsPanels.auditLogPanel.filterAll')} active={filter === 'all'} onClick={() => setFilter('all')} />
        {(Object.keys(KIND_LABEL_KEYS) as AuditEventKind[]).map((k) => (
          <FilterChip
            key={k}
            label={t(KIND_LABEL_KEYS[k])}
            active={filter === k}
            onClick={() => setFilter(k)}
          />
        ))}
      </div>

      {/* Extension scope row — appears only when the panel was opened
          un-scoped AND there's more than one extension in the log.
          Lets the user narrow "show only events for this extension". */}
      {!extensionId && distinctExtensionIds.length > 1 && (
        <div className="flex items-center gap-1 border-b px-4 py-2 overflow-x-auto">
          <span className="text-2xs text-muted-foreground shrink-0">{t('extensionsPanels.auditLogPanel.extensionFilterLabel')}</span>
          <FilterChip
            label={t('extensionsPanels.auditLogPanel.filterAll')}
            active={extensionFilter === undefined}
            onClick={() => setExtensionFilter(undefined)}
          />
          {distinctExtensionIds.map((id) => (
            <FilterChip
              key={id}
              label={id}
              active={extensionFilter === id}
              onClick={() => setExtensionFilter(id)}
            />
          ))}
        </div>
      )}

      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            {t('extensionsPanels.auditLogPanel.emptyState')}
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.slice().reverse().map((event) => (
              <li key={event.seq} className="flex items-start gap-3 px-4 py-2.5 text-xs">
                <span className={`shrink-0 font-medium ${KIND_TONES[event.kind]}`}>
                  {t(KIND_LABEL_KEYS[event.kind])}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-2xs break-all">{event.extensionId}</div>
                  <div className="text-2xs text-muted-foreground">
                    {auditMetadata(event, t, locale)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/70'
      }`}
    >
      {label}
    </button>
  );
}

function auditMetadata(event: AuditEvent, t: UseTranslationResult['t'], locale: string): string {
  const date = formatExtensionDate(event.ts, locale);
  const detail = extraDetail(event, t, locale);
  if (event.version && detail) {
    return t('extensionsPanels.auditLogPanel.metadataVersionDetail', { date, version: event.version, detail });
  }
  if (event.version) return t('extensionsPanels.auditLogPanel.metadataVersion', { date, version: event.version });
  if (detail) return t('extensionsPanels.auditLogPanel.metadataDetail', { date, detail });
  return t('extensionsPanels.auditLogPanel.metadataDate', { date });
}

function extraDetail(event: AuditEvent, t: UseTranslationResult['t'], locale: string): string {
  switch (event.kind) {
    case 'install':
    case 'update':
      return event.grantedCapabilities
        ? t('extensionsPanels.auditLogPanel.capabilityGrants', {
            count: event.grantedCapabilities.length,
            countDisplay: formatLocaleNumber(locale, event.grantedCapabilities.length),
          })
        : '';
    case 'mutation_summary':
      return t('extensionsPanels.auditLogPanel.mutationEntities', {
        count: event.entityCount,
        countDisplay: formatLocaleNumber(locale, event.entityCount),
      });
    case 'network_fetch':
      return t('extensionsPanels.auditLogPanel.networkFetch', {
        host: event.host,
        bytes: formatLocaleNumber(locale, event.bytes),
      });
    case 'unhealthy':
    case 'killed':
      return t('extensionsPanels.auditLogPanel.reasonSuffix', { reason: event.reason });
    default:
      return '';
  }
}
