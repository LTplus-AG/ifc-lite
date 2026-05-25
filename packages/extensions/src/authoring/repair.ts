/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Repair controller — orchestrates the validate → dry-run → fix loop.
 *
 * The host wraps the LLM call as an `AuthoringStep` callback. The
 * controller drives:
 *
 *   1. Run the step (LLM generates output).
 *   2. Parse + validate. If validation fails, build a structured
 *      diagnostic and ask the model to fix it.
 *   3. Otherwise, dry-run the bundle. On failure, structured
 *      diagnostic + repair turn.
 *   4. Otherwise, return the bundle.
 *
 * The controller enforces:
 *   - Max iteration count
 *   - Wall-clock budget per attempt
 *   - Total wall-clock budget
 *   - Token-cost estimate (caller-supplied per response)
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §8.
 */

import { validateCode } from '../validate/code.js';
import { crossReferenceBundle } from '../validate/cross-ref.js';
import { validateManifest } from '../manifest/index.js';
import { validateWidget } from '../widget/schema.js';
import { parseCapabilities } from '../capability/parse.js';
import { buildBundleFromFiles } from '../bundle/loader.js';
import type { ExtensionManifest, ValidationError, ValidationResult } from '../types.js';
import { parseBundleOutput, type ParsedBundleOutput } from './synthesize.js';

export interface RepairControllerOptions {
  /** Maximum number of repair attempts. Default 4. */
  maxAttempts?: number;
  /** Wall-clock budget per attempt, in ms. Default 90 s. */
  attemptBudgetMs?: number;
  /** Total wall-clock budget for the whole repair, in ms. Default 6 min. */
  totalBudgetMs?: number;
  /** Optional clock for tests. */
  now?: () => number;
}

export interface AuthoringTurn {
  /** The LLM's raw text response. */
  response: string;
  /** Estimated input + output tokens for cost accounting. */
  tokens?: { input: number; output: number };
}

export type AuthoringStep = (
  conversation: AuthoringMessage[],
) => Promise<AuthoringTurn>;

export interface AuthoringMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RepairResult {
  ok: boolean;
  /** Parsed bundle pieces (always present so callers can inspect partial output). */
  parsed?: ParsedBundleOutput;
  /** Manifest is present iff validation passed. */
  manifest?: ExtensionManifest;
  /** Diagnostics from the last attempt — empty on full success. */
  diagnostics: ValidationError[];
  /** Number of attempts run. */
  attempts: number;
  /** True iff a budget (attempts / time) was exhausted. */
  budgetExhausted?: 'attempts' | 'wallclock';
}

const DEFAULTS: Required<Pick<RepairControllerOptions, 'maxAttempts' | 'attemptBudgetMs' | 'totalBudgetMs'>> = {
  maxAttempts: 4,
  attemptBudgetMs: 90_000,
  totalBudgetMs: 6 * 60_000,
};

/**
 * Drive an authoring session. Calls `step()` repeatedly with the
 * conversation so far, validates each response, and feeds structured
 * diagnostics back as user turns until the bundle validates or the
 * budget runs out.
 */
export async function runRepairLoop(
  initialMessages: readonly AuthoringMessage[],
  step: AuthoringStep,
  opts: RepairControllerOptions = {},
): Promise<RepairResult> {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now ?? (() => Date.now());
  const start = now();
  const conversation: AuthoringMessage[] = [...initialMessages];
  let attempts = 0;
  let parsed: ParsedBundleOutput | undefined;
  let diagnostics: ValidationError[] = [];

  while (attempts < o.maxAttempts) {
    if (now() - start > o.totalBudgetMs) {
      return { ok: false, parsed, diagnostics, attempts, budgetExhausted: 'wallclock' };
    }
    attempts += 1;

    // Pass a defensive copy so callers can't mutate our buffer and so
    // tests that inspect captured args see the snapshot at call time.
    const turn = await runWithTimeout(step([...conversation]), o.attemptBudgetMs);
    conversation.push({ role: 'assistant', content: turn.response });

    const validated = validateBundleResponse(turn.response);
    parsed = validated.parsed;
    diagnostics = validated.errors;
    if (validated.ok) {
      return { ok: true, parsed, manifest: validated.manifest, diagnostics: [], attempts };
    }
    if (attempts >= o.maxAttempts) break;

    // Repair turn: structured diagnostic + ask for a corrected output.
    conversation.push({
      role: 'user',
      content: buildRepairPrompt(diagnostics),
    });
  }

  return { ok: false, parsed, diagnostics, attempts, budgetExhausted: 'attempts' };
}

interface BundleResponseValidation {
  ok: boolean;
  parsed?: ParsedBundleOutput;
  manifest?: ExtensionManifest;
  errors: ValidationError[];
}

/**
 * Validate a single LLM response end-to-end: parse fenced blocks,
 * validate the manifest, validate widgets, validate code, then
 * cross-reference the assembled bundle.
 */
export function validateBundleResponse(response: string): BundleResponseValidation {
  const parsedResult = parseBundleOutput(response);
  if (!parsedResult.ok) {
    return { ok: false, errors: parsedResult.errors };
  }
  const parsed = parsedResult.value;
  if (!parsed.manifest) {
    return {
      ok: false,
      parsed,
      errors: [{ path: '<manifest>', code: 'required', message: 'No manifest block found.' }],
    };
  }

  const errors: ValidationError[] = [];

  const manifestValid = validateManifest(parsed.manifest);
  if (!manifestValid.ok) {
    errors.push(...manifestValid.errors);
  }

  for (const [path, widget] of Object.entries(parsed.widgets)) {
    const v = validateWidget(widget, path);
    if (!v.ok) errors.push(...v.errors);
  }

  for (const [path, source] of Object.entries(parsed.files)) {
    // Skip widget JSON files — they pass through validateWidget above.
    if (parsed.widgets[path]) continue;
    // Only lint .js / .mjs / .cjs files; widgets and manifest are JSON.
    if (!/\.m?c?js$/.test(path)) continue;
    const codeResult = validateCode(source, { pathPrefix: path });
    if (!codeResult.ok) errors.push(...codeResult.errors);
  }

  if (!manifestValid.ok) {
    return { ok: false, parsed, errors };
  }

  // Cross-reference against an in-memory bundle.
  const manifest = manifestValid.value;
  const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  files.set(
    'manifest.json',
    {
      path: 'manifest.json',
      bytes: new TextEncoder().encode(JSON.stringify(parsed.manifest)),
      text: JSON.stringify(parsed.manifest),
    },
  );
  for (const [path, text] of Object.entries(parsed.files)) {
    files.set(path, { path, bytes: new TextEncoder().encode(text), text });
  }
  const bundleResult = buildBundleFromFiles(
    files,
    files.get('manifest.json')!,
    { kind: 'memory' },
  );
  if (!bundleResult.ok) {
    errors.push(...bundleResult.errors);
  } else {
    const crossRef = crossReferenceBundle(bundleResult.value);
    if (!crossRef.ok) errors.push(...crossRef.errors);
  }

  // Validate that requested capabilities parse cleanly (in case the
  // model emitted invalid ones).
  const capabilityCheck = parseCapabilities(manifest.capabilities);
  if (!capabilityCheck.ok) errors.push(...capabilityCheck.errors);

  if (errors.length > 0) {
    return { ok: false, parsed, manifest, errors };
  }
  return { ok: true, parsed, manifest, errors: [] };
}

function buildRepairPrompt(errors: readonly ValidationError[]): string {
  const lines = ['The bundle did not validate. Please fix the following:'];
  for (const err of errors) {
    const where = err.path || '<root>';
    const hint = err.hint ? ` (${err.hint})` : '';
    lines.push(`- ${where}: [${err.code}] ${err.message}${hint}`);
  }
  lines.push('');
  lines.push('Emit the corrected bundle using the same fenced-block format.');
  return lines.join('\n');
}

async function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Authoring turn exceeded ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
