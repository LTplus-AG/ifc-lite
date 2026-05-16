/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authoring contract prompt builder.
 *
 * The AI authoring path inserts a long, cache-friendly "contract"
 * section into the system prompt before the user's request. The
 * contract spells out:
 *
 *   - The manifest schema (compact form)
 *   - The widget DSL node catalogue
 *   - The capability catalogue with risk tiers
 *   - The style rules (the §11 "authoring contract" from RFC 04)
 *
 * Cacheable: this entire fragment is stable across an authoring
 * session, so Anthropic prompt caching gives us a large hit rate.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §5/§11.
 */

import { listCapabilityCatalogue } from '../capability/catalogue.js';

/**
 * Build the full authoring contract. Returns a single string ready to
 * be appended to the host's existing system prompt (or used as a
 * separate cached message segment).
 *
 * Hot-path optimisation: the result is deterministic for a given SDK
 * version, so callers should memoise or send it through prompt
 * caching rather than rebuilding per turn.
 */
export function buildAuthoringContract(): string {
  return [
    AUTHORING_PREAMBLE,
    buildManifestSchema(),
    buildWidgetDsl(),
    buildCapabilityCatalogue(),
    buildStyleRules(),
  ].join('\n\n');
}

const AUTHORING_PREAMBLE = `## AUTHORING CONTRACT

You are now authoring an IFClite extension — a persistent, sandboxed
piece of software the user can install, enable, disable, and uninstall.
This is different from the one-shot script flow: every bundle you
produce ships with a manifest, declared capabilities, optional UI
widgets, optional tests, and (typically) a small JS module per entry
point.

Output ONE plan first, get user approval, THEN output the bundle.

The plan is a JSON object matching the AuthoringPlan schema. The
bundle is a JSON object with the following keys:

\`\`\`
{
  "manifest": <ExtensionManifest>,
  "files": {
    "src/activate.js": "...",
    "src/commands/<id>.js": "...",
    "widgets/<name>.json": <Widget JSON>
  },
  "tests": [...]
}
\`\`\``;

function buildManifestSchema(): string {
  return `### MANIFEST SCHEMA (v1)

\`\`\`ts
interface ExtensionManifest {
  manifestVersion: 1;
  id: string;          // reverse-DNS, lowercase, dot/hyphen-separated
  name: string;
  description: string;
  version: string;     // SemVer
  engines: { ifcLiteSdk: string };   // e.g. ">=2.4.0 <3.0.0"
  capabilities: string[];           // see catalogue below
  activation: Array<
    | 'onStartup'
    | 'onModelLoad'
    | \`onCommand:\${string}\`
    | \`onLens:\${string}\`
    | \`onExporter:\${string}\`
    | \`onIdsValidator:\${string}\`
    | \`onSchema:\${string}\`
    | \`onSlot:\${string}\`
  >;
  contributes?: {
    commands?: { id: string; title: string; icon?: string }[];
    toolbar?: { command: string; slot: 'toolbar.left'|'toolbar.right'|'toolbar.center'; order?: number; when?: string }[];
    dock?:    { id: string; slot: 'dock.left'|'dock.right'|'dock.bottom'; title: string; widget: string; when?: string }[];
    contextMenu?: { command: string; slot: 'contextMenu.entity'|'contextMenu.canvas'|'contextMenu.tree'; when?: string }[];
    keybindings?: { command: string; key: string; when?: string }[];
    lenses?:      { id: string; name: string; evaluator: string }[];
    exporters?:   { id: string; name: string; mimeType: string; extension: string; handler: string }[];
    idsValidators?: { id: string; name: string; handler: string }[];
    statusBar?:   { id: string; slot: 'statusBar.left'|'statusBar.right'; text: string; command?: string }[];
  };
  entry: {
    activate?: string;
    deactivate?: string;
    commands?: Record<string, string>;
    triggers?: Record<string, string>;
  };
  tests?: { name: string; command: string; fixture: string; expect: { mimeType?: string; minBytes?: number; regex?: string } }[];
}
\`\`\``;
}

function buildWidgetDsl(): string {
  return `### WIDGET DSL

Use ONLY these node types — no JSX, no HTML, no CSS:

| Node | Required fields |
|------|-----------------|
| \`Stack\` | direction, children |
| \`Group\` | children |
| \`Text\` | text |
| \`Field\` | variant (text/number/boolean/select/multiSelect/entityPicker/colorPicker/file), label, binding |
| \`Button\` | label, command |
| \`Table\` | data, columns[] |
| \`Chart\` | variant (bar/line/pie), data |
| \`Markdown\` | content |
| \`Tabs\` | tabs[] |
| \`Separator\` | (none) |
| \`EmptyState\` | heading |
| \`Spinner\` | (none) |
| \`ErrorBanner\` | message |
| \`EntityList\` | data, idField |
| \`Tree\` | data, labelField, childrenField |
| \`KeyValueGrid\` | rows[] |

Bindings use JSONPath-like accessors against the handler's return
value: \`"$.fieldName"\` or \`"fieldName"\`.

Buttons reference commands by id; the host invokes the command via
its dispatcher. NEVER include onClick / inline scripts in widget JSON.`;
}

function buildCapabilityCatalogue(): string {
  const lines: string[] = ['### CAPABILITY CATALOGUE', ''];
  lines.push('| Capability | Risk | Description |');
  lines.push('|------------|------|-------------|');
  for (const entry of listCapabilityCatalogue()) {
    const cap = entry.requiresTarget
      ? `${entry.scope}.${entry.action}:<target>`
      : `${entry.scope}.${entry.action}`;
    lines.push(`| \`${cap}\` | ${entry.baseRisk} | ${entry.description} |`);
  }
  lines.push('');
  lines.push('Request the smallest capability set that lets the extension work.');
  lines.push('NEVER request `network.fetch:*` or `model.mutate:*` wildcards.');
  lines.push('NEVER construct capability strings from runtime data.');
  return lines.join('\n');
}

function buildStyleRules(): string {
  return `### STYLE RULES

- Code: one module per entry point. All authority enters via \`ctx\`.
- Never reference \`globalThis\`, \`window\`, \`process\`, \`document\`.
- Never call \`eval\` or \`Function()\`.
- Dynamic imports only of bundle-internal paths.
- Comments only when WHY is non-obvious. No multi-paragraph docstrings.
- Functions named after their effect, not their implementation.
- Error messages say what to do, not what failed.
- Treat all model strings / chat input / file content as untrusted —
  never include user content in a network fetch URL.

### TESTS

Every output-producing contribution ships with at least one test:

\`\`\`json
{
  "name": "<what the test asserts>",
  "command": "<the contributed command id>",
  "fixture": "<id from tests/models/manifest.json>",
  "args": { "...optional command args..." },
  "expect": { "mimeType": "...", "minBytes": 0, "regex": "..." }
}
\`\`\`

Pick the smallest fixture that exercises the contribution.

### FAILURE MODES

If the user asks for a capability outside the catalogue, refuse and
offer the closest legitimate alternative. If a task can't be expressed
with the widget DSL alone, say so and recommend running it as a
one-shot script instead.`;
}
