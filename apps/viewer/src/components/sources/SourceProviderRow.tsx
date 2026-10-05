/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactNode } from 'react';
import type { FileSourceProvider } from '@ifc-lite/plugin-api';
import type { SourceHost } from '@/services/sources/source-host';
import { isPrefsConfigured, loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { isAllowedHost, isHttpsUrl } from '@/services/sources/host-fetch';
import { SourceLoadedBadge } from './SourceLoadedBadge';
import { useSourceAuth } from './useSourceAuth';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { CheckCircle2, ChevronDown, ChevronRight, Cloud, LogIn, LogOut, Settings, Star } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { resolveLiveMessage } from '@/i18n/live-message';

interface SourceProviderRowProps {
  provider: FileSourceProvider;
  sourceHost: SourceHost;
  /** Bumped by the panel whenever saved preferences change, so the configured state re-derives. */
  prefsVersion: number;
  onOpenSettings: () => void;
  onBrowse: () => void;
  expanded?: boolean;
  browseDisabled?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  children?: ReactNode;
  onReady?: (providerId: string, ready: boolean) => void;
  /**
   * Reports this provider's signed-in identity once its auth has SETTLED. Auth
   * lives in this row, but the favourites list above it is filtered by
   * identity, so it has to learn about a sign-in that happens while the panel
   * is open — and, just as much, about a silent restore that resolves nothing.
   */
  onIdentityChange?: (providerId: string, identityId: string | null) => void;
}

/**
 * A provider manifest is third-party data, and `iconUrl` lands in an `img src`,
 * which fires an uncredentialed cross-origin GET the moment it renders — a
 * beacon. So the host, not the plugin, decides where that tag may point.
 *
 * Two rules, both checked on the RESOLVED URL rather than on the raw string:
 *
 * - **Same-origin is always allowed**, whatever `permissions.network` says. A
 *   provider that talks to nothing still gets to ship `/icons/acme.svg`; an
 *   empty allowlist means "no cross-origin icon", never "no icon at all".
 * - **Cross-origin must be https AND in `permissions.network`** — the same
 *   allowlist (wildcards included) the host's fetch wrapper already enforces,
 *   so a plugin can point its icon exactly where it has already declared it
 *   talks, and nowhere else. That rejects `data:`, `javascript:`, plaintext
 *   `http:`, and protocol-relative URLs as a side effect of the same check.
 *
 * String-prefixing the raw value is NOT good enough, which is why this resolves
 * through `new URL()` first: `/\evil.example/beacon.gif` passes a leading-slash
 * "same-origin" test, but the URL parser folds `\` into `/` for special
 * schemes, so the browser requests `//evil.example/beacon.gif`. Anything
 * unparseable or disallowed falls back to the generic icon.
 */
export function safeIconUrl(
  raw: string | undefined,
  allowedHosts: readonly string[],
): string | undefined {
  if (!raw) return undefined;

  let resolved: URL;
  try {
    // Resolving against the document base is what the browser would do with
    // this string anyway; doing it here means the origin we check is the
    // origin that will actually be requested.
    resolved = new URL(raw, window.location.href);
  } catch {
    return undefined;
  }

  // Normalized, so whatever escaping trick produced the string is gone by the
  // time it reaches the tag.
  if (resolved.origin === window.location.origin) return resolved.href;
  if (!isHttpsUrl(resolved)) return undefined;
  return isAllowedHost(allowedHosts, resolved.hostname) ? resolved.href : undefined;
}

export function SourceProviderRow({
  provider,
  sourceHost,
  prefsVersion,
  onOpenSettings,
  onBrowse,
  onIdentityChange,
  expanded = false,
  browseDisabled = false,
  pinned = false,
  onTogglePin,
  children,
  onReady,
}: SourceProviderRowProps) {
  const { t } = useTranslation();
  const { manifest } = provider;
  const iconUrl = safeIconUrl(manifest.iconUrl, manifest.permissions.network);
  const auth = useSourceAuth(provider, sourceHost);
  const openAfterSignIn = useRef(false);
  useEffect(() => {
    if (openAfterSignIn.current && auth.status === 'signed-in') {
      openAfterSignIn.current = false;
      if (!expanded) onBrowse();
    }
  }, [auth.status, expanded, onBrowse]);
  const interactive = auth.status !== 'not-interactive';

  const identityId = auth.identity?.id ?? null;
  // Gated on the auth being settled, and that gate is the whole point rather
  // than tidiness. A silent `restore()` that resolves no session leaves
  // `identityId` at the `null` it already held while restoring, so an effect
  // keyed on the id alone never re-runs — the listener above would keep
  // whatever it last heard, which on a fresh mount is nothing at all. The
  // status transition is the only edge that "signed out after all" produces.
  const settled = auth.status !== 'restoring' && auth.status !== 'busy';
  const providerId = manifest.name;
  useEffect(() => {
    if (!settled) return;
    onIdentityChange?.(providerId, identityId);
  }, [identityId, onIdentityChange, providerId, settled]);

  // prefsVersion is not read directly — it exists to re-run this derivation
  // after the settings dialog saves or forgets values.
  void prefsVersion;
  const prefs = loadResolvedSourcePrefs(manifest);
  const prefsConfigured = isPrefsConfigured(manifest, prefs);

  const canBrowse = interactive ? auth.status === 'signed-in' : prefsConfigured;
  useEffect(() => {
    onReady?.(providerId, canBrowse);
  }, [providerId, canBrowse, onReady]);
  // Interactive providers can still require preferences (e.g. a client id for
  // the OAuth app registration) — sign-in is pointless until those exist.
  const canSignIn = auth.status === 'signed-out' && prefsConfigured;
  const notice = resolveLiveMessage(t, auth.notice);
  const hint = !canBrowse
    ? interactive
      ? auth.status === 'restoring'
        ? t('sources.sourceProviderRow.restoringSession')
        : !prefsConfigured
          ? t('sources.sourceProviderRow.addSettingsThenSignIn')
          : (auth.notice ? notice : t('sources.sourceProviderRow.signInToBrowse'))
      : t('sources.sourceProviderRow.addRequiredSettings')
    : notice;

  const identityLabel = auth.identity
    ? (auth.identity.displayName ?? auth.identity.email ?? auth.identity.id)
    : null;

  return (
    <li className={`rounded-lg border bg-background ${expanded ? 'border-primary/40' : ''}`}>
      <div className="flex items-center gap-1 p-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1.5 text-left hover:bg-accent disabled:cursor-default"
          disabled={!canBrowse || browseDisabled} onClick={onBrowse} aria-expanded={expanded}
          aria-label={t('sources.sourceProviderRow.browseAria', { title: manifest.title })}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
            {iconUrl ? <img src={iconUrl} alt="" className="h-5 w-5 object-contain" />
              : <Cloud className="h-5 w-5 text-muted-foreground" aria-hidden />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{manifest.title}</span>
            <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              {canBrowse && <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden />}
              {identityLabel ?? t(canBrowse ? 'sources.workspace.ready' : 'sources.workspace.notConnected')}
            </span>
            <SourceLoadedBadge providerId={manifest.name} />
          </span>
          {canBrowse && (expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />)}
        </button>
        {onTogglePin && <IconButton label={t(pinned ? 'sources.workspace.unpin' : 'sources.workspace.pin', { title: manifest.title })}
          aria-pressed={pinned} onClick={onTogglePin} className={pinned ? 'text-amber-500' : 'text-muted-foreground'}>
          <Star className={`h-4 w-4 ${pinned ? 'fill-current' : ''}`} aria-hidden />
        </IconButton>}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
        {interactive && auth.status === 'signed-in' && <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground"
          aria-label={t('sources.sourceProviderRow.signOutAria', { title: manifest.title })} onClick={auth.signOut}>
          <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t('sources.sourceProviderRow.signOut')}
        </Button>}
        {interactive && auth.status !== 'signed-in' && <Button variant="outline" size="sm" className="h-8 flex-1"
          aria-label={t('sources.sourceProviderRow.signInAria', { title: manifest.title })} disabled={!canSignIn} onClick={() => { openAfterSignIn.current = true; auth.signIn(); }}>
          {auth.status === 'signed-out' ? <LogIn className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Spinner size="sm" className="mr-1.5" />}
          {t(auth.status === 'restoring' ? 'sources.sourceProviderRow.restoringSession' : auth.status === 'busy' ? 'sources.workspace.connecting' : 'sources.sourceProviderRow.signIn')}
        </Button>}
        {!prefsConfigured && <Button variant="outline" size="sm" onClick={onOpenSettings}>{t('sources.workspace.configure')}</Button>}
        {auth.cancelSignIn && <Button variant="ghost" size="sm" onClick={auth.cancelSignIn}>{t('sources.sourceProviderRow.cancelSignIn')}</Button>}
        <IconButton label={t('sources.sourceProviderRow.settingsAria', { title: manifest.title })} className="ml-auto h-7 w-7" onClick={onOpenSettings}>
          <Settings className="h-3.5 w-3.5" aria-hidden />
        </IconButton>
      </div>
      {hint && <output className="block px-3 pb-2 text-xs text-muted-foreground">{hint}</output>}
      {expanded && canBrowse && <div className="border-t">{children}</div>}
    </li>
  );
}
