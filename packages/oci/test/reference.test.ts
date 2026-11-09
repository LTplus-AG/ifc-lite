/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { OciError, parseReference, type OciReference } from '../src/index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('parseReference: valid references', () => {
  const cases: Array<[string, OciReference, { insecureHosts?: string[] }?]> = [
    ['ghcr.io/acme/model:v1', { registry: 'ghcr.io', origin: 'https://ghcr.io', repository: 'acme/model', tag: 'v1' }],
    ['oci://ghcr.io/acme/model:v1', { registry: 'ghcr.io', origin: 'https://ghcr.io', repository: 'acme/model', tag: 'v1' }],
    ['ghcr.io/acme/model', { registry: 'ghcr.io', origin: 'https://ghcr.io', repository: 'acme/model' }],
    [`ghcr.io/acme/model@${DIGEST}`, { registry: 'ghcr.io', origin: 'https://ghcr.io', repository: 'acme/model', digest: DIGEST }],
    [
      `ghcr.io/acme/model:v1@${DIGEST}`,
      { registry: 'ghcr.io', origin: 'https://ghcr.io', repository: 'acme/model', tag: 'v1', digest: DIGEST },
    ],
    // The port belongs to the host (first segment); the tag to the last segment.
    [
      'registry.example.com:5000/a/b/c:5000',
      { registry: 'registry.example.com:5000', origin: 'https://registry.example.com:5000', repository: 'a/b/c', tag: '5000' },
    ],
    ['localhost/model:latest', { registry: 'localhost', origin: 'https://localhost', repository: 'model', tag: 'latest' }],
    [
      'localhost:5000/model:latest',
      { registry: 'localhost:5000', origin: 'http://localhost:5000', repository: 'model', tag: 'latest' },
      { insecureHosts: ['localhost'] },
    ],
    [
      '127.0.0.1:5000/model',
      { registry: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000', repository: 'model' },
      { insecureHosts: ['127.0.0.1:5000'] },
    ],
    // A port-specific insecure entry does not cover another port.
    ['127.0.0.1:6000/model', { registry: '127.0.0.1:6000', origin: 'https://127.0.0.1:6000', repository: 'model' }, { insecureHosts: ['127.0.0.1:5000'] }],
    ['[::1]:5000/model', { registry: '[::1]:5000', origin: 'https://[::1]:5000', repository: 'model' }],
    ['GHCR.IO/acme/model', { registry: 'ghcr.io', origin: 'https://ghcr.io', repository: 'acme/model' }],
    ['ghcr.io/a.b_c__d--e/f-g:V1.0_rc-1', { registry: 'ghcr.io', origin: 'https://ghcr.io', repository: 'a.b_c__d--e/f-g', tag: 'V1.0_rc-1' }],
  ];
  it.each(cases)('%s', (input, expected, options) => {
    expect(parseReference(input, options)).toEqual(expected);
  });
});

describe('parseReference: invalid references', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /empty/],
    ['oci://', /empty/],
    ['library/alpine', /not a registry host/],
    ['alpine:3', /expected host\/repository/],
    ['https://ghcr.io/acme/model', /only the oci:\/\/ prefix/],
    ['user:pass@ghcr.io/acme/model', /userinfo/],
    ['user@ghcr.io/acme/model', /userinfo/],
    ['ghcr.io/', /missing repository/],
    ['ghcr.io//model', /empty path segment/],
    ['ghcr.io/acme//model', /empty path segment/],
    ['ghcr.io/acme/model/', /empty path segment/],
    ['ghcr.io/acme/../model', /relative path segment/],
    ['ghcr.io/Acme/model', /lowercase/],
    ['ghcr.io/acme/-model', /not a valid repository path component/],
    ['ghcr.io:tag/acme/model', /not a valid port/],
    ['ghcr.io:99999/acme/model', /not a valid port/],
    ['ghcr.io/acme/model:', /not a valid tag/],
    ['ghcr.io/acme/model:-bad', /not a valid tag/],
    [`ghcr.io/acme/model:${'t'.repeat(129)}`, /not a valid tag/],
    ['ghcr.io/acme/model:a:b', /not a valid tag/],
    [`ghcr.io/acme/model@sha512:${'a'.repeat(128)}`, /only sha256/],
    [`ghcr.io/acme/model@sha256:${'a'.repeat(63)}`, /64 lowercase hex/],
    [`ghcr.io/acme/model@sha256:${'A'.repeat(64)}`, /64 lowercase hex/],
    [`ghcr.io/acme/model@${DIGEST}@${DIGEST}`, /64 lowercase hex/],
    ['ghcr.io/acme/model name', /whitespace/],
    ['ghcr.io/acme/model?x=1', /URL syntax/],
    ['bad_host.io/acme/model', /not a valid registry host/],
    [`ghcr.io/${'a/'.repeat(128)}b`, /longer than 255/],
  ];
  it.each(cases)('%j', (input, message) => {
    let caught: unknown;
    try {
      parseReference(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OciError);
    expect((caught as OciError).code).toBe('INVALID_REFERENCE');
    expect((caught as OciError).message).toMatch(message);
  });
});
