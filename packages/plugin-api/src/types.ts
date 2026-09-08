/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// File-source plugin API — the stable contract between host and provider.
//
// This package is dependency-free. Plugins import only from here; they never
// touch the DOM, the store, or any app-internal module.
//
// Shape notes (v2). The v1 contract was drawn around a single provider whose
// API cannot filter server-side, and it encoded that limitation as the
// interface. v2 is drawn against two deliberately dissimilar providers — a
// static-API-key CDE with no CORS and no server-side folder filtering, and an
// OAuth CDE with per-folder listing, cursor pagination and pre-signed download
// URLs on a foreign host. Every difference between them is expressed as a
// declared capability rather than as an assumption.
// ============================================================================

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export interface PluginManifest {
  /** Kebab-case slug, unique across all providers. */
  readonly name: string;
  /** Human-readable display title. */
  readonly title: string;
  /** Optional icon shown by the host when listing providers. */
  readonly iconUrl?: string;
  /**
   * Semver caret range the host must satisfy, e.g. `"^2.0.0"`. Compared
   * against the host's implemented contract version, which the reference host
   * pins to this package's own version.
   */
  readonly api: string;
  /** Allowed outbound network access. The host's fetch wrapper enforces this. */
  readonly permissions: PluginPermissions;
  /** How the user authenticates. Drives which settings UI the host renders. */
  readonly auth: PluginAuthKind;
  /** Declarative preferences — the host auto-generates the settings UI. */
  readonly preferences: readonly PluginPreference[];
  /** What this provider can and cannot do. The host adapts its UI to these. */
  readonly capabilities: ProviderCapabilities;
  /** Contribution points. */
  readonly contributes: PluginContributions;
}

/**
 * `preferences` — the user pastes a long-lived credential (API key) into the
 * host-rendered settings form; the provider reads it via `ctx.getPreference`.
 *
 * `interactive` — the provider owns an interactive sign-in (OAuth and friends)
 * and must implement `SourceAuth`. The host renders sign-in/sign-out and an
 * identity line instead of, or alongside, the preferences form.
 */
export type PluginAuthKind = 'preferences' | 'interactive';

export interface PluginPermissions {
  /**
   * Hostnames the provider may contact. `*.example.com` matches any subdomain
   * and the apex. Enforced on the *upstream* host, before any relay rewrite.
   *
   * Wildcards exist for providers whose data host is tenant-specific and
   * therefore unknowable at build time (e.g. `*.sharepoint.com`).
   */
  readonly network: readonly string[];
  /**
   * Hostnames whose content may be fetched with `ctx.fetchPublic` — that is,
   * pre-signed URLs that must be requested *without* credentials. Kept
   * separate from `network` so a provider cannot accidentally widen the set of
   * hosts its authenticated requests can reach.
   */
  readonly publicNetwork?: readonly string[];
  /**
   * Declares that this provider's API sends no CORS headers and must be
   * reached through a same-origin path the app's own server forwards
   * upstream. The host validates the declaration against the relay routes it
   * actually has configured and refuses to register the provider otherwise,
   * so a relay can never be silently missing in production.
   */
  readonly relay?: RelayDeclaration;
}

export interface RelayDeclaration {
  /** Upstream origin + base path, e.g. `https://api.example.com/service/api`. */
  readonly upstream: string;
  /** Same-origin path the host forwards from, e.g. `/api/example`. */
  readonly path: string;
}

export interface PluginContributions {
  /** Relative paths to the provider entry modules. */
  readonly fileSources: readonly string[];
}

// ---------------------------------------------------------------------------
// Capabilities — how the host should drive this provider
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /**
   * `direct-children` — `listContainers` returns only the direct children of
   * `parentId`. The host browses one level at a time. Correct for any API with
   * a real per-folder endpoint, and mandatory for stores large enough that
   * enumerating a whole tree is not viable.
   *
   * `flat-subtree` — `listContainers` returns every descendant of `parentId`
   * in one call, flattened, with `parentId` links intact. For APIs that cannot
   * filter by folder server-side and would otherwise need one full sweep per
   * level. The host nests the result client-side.
   */
  readonly containerListing: 'direct-children' | 'flat-subtree';
  /**
   * Whether `listFiles` on a container also returns files in its descendant
   * containers. Providers that can only sweep a whole file area report `true`;
   * the host then avoids re-querying per folder.
   */
  readonly listFilesIsRecursive: boolean;
  /** Provider implements `listRevisions`. */
  readonly revisionHistory: boolean;
  /**
   * Whether `download` can honour a `revisionId` other than the file's current
   * one. Being able to *list* history does not imply being able to *fetch* it:
   * Microsoft Graph serves historical versions only through a redirect that a
   * browser cannot follow while authenticating, so a browser-only provider can
   * offer full history in the UI and still be unable to retrieve those bytes.
   * Hosts must not offer "load this older revision" when this is false.
   */
  readonly downloadHistoricalRevisions: boolean;
  /** Provider implements `watchRevisions` for change detection. */
  readonly changeDetection: boolean;
  /** Provider implements `searchFiles`; the host shows a search box. */
  readonly search: boolean;
  /**
   * Projects cannot be enumerated — delegated Microsoft Graph, for one, has no
   * "list every site I can see". The host must offer search and/or a
   * paste-a-URL affordance instead of presenting a list as complete.
   */
  readonly projectsAreDiscoverableOnly?: boolean;
  /**
   * Whether the host should eagerly drain every page of a container's file
   * listing up front, rather than loading one page at a time with an
   * explicit "load more" (the same incremental pattern already used for
   * folders — see `containerListing`).
   *
   * Defaults to `false` (off) when omitted, so a provider that does not set
   * this gets ordinary incremental file paging. Set `true` only when the
   * provider's own UI has no per-folder "load more files" concept — Dalux is
   * the reference case: its UI always shows a folder's files as one complete
   * set, with no paginated affordance to partially match, so partial paging
   * in the host would be inventing UX the provider itself doesn't have.
   *
   * A provider with a genuine per-folder file endpoint (the expected case for
   * anything landing after Dalux — Graph-backed stores included) should leave
   * this off: incremental paging avoids blocking a folder's first render on a
   * full drain, and avoids the sweep's bounded-but-real cap on very large
   * folders (`MAX_FILE_SWEEP_ITEMS` / `MAX_FILE_SWEEP_PAGES` in
   * `apps/viewer/src/components/sources/sourceCatalogPaging.ts`).
   */
  readonly eagerFileSweep?: boolean;
}

// ---------------------------------------------------------------------------
// Preferences schema (host-rendered settings modal)
// ---------------------------------------------------------------------------

export type PluginPreferenceType = 'textfield' | 'password' | 'checkbox' | 'dropdown';

export interface PluginPreference {
  /** Machine key stored in the host's config storage. */
  readonly name: string;
  /** Human-readable label for the settings UI. */
  readonly title: string;
  /** Optional longer description shown below the field. */
  readonly description?: string;
  readonly type: PluginPreferenceType;
  readonly required: boolean;
  /** Default value (for checkbox: `"true"` / `"false"`). */
  readonly default?: string;
  /** For `dropdown` type only — the available choices. */
  readonly options?: readonly DropdownOption[];
}

export interface DropdownOption {
  readonly label: string;
  readonly value: string;
}

// ---------------------------------------------------------------------------
// Plugin context — injected by the host at runtime
// ---------------------------------------------------------------------------

export interface PluginContext {
  /**
   * Host-injected fetch for *authenticated* API calls. The host enforces
   * `permissions.network` against the upstream hostname, applies the declared
   * relay if any, never follows redirects (a redirect off the checked host
   * would leak request headers), never attaches ambient credentials
   * (`credentials: 'omit'` — a relay makes requests same-origin, so the
   * default would send the app's own cookies upstream), and retries `429` and
   * `503` responses carrying `Retry-After` with bounded backoff.
   *
   * Providers must use this instead of global `fetch`.
   */
  readonly fetch: typeof fetch;
  /**
   * Fetch for pre-signed, credential-free URLs — the download links some
   * providers return, which point at a CDN or tenant host and are invalidated
   * by sending an `Authorization` header at all.
   *
   * Enforced against `permissions.publicNetwork`. The host strips every
   * request header except `Accept` and `Range`, so a provider cannot use this
   * path to smuggle a credential to a host outside `permissions.network`.
   * Redirects are followed, since pre-signed URLs commonly bounce.
   */
  readonly fetchPublic: (url: string, init?: PublicFetchInit) => Promise<Response>;
  /** Retrieve a preference value (secret or plain). */
  getPreference(name: string): Promise<string | undefined>;
  /** Namespaced key-value store (localStorage-backed in the reference host; treat values as user-revocable, not securely encrypted). */
  readonly storage: KeyValueStore;
  readonly log: Logger;
}

export interface PublicFetchInit {
  readonly signal?: AbortSignal;
  /** Byte range for resumable or chunked downloads, e.g. `"bytes=0-1048575"`. */
  readonly range?: string;
}

export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * One page of results. `cursor` is an opaque provider-defined continuation
 * token; `undefined` means this is the last page. Hosts must treat it as
 * opaque and must not persist it across sessions.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

/** Options accepted by every listing call. */
export interface ListOptions {
  readonly cursor?: string;
  /** Hint only; providers clamp to whatever their API allows. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Domain model — projects, containers, files, revisions
// ---------------------------------------------------------------------------

export interface SourceProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Provider-specific metadata the host passes through opaquely. */
  readonly meta?: Record<string, unknown>;
}

export interface SourceContainer {
  readonly id: string;
  readonly name: string;
  /** Parent container id, or `undefined` for root-level containers. */
  readonly parentId?: string;
  /**
   * `false` when the provider knows this container has no child containers,
   * letting the host render a leaf without a round-trip. `undefined` means
   * unknown.
   */
  readonly hasChildren?: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface SourceFile {
  readonly id: string;
  readonly name: string;
  /** The container this file actually lives in, not necessarily the one queried. */
  readonly containerId: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  /**
   * Opaque id of the current revision. Providers whose API exposes no revision
   * identity should report a content hash or etag here; it must change when
   * the bytes change and must not change when only metadata changes.
   */
  readonly currentRevisionId: string;
  readonly modifiedAt?: string;
  readonly modifiedBy?: string;
  readonly meta?: Record<string, unknown>;
}

export interface SourceRevision {
  /**
   * Opaque revision id. Deliberately a string: SharePoint version labels are
   * `"1.0"` and `"2.0"`, not integers.
   */
  readonly id: string;
  /** Display label, provider-formatted. */
  readonly label: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly sizeBytes?: number;
}

export interface RevisionEvent {
  readonly fileId: string;
  readonly latestRevisionId: string;
  readonly previousRevisionId?: string;
  /** The file is gone upstream (deleted, or moved out of the user's reach). */
  readonly deleted?: boolean;
}

export interface RevisionWatchResult {
  readonly events: readonly RevisionEvent[];
  /**
   * Cursor to pass to the next `watchRevisions` call. Providers with a delta
   * endpoint return a real token here, turning polling from "re-sweep
   * everything" into a single cheap request.
   */
  readonly cursor?: string;
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * Fully-qualified reference to a file. v1 passed a bare `fileId`, which forced
 * providers to keep their own id-to-location map in host storage and to crawl
 * the entire account whenever that map missed. Carrying the full path removes
 * the failure mode instead of caching around it.
 */
export interface SourceFileRef {
  readonly projectId: string;
  readonly containerId: string;
  readonly fileId: string;
  /** Omit for "latest". */
  readonly revisionId?: string;
}

export interface DownloadOptions {
  readonly signal?: AbortSignal;
  /** Called with bytes received and, when the provider knows it, the total. */
  readonly onProgress?: (received: number, total?: number) => void;
}

// ---------------------------------------------------------------------------
// File filter
// ---------------------------------------------------------------------------

export interface FileFilter {
  /** Glob patterns matched case-insensitively against the file name. */
  readonly namePatterns?: readonly string[];
  /** MIME types to include. Advisory: many stores report IFC as octet-stream. */
  readonly mimeTypes?: readonly string[];
}

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
  /** Re-establish a session from cache, silently. Returns null if not signed in. */
  restore(ctx: PluginContext): Promise<SourceIdentity | null>;
  /** Interactive sign-in. Called only from a user gesture. */
  signIn(ctx: PluginContext): Promise<SourceIdentity>;
  signOut(ctx: PluginContext): Promise<void>;
  /** Current identity, or null. Must not perform interactive work. */
  getIdentity(ctx: PluginContext): Promise<SourceIdentity | null>;
}

// ---------------------------------------------------------------------------
// FileSourceProvider — the core interface plugins implement
// ---------------------------------------------------------------------------

export interface FileSourceProvider {
  readonly manifest: PluginManifest;

  /** Required when `manifest.auth === 'interactive'`. */
  readonly auth?: SourceAuth;

  /**
   * List projects visible to the authenticated identity.
   *
   * Providers reporting `projectsAreDiscoverableOnly` may return a partial or
   * empty page when `query` is absent; the host then prompts the user to
   * search or paste a URL rather than presenting the result as complete.
   */
  listProjects(ctx: PluginContext, options?: ListProjectsOptions): Promise<Page<SourceProject>>;

  /**
   * List containers within a project. `parentId` omitted means top level.
   *
   * The shape of the result is governed by `capabilities.containerListing`:
   * `direct-children` returns only immediate children, `flat-subtree` returns
   * the whole descendant set flattened with `parentId` links intact.
   */
  listContainers(
    ctx: PluginContext,
    projectId: string,
    parentId?: string,
    options?: ListOptions,
  ): Promise<Page<SourceContainer>>;

  /**
   * List files in a container. Whether descendants are included is governed by
   * `capabilities.listFilesIsRecursive`.
   */
  listFiles(
    ctx: PluginContext,
    projectId: string,
    containerId: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>>;

  /** Download file content. */
  download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer>;

  /** Optional: revision history for one file, newest first. */
  listRevisions?(
    ctx: PluginContext,
    ref: SourceFileRef,
    options?: ListOptions,
  ): Promise<Page<SourceRevision>>;

  /**
   * Optional: detect new revisions.
   *
   * Providers with a delta or change-feed endpoint should use `cursor` and
   * ignore `refs`, returning a fresh cursor each call. Providers without one
   * poll the given `refs`. Either way the host passes both, and the cost of
   * the call is the provider's business rather than the host's guess.
   */
  watchRevisions?(
    ctx: PluginContext,
    refs: readonly SourceFileRef[],
    cursor?: string,
    options?: ListOptions,
  ): Promise<RevisionWatchResult>;

  /** Optional: server-side file search within a project. */
  searchFiles?(
    ctx: PluginContext,
    projectId: string,
    query: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>>;

  /** Optional: test the connection and return a diagnostic message. */
  testConnection?(ctx: PluginContext): Promise<ConnectionTestResult>;
}

export interface ListProjectsOptions extends ListOptions {
  /** Free-text query, for providers that can only discover projects by search. */
  readonly query?: string;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
  /** Number of accessible projects, when the provider can count them cheaply. */
  readonly projectCount?: number;
}

// ---------------------------------------------------------------------------
// Source tag — metadata attached to federated models loaded from a provider
// ---------------------------------------------------------------------------

export interface SourceTag {
  readonly provider: string;
  readonly projectId: string;
  readonly containerId: string;
  readonly fileId: string;
  readonly revisionId: string;
  readonly loadedAt: number;
}
