/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sign-in form of the BCF server dialog: pick a known public server or a
 * custom one, choose an auth method the server supports, connect. On
 * success the parent takes over with the connected view.
 */

import { useCallback, useMemo, useState } from 'react';
import { Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  bcfOAuthRedirectUri,
  completeBcfOAuth,
  prepareBcfOAuth,
  signInToBcfServer,
  signInWithClientCredentials,
  signInWithToken,
  validateBcfServerUrl,
  type BcfServerConfig,
} from '@/services/bcf-server';
import {
  AUTH_METHOD_LABELS,
  BCF_SERVER_PRESETS,
  CUSTOM_PRESET_ID,
  findBcfServerPreset,
  presetForServerUrl,
  vendorAppEnvPrefix,
  vendorAppForPreset,
  type BcfAuthMethod,
} from './bcf-server-presets';

interface BCFServerConnectFormProps {
  initialServerUrl: string;
  initialUsername: string;
  onSignedIn: (config: BcfServerConfig) => void;
}

export function BCFServerConnectForm({
  initialServerUrl,
  initialUsername,
  onSignedIn,
}: BCFServerConnectFormProps) {
  const [presetId, setPresetId] = useState(() => presetForServerUrl(initialServerUrl).id);
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [authMethod, setAuthMethod] = useState<BcfAuthMethod>(
    () => presetForServerUrl(initialServerUrl).authMethods[0],
  );
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = findBcfServerPreset(presetId);
  // An OAuth app this deployment holds with the vendor. When present the
  // browser sign-in runs through it and the client-id fields stay hidden:
  // for vendors that only issue ids to application developers (BIMcollab)
  // this is the only way a space user can sign in at all.
  const vendorApp = useMemo(() => vendorAppForPreset(preset.id), [preset.id]);
  // Honest wording for those vendors when the deployment has no app: the
  // generic "register an OAuth application with the vendor" sends users
  // after something the vendor will not give them (#3900).
  const missingClientIdMessage = preset.vendorIssuedClientsOnly
    ? `${preset.label} issues client ids to application vendors, not to space users, and this IFClite deployment has no ${preset.label} app configured (${vendorAppEnvPrefix(preset.id)}_CLIENT_ID). Sign in via browser is unavailable here.`
    : undefined;

  const handlePresetChange = useCallback((id: string) => {
    const next = findBcfServerPreset(id);
    setPresetId(next.id);
    // Every named preset owns the URL field: fixed servers fill it, and
    // tenant-hosted ones (BIMcollab, OpenProject) CLEAR it — carrying the
    // previous preset's URL over would label one server while connecting
    // to another. Only Custom keeps whatever the user typed.
    if (next.id !== CUSTOM_PRESET_ID) setServerUrl(next.baseUrl);
    setAuthMethod((current) =>
      next.authMethods.includes(current) ? current : next.authMethods[0],
    );
    setError(null);
  }, []);

  const handleConnect = useCallback(async () => {
    const urlError = validateBcfServerUrl(serverUrl);
    if (urlError) {
      setError(urlError);
      return;
    }
    // The popup must be opened synchronously inside the click handler or
    // popup blockers eat it; it navigates once discovery has the auth URL.
    const popup =
      authMethod === 'oauth'
        ? window.open('about:blank', 'ifc-lite-bcf-oauth', 'width=500,height=700')
        : null;
    // A blocked popup fails the attempt before any network work — running
    // discovery and dynamic client registration for a sign-in that cannot
    // complete would mint throwaway clients on the server.
    if (authMethod === 'oauth' && (!popup || popup.closed)) {
      setError('Sign-in popup was blocked — allow popups for this site and try again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let config: BcfServerConfig;
      if (authMethod === 'password') {
        config = await signInToBcfServer(serverUrl, username.trim(), password);
      } else if (authMethod === 'token') {
        config = await signInWithToken(serverUrl, accessToken);
      } else if (authMethod === 'oauth') {
        if (!popup) {
          throw new Error('Sign-in popup was blocked — allow popups for this site and try again.');
        }
        const preparation = await prepareBcfOAuth(serverUrl, {
          clientId: vendorApp?.clientId ?? clientId,
          clientSecret: vendorApp?.clientSecret ?? clientSecret,
          redirectUri: vendorApp?.redirectUri || undefined,
          scope: preset.oauthScope,
          missingClientIdMessage,
        });
        // Subscribe before navigating: BroadcastChannel does not buffer.
        const { waitForOAuthCallback } = await import('@ifc-lite/oauth-pkce');
        const callback = waitForOAuthCallback({
          expectedState: preparation.state,
          timeoutMs: 5 * 60 * 1000,
          timeoutMessage: 'The BCF server sign-in was not completed within 5 minutes.',
        });
        popup.location.href = preparation.authorizeUrl;
        const callbackUrl = await callback;
        config = await completeBcfOAuth(preparation, callbackUrl);
      } else {
        config = await signInWithClientCredentials(
          serverUrl,
          clientId.trim(),
          clientSecret.trim(),
        );
      }
      setPassword('');
      setAccessToken('');
      setClientSecret('');
      onSignedIn(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Inert when COOP already severed the handle or the page closed itself.
      popup?.close();
      setBusy(false);
    }
  }, [
    serverUrl,
    authMethod,
    username,
    password,
    accessToken,
    clientId,
    clientSecret,
    preset,
    vendorApp,
    missingClientIdMessage,
    onSignedIn,
  ]);

  const missingCredentials =
    authMethod === 'password'
      ? !username.trim() || !password
      : authMethod === 'token'
        ? !accessToken.trim()
        : authMethod === 'oauth'
          ? false // client id is optional: dynamic registration may supply one
          : !clientId.trim() || !clientSecret.trim();
  const connectDisabled = busy || !serverUrl.trim() || missingCredentials;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label id="bcf-server-preset-label">Server</Label>
        <Select value={presetId} onValueChange={handlePresetChange}>
          <SelectTrigger id="bcf-server-preset" aria-labelledby="bcf-server-preset-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BCF_SERVER_PRESETS.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preset.note && <p className="text-xs text-muted-foreground">{preset.note}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bcf-server-url">Server URL</Label>
        <Input
          id="bcf-server-url"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://example.com/bcf"
          autoComplete="url"
        />
      </div>

      {preset.authMethods.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label id="bcf-server-auth-label">Sign-in method</Label>
          <Select
            value={authMethod}
            onValueChange={(value) => {
              setAuthMethod(value as BcfAuthMethod);
              setError(null);
            }}
          >
            <SelectTrigger id="bcf-server-auth" aria-labelledby="bcf-server-auth-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {preset.authMethods.map((method) => (
                <SelectItem key={method} value={method}>
                  {AUTH_METHOD_LABELS[method]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {authMethod === 'password' && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bcf-server-user">Email</Label>
            <Input
              id="bcf-server-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bcf-server-password">Password</Label>
            <Input
              id="bcf-server-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
        </>
      )}

      {authMethod === 'token' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bcf-server-token">Access token</Label>
          <Input
            id="bcf-server-token"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="Paste an access token"
            autoComplete="off"
          />
        </div>
      )}

      {authMethod === 'oauth' && vendorApp && (
        <p className="text-xs text-muted-foreground" data-testid="bcf-server-vendor-app">
          Signs you in with your {preset.label} account through IFClite&rsquo;s registered{' '}
          {preset.label} app — no client id to enter.
        </p>
      )}

      {authMethod === 'oauth' && !vendorApp && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bcf-server-oauth-client-id">Client ID</Label>
            <Input
              id="bcf-server-oauth-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={
                preset.vendorIssuedClientsOnly
                  ? 'Issued by the vendor to application developers'
                  : 'Leave empty to auto-register when supported'
              }
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {preset.vendorIssuedClientsOnly
                ? `${preset.label} issues client ids to application vendors, not to space users. Ask whoever runs this IFClite deployment to configure its ${preset.label} app.`
                : 'From an OAuth app registered with the vendor. Servers offering dynamic client registration need no ID — leave it empty.'}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bcf-server-oauth-client-secret">Client secret (optional)</Label>
            <Input
              id="bcf-server-oauth-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The OAuth app must allow this redirect URI:{' '}
            <code className="break-all">{bcfOAuthRedirectUri()}</code>
          </p>
        </>
      )}

      {authMethod === 'clientCredentials' && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bcf-server-client-id">Client ID</Label>
            <Input
              id="bcf-server-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bcf-server-client-secret">Client secret</Label>
            <Input
              id="bcf-server-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        {authMethod === 'password'
          ? 'The password is exchanged for an access token and never stored. The token is kept in this browser’s local storage, unencrypted — treat it as revocable, not secret.'
          : 'Credentials are kept in this browser’s local storage, unencrypted — treat them as revocable, not secret.'}
      </p>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          <XCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void handleConnect()} disabled={connectDisabled}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </div>
    </div>
  );
}
