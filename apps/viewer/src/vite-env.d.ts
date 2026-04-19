/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Server URL for IFC processing (also used by superset integration) */
  readonly VITE_IFC_SERVER_URL?: string;
  /** Alternative server URL env var */
  readonly VITE_SERVER_URL?: string;
  /** Set to 'true' to route IFC loading through server instead of client-side WASM */
  readonly VITE_USE_SERVER?: string;
  /** Comma-separated free-tier model IDs */
  readonly VITE_LLM_FREE_MODELS?: string;
  /** Comma-separated model IDs that support image inputs */
  readonly VITE_LLM_IMAGE_MODELS?: string;
  /** Comma-separated model IDs that support file attachment context */
  readonly VITE_LLM_FILE_ATTACHMENT_MODELS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Build-time constants injected by Vite define
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __RELEASE_HISTORY__: Array<{
  name: string;
  releases: Array<{
    version: string;
    highlights: Array<{ type: 'feature' | 'fix' | 'perf'; text: string }>;
  }>;
}>;
declare const __PACKAGE_VERSIONS__: Array<{ name: string; version: string }>;
