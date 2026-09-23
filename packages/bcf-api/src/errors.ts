/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF's error types are the generic OpenCDE Foundation API error types
 * (https://github.com/buildingSMART/foundation-API): an HTTP-level failure
 * carries the same status/url/detail/isAuthError shape for every OpenCDE
 * service, and BCF's token endpoint failures follow the same RFC 6749 shape
 * Documents API auth does. Re-exported under their historical BCF names so
 * `instanceof BcfApiError` keeps working for existing callers — these ARE
 * `@ifc-lite/opencde-foundation`'s classes, not copies of them.
 */
export {
  FoundationApiError as BcfApiError,
  FoundationAuthenticationError as BcfAuthenticationError,
  extractErrorDetail,
} from '@ifc-lite/opencde-foundation';
