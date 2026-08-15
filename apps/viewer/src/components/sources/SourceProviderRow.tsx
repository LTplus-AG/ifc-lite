/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FileSourceProvider } from '@ifc-lite/plugin-api';
import type { SourceHost } from '@/services/sources/source-host';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { isAllowedHost, isHttpsUrl } from '@/services/sources/host-fetch';
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
}: SourceProviderRowProps) {
  const { manifest } = provider;
  const iconUrl = safeIconUrl(manifest.iconUrl, manifest.permissions.network);
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
        {iconUrl ? (
          <img
            src={iconUrl}
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
