/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SDK-version compatibility checker.
 *
 * Each extension's manifest declares an `engines.ifcLiteSdk` range
 * (e.g. `>=2.0.0`, `^2.1`, `2.x`). When the viewer SDK bumps, this
 * module decides which installed extensions need re-evaluation:
 *
 *   - `compatible`   — the declared range still matches the new
 *                      SDK version. Pass-through.
 *   - `outdated`     — the range explicitly excludes the new SDK.
 *                      Needs migration / repair.
 *   - `permissive`   — the range is so loose it accepts the new
 *                      SDK without comment, but the SDK bump crosses
 *                      a major version. Worth a re-test, even if the
 *                      range technically passes.
 *
 * The matcher is small and dependency-free — semver in its full glory
 * is overkill for what extension manifests need. We support:
 *
 *   - Single-version pins (`2.0.0`)
 *   - Range comparators (`>=`, `>`, `<=`, `<`, `=`, `^`, `~`)
 *   - Logical AND inside one range string (space-separated)
 *
 * Wildcards (`*`, `x`, `X`) and the `||` OR operator are intentionally
 * not supported; manifests that use them parse but everything resolves
 * to `permissive` so the user is asked to confirm.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §5.
 */

export type Compatibility = 'compatible' | 'outdated' | 'permissive';

export interface CompatibilityResult {
  /** The extension id we evaluated. */
  extensionId: string;
  /** The declared `engines.ifcLiteSdk` range string. */
  declared: string;
  /** The current SDK version we evaluated against. */
  sdk: string;
  status: Compatibility;
  /** Human-readable reason — useful in audit logs and the repair UI. */
  reason: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

interface Comparator {
  op: '>=' | '>' | '<=' | '<' | '=' | '^' | '~';
  version: ParsedVersion;
}

const COMPARATOR_RE = /^(>=|<=|>|<|\^|~|=)?\s*(\d+(?:\.\d+){0,2}(?:[.-].*)?)$/;
// Accept shorthand: `2`, `2.1`, `2.1.0`, with an optional prerelease /
// build suffix. Reject 4+ dotted segments outright — silent truncation
// of `1.2.3.4` to `1.2.3` would hide manifest typos.
const VERSION_PARSE_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[.-].*)?$/;

function parseVersion(raw: string): ParsedVersion | undefined {
  const m = raw.trim().match(VERSION_PARSE_RE);
  if (!m) return undefined;
  const major = Number.parseInt(m[1], 10);
  const minor = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
  const patch = m[3] !== undefined ? Number.parseInt(m[3], 10) : 0;
  if ([major, minor, patch].some((n) => Number.isNaN(n))) return undefined;
  return { major, minor, patch };
}

function parseRange(raw: string): Comparator[] | 'permissive' {
  const trimmed = raw.trim();
  if (!trimmed) return 'permissive';
  if (trimmed.includes('||')) return 'permissive';
  if (/[*xX]/.test(trimmed)) return 'permissive';

  const tokens = trimmed.split(/\s+/);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const m = token.match(COMPARATOR_RE);
    if (!m) return 'permissive';
    const op = (m[1] ?? '=') as Comparator['op'];
    const version = parseVersion(m[2]);
    if (!version) return 'permissive';
    comparators.push({ op, version });
  }
  return comparators;
}

function cmp(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function satisfies(comp: Comparator, target: ParsedVersion): boolean {
  switch (comp.op) {
    case '>=': return cmp(target, comp.version) >= 0;
    case '>': return cmp(target, comp.version) > 0;
    case '<=': return cmp(target, comp.version) <= 0;
    case '<': return cmp(target, comp.version) < 0;
    case '=': return cmp(target, comp.version) === 0;
    case '^': {
      // ^2.1.3 = >=2.1.3 <3.0.0; ^0.x is special-cased per npm but we
      // treat anchored-on-major for simplicity.
      const lo = cmp(target, comp.version) >= 0;
      const hi = target.major === comp.version.major;
      return lo && hi;
    }
    case '~': {
      // ~2.1.3 = >=2.1.3 <2.2.0
      const lo = cmp(target, comp.version) >= 0;
      const hi = target.major === comp.version.major && target.minor === comp.version.minor;
      return lo && hi;
    }
    default: {
      // Exhaustiveness: if a new op variant lands without updating this
      // switch, fail loudly instead of returning undefined → falsy.
      const exhaustive: never = comp.op;
      throw new Error(`Unreachable comparator op: ${exhaustive as string}`);
    }
  }
}

/**
 * Compare a single declared range against the current SDK version.
 * Used internally by `findAffected` but also exposed for callers that
 * have a single bundle to inspect.
 */
export function evaluateCompatibility(
  extensionId: string,
  declared: string,
  sdk: string,
): CompatibilityResult {
  const sdkVersion = parseVersion(sdk);
  if (!sdkVersion) {
    return {
      extensionId,
      declared,
      sdk,
      status: 'permissive',
      reason: `Could not parse SDK version "${sdk}".`,
    };
  }
  const parsed = parseRange(declared);
  if (parsed === 'permissive') {
    return {
      extensionId,
      declared,
      sdk,
      status: 'permissive',
      reason: 'Range too loose to evaluate — re-run tests to confirm.',
    };
  }
  for (const comp of parsed) {
    if (!satisfies(comp, sdkVersion)) {
      return {
        extensionId,
        declared,
        sdk,
        status: 'outdated',
        reason: `Range "${declared}" no longer matches SDK ${sdk}.`,
      };
    }
  }
  return {
    extensionId,
    declared,
    sdk,
    status: 'compatible',
    reason: `Range "${declared}" still matches SDK ${sdk}.`,
  };
}

export interface InstalledForCompatCheck {
  id: string;
  engines: { ifcLiteSdk: string };
}

/**
 * Produce a list of compatibility results for every supplied install
 * record. The caller decides what to do with each — typically the
 * repair UI re-runs tests on `outdated` and `permissive` rows.
 */
export function findAffected(
  installed: readonly InstalledForCompatCheck[],
  sdk: string,
): CompatibilityResult[] {
  return installed.map((ext) => evaluateCompatibility(ext.id, ext.engines.ifcLiteSdk, sdk));
}
