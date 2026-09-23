/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wire types for the buildingSMART OpenCDE Foundation API
 * (https://github.com/buildingSMART/foundation-API), the small set of
 * services and conventions every OpenCDE API (BCF, Documents, ...) shares:
 * version discovery, OAuth2 auth discovery, and the current-user lookup.
 */

/** Entry of `GET /foundation/versions`. */
export interface FoundationVersion {
  api_id: string;
  version_id: string;
  detailed_version?: string | null;
  /** Fully-qualified base URL for this API/version; relocates it off the default path when present. */
  api_base_url?: string | null;
}

/** Response of `GET {base}/{version}/auth`. */
export interface FoundationAuthInfo {
  oauth2_auth_url?: string;
  oauth2_token_url?: string;
  oauth2_dynamic_client_reg_url?: string;
  http_basic_supported?: boolean | null;
  supported_oauth2_flows?: string[];
}

/** Response of `GET {base}/{version}/current-user`. */
export interface FoundationCurrentUser {
  id: string;
  name?: string | null;
}

/**
 * OAuth2 token response of `POST {oauth2_token_url}`. Unlike the wire DTOs
 * above, this is what the auth helpers RETURN after field-by-field
 * validation (`postTokenRequest`), so absent fields are always `undefined`,
 * never `null`.
 */
export interface FoundationTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

/** Minimal fetch signature every OpenCDE client depends on (injectable in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Supplies the current access token; return undefined for anonymous calls. */
export type FoundationTokenProvider = () => string | undefined | Promise<string | undefined>;
