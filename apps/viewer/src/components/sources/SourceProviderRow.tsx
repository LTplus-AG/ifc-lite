/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FileSourceProvider } from '@ifc-lite/plugin-api';
import type { SourceHost } from '@/services/sources/source-host';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { useSourceAuth } from './useSourceAuth';
import { Button } from '@/components/ui/button';
import { Cloud, Loader2, LogIn, LogOut, Settings } from 'lucide-react';

interface SourceProviderRowProps {
  provider: FileSourceProvider;
  sourceHost: SourceHost;
  /** Bumped by the panel whenever saved preferences change, so the configured state re-derives. */
  prefsVersion: number;
  onOpenSettings: () => void;
  onBrowse: () => void;
}

/**
 * A provider manifest is third-party data, and `iconUrl` lands in an `img src`.
 * Allow only https: and same-origin relative paths — `javascript:` is inert in
 * `src` but `data:`/protocol-relative URLs are a real exfiltration and
 * mixed-content surface, and a plugin has no business pointing the tag anywhere
 * else. Anything unparseable or off-scheme falls back to the generic icon.
 */
function safeIconUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('//')) return undefined; // protocol-relative
  if (raw.startsWith('/') || raw.startsWith('./')) return raw; // same-origin
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function SourceProviderRow({
  provider,
  sourceHost,
  prefsVersion,
  onOpenSettings,
  onBrowse,
}: SourceProviderRowProps) {
  const { manifest } = provider;
  const auth = useSourceAuth(provider, sourceHost);
  const interactive = auth.status !== 'not-interactive';

  // prefsVersion is not read directly — it exists to re-run this derivation
  // after the settings dialog saves or forgets values.
  void prefsVersion;
  const prefs = loadResolvedSourcePrefs(manifest);
  const prefsConfigured = manifest.preferences
    .filter((pref) => pref.required)
    .every((pref) => Boolean(prefs[pref.name]?.trim()));

  const canBrowse = interactive ? auth.status === 'signed-in' : prefsConfigured;
  // Interactive providers can still require preferences (e.g. a client id for
  // the OAuth app registration) — sign-in is pointless until those exist.
  const canSignIn = auth.status === 'signed-out' && prefsConfigured;
  const hint = !canBrowse
    ? interactive
      ? auth.status === 'restoring'
        ? 'Restoring session…'
        : !prefsConfigured
          ? 'Add the required settings, then sign in to browse'
          : (auth.notice ?? 'Sign in to browse')
      : 'Add the required settings to browse'
    : auth.notice;

  const identityLabel = auth.identity
    ? (auth.identity.displayName ?? auth.identity.email ?? auth.identity.id)
    : null;

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2">
      {/* Name on its own row. Sharing one row with up to three controls
          truncated real provider titles ("SharePoint / OneDrive" became
          "SharePo…") at the panel's default docked width. */}
      <div className="flex items-center gap-2">
        {safeIconUrl(manifest.iconUrl) ? (
          <img
            src={safeIconUrl(manifest.iconUrl)}
            alt=""
            className="h-4 w-4 shrink-0 rounded-sm object-contain"
          />
        ) : (
          <Cloud className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{manifest.title}</span>
          {identityLabel && (
            <span className="block truncate text-xs text-muted-foreground">
              {identityLabel}
              {auth.identity?.organization ? ` · ${auth.identity.organization}` : ''}
            </span>
          )}
        </span>
      </div>

      <div className="flex items-center justify-end gap-1 pl-6">
        {interactive && auth.status === 'signed-in' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            aria-label={`Sign out of ${manifest.title}`}
            onClick={auth.signOut}
          >
            <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Sign out
          </Button>
        )}
        {interactive && (auth.status === 'signed-out' || auth.status === 'busy' || auth.status === 'restoring') && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            aria-label={`Sign in to ${manifest.title}`}
            disabled={!canSignIn}
            onClick={auth.signIn}
          >
            {auth.status === 'signed-out' ? (
              <LogIn className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            ) : (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            Sign in
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={`${manifest.title} settings`}
          onClick={onOpenSettings}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          variant={canBrowse ? 'ghost' : 'outline'}
          size="sm"
          className="h-7"
          disabled={!canBrowse}
          aria-label={`Browse ${manifest.title}`}
          onClick={onBrowse}
        >
          Browse
        </Button>
      </div>
      {hint && (
        <p className="pl-6 text-xs text-muted-foreground">{hint}</p>
      )}
    </li>
  );
}
