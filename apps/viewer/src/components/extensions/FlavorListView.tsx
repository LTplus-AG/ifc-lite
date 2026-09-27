/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorListView` — CRUD surface for the flavor library.
 *
 * Sits inside `FlavorDialog`; the dialog owns data fetching, busy
 * state, and outgoing actions. Each row supports the full management
 * loop a user actually needs:
 *
 *   - **Activate** (non-active rows)
 *   - **Capture into THIS flavor** — snapshot the live viewer state
 *     into that specific flavor, not just the active one
 *   - **Rename** (inline click-to-edit on the name)
 *   - **Duplicate** — clone the flavor with a fresh id
 *   - **Export** / **Delete**
 *
 * Header offers **New flavor** (empty, name it) and **Save current as
 * flavor** (snapshot from current viewer state, name it). Both flows
 * open an inline name input so the user never sees an empty list with
 * no path forward.
 */

import { useState } from 'react';
import { Camera, Copy, Download, FilePlus, Pencil, RefreshCcw, Upload, X, Check } from 'lucide-react';
import type { Flavor } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { localizedFlavorDescription, localizedFlavorName } from './localized-flavor-metadata';
import { formatExtensionDate } from './localized-date';

/** Number of clash rules (customs + modified built-ins) stored in a flavor's
 *  `settings.clash` blob. 0 when the flavor carries no clash config. */
function clashRuleCount(flavor: Flavor): number {
  const clash = (flavor.settings as Record<string, unknown> | undefined)?.clash;
  if (!clash || typeof clash !== 'object') return 0;
  const presets = (clash as { presets?: unknown }).presets;
  return Array.isArray(presets) ? presets.length : 0;
}

interface FlavorListViewProps {
  flavors: readonly Flavor[];
  activeId: string | undefined;
  busy: boolean;
  /** Count of lenses currently in viewer state — surfaces "you have N lenses uncaptured" hint. */
  liveLensCount: number;
  onActivate(id: string): void;
  onExport(id: string): void;
  onDelete(id: string): void;
  onImportClick(): void;
  onReset(): void;
  /** Snapshot current viewer state into a SPECIFIC flavor (not just active). */
  onCaptureInto(id: string): void;
  /** Rename a flavor. Caller validates. */
  onRename(id: string, name: string): void;
  /** Duplicate a flavor with a fresh id. */
  onDuplicate(id: string): void;
  /** Create a new flavor — empty body, user-provided name. Optional snapshot. */
  onCreate(opts: { name: string; snapshot: boolean }): void;
}

type Creating = null | { mode: 'empty' | 'snapshot'; name: string };

export function FlavorListView({
  flavors,
  activeId,
  busy,
  liveLensCount,
  onActivate,
  onExport,
  onDelete,
  onImportClick,
  onReset,
  onCaptureInto,
  onRename,
  onDuplicate,
  onCreate,
}: FlavorListViewProps) {
  const { t, locale } = useTranslation();
  const [creating, setCreating] = useState<Creating>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [initialRenameValue, setInitialRenameValue] = useState('');

  const startRename = (flavor: Flavor) => {
    setRenamingId(flavor.id);
    const displayName = localizedFlavorName(flavor, t);
    setRenameValue(displayName);
    setInitialRenameValue(displayName);
  };
  const commitRename = () => {
    const trimmedName = renameValue.trim();
    if (renamingId && trimmedName.length > 0 && trimmedName !== initialRenameValue) {
      onRename(renamingId, trimmedName);
    }
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);

  const submitCreate = () => {
    if (!creating || creating.name.trim().length === 0) return;
    onCreate({ name: creating.name.trim(), snapshot: creating.mode === 'snapshot' });
    setCreating(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground flex-1 min-w-[200px]">
          {t('extensionsFlavors.flavorListView.intro')}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="default"
            onClick={() => setCreating({ mode: liveLensCount > 0 ? 'snapshot' : 'empty', name: '' })}
            disabled={busy || creating !== null}
            aria-label={
              liveLensCount > 0
                ? t('extensionsFlavors.flavorListView.saveCurrentAriaLabel')
                : t('extensionsFlavors.flavorListView.createNewAriaLabel')
            }
          >
            <FilePlus className="mr-1 h-3.5 w-3.5" />
            {liveLensCount > 0
              ? t('extensionsFlavors.flavorListView.saveCurrentLabel')
              : t('extensionsFlavors.flavorListView.newFlavorLabel')}
          </Button>
          <Button size="sm" variant="outline" onClick={onImportClick} disabled={busy}>
            <Upload className="mr-1 h-3.5 w-3.5" />
            {t('extensionsFlavors.flavorListView.importButton')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onReset}
            disabled={busy}
            title={t('extensionsFlavors.flavorListView.resetTitle')}
          >
            <RefreshCcw className="mr-1 h-3.5 w-3.5" />
            {t('extensionsFlavors.flavorListView.resetButton')}
          </Button>
        </div>
      </div>

      {/* Inline name input — appears when user clicks "New flavor" or
          "Save current as flavor". Keeping it inline avoids a nested
          modal stack inside the Flavors dialog. */}
      {creating && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <label className="text-xs font-medium block mb-1">
            {creating.mode === 'snapshot'
              ? t('extensionsFlavors.flavorListView.nameSnapshotLabel', {
                  count: liveLensCount,
                  countDisplay: formatLocaleNumber(locale, liveLensCount),
                })
              : t('extensionsFlavors.flavorListView.nameEmptyLabel')}
          </label>
          <div className="flex items-center gap-2">
            {/* The inline editor opens by explicit user action; focus starts in its text field. */}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Input autoFocus
              value={creating.name}
              onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') setCreating(null);
              }}
              placeholder={
                creating.mode === 'snapshot'
                  ? t('extensionsFlavors.flavorListView.placeholderSnapshot')
                  : t('extensionsFlavors.flavorListView.placeholderEmpty')
              }
              className="h-8 text-xs"
              disabled={busy}
            />
            {/* Snapshot/empty toggle so the user can switch mode without re-opening the form. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCreating({
                ...creating,
                mode: creating.mode === 'snapshot' ? 'empty' : 'snapshot',
              })}
              disabled={busy || liveLensCount === 0}
              title={
                creating.mode === 'snapshot'
                  ? t('extensionsFlavors.flavorListView.switchToEmptyTitle')
                  : t('extensionsFlavors.flavorListView.switchToSnapshotTitle')
              }
            >
              {creating.mode === 'snapshot'
                ? t('extensionsFlavors.flavorListView.modeLabelSnapshot')
                : t('extensionsFlavors.flavorListView.modeLabelEmpty')}
            </Button>
            <Button size="sm" variant="default" onClick={submitCreate} disabled={busy || creating.name.trim().length === 0}>
              {t('extensionsFlavors.flavorListView.createButton')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(null)} disabled={busy}>
              {t('extensionsFlavors.flavorListView.cancelButton')}
            </Button>
          </div>
        </div>
      )}

      {flavors.length === 0 ? (
        <div className="rounded border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
          {t('extensionsFlavors.flavorListView.emptyState', {
            newFlavor: t('extensionsFlavors.flavorListView.newFlavorLabel'),
            reset: t('extensionsFlavors.flavorListView.resetButton'),
            import: t('extensionsFlavors.flavorListView.importButton'),
          })}
        </div>
      ) : (
        <ul className="divide-y border rounded">
          {flavors.map((flavor) => {
            const isActive = flavor.id === activeId;
            const isRenaming = renamingId === flavor.id;
            const hasUncaptured = isActive && liveLensCount > flavor.lenses.length;
            const uncapturedCount = liveLensCount - flavor.lenses.length;
            const displayName = localizedFlavorName(flavor, t);
            const displayDescription = localizedFlavorDescription(flavor, t);
            return (
              <li
                key={flavor.id}
                className={`flex items-start gap-3 px-3 py-2 ${isActive ? 'bg-primary/5' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {isRenaming ? (
                      <>
                        {/* Rename opens by explicit user action; focus starts in its text field. */}
                        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                        <Input autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') cancelRename();
                          }}
                          className="h-7 text-sm"
                        />
                        <IconButton
                          label={t('extensionsFlavors.flavorListView.saveNameAriaLabel')}
                          onClick={commitRename}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton
                          label={t('extensionsFlavors.flavorListView.cancelRenameAriaLabel')}
                          onClick={cancelRename}
                        >
                          <X className="h-3.5 w-3.5" />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startRename(flavor)}
                          className="text-sm font-medium hover:underline underline-offset-2 text-left truncate max-w-[14rem]"
                          aria-label={t('extensionsFlavors.flavorListView.renameAriaLabel', { name: displayName })}
                          title={t('extensionsFlavors.flavorListView.clickToRenameTitle')}
                        >
                          {displayName}
                        </button>
                        {isActive && (
                          <span className="text-xs uppercase tracking-wide bg-primary/20 text-primary rounded px-1.5 py-0.5 font-semibold">
                            {t('extensionsFlavors.flavorListView.activeBadge')}
                          </span>
                        )}
                        {hasUncaptured && (
                          <span
                            className="text-xs uppercase tracking-wide bg-amber-500/20 text-amber-700 dark:text-amber-300 rounded px-1.5 py-0.5 font-semibold"
                            title={t('extensionsFlavors.flavorListView.uncapturedTitle', {
                              count: uncapturedCount,
                              countDisplay: formatLocaleNumber(locale, uncapturedCount),
                            })}
                          >
                            {t('extensionsFlavors.flavorListView.uncapturedBadge', {
                              count: formatLocaleNumber(locale, uncapturedCount),
                            })}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono break-all">
                    {flavor.id}
                  </div>
                  {displayDescription && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {displayDescription}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {t('extensionsFlavors.flavorListView.statsLine', {
                      ext: formatLocaleNumber(locale, flavor.extensions.length),
                      lens: formatLocaleNumber(locale, flavor.lenses.length),
                      qry: formatLocaleNumber(locale, flavor.savedQueries.length),
                      clash: formatLocaleNumber(locale, clashRuleCount(flavor)),
                      date: formatExtensionDate(flavor.updatedAt, locale, true),
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {!isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onActivate(flavor.id)}
                      disabled={busy}
                    >
                      {t('extensionsFlavors.flavorListView.activateButton')}
                    </Button>
                  )}
                  <IconButton
                    label={t('extensionsFlavors.flavorListView.captureAriaLabel', { name: displayName })}
                    tooltip={hasUncaptured ? t('extensionsFlavors.flavorListView.captureTitleUncaptured', { name: displayName, count: formatLocaleNumber(locale, uncapturedCount) }) : t('extensionsFlavors.flavorListView.captureTitleSnapshot', { name: displayName })}
                    variant={hasUncaptured ? 'default' : 'ghost'}
                    onClick={() => onCaptureInto(flavor.id)}
                    disabled={busy}
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={t('extensionsFlavors.flavorListView.renameAriaLabel', { name: displayName })}
                    tooltip={t('extensionsFlavors.flavorListView.renameTitle')}
                    onClick={() => startRename(flavor)}
                    disabled={busy || isRenaming}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={t('extensionsFlavors.flavorListView.duplicateAriaLabel', { name: displayName })}
                    tooltip={t('extensionsFlavors.flavorListView.duplicateTitle')}
                    onClick={() => onDuplicate(flavor.id)}
                    disabled={busy}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={t('extensionsFlavors.flavorListView.exportAriaLabel', { name: displayName })}
                    tooltip={t('extensionsFlavors.flavorListView.exportTitle')}
                    onClick={() => onExport(flavor.id)}
                    disabled={busy}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </IconButton>
                  {!isActive && (
                    <IconButton
                      label={t('extensionsFlavors.flavorListView.deleteAriaLabel', { name: displayName })}
                      tooltip={t('extensionsFlavors.flavorListView.deleteTitle')}
                      onClick={() => onDelete(flavor.id)}
                      disabled={busy}
                    >
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
