/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CapturedNetworkRequest, PostHogConfig } from 'posthog-js';

// Report upload object keys are private/<report UUID>/<upload UUID>, including
// path-style S3 endpoints. Match the shape, never retain a registry of signed URLs.
const privateReportObject = /(?:^|\/)private\/[\da-f-]{36}\/[\da-f-]{36}(?:\/|$)/i;

export function maskReportNetworkRequest(request: CapturedNetworkRequest): CapturedNetworkRequest | undefined {
  try {
    const url = new URL(request.name, 'https://replay-relative.invalid');
    const path = decodeURIComponent(url.pathname);
    if (/(?:^|\/)api\/reports(?:\/|$)/i.test(path) || privateReportObject.test(path)) return undefined;
    // Signed object URLs are credentials, even when the hostname is a custom
    // bucket endpoint or an upload fails before the SDK captures its body.
    for (const key of url.searchParams.keys()) {
      if (/^(?:x-amz-|awsaccesskeyid$|signature$)/i.test(key)) return undefined;
    }
    // Custom callbacks replace PostHog's default payload scrubber. Keep its
    // body/header collection defaults disabled, and strip any already-present
    // payload fields defensively, while preserving unrelated network timings.
    const { requestBody: _requestBody, responseBody: _responseBody,
      requestHeaders: _requestHeaders, responseHeaders: _responseHeaders, ...timing } = request;
    return timing;
  } catch {
    // Malformed network URLs cannot be classified safely; never log their input.
    return undefined;
  }
}

export const reportReplayPrivacy = {
  recordBody: false,
  recordHeaders: false,
  maskCapturedNetworkRequestFn: maskReportNetworkRequest,
} satisfies NonNullable<PostHogConfig['session_recording']>;
