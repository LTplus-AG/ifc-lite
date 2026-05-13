/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDSAuditSummary — surfaces the auditor's verdict on a loaded IDS
 * document.
 *
 * Visual language: refined-technical instrument. Restraint over
 * decoration. The hierarchy is carried by:
 *  - **Severity rails** — 2px tinted left border on each issue row.
 *  - **Codes as machine output** — monospace uppercase chips with
 *    severity-tinted backgrounds; treat them like log lines.
 *  - **Counts strip** — compact `▪ 3 errors  ▪ 2 warnings  ▪ 0 info`
 *    bar with colored dots, similar to a developer-tool status line.
 *  - **Empty state** — single line with a check icon, no flair.
 *
 * Interactions:
 *  - Click counts strip to toggle the issue list.
 *  - Click an individual row to expose its `path` and `detail` payload.
 *  - Filter tabs (All / Errors / Warnings) when any issues exist.
 */

import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
} from 'lucide-react';
import type { IDSAuditIssue, IDSAuditReport, IDSAuditSeverity } from '@ifc-lite/ids';
import { cn } from '@/lib/utils';

interface IDSAuditSummaryProps {
  report: IDSAuditReport | null;
  /** True while the auditor is running. */
  auditing?: boolean;
  /** Optional className passed to the outer container. */
  className?: string;
}

type SeverityFilter = 'all' | IDSAuditSeverity;

// ---------------------------------------------------------------------------
// Severity tokens
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<IDSAuditSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_TOKENS: Record<
  IDSAuditSeverity,
  {
    label: string;
    pluralLabel: string;
    dot: string;
    rail: string;
    chipBg: string;
    chipFg: string;
    chipBorder: string;
    icon: React.ReactNode;
    iconClass: string;
  }
> = {
  error: {
    label: 'error',
    pluralLabel: 'errors',
    dot: 'bg-red-500',
    rail: 'border-l-red-500',
    chipBg: 'bg-red-500/10',
    chipFg: 'text-red-600 dark:text-red-400',
    chipBorder: 'border-red-500/30',
    icon: <AlertCircle className="h-4 w-4" aria-hidden="true" />,
    iconClass: 'text-red-500',
  },
  warning: {
    label: 'warning',
    pluralLabel: 'warnings',
    dot: 'bg-amber-500',
    rail: 'border-l-amber-500',
    chipBg: 'bg-amber-500/10',
    chipFg: 'text-amber-700 dark:text-amber-400',
    chipBorder: 'border-amber-500/30',
    icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
    iconClass: 'text-amber-500',
  },
  info: {
    label: 'note',
    pluralLabel: 'notes',
    dot: 'bg-sky-400',
    rail: 'border-l-sky-400',
    chipBg: 'bg-sky-400/10',
    chipFg: 'text-sky-600 dark:text-sky-400',
    chipBorder: 'border-sky-400/30',
    icon: <Info className="h-4 w-4" aria-hidden="true" />,
    iconClass: 'text-sky-500',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IDSAuditSummary({
  report,
  auditing = false,
  className,
}: IDSAuditSummaryProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<SeverityFilter>('all');

  // Stable per-severity counts.
  const counts = useMemo(() => {
    const base: Record<IDSAuditSeverity, number> = {
      error: 0,
      warning: 0,
      info: 0,
    };
    if (!report) return base;
    for (const issue of report.issues) {
      base[issue.severity] += 1;
    }
    return base;
  }, [report]);

  // Sort issues by severity (errors first), preserving document order
  // within each bucket. Rendering errors-first gives the user the most
  // important information at the top of the expanded list.
  const sortedIssues = useMemo(() => {
    if (!report) return [];
    return [...report.issues].sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    );
  }, [report]);

  const visibleIssues = useMemo(() => {
    if (filter === 'all') return sortedIssues;
    return sortedIssues.filter((i) => i.severity === filter);
  }, [sortedIssues, filter]);

  // Auditing in flight — quietly mark the spot.
  if (auditing && !report) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground',
          'animate-fade-in-up',
          className
        )}
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        <span>Auditing IDS document…</span>
      </div>
    );
  }

  if (!report) return null;

  const totalIssues = report.issues.length;
  const isClean = report.status === 'valid' || totalIssues === 0;

  // Clean state — single line, no flair.
  if (isClean) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400',
          'animate-fade-in-up',
          className
        )}
      >
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        <span>Document is valid — no audit issues</span>
      </div>
    );
  }

  // Has issues — counts strip + collapsible list.
  return (
    <section
      className={cn(
        'overflow-hidden rounded-md border border-border/70 bg-card animate-fade-in-up',
        className
      )}
      aria-label="IDS document audit summary"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
          'hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
        )}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-3 text-xs">
          {(['error', 'warning', 'info'] as IDSAuditSeverity[]).map((sev) => {
            const n = counts[sev];
            if (n === 0) return null;
            const t = SEVERITY_TOKENS[sev];
            return (
              <span key={sev} className="inline-flex items-center gap-1.5">
                <span
                  className={cn('h-1.5 w-1.5 rounded-full', t.dot)}
                  aria-hidden="true"
                />
                <span className={cn('font-mono tabular-nums', t.chipFg)}>
                  {n}
                </span>
                <span className="text-muted-foreground">
                  {n === 1 ? t.label : t.pluralLabel}
                </span>
              </span>
            );
          })}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{expanded ? 'Hide' : 'Details'}</span>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/60">
          {/* Filter tabs */}
          <div className="flex items-center gap-1 border-b border-border/60 bg-muted/20 px-2 py-1.5">
            {(
              [
                { key: 'all', label: `All (${totalIssues})` },
                counts.error > 0 && {
                  key: 'error',
                  label: `Errors (${counts.error})`,
                },
                counts.warning > 0 && {
                  key: 'warning',
                  label: `Warnings (${counts.warning})`,
                },
                counts.info > 0 && {
                  key: 'info',
                  label: `Notes (${counts.info})`,
                },
              ].filter(Boolean) as Array<{
                key: SeverityFilter;
                label: string;
              }>
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  filter === tab.key
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Issue list */}
          <ul className="max-h-72 overflow-y-auto py-1">
            {visibleIssues.map((issue, i) => (
              <IssueRow key={`${issue.code}-${issue.path}-${i}`} issue={issue} index={i} />
            ))}
            {visibleIssues.length === 0 && (
              <li className="px-3 py-3 text-xs text-muted-foreground">
                No issues match the selected filter.
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Issue row
// ---------------------------------------------------------------------------

interface IssueRowProps {
  issue: IDSAuditIssue;
  index: number;
}

function IssueRow({ issue, index }: IssueRowProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const t = SEVERITY_TOKENS[issue.severity];
  const hasDetail =
    !!issue.path ||
    (issue.detail !== undefined && Object.keys(issue.detail).length > 0);

  return (
    <li
      className={cn(
        'group border-l-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted/30',
        t.rail,
        // Stagger reveal — capped so long lists don't take seconds.
        'animate-fade-in-up'
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 24}ms` }}
    >
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-start gap-2 text-left',
          hasDetail && 'cursor-pointer',
          !hasDetail && 'cursor-default'
        )}
        aria-expanded={hasDetail ? open : undefined}
      >
        <span className={cn('mt-0.5 shrink-0', t.iconClass)}>{t.icon}</span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-baseline gap-2">
            <code
              className={cn(
                'shrink-0 rounded border px-1.5 py-0 font-mono text-[10px] uppercase tracking-tight leading-relaxed',
                t.chipBg,
                t.chipFg,
                t.chipBorder
              )}
            >
              {issue.code}
            </code>
            <span className="text-foreground">{issue.message}</span>
          </span>
          {hasDetail && open && (
            <div className="ml-1 mt-1.5 space-y-1 border-l border-border/60 pl-2">
              {issue.path && (
                <div className="flex gap-2 font-mono text-[11px]">
                  <span className="text-muted-foreground/70">path</span>
                  <span className="break-all text-muted-foreground">
                    {issue.path}
                  </span>
                </div>
              )}
              {issue.facetType && (
                <div className="flex gap-2 font-mono text-[11px]">
                  <span className="text-muted-foreground/70">facet</span>
                  <span className="text-muted-foreground">
                    {issue.facetType}
                  </span>
                </div>
              )}
              {issue.detail && Object.keys(issue.detail).length > 0 && (
                <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {Object.entries(issue.detail).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <span className="text-muted-foreground/70">{k}</span>
                      <span className="break-all text-muted-foreground">
                        {String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </span>
        {hasDetail && (
          <ChevronDown
            className={cn(
              'mt-1 h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform',
              open && 'rotate-180'
            )}
            aria-hidden="true"
          />
        )}
      </button>
    </li>
  );
}
