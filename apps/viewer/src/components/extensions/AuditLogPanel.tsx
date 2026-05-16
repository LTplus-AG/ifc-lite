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

import { useEffect, useState } from 'react';
import { Download, Trash2, FileText, Filter } from 'lucide-react';
import type { AuditEvent, AuditEventKind } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';

const KIND_LABELS: Record<AuditEventKind, string> = {
  install: 'Install',
  uninstall: 'Uninstall',
  update: 'Update',
  enable: 'Enable',
  disable: 'Disable',
  capability_grant: 'Granted',
  capability_revoke: 'Revoked',
  activate: 'Activate',
  deactivate: 'Deactivate',
  mutation_summary: 'Mutations',
  network_fetch: 'Fetch',
  unhealthy: 'Unhealthy',
  killed: 'Killed',
};

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
  network_fetch: 'text-purple-600 dark:text-purple-400',
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
  const host = useExtensionHost();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filter, setFilter] = useState<AuditEventKind | 'all'>('all');

  useEffect(() => {
    setEvents(host.audit.list(extensionId ? { extensionId } : {}));
    const off = host.onChange(() => {
      setEvents(host.audit.list(extensionId ? { extensionId } : {}));
    });
    return off;
  }, [host, extensionId]);

  const filtered = filter === 'all' ? events : events.filter((e) => e.kind === filter);

  const handleExport = () => {
    const json = host.audit.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ifclite-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Audit log exported.');
  };

  const handleClear = () => {
    if (!confirm('Clear the audit log? This cannot be undone.')) return;
    // AuditLog.clear() is on the in-memory writer. The future IDB
    // persistence layer (next batch) reflows this; for now we just
    // call through and refresh.
    host.audit.clear();
    setEvents([]);
    toast.success('Audit log cleared.');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Audit Log</h2>
          <span className="text-[11px] text-muted-foreground">
            {filtered.length} of {events.length} events
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={handleExport} aria-label="Export audit log">
            <Download className="mr-1 h-3.5 w-3.5" />
            Export
          </Button>
          <Button size="sm" variant="ghost" onClick={handleClear} aria-label="Clear audit log">
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
          {onClose && (
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close audit log">
              ×
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 border-b px-4 py-2 overflow-x-auto">
        <Filter className="h-3 w-3 text-muted-foreground shrink-0" />
        <FilterChip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
        {(Object.keys(KIND_LABELS) as AuditEventKind[]).map((k) => (
          <FilterChip
            key={k}
            label={KIND_LABELS[k]}
            active={filter === k}
            onClick={() => setFilter(k)}
          />
        ))}
      </div>

      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            No events yet. Audit entries appear here when extensions are installed,
            updated, enabled, disabled, or uninstalled.
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.slice().reverse().map((event) => (
              <li key={event.seq} className="flex items-start gap-3 px-4 py-2.5 text-xs">
                <span className={`shrink-0 font-medium ${KIND_TONES[event.kind]}`}>
                  {KIND_LABELS[event.kind]}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[11px] break-all">{event.extensionId}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(event.ts).toLocaleString()}
                    {event.version ? ` · v${event.version}` : ''}
                    {extraDetail(event)}
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
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/70'
      }`}
    >
      {label}
    </button>
  );
}

function extraDetail(event: AuditEvent): string {
  switch (event.kind) {
    case 'install':
    case 'update':
      return event.grantedCapabilities
        ? ` · ${event.grantedCapabilities.length} capability ${event.grantedCapabilities.length === 1 ? 'grant' : 'grants'}`
        : '';
    case 'mutation_summary':
      return ` · ${event.entityCount} entities`;
    case 'network_fetch':
      return ` · ${event.host} (${event.bytes} bytes)`;
    case 'unhealthy':
    case 'killed':
      return ` · ${event.reason}`;
    default:
      return '';
  }
}
