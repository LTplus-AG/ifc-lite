/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ConnectionTestResult } from '@ifc-lite/plugin-api';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { SourceSettingsDialog } from './SourceSettingsDialog';
import { SourceBrowser } from './SourceBrowser';
import { SourceProviderRow } from './SourceProviderRow';
import { SourceFavouritesList } from './SourceFavouritesList';
import { useSourceDownloadBatch } from './useSourceDownloadBatch';
import type { SourceFavourite } from '@/lib/sources/favourites';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { AlertCircle, Cloud, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { TranslationKey } from '@/i18n';
import { getLocale, hasActiveTranslation, resolveEnglish, selectPluralCategory } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { loadResolvedSourcePrefs, saveSourcePrefs } from '@/lib/sources/preferences';
import { useSourceProviderPins } from './useSourceProviderPins';
import { clearAllSourceData } from '@/lib/sources/persistence';
import {
  claimRevisionWatchSlot,
  watchSourceRevisions,
  type SourceRevisionUpdate,
} from '@/lib/sources/revisionWatch';

interface SourcesPanelProps {
  onClose: () => void;
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** Build one complete, locale-orderable source revision notice. */
const REVISION_BOTH_KEYS: Record<Intl.LDMLPluralRule, TranslationKey> = {
  zero: 'sources.sourcesPanel.revisionChangedZeroDeleted',
  one: 'sources.sourcesPanel.revisionChangedOneDeleted',
  two: 'sources.sourcesPanel.revisionChangedTwoDeleted',
  few: 'sources.sourcesPanel.revisionChangedFewDeleted',
  many: 'sources.sourcesPanel.revisionChangedManyDeleted',
  other: 'sources.sourcesPanel.revisionChangedOtherDeleted',
};

export function revisionSyncMessage(t: Translate, locale: string, changed: number, deleted: number): string {
  if (changed > 0 && deleted > 0) {
    const localeKey = REVISION_BOTH_KEYS[selectPluralCategory(locale, changed)];
    const params = {
      count: deleted,
      changed: formatLocaleNumber(locale, changed),
      deleted: formatLocaleNumber(locale, deleted),
    };
    // Locale catalogues are partial (#4785): falling back to English text
    // under the *active locale's* plural category (e.g. Russian "one" for
    // 21) can pick an English form that count doesn't have (English's
    // "one" is only for exactly 1) — reselect with English plural rules
    // first so the fallback text and its count agree grammatically.
    return hasActiveTranslation(localeKey)
      ? t(localeKey, params)
      : resolveEnglish(REVISION_BOTH_KEYS[selectPluralCategory('en', changed)], params);
  }
  if (changed > 0) {
    return t('sources.sourcesPanel.revisionChangedOnly', { count: changed });
  }
  if (deleted > 0) {
    return t('sources.sourcesPanel.revisionDeletedOnly', { count: deleted });
  }
  return '';
}

/**
 * Builds and shows the background revision-sync toast. Reads the active
 * locale live via `getLocale()` rather than accepting it as a parameter:
 * the one-shot, slot-gated effect below can still be pending when the
 * app's async startup locale activates, so a closed-over value could be
 * stale by the time this resolves (#5000 review).
 */
export function notifyRevisionSync(t: Translate, updates: readonly SourceRevisionUpdate[]): void {
  const deleted = updates.filter((u) => u.event.deleted).length;
  const changed = updates.length - deleted;
  toast.info(revisionSyncMessage(t, getLocale(), changed, deleted));
}

export function RegistrationFailureMessage({ provider, reason }: { provider: string; reason: string }) {
  const { t } = useTranslation();
  let marker = '\uE000provider\uE001';
  while (reason.includes(marker)) marker += '\uE002';
  const message = t('sources.sourcesPanel.failedToRegister', { provider: marker, reason });
  const segments = message.split(marker);
  if (segments.length === 1) return message;
  return segments.flatMap((segment, index) => index === segments.length - 1
    ? [segment]
    : [segment, <span key={index} className="font-medium">{provider}</span>]);
}

export function SourcesPanel({ onClose }: SourcesPanelProps) {
  const { t } = useTranslation();
  const sourceHost = useSourceHost();
  const providers = useMemo(() => sourceHost.list(), [sourceHost]);
  const registrationFailures = useMemo(
    () => sourceHost.getRegistrationFailures(),
    [sourceHost],
  );
  const pins = useSourceProviderPins();
  const didAutoOpen = useRef(false);
  const [readyProviders, setReadyProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [downloadOwner, setDownloadOwner] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  // Bumped when saved prefs change so rows/contexts re-derive configured state.
  const [prefsVersion, setPrefsVersion] = useState(0);
  // Same counter pattern for the favourites the list reads from storage. Its
  // other half, the identity those favourites are filtered by, is live auth
  // state rather than a counter: only the provider rows know it.
  const [favouritesVersion, setFavouritesVersion] = useState(0);
  const [liveIdentities, setLiveIdentities] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  // The favourite a click asked to jump to; consumed once by the browser.
  const [browseTarget, setBrowseTarget] = useState<SourceFavourite | null>(null);

  const bumpFavourites = useCallback(() => setFavouritesVersion((v) => v + 1), []);
  // Referentially stable, and a no-op when the reported identity is unchanged:
  // the rows call this from an effect, so a fresh Map every time would re-render
  // the list on every render of the panel.
  const recordIdentity = useCallback((providerId: string, identityId: string | null) => {
    setLiveIdentities((previous) => {
      if (previous.has(providerId) && previous.get(providerId) === identityId) return previous;
      return new Map(previous).set(providerId, identityId);
    });
  }, []);

  const recordReady = useCallback((providerId: string, ready: boolean) => {
    setReadyProviders((previous) => {
      if (previous.has(providerId) === ready) return previous;
      const next = new Set(previous);
      if (ready) next.add(providerId); else next.delete(providerId);
      return next;
    });
  }, []);
  useEffect(() => {
    if (didAutoOpen.current || browsing) return;
    const pinned = pins.ids.find((id) => readyProviders.has(id));
    if (pinned) { didAutoOpen.current = true; setBrowsing(pinned); }
  }, [pins.ids, readyProviders, browsing]);

  const closeBrowser = useCallback(() => {
    setBrowsing(null);
    setBrowseTarget(null);
  }, []);

  useEffect(() => {
    if (browsing && liveIdentities.has(browsing) && !readyProviders.has(browsing)) {
      setBrowsing(null); setBrowseTarget(null);
    }
  }, [browsing, liveIdentities, readyProviders]);

  const activeProvider = browsing ? sourceHost.get(browsing) : undefined;
  const settingsProvider = settingsFor ? sourceHost.get(settingsFor) : undefined;

  // Background change detection for loaded source models, one pass per panel
  // mount, gated per provider on `capabilities.changeDetection`.
  useEffect(() => {
    const tags = useViewerStore.getState().sourceTags;
    if (tags.size === 0) return;
    if (!claimRevisionWatchSlot()) return;
    const controller = new AbortController();
    void watchSourceRevisions(sourceHost, tags, controller.signal)
      .then((updates) => {
        if (controller.signal.aborted || updates.length === 0) return;
        // `notifyRevisionSync` reads the locale live (`getLocale()`) rather
        // than a value closed over here: this is a one-shot, slot-gated
        // check that can still be pending when the startup locale finishes
        // loading and activates, so a render-time snapshot could be stale
        // by the time this resolves (#5000 review). `locale` is
        // deliberately not a dependency of this effect — adding it would
        // abort and restart the one-shot check on every switch.
        notifyRevisionSync(t, updates);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('[sources] Background revision check failed', err);
      });
    return () => controller.abort();
  }, [sourceHost, t]);

  const handleSavePrefs = useCallback(
    (values: Record<string, string>) => {
      if (settingsFor) {
        saveSourcePrefs(settingsFor, values);
        setPrefsVersion((v) => v + 1);
      }
    },
    [settingsFor],
  );

  const handleForgetPrefs = useCallback(() => {
    if (settingsFor) {
      // Sweep everything the feature stored for this provider — prefs (API
      // key), catalog caches, downloaded-file records, watch cursors, and the
      // provider's own storage namespace. On a shared machine "forget" has to
      // mean all of it.
      clearAllSourceData(settingsFor);
      setPrefsVersion((v) => v + 1);
      // The sweep takes this provider's favourites with it (they hold folder
      // and file names), so the list has to re-read storage.
      bumpFavourites();
    }
  }, [bumpFavourites, settingsFor]);

  const handleTestConnection = useCallback(
    async (values: Record<string, string>): Promise<ConnectionTestResult> => {
      if (!settingsProvider) {
        return { ok: false, message: t('sources.sourcesPanel.noProviderMessage') };
      }
      const ctx = sourceHost.createContext(settingsProvider.manifest, values);
      if (settingsProvider.testConnection) {
        return settingsProvider.testConnection(ctx);
      }
      return { ok: false, message: t('sources.sourcesPanel.connectionTestUnsupported') };
    },
    [settingsProvider, sourceHost, t],
  );

  // Downloads are aborted when the panel unmounts (close / navigate away).
  const { downloading, downloadStates, handleDownload, cancelDownload, clearFinishedDownloadStates } = useSourceDownloadBatch({
    provider: activeProvider,
    providerId: browsing,
    sourceHost,
    onBatchSucceeded: pins.ids.includes(browsing ?? '') ? () => {} : closeBrowser,
  });

  const openFavourite = useCallback((favourite: SourceFavourite) => {
    if (downloading) return;
    didAutoOpen.current = true;
    setBrowseTarget(favourite);
    setBrowsing(favourite.providerId);
  }, [downloading]);

  useEffect(() => {
    if (downloading && downloadOwner && sourceHost.get(downloadOwner)?.manifest.auth === 'interactive'
      && liveIdentities.has(downloadOwner) && liveIdentities.get(downloadOwner) === null) cancelDownload();
  }, [downloading, downloadOwner, liveIdentities, sourceHost, cancelDownload]);

  const browsingCtx = useMemo(() => {
    if (!activeProvider || !browsing) return null;
    // prefsVersion re-derives the context after settings changes.
    void prefsVersion;
    return sourceHost.createContext(
      activeProvider.manifest,
      loadResolvedSourcePrefs(activeProvider.manifest),
    );
  }, [activeProvider, browsing, sourceHost, prefsVersion]);

  // Stable initial values for the settings dialog — a fresh object every
  // render would wipe the form whenever the panel re-renders.
  const settingsInitialValues = useMemo(() => {
    if (!settingsProvider) return undefined;
    void prefsVersion;
    return loadResolvedSourcePrefs(settingsProvider.manifest);
  }, [settingsProvider, prefsVersion]);


  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{t('sources.sourcesPanel.title')}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 rounded-sm"
          aria-label={t('sources.sourcesPanel.closeAria')}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-1 pb-3 text-xs text-muted-foreground">{t('sources.workspace.intro')}</p>
        {providers.length === 0 && registrationFailures.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
            <Cloud className="h-8 w-8" aria-hidden />
            <span>{t('sources.sourcesPanel.noProviders')}</span>
          </div>
        )}

        {pins.restoreFailed && <p role="alert" className="mb-2 rounded border p-2 text-xs text-muted-foreground">{t('sources.workspace.pinRestoreFailed')}</p>}
        {downloading && <div className="mb-2 flex items-center gap-2 rounded border p-2">
          <output className="min-w-0 flex-1 text-xs">{t('sources.workspace.downloading', { title: sourceHost.get(downloadOwner ?? '')?.manifest.title ?? '' })}</output>
          <Button size="sm" variant="outline" onClick={cancelDownload}>{t('sources.sourceBrowserHeader.cancelDownload')}</Button>
        </div>}
        <SourceFavouritesList
          sourceHost={sourceHost}
          favouritesVersion={favouritesVersion}
          liveIdentities={liveIdentities}
          onOpen={openFavourite}
          navigationDisabled={downloading}
          onChanged={bumpFavourites}
        />

        <ul className="space-y-2">
          {[...providers].sort((a, b) => Number(pins.ids.includes(b.manifest.name)) - Number(pins.ids.includes(a.manifest.name))).map((p) => (
            <SourceProviderRow
              key={p.manifest.name}
              provider={p}
              sourceHost={sourceHost}
              prefsVersion={prefsVersion}
              onOpenSettings={() => setSettingsFor(p.manifest.name)}
              onBrowse={() => {
                didAutoOpen.current = true;
                setBrowseTarget(null);
                setBrowsing((previous) => previous === p.manifest.name ? null : p.manifest.name);
              }}
              browseDisabled={downloading && downloadOwner !== p.manifest.name}
              expanded={browsing === p.manifest.name}
              pinned={pins.ids.includes(p.manifest.name)}
              onTogglePin={() => pins.toggle(p.manifest.name)}
              onReady={recordReady}
              onIdentityChange={recordIdentity}
            >
              {browsing === p.manifest.name && activeProvider && browsingCtx && (
                <div className="flex h-[min(65vh,600px)] min-h-64 flex-col">
                  <SourceBrowser key={JSON.stringify([browsing, prefsVersion, browseTarget?.projectId, browseTarget?.fileAreaId, browseTarget?.containerId, browseTarget?.fileId])} provider={activeProvider} ctx={browsingCtx}
                    onDownload={(selection) => { setDownloadOwner(browsing); void handleDownload(selection); }}
                    onBack={() => { didAutoOpen.current = true; closeBrowser(); clearFinishedDownloadStates(); }}
                    busy={downloading} onCancelDownload={cancelDownload} downloadStates={downloadOwner === browsing ? downloadStates : new Map()}
                    openTarget={browseTarget} onFavouritesChanged={bumpFavourites} favouritesVersion={favouritesVersion} />
                </div>
              )}
            </SourceProviderRow>
          ))}
        </ul>

        {registrationFailures.length > 0 && (
          <div className="border-t px-3 py-2">
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              {t('sources.sourcesPanel.unavailableProviders')}
            </div>
            <ul className="flex flex-col gap-1.5">
              {registrationFailures.map((failure) => (
                <li
                  key={failure.provider}
                  className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    <RegistrationFailureMessage provider={failure.provider} reason={failure.reason} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {settingsProvider && (
        <SourceSettingsDialog
          manifest={settingsProvider.manifest}
          open={!!settingsFor}
          onOpenChange={(open) => { if (!open) setSettingsFor(null); }}
          onSave={handleSavePrefs}
          onForget={handleForgetPrefs}
          onTestConnection={
            settingsProvider.testConnection ? handleTestConnection : undefined
          }
          initialValues={settingsInitialValues}
        />
      )}
    </div>
  );
}
