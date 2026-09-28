/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PLUGIN_API_VERSION } from '@ifc-lite/plugin-api';
import type { CommitCapabilities, PluginManifest, ProviderCapabilities } from '@ifc-lite/plugin-api';

/**
 * Configuration a HOST application supplies when it registers this provider.
 *
 * WHY THIS IS NOT A PREFERENCE: `permissions.network` is the host's security
 * boundary, checked before every request, and a preference is user-editable
 * data. A generic provider whose hostnames came from a preference would let
 * anyone who can type in the settings dialog widen the allowlist to any host
 * they like — and `isValidHostPattern` rejects a bare `*`, deliberately, so
 * there is no "allow everything" escape hatch to fall back on either.
 *
 * So the deployment declares its hosts in code, at `registerFactory` time
 * (`apps/viewer/src/bootstrap.tsx` is the seam for exactly this), and the
 * user's `baseUrl` preference can only select among paths on those hosts.
 */
export interface CommitHttpManifestOptions {
  /**
   * Hostnames this provider may contact: the commit service, and the OIDC
   * issuer when it lives elsewhere. `*.example.com` matches any subdomain
   * and the apex.
   */
  readonly network: readonly string[];
  /** Kebab-case slug. Defaults to `commit-http`; give each deployment its own when registering several. */
  readonly name?: string;
  /** Display title. Defaults to `Commit service`. */
  readonly title?: string;
  /**
   * What the service supports. REQUIRED, and deliberately not defaulted.
   *
   * The contract is "a method is present exactly when its flag is true", and
   * a manifest is read once at registration — so this cannot be discovered
   * lazily and back-filled: a host that saw `storedDiffs: false` at
   * registration has already decided not to render the compare preview.
   *
   * A deployment that does not want to hard-code it can call
   * {@link fetchCommitCapabilities} at bootstrap and pass the result here.
   * `testConnection` re-reads `GET /capabilities` and reports any
   * disagreement, so a declaration that drifts from the service is visible
   * rather than silent.
   */
  readonly commits: CommitCapabilities;
}

/**
 * The 2.0.0 half, all off.
 *
 * A commit service is not a file store: it has no containers, no file
 * listing and no per-file revision history, and this provider does not
 * pretend otherwise. `listProjects` is real; `listContainers` / `listFiles`
 * answer empty pages, because the contract requires them to exist and the
 * host's browser shows "no files" rather than breaking.
 */
const FILE_CAPABILITIES = {
  containerListing: 'direct-children',
  listFilesIsRecursive: false,
  revisionHistory: false,
  downloadHistoricalRevisions: false,
  changeDetection: false,
  search: false,
} as const satisfies Partial<ProviderCapabilities>;

export function buildCommitHttpManifest(options: CommitHttpManifestOptions): PluginManifest {
  return {
    name: options.name ?? 'commit-http',
    title: options.title ?? 'Commit service',
    // `^2.1.0`, not `^2.0.0`: this provider's whole surface is the commit
    // API, so a 2.0.0 host could register it and then find nothing to call.
    api: `^${PLUGIN_API_VERSION}`,
    auth: 'interactive',
    permissions: { network: options.network },
    preferences: [
      {
        name: 'baseUrl',
        title: 'Service URL',
        description: 'Base URL of the commit service REST API, e.g. https://commits.example.com/api/v1',
        type: 'textfield',
        required: true,
      },
      {
        name: 'issuer',
        title: 'Sign-in issuer',
        description:
          'OIDC issuer URL. Its /.well-known/openid-configuration supplies the authorization and token endpoints. ' +
          'Leave blank to use the service URL.',
        type: 'textfield',
        required: false,
      },
      {
        name: 'clientId',
        title: 'Client ID',
        description: 'OIDC public client registered for this viewer. Not a secret: the flow is authorization code with PKCE.',
        type: 'textfield',
        required: true,
      },
    ],
    capabilities: {
      ...FILE_CAPABILITIES,
      commits: options.commits,
    },
    contributes: { fileSources: ['./src/provider.ts'] },
  };
}
