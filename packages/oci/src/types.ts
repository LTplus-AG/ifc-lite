/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A parsed `host[:port]/repository[:tag][@sha256:<hex>]` reference. */
export interface OciReference {
  /** `host[:port]`, lowercased. */
  registry: string;
  /** `https://host[:port]`, or `http://` for a host the caller listed as insecure. */
  origin: string;
  repository: string;
  tag?: string;
  /** `sha256:<64 lowercase hex>`. */
  digest?: string;
}

/**
 * Registry credentials. `username`/`password` is exchanged at the token realm
 * (or sent as Basic to the registry itself); `token` is sent as
 * `Authorization: Bearer <token>` straight to the registry.
 */
export type OciCredentials = { username: string; password: string } | { token: string };

/** Incremental SHA-256. `digest()` returns lowercase hex without the `sha256:` prefix. */
export interface OciHasher {
  update(chunk: Uint8Array): void;
  digest(): Promise<string> | string;
}

export interface OciClientOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  credentials?: OciCredentials;
  /**
   * Token-realm origins (`https://auth.example.com`) other than the registry's
   * own origin that may receive `username`/`password` credentials.
   */
  trustedRealms?: readonly string[];
  /** `host` or `host:port` entries allowed over plain `http:`. */
  insecureHosts?: readonly string[];
  /** Streaming hasher factory. Default: WebCrypto over the whole body. */
  createHasher?: () => OciHasher;
  /** Default 4 MiB. */
  maxManifestBytes?: number;
  /** Sent as `User-Agent` when set (browsers may ignore it). */
  userAgent?: string;
}

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
  artifactType?: string;
  platform?: unknown;
}

export interface OciManifest {
  kind: 'manifest';
  mediaType: string;
  artifactType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
  annotations?: Record<string, string>;
}

export interface OciIndex {
  kind: 'index';
  mediaType: string;
  manifests: OciDescriptor[];
  annotations?: Record<string, string>;
}

export interface OciManifestResult {
  /** `sha256:<hex>` of the received bytes. */
  digest: string;
  mediaType: string;
  /** The exact bytes received; the digest is computed over these. */
  bytes: Uint8Array;
  value: OciManifest | OciIndex;
}

/** The parts of a reference that address a repository. */
export type OciRepositoryRef = Pick<OciReference, 'origin' | 'registry' | 'repository'>;

/** What `pushBlob` stored (or found already stored). */
export interface OciPushedBlob {
  /** `sha256:<hex>` computed from the bytes sent. */
  digest: string;
  size: number;
}

export interface OciPushManifestOptions {
  signal?: AbortSignal;
  /**
   * Replace an existing tag. Without it, a tag that already exists is
   * `TAG_EXISTS`. The check is not atomic (see `pushManifest`).
   */
  allowOverwrite?: boolean;
}

export interface OciPushedManifest {
  /** `sha256:<hex>` computed from the manifest bytes sent. */
  digest: string;
}

export interface OciImageManifestInput {
  artifactType?: string;
  /** Default: the OCI empty descriptor (`application/vnd.oci.empty.v1+json`, `{}`, 2 bytes). */
  config?: OciDescriptor;
  layers: OciDescriptor[];
  annotations?: Record<string, string>;
}

export interface OciBuiltManifest {
  /** The serialized manifest; push exactly these bytes. */
  bytes: Uint8Array;
  /** `application/vnd.oci.image.manifest.v1+json`. */
  mediaType: string;
  /** `sha256:<hex>` of `bytes`. */
  digest: string;
}
