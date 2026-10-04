/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from './types.js';

// ---------------------------------------------------------------------------
// Interactive authentication
// ---------------------------------------------------------------------------

export interface SourceIdentity {
  /** Stable account id, provider-scoped. */
  readonly id: string;
  readonly displayName?: string;
  readonly email?: string;
  /** Tenant or organisation label, when the provider has one. */
  readonly organization?: string;
}

/**
 * Implemented by providers declaring `auth: 'interactive'`.
 *
 * `restore` runs at registration and must be silent and non-blocking: no
 * popups, no navigation. `signIn` may open a popup and must therefore only be
 * called from a user gesture — the host guarantees this.
 */
export interface SourceAuth {
  /** Explicitly cancel an interactive attempt, including a COOP-separated popup. */
  cancelSignIn?(): void;
  /** Re-establish a session from cache, silently. Returns null if not signed in. */
  restore(ctx: PluginContext): Promise<SourceIdentity | null>;
  /** Interactive sign-in. Called only from a user gesture. */
  signIn(ctx: PluginContext): Promise<SourceIdentity>;
  signOut(ctx: PluginContext): Promise<void>;
  /** Current identity, or null. Must not perform interactive work. */
  getIdentity(ctx: PluginContext): Promise<SourceIdentity | null>;
}

