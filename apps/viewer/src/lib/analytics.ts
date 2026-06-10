/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import posthog from 'posthog-js';

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const host = import.meta.env.VITE_POSTHOG_HOST as string | undefined;

if (key && host) {
  posthog.init(key, {
    api_host: host,
    person_profiles: 'always',
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: false,
  });
}

export { posthog };
