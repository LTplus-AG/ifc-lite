/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Info, Keyboard, ExternalLink, Sparkles, ChevronDown, ChevronRight, Zap, Wrench, Plus, Package, ShieldCheck } from 'lucide-react';

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.04 11.04 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.8 1.18 1.83 1.18 3.09 0 4.42-2.7 5.4-5.27 5.69.42.36.78 1.08.78 2.18 0 1.57-.01 2.83-.01 3.22 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { KEYBOARD_SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

const GITHUB_URL = 'https://github.com/LTplus-AG/ifc-lite';

interface InfoDialogProps {
  open: boolean;
  onClose: () => void;
}

function formatBuildDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

const TYPE_CONFIG = {
  feature: { icon: Plus, className: 'text-emerald-500' },
  fix: { icon: Wrench, className: 'text-amber-500' },
  perf: { icon: Zap, className: 'text-blue-500' },
} as const;

function PrivacyBanner() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="pt-2 border-t">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-left transition-colors hover:bg-emerald-500/15"
      >
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
        <span className="text-xs font-medium">Your IFC data never leaves your device.</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 ml-1 space-y-1 text-xs text-muted-foreground">
          <p>
            All files are processed locally in the browser with{' '}
            <a
              href="https://webassembly.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground transition-colors"
            >
              WebAssembly (WASM)
            </a>
            {' '}&ndash; no server upload, near-native speed.
          </p>
          <p className="text-[11px] italic">
            Verify: press <kbd className="px-1 py-0.5 bg-muted rounded border font-mono text-[10px]">F12</kbd> &rarr; Network tab &rarr; no IFC data transmitted.
          </p>
        </div>
      )}
    </div>
  );
}

function AboutTab() {
  const [showPackages, setShowPackages] = useState(false);
  const packageVersions = typeof __PACKAGE_VERSIONS__ !== 'undefined' ? __PACKAGE_VERSIONS__ : [];

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="text-center pb-2 border-b">
        <h3 className="text-xl font-bold">ifc-lite</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          v{__APP_VERSION__} &middot; {formatBuildDate(__BUILD_DATE__)}
        </p>
      </div>

      {/* Links */}
      <div className="flex items-center justify-center flex-wrap gap-x-4 gap-y-1.5 text-xs">
        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          ifclite.dev
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href="https://ltplus-ag.github.io/ifc-lite/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          Docs
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <GithubIcon className="h-3.5 w-3.5" />
          GitHub
        </a>
        <a
          href={`${GITHUB_URL}/issues`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          Report issue
          <ExternalLink className="h-3 w-3" />
        </a>
        <span className="text-muted-foreground">MPL-2.0</span>
      </div>

      {/* Feature chips */}
      <div className="flex flex-wrap gap-1 justify-center pt-2 border-t">
        {[
          'WebGPU', 'IFC2x3', 'IFC4', 'IFC4X3', 'IFC5/IFCX',
          'Federation', 'Measurements', 'Sections',
          'Properties', 'Data tables', 'Lens rules', 'IDS',
          '2D drawings', 'BCF', 'Scripting', 'AI assistant',
          'glTF export', 'CSV', 'Parquet',
        ].map((tag) => (
          <span
            key={tag}
            className="px-2 py-0.5 text-[11px] rounded-full bg-muted/60 text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>

      {/* Privacy & Security */}
      <PrivacyBanner />

      {/* Package Versions */}
      {packageVersions.length > 0 && (
        <div className="pt-2 border-t">
          <button
            onClick={() => setShowPackages(!showPackages)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showPackages ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Package className="h-3 w-3" />
            {packageVersions.length} packages
          </button>
          {showPackages && (
            <div className="rounded-md border bg-muted/30 p-2 mt-1.5 max-h-48 overflow-y-auto">
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                {packageVersions.map((pkg) => (
                  <div
                    key={pkg.name}
                    className="flex items-center justify-between text-xs py-0.5 px-1 min-w-0"
                  >
                    <span className="text-muted-foreground font-mono truncate mr-2">
                      {pkg.name.replace('@ifc-lite/', '')}
                    </span>
                    <span className="font-mono shrink-0 tabular-nums">{pkg.version}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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

function WhatsNewTab() {
  const packageChangelogs = __RELEASE_HISTORY__;
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
        No release history available.
      </div>
    );
  }

  return (
    <div className="space-y-1">
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
              <span className="text-sm font-semibold">v{release.version}</span>
              {release.isViewerVersion && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-sky-500/15 text-sky-600 dark:text-sky-400 rounded">
                  viewer
                </span>
              )}
              <span className="text-xs text-muted-foreground ml-auto">
                {totalHighlights} change{totalHighlights !== 1 ? 's' : ''}
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
      <div className="pt-3 border-t flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Plus className="h-3 w-3 text-emerald-500" /> Feature
        </span>
        <span className="flex items-center gap-1">
          <Wrench className="h-3 w-3 text-amber-500" /> Fix
        </span>
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3 text-blue-500" /> Perf
        </span>
      </div>
    </div>
  );
}

function ShortcutsTab() {
  // Group shortcuts by category
  const grouped = KEYBOARD_SHORTCUTS.reduce(
    (acc, shortcut) => {
      if (!acc[shortcut.category]) {
        acc[shortcut.category] = [];
      }
      acc[shortcut.category].push(shortcut);
      return acc;
    },
    {} as Record<string, (typeof KEYBOARD_SHORTCUTS)[number][]>
  );

  return (
    <div className="space-y-4">
      {/* Learn-more row: drives discovery to the marketing site and the github.io
          docs. Sits above the shortcut groups so it's the first thing users hunting
          for help see, without crowding the keyboard reference itself. */}
      <div className="rounded border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Learn more:</span>
        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-2 underline-offset-2 hover:underline hover:text-primary transition-colors"
        >
          ifclite.dev
        </a>
        <span className="mx-1.5 opacity-40">·</span>
        <a
          href="https://ltplus-ag.github.io/ifc-lite/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline hover:text-primary transition-colors"
        >
          docs
        </a>
      </div>
      {Object.entries(grouped).map(([category, shortcuts]) => (
        <div key={category}>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            {category}
          </h3>
          <div className="space-y-1">
            {shortcuts.map((shortcut) => (
              <div
                key={shortcut.key + shortcut.description}
                className="flex items-center justify-between py-1"
              >
                <span className="text-sm">{shortcut.description}</span>
                <kbd className="px-2 py-0.5 text-xs bg-muted rounded border font-mono">
                  {shortcut.key}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function KeyboardShortcutsDialog({ open, onClose }: InfoDialogProps) {
  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border rounded-lg shadow-xl w-full max-w-md m-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Info</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tabbed Content */}
        <Tabs defaultValue="about" className="w-full">
          <div className="px-4 pt-4">
            <TabsList className="w-full">
              <TabsTrigger value="about" className="flex-1 gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground">
                <Info className="h-3.5 w-3.5" />
                About
              </TabsTrigger>
              <TabsTrigger value="whatsnew" className="flex-1 gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                What's New
              </TabsTrigger>
              <TabsTrigger value="shortcuts" className="flex-1 gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground">
                <Keyboard className="h-3.5 w-3.5" />
                Shortcuts
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="about" className="p-4 max-h-80 overflow-y-auto">
            <AboutTab />
          </TabsContent>

          <TabsContent value="whatsnew" className="p-4 max-h-96 overflow-y-auto">
            <WhatsNewTab />
          </TabsContent>

          <TabsContent value="shortcuts" className="p-4 max-h-80 overflow-y-auto">
            <ShortcutsTab />
          </TabsContent>
        </Tabs>

        {/* Footer */}
        <div className="p-4 border-t text-center">
          <span className="text-xs text-muted-foreground">
            Press{' '}
            <kbd className="px-1 py-0.5 bg-muted rounded border font-mono text-xs">
              ?
            </kbd>{' '}
            to toggle this panel
          </span>
        </div>
      </div>
    </div>
  );
}

// Hook to manage info dialog state (renamed export for backward compatibility)
export function useKeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);

  // Listen for '?' key to toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input or textarea
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  return { open, toggle, close };
}
