/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capability grammar parser.
 *
 *   capability  := scope "." action [ ":" target ]
 *   scope       := "model" | "viewer" | "export" | "storage"
 *                | "network" | "command" | "ui"
 *   action      := identifier
 *   target      := pattern | "*"
 *   pattern     := segment ( "." segment )*
 *   segment     := identifier | identifier "*" | "*"
 *
 * Identifiers are `[A-Za-z_][A-Za-z0-9_-]*`. Segments support a single
 * trailing `*` (glob within a segment) or a bare `*` (matches any segment).
 *
 * Spec: docs/architecture/ai-customization/02-security.md §3.
 */

import type {
  Capability,
  CapabilityScope,
  CapabilityTarget,
  CapabilityTargetSegment,
  ValidationResult,
} from '../types.js';

const VALID_SCOPES: ReadonlySet<CapabilityScope> = new Set([
  'model',
  'viewer',
  'export',
  'storage',
  'network',
  'command',
  'ui',
]);

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SEGMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]*\*?|\*)$/;

/**
 * Parse a capability string. Returns `{ ok: true, value }` on success or
 * `{ ok: false, errors }` with at least one structured error.
 */
export function parseCapability(raw: string): ValidationResult<Capability> {
  if (typeof raw !== 'string') {
    return fail('', 'type_mismatch', 'Capability must be a string.');
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fail('', 'invalid_capability', 'Capability string is empty.');
  }
  if (trimmed !== raw) {
    return fail(
      '',
      'invalid_capability',
      'Capability has leading or trailing whitespace.',
      'Remove surrounding whitespace.',
    );
  }

  // Split scope.action[:target]
  const colonIdx = raw.indexOf(':');
  const head = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
  const tail = colonIdx === -1 ? undefined : raw.slice(colonIdx + 1);

  if (colonIdx !== -1 && tail === '') {
    return fail(
      '',
      'invalid_capability',
      `Capability "${raw}" has a colon but no target.`,
      'Either remove the colon or supply a target pattern (e.g. ":*").',
    );
  }

  const dotIdx = head.indexOf('.');
  if (dotIdx === -1) {
    return fail(
      '',
      'invalid_capability',
      `Capability "${raw}" is missing the action — expected "scope.action".`,
      'Example: "model.read", "network.fetch:example.com".',
    );
  }

  const scopeRaw = head.slice(0, dotIdx);
  const action = head.slice(dotIdx + 1);

  if (!isCapabilityScope(scopeRaw)) {
    return fail(
      '',
      'invalid_capability',
      `Unknown capability scope "${scopeRaw}".`,
      `Allowed scopes: ${Array.from(VALID_SCOPES).join(', ')}.`,
    );
  }

  if (!IDENTIFIER_RE.test(action)) {
    return fail(
      '',
      'invalid_capability',
      `Invalid action "${action}" in capability "${raw}".`,
      'Actions must match [A-Za-z_][A-Za-z0-9_-]*.',
    );
  }

  let target: CapabilityTarget | undefined;
  if (tail !== undefined) {
    const parsedTarget = parseTarget(tail);
    if (!parsedTarget.ok) {
      // Map nested error to the capability path.
      return {
        ok: false,
        errors: parsedTarget.errors.map((e) => ({
          ...e,
          message: `Capability "${raw}": ${e.message}`,
        })),
      };
    }
    target = parsedTarget.value;
  }

  return {
    ok: true,
    value: {
      raw,
      scope: scopeRaw,
      action,
      target,
    },
  };
}

function parseTarget(raw: string): ValidationResult<CapabilityTarget> {
  if (raw === '*') {
    return {
      ok: true,
      value: {
        raw,
        segments: [{ kind: 'glob' }],
        isUniversalWildcard: true,
      },
    };
  }

  const parts = raw.split('.');
  const segments: CapabilityTargetSegment[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg.length === 0) {
      return fail(
        '',
        'invalid_capability',
        `Target "${raw}" contains an empty segment.`,
        'Targets must not contain consecutive dots or leading/trailing dots.',
      );
    }
    if (!SEGMENT_RE.test(seg)) {
      return fail(
        '',
        'invalid_capability',
        `Invalid target segment "${seg}".`,
        'Segments must be identifiers, may end with "*" (single-segment glob), or be "*" alone.',
      );
    }
    if (seg === '*') {
      segments.push({ kind: 'glob' });
    } else {
      // A trailing-`*` segment stays a literal here — the `*` is kept
      // in `value` and the glob-suffix prefix match is applied by
      // `matchSegment` in match.ts.
      segments.push({ kind: 'literal', value: seg });
    }
  }

  return {
    ok: true,
    value: {
      raw,
      segments,
      isUniversalWildcard: false,
    },
  };
}

export function isCapabilityScope(value: unknown): value is CapabilityScope {
  return typeof value === 'string' && VALID_SCOPES.has(value as CapabilityScope);
}

function fail(
  path: string,
  code: import('../types.js').ValidationErrorCode,
  message: string,
  hint?: string,
): ValidationResult<never> {
  return {
    ok: false,
    errors: [{ path, code, message, hint }],
  };
}

/**
 * Parse a list of capability strings. Returns either all-ok with parsed
 * capabilities, or all errors aggregated with an indexed path
 * (e.g. `[3]` for the fourth capability).
 */
export function parseCapabilities(raws: readonly string[]): ValidationResult<Capability[]> {
  const errors: import('../types.js').ValidationError[] = [];
  const values: Capability[] = [];
  for (let i = 0; i < raws.length; i += 1) {
    const result = parseCapability(raws[i]);
    if (result.ok) {
      values.push(result.value);
    } else {
      for (const err of result.errors) {
        errors.push({ ...err, path: `[${i}]${err.path}` });
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: values };
}
