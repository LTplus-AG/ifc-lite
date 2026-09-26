/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `KeyboardShortcutsDialog`'s "What's New" tab, split out of
 * `KeyboardShortcutsDialogTabs.tsx` (#5817 review: that file crossed the
 * 400-line module-size budget once the dialog's own shell code moved out of
 * `KeyboardShortcutsDialog.tsx` and its tab bodies moved in). Content is
 * unchanged from before the split.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Zap, Wrench, Plus } from 'lucide-react';
import { useTranslation } from '@/i18n';

const TYPE_CONFIG = {
  feature: { icon: Plus, className: 'text-emerald-500' },
  fix: { icon: Wrench, className: 'text-amber-500' },
  perf: { icon: Zap, className: 'text-blue-500' },
} as const;

function formatPkgName(name: string): string {
  return name.replace('@ifc-lite/', '');
}

type TimelineEntry = {
  version: string;
  isViewerVersion: boolean;
  entries: Array<{ pkg: string; highlights: typeof __RELEASE_HISTORY__[0]['releases'][0]['highlights'] }>;
};

const compareSemver = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
};

/** Merge all per-package changelogs into a unified timeline grouped by version. */
function buildTimeline(
  packageChangelogs: typeof __RELEASE_HISTORY__,
  viewerVersion: string
): TimelineEntry[] {
  type Highlights = typeof __RELEASE_HISTORY__[0]['releases'][0]['highlights'];
  const versionMap = new Map<string, Map<string, Highlights>>();

  for (const pkg of packageChangelogs) {
    for (const release of pkg.releases) {
      if (!versionMap.has(release.version)) {
        versionMap.set(release.version, new Map());
      }
      versionMap.get(release.version)!.set(pkg.name, release.highlights);
    }
  }

  return Array.from(versionMap.entries())
    .sort(([a], [b]) => compareSemver(a, b))
    .map(([version, pkgMap]) => ({
      version,
      isViewerVersion: version === viewerVersion,
      entries: Array.from(pkgMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pkg, highlights]) => ({ pkg, highlights })),
    }));
}

export function WhatsNewTab() {
  const { t } = useTranslation(); const packageChangelogs = __RELEASE_HISTORY__;
  const viewerVersion = __APP_VERSION__;
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => new Set());

  const timeline = useMemo(
    () => buildTimeline(packageChangelogs, viewerVersion),
    [packageChangelogs, viewerVersion]
  );

  // Auto-expand the first version with actual changes
  useEffect(() => {
    if (timeline.length > 0 && expandedVersions.size === 0) {
      setExpandedVersions(new Set([timeline[0].version]));
    }
  }, [timeline]);

  const toggleVersion = useCallback((version: string) => {
    setExpandedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  }, []);

  if (timeline.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        {t('keyboardShortcuts.whatsNew.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Anchor the current app version. The rows below carry each package's
          own independent version (e.g. parser may be ahead of the viewer), so
          without this the highest row reads as "the version" — issue #1107,
          item 2. */}
      <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-2 mb-1">
        <span className="text-sm font-semibold">
          {t('keyboardShortcuts.whatsNew.currentVersion', { version: viewerVersion })}
        </span>
        <span className="text-2xs text-muted-foreground shrink-0">
          {t('keyboardShortcuts.whatsNew.perPackageHint')}
        </span>
      </div>
      {timeline.map((release) => {
        const isExpanded = expandedVersions.has(release.version);
        const totalHighlights = release.entries.reduce((s, e) => s + e.highlights.length, 0);
        return (
          <div key={release.version}>
            <button
              onClick={() => toggleVersion(release.version)}
              className="flex items-center gap-2 w-full py-1.5 px-1 text-left hover:bg-muted/40 transition-colors rounded"
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="text-sm font-semibold">{t('keyboardShortcuts.whatsNew.releaseVersionLabel', { version: release.version })}</span>
              {release.isViewerVersion && (
                <span className="px-1.5 py-0.5 text-2xs font-medium bg-sky-500/15 text-sky-600 dark:text-sky-400 rounded">
                  {t('keyboardShortcuts.whatsNew.viewerBadge')}
                </span>
              )}
              <span className="text-xs text-muted-foreground ml-auto">
                {t('keyboardShortcuts.whatsNew.changeCount', { count: totalHighlights })}
              </span>
            </button>
            {isExpanded && (
              <div className="ml-5 pb-2 space-y-2">
                {release.entries.map(({ pkg, highlights }) => (
                  <div key={pkg}>
                    <span className="text-xs font-medium font-mono text-muted-foreground">
                      {formatPkgName(pkg)}
                    </span>
                    <ul className="space-y-0.5 mt-0.5">
                      {highlights.map((h) => {
                        const { icon: Icon, className } = TYPE_CONFIG[h.type];
                        return (
                          <li
                            key={h.text}
                            className="flex items-start gap-1.5 text-sm text-muted-foreground"
                          >
                            <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${className}`} />
                            <span>{h.text}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Legend */}
      <div className="pt-3 border-t flex items-center justify-center gap-4 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Plus className="h-3 w-3 text-emerald-500" /> {t('keyboardShortcuts.whatsNew.legendFeature')}
        </span>
        <span className="flex items-center gap-1">
          <Wrench className="h-3 w-3 text-amber-500" /> {t('keyboardShortcuts.whatsNew.legendFix')}
        </span>
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3 text-blue-500" /> {t('keyboardShortcuts.whatsNew.legendPerf')}
        </span>
      </div>
    </div>
  );
}
