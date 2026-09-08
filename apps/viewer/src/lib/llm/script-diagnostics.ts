/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type ScriptDiagnosticSeverity = 'error' | 'warning';
export type ScriptDiagnosticSource = 'preflight' | 'runtime' | 'patch';
export type RepairScope = 'local' | 'block' | 'structural' | 'full_rewrite';

export type PreflightDiagnosticCode =
  | 'unknown_namespace'
  | 'unknown_method'
  | 'create_contract'
  | 'bare_identifier'
  | 'wall_hosted_opening_pattern'
  | 'metadata_query_pattern'
  | 'storey_elevation_double_applied'
  | 'detached_snippet_scope';

export type RuntimeDiagnosticCode =
  | 'generic_placement_contract'
  | 'plate_contract_mismatch'
  | 'storey_elevation_double_applied'
  | 'detached_snippet_scope'
  | 'wall_hosted_opening_alignment';

export type PatchDiagnosticCode =
  | 'patch_revision_conflict'
  | 'patch_range_error'
  | 'patch_semantic_error'
  | 'unsafe_full_replacement'
  | 'destructive_partial_rewrite';

export interface ScriptDiagnosticRange {
  from: number;
  to: number;
}

export interface ScriptDiagnosticEvidence {
  source?: ScriptDiagnosticSource;
  code?: string;
  message?: string;
  methodName?: string;
  symbol?: string;
  failureKind?: string;
  range?: ScriptDiagnosticRange;
  line?: number;
  column?: number;
  snippet?: string;
}

export interface ScriptDiagnosticBase<TSource extends ScriptDiagnosticSource, TCode extends string> {
  source: TSource;
  code: TCode;
  severity: ScriptDiagnosticSeverity;
  message: string;
  rootCauseKey: string;
  repairScope: RepairScope;
  evidence?: ScriptDiagnosticEvidence[];
  data?: Record<string, unknown>;
}

export type PreflightScriptDiagnostic = ScriptDiagnosticBase<'preflight', PreflightDiagnosticCode>;
export type RuntimeScriptDiagnostic = ScriptDiagnosticBase<'runtime', RuntimeDiagnosticCode>;
export type PatchScriptDiagnostic = ScriptDiagnosticBase<'patch', PatchDiagnosticCode>;

export type ScriptDiagnostic =
  | PreflightScriptDiagnostic
  | RuntimeScriptDiagnostic
  | PatchScriptDiagnostic;

export interface RootCauseDiagnosticGroup {
  rootCauseKey: string;
  repairScope: RepairScope;
  summary: string;
  diagnostics: ScriptDiagnostic[];
  evidence: ScriptDiagnosticEvidence[];
}

export function createPreflightDiagnostic(
  code: PreflightDiagnosticCode,
  message: string,
  severity: ScriptDiagnosticSeverity = 'error',
  data?: Record<string, unknown>,
): PreflightScriptDiagnostic {
  return createDiagnosticBase('preflight', code, message, severity, data);
}

export function createRuntimeDiagnostic(
  code: RuntimeDiagnosticCode,
  message: string,
  severity: ScriptDiagnosticSeverity = 'error',
  data?: Record<string, unknown>,
): RuntimeScriptDiagnostic {
  return createDiagnosticBase('runtime', code, message, severity, data);
}

export function createPatchDiagnostic(
  code: PatchDiagnosticCode,
  message: string,
  severity: ScriptDiagnosticSeverity = 'error',
  data?: Record<string, unknown>,
): PatchScriptDiagnostic {
  return createDiagnosticBase('patch', code, message, severity, data);
}

export function formatDiagnosticsForDisplay(diagnostics: ScriptDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.message);
}

export function formatDiagnosticsForPrompt(diagnostics: ScriptDiagnostic[]): string {
  if (diagnostics.length === 0) return '';
  const groups = groupDiagnosticsByRootCause(diagnostics);
  const rootCauseLines = groups.flatMap((group) => {
    const lines = [`- [root-cause:${group.rootCauseKey}] ${group.summary} (scope=${group.repairScope})`];
    for (const evidence of group.evidence.slice(0, 4)) {
      lines.push(`  supporting evidence: ${formatEvidence(evidence)}`);
    }
    return lines;
  });
  const rawLines = diagnostics.map((diagnostic) => {
    const details = formatDiagnosticDetails(diagnostic.data);
    const hint = typeof diagnostic.data?.fixHint === 'string' ? ` Hint: ${diagnostic.data.fixHint}` : '';
    return `- [${diagnostic.source}:${diagnostic.code}] ${diagnostic.message} (rootCause=${diagnostic.rootCauseKey}, scope=${diagnostic.repairScope})${details}${hint}`;
  });

  return [
    'Root causes:',
    ...rootCauseLines,
    'Raw diagnostics:',
    ...rawLines,
  ].join('\n');
}

export function groupDiagnosticsByRootCause(diagnostics: ScriptDiagnostic[]): RootCauseDiagnosticGroup[] {
  const groups = new Map<string, RootCauseDiagnosticGroup>();

  for (const diagnostic of diagnostics) {
    const key = diagnostic.rootCauseKey;
    const existing = groups.get(key);
    const evidence = dedupeEvidence(collectDiagnosticEvidence(diagnostic));
    if (!existing) {
      groups.set(key, {
        rootCauseKey: key,
        repairScope: diagnostic.repairScope,
        summary: summarizeRootCause(key, diagnostic),
        diagnostics: [diagnostic],
        evidence,
      });
      continue;
    }

    existing.diagnostics.push(diagnostic);
    existing.repairScope = widenRepairScope(existing.repairScope, diagnostic.repairScope);
    existing.evidence = dedupeEvidence([...existing.evidence, ...evidence]);
  }

  return [...groups.values()].sort((left, right) => compareRepairScope(right.repairScope, left.repairScope));
}

export function getPrimaryRootCause(diagnostics: ScriptDiagnostic[]): RootCauseDiagnosticGroup | null {
  return groupDiagnosticsByRootCause(diagnostics)[0] ?? null;
}

function formatDiagnosticDetails(data?: Record<string, unknown>): string {
  if (!data) return '';

  const details: string[] = [];
  const opId = asString(data.opId);
  const methodName = asString(data.methodName);
  const symbol = asString(data.symbol);
  const failureKind = asString(data.failureKind);
  const snippet = asString(data.snippet);
  const range = formatRange(data.range);
  const selection = formatRange(data.selection);
  const currentEditorRevision = asNumber(data.currentEditorRevision);
  const expectedBaseRevision = asNumber(data.expectedBaseRevision);
  const line = asNumber(data.line);
  const column = asNumber(data.column);

  if (opId) details.push(`op=${opId}`);
  if (methodName) details.push(`method=${methodName}`);
  if (symbol) details.push(`symbol=${symbol}`);
  if (failureKind) details.push(`failure=${failureKind}`);
  if (line !== null) details.push(`line=${line}`);
  if (column !== null) details.push(`column=${column}`);
  if (range) details.push(`range=${range}`);
  if (selection) details.push(`selection=${selection}`);
  if (expectedBaseRevision !== null) details.push(`expectedRevision=${expectedBaseRevision}`);
  if (currentEditorRevision !== null) details.push(`currentRevision=${currentEditorRevision}`);
  if (snippet) details.push(`snippet=${JSON.stringify(truncateSnippet(snippet))}`);

  return details.length > 0 ? ` (${details.join(', ')})` : '';
}

function formatRange(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const from = asNumber((value as Record<string, unknown>).from);
  const to = asNumber((value as Record<string, unknown>).to);
  if (from === null || to === null) return null;
  return `${from}..${to}`;
}

function formatEvidence(evidence: ScriptDiagnosticEvidence): string {
  const parts: string[] = [];
  if (evidence.code) parts.push(`${evidence.source ?? 'diagnostic'}:${evidence.code}`);
  if (evidence.methodName) parts.push(`method=${evidence.methodName}`);
  if (evidence.symbol) parts.push(`symbol=${evidence.symbol}`);
  if (evidence.failureKind) parts.push(`failure=${evidence.failureKind}`);
  const range = formatRange(evidence.range);
  if (range) parts.push(`range=${range}`);
  if (typeof evidence.line === 'number') parts.push(`line=${evidence.line}`);
  if (typeof evidence.column === 'number') parts.push(`column=${evidence.column}`);
  if (evidence.snippet) parts.push(`snippet=${JSON.stringify(truncateSnippet(evidence.snippet))}`);
  if (evidence.message) parts.push(evidence.message);
  return parts.join(', ');
}

function createDiagnosticBase<TSource extends ScriptDiagnosticSource, TCode extends string>(
  source: TSource,
  code: TCode,
  message: string,
  severity: ScriptDiagnosticSeverity,
  data?: Record<string, unknown>,
): ScriptDiagnosticBase<TSource, TCode> {
  const rootCauseKey = asString(data?.rootCauseKey) ?? defaultRootCauseKey(source, code);
  const repairScope = asRepairScope(data?.repairScope) ?? defaultRepairScope(rootCauseKey, code);
  const evidence = dedupeEvidence(buildEvidenceFromData(source, code, message, data));

  return {
    source,
    code,
    severity,
    message,
    rootCauseKey,
    repairScope,
    evidence: evidence.length > 0 ? evidence : undefined,
    data,
  };
}

function buildEvidenceFromData(
  source: ScriptDiagnosticSource,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): ScriptDiagnosticEvidence[] {
  const explicit = Array.isArray(data?.evidence)
    ? (data.evidence as unknown[]).map(asEvidence).filter((value): value is ScriptDiagnosticEvidence => Boolean(value))
    : [];
  if (explicit.length > 0) return explicit;

  const methodName = asString(data?.methodName);
  const symbol = asString(data?.symbol);
  const failureKind = asString(data?.failureKind);
  const snippet = asString(data?.snippet);
  const range = asRange(data?.range);
  const line = asNumber(data?.line);
  const column = asNumber(data?.column);
  if (!methodName && !symbol && !failureKind && !snippet && !range && line === null && column === null) {
    return [];
  }

  return [{
    source,
    code,
    message,
    methodName: methodName ?? undefined,
    symbol: symbol ?? undefined,
    failureKind: failureKind ?? undefined,
    snippet: snippet ?? undefined,
    range: range ?? undefined,
    line: line ?? undefined,
    column: column ?? undefined,
  }];
}

function collectDiagnosticEvidence(diagnostic: ScriptDiagnostic): ScriptDiagnosticEvidence[] {
  return diagnostic.evidence ?? [];
}

function summarizeRootCause(rootCauseKey: string, diagnostic: ScriptDiagnostic): string {
  switch (rootCauseKey) {
    case 'api_contract_mismatch':
      return 'The failing code does not match the exact BIM API contract and should be repaired by correcting the payload shape or required keys.';
    case 'placement_context_mismatch':
      return 'The script is mixing placement or host-context assumptions, so related geometry calls should be repaired together instead of as isolated lines.';
    case 'detached_fragment_rewrite':
      return 'The proposed or current script fragment depends on missing surrounding declarations, so the repair should preserve and reconnect the broader script context.';
    case 'creator_lifecycle_violation':
      return 'The script uses a creator or project lifecycle in an invalid order, so the repair must fix the broader creation/finalization flow.';
    case 'structural_script_corruption':
      return 'The repair payload would corrupt, truncate, or replace too much of the script, so context-preserving structural repair is required.';
    case 'stale_patch_target':
      return 'The repair patch no longer matches the current script snapshot, so it must be regenerated against the latest revision and exact text.';
    case 'malformed_repair_reply':
      return 'The repair reply format is invalid or ambiguous, so the next repair turn should reissue a clean patch-only response.';
    case 'unknown_api_reference':
      return 'The script references an unknown BIM namespace or method and should be corrected to match the supported API surface.';
    case 'metadata_access_pattern':
      return 'The script is using a brittle metadata access pattern and should switch to dedicated IFC query helpers.';
    default:
      return diagnostic.message;
  }
}

function defaultRootCauseKey(source: ScriptDiagnosticSource, code: string): string {
  switch (code) {
    case 'unknown_namespace':
    case 'unknown_method':
      return 'unknown_api_reference';
    case 'create_contract':
    case 'bare_identifier':
    case 'generic_placement_contract':
    case 'plate_contract_mismatch':
      return 'api_contract_mismatch';
    case 'wall_hosted_opening_pattern':
    case 'storey_elevation_double_applied':
    case 'wall_hosted_opening_alignment':
      return 'placement_context_mismatch';
    case 'detached_snippet_scope':
      return 'detached_fragment_rewrite';
    case 'metadata_query_pattern':
      return 'metadata_access_pattern';
    case 'patch_revision_conflict':
    case 'patch_range_error':
      return 'stale_patch_target';
    case 'patch_semantic_error':
      return source === 'patch' ? 'malformed_repair_reply' : 'api_contract_mismatch';
    case 'unsafe_full_replacement':
    case 'destructive_partial_rewrite':
      return 'structural_script_corruption';
    default:
      return code;
  }
}

function defaultRepairScope(rootCauseKey: string, code: string): RepairScope {
  switch (rootCauseKey) {
    case 'stale_patch_target':
    case 'malformed_repair_reply':
    case 'structural_script_corruption':
    case 'detached_fragment_rewrite':
    case 'creator_lifecycle_violation':
      return 'structural';
    case 'placement_context_mismatch':
      return 'block';
    case 'api_contract_mismatch':
    case 'unknown_api_reference':
    case 'metadata_access_pattern':
      return code === 'bare_identifier' ? 'block' : 'local';
    default:
      return 'local';
  }
}

function widenRepairScope(left: RepairScope, right: RepairScope): RepairScope {
  return compareRepairScope(left, right) >= 0 ? left : right;
}

function compareRepairScope(left: RepairScope, right: RepairScope): number {
  return repairScopeRank(left) - repairScopeRank(right);
}

function repairScopeRank(scope: RepairScope): number {
  switch (scope) {
    case 'local':
      return 0;
    case 'block':
      return 1;
    case 'structural':
      return 2;
    case 'full_rewrite':
      return 3;
  }
}

function dedupeEvidence(evidence: ScriptDiagnosticEvidence[]): ScriptDiagnosticEvidence[] {
  const seen = new Set<string>();
  const result: ScriptDiagnosticEvidence[] = [];
  for (const item of evidence) {
    const key = [
      item.source ?? '',
      item.code ?? '',
      item.methodName ?? '',
      item.symbol ?? '',
      item.failureKind ?? '',
      item.range?.from ?? '',
      item.range?.to ?? '',
      item.snippet ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function asRange(value: unknown): ScriptDiagnosticRange | null {
  if (!value || typeof value !== 'object') return null;
  const from = asNumber((value as Record<string, unknown>).from);
  const to = asNumber((value as Record<string, unknown>).to);
  if (from === null || to === null) return null;
  return { from, to };
}

function asEvidence(value: unknown): ScriptDiagnosticEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    source: asDiagnosticSource(record.source) ?? undefined,
    code: asString(record.code) ?? undefined,
    message: asString(record.message) ?? undefined,
    methodName: asString(record.methodName) ?? undefined,
    symbol: asString(record.symbol) ?? undefined,
    failureKind: asString(record.failureKind) ?? undefined,
    range: asRange(record.range) ?? undefined,
    line: asNumber(record.line) ?? undefined,
    column: asNumber(record.column) ?? undefined,
    snippet: asString(record.snippet) ?? undefined,
  };
}

function asDiagnosticSource(value: unknown): ScriptDiagnosticSource | null {
  return value === 'preflight' || value === 'runtime' || value === 'patch'
    ? value
    : null;
}

function asRepairScope(value: unknown): RepairScope | null {
  return value === 'local' || value === 'block' || value === 'structural' || value === 'full_rewrite'
    ? value
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncateSnippet(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
