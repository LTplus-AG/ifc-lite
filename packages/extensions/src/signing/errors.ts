/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Signing-specific error classes. Each carries enough structured detail
 * for callers (loader, CLI, AI repair loop) to render an actionable
 * message without parsing a generic `Error.message`.
 */

export class SignatureMismatchError extends Error {
  readonly expectedFingerprint?: string;
  readonly actualFingerprint?: string;
  constructor(message: string, info: {
    expectedFingerprint?: string;
    actualFingerprint?: string;
  } = {}) {
    super(message);
    this.name = 'SignatureMismatchError';
    this.expectedFingerprint = info.expectedFingerprint;
    this.actualFingerprint = info.actualFingerprint;
  }
}

export class SignatureFormatError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'SignatureFormatError';
    this.field = field;
  }
}

export class KeyFormatError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'KeyFormatError';
    this.field = field;
  }
}
