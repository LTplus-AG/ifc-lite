/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The four tab bodies for `KeyboardShortcutsDialog` (About / What's New /
 * Shortcuts — Learn lives in `LearnTab.tsx` already), split out so that
 * file stays under the module-size budget (#5817 moved its shell onto
 * `ui/dialog.tsx`, which only grew it further). Content is unchanged from
 * before the split — this is a pure extraction.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Package, ShieldCheck, ExternalLink } from 'lucide-react';
import { KEYBOARD_SHORTCUTS } from '@/hooks/keyboard-shortcuts-list';
import { useTranslation } from '@/i18n';

const GITHUB_URL = 'https://github.com/LTplus-AG/ifc-lite';

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

export function PrivacyBanner() { // exported for ViewportWelcomeCard.privacy.test.tsx (#5119): the start screen renders the same key
  const { t } = useTranslation(); const [expanded, setExpanded] = useState(false);

  return (
    <div className="pt-2 border-t">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-left transition-colors hover:bg-emerald-500/15"
      >
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
        <span className="text-xs font-medium">{t('keyboardShortcuts.privacy.banner')}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 ml-1 space-y-1 text-xs text-muted-foreground">
          <p>
            {t('keyboardShortcuts.privacy.intro')}{' '}
            <a
              href="https://webassembly.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground transition-colors"
            >
              {t('keyboardShortcuts.privacy.wasmLink')}
            </a>
            {' '}{t('keyboardShortcuts.privacy.outro')}
          </p>
          <p className="text-2xs italic">
            {t('keyboardShortcuts.privacy.verifyIntro')} <kbd className="px-1 py-0.5 bg-muted rounded border font-mono text-2xs">{t('keyboardShortcuts.privacy.verifyKey')}</kbd> {t('keyboardShortcuts.privacy.verifyOutro')}
          </p>
        </div>
      )}
    </div>
  );
}

export function AboutTab() {
  const { t } = useTranslation(); const [showPackages, setShowPackages] = useState(false);
  const packageVersions = typeof __PACKAGE_VERSIONS__ !== 'undefined' ? __PACKAGE_VERSIONS__ : [];

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="text-center pb-2 border-b">
        <h3 className="text-xl font-bold">{t('keyboardShortcuts.about.appName')}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t('keyboardShortcuts.about.versionLabel', { version: __APP_VERSION__ })} &middot; {formatBuildDate(__BUILD_DATE__)}</p>
      </div>

      {/* Links */}
      <div className="flex items-center justify-center flex-wrap gap-x-4 gap-y-1.5 text-xs">
        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('keyboardShortcuts.about.homepageLink')}
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href="https://ifclite.dev/docs/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('keyboardShortcuts.about.docsLink')}
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <GithubIcon className="h-3.5 w-3.5" />
          {t('keyboardShortcuts.about.githubLink')}
        </a>
        <a
          href={`${GITHUB_URL}/issues`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('keyboardShortcuts.about.reportIssueLink')}
          <ExternalLink className="h-3 w-3" />
        </a>
        <span className="text-muted-foreground">{t('keyboardShortcuts.about.license')}</span>
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
            className="px-2 py-0.5 text-2xs rounded-full bg-muted/60 text-muted-foreground"
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
            {t('keyboardShortcuts.about.packagesCount', { count: packageVersions.length })}
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

export function ShortcutsTab() {
  const { t } = useTranslation(); // Group shortcuts by category
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
        <span className="font-medium text-foreground">{t('keyboardShortcuts.shortcuts.learnMore')}</span>
        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-2 underline-offset-2 hover:underline hover:text-primary transition-colors"
        >
          {t('keyboardShortcuts.shortcuts.homepageLink')}
        </a>
        <span className="mx-1.5 opacity-40">·</span>
        <a
          href="https://ifclite.dev/docs/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline hover:text-primary transition-colors"
        >
          {t('keyboardShortcuts.shortcuts.docsLink')}
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
