/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * `/mcp` marketing landing (#4918 sweep): `McpLanding.tsx` (nav, hero,
 * install/recipes/catalog sections, footer), `HeroScene.tsx` (the hero's
 * WebGL-unavailable caption), and `PlaygroundViewer.tsx` (the inline 3D
 * viewer's own chrome — WebGL-unavailable card, phase HUD).
 *
 * Deliberately NOT covered — data, not UI copy written in these files:
 *  - `CATALOG`/`RECIPES`/`CLIENTS`/`EXAMPLES` content from `./data` (tool
 *    names, descriptions, recipe prompts, client blurbs/config hints) —
 *    catalogue/fixture data, the same class as `SCRIPT_TEMPLATES` in the
 *    command-palette catalogue's exclusions.
 *  - `HERO_STEPS` verb/line/family/overlay text in `HeroScene.tsx` — the
 *    demo transcript's own scripted content, not chrome around it.
 *  - console-only diagnostic strings — never rendered to a user.
 */
export const mcpEn = {
  // ── McpLanding: top bar ──
  'mcp.mcpLanding.documentTitle': '@ifc-lite/mcp — drive an IFC from any LLM',
  'mcp.mcpLanding.brand': 'ifc-lite',
  'mcp.mcpLanding.navBadge': '/ mcp · {version}',
  'mcp.mcpLanding.navViewer': 'Viewer',
  'mcp.mcpLanding.navInstall': 'Install',
  'mcp.mcpLanding.navRecipes': 'Recipes',
  'mcp.mcpLanding.navTools': 'Tools',
  'mcp.mcpLanding.navPlayground': 'Playground',

  // ── McpLanding: hero ──
  'mcp.mcpLanding.heroBadge': 'new · @ifc-lite/mcp v{version}',
  'mcp.mcpLanding.heroTitleLine1': 'Drive a building.',
  'mcp.mcpLanding.heroTitleLine2': 'From a chat.',
  'mcp.mcpLanding.heroSubtitle':
    '{count} typed tools that let any LLM agent query, validate, mutate, and visualise real IFC building models. The same toolkit your engineers ship with, in a chat.',
  'mcp.mcpLanding.tryInPlayground': 'Try in playground',
  'mcp.mcpLanding.installCta': 'Install',
  'mcp.mcpLanding.statTypedTools': { one: '{countDisplay} typed tool', other: '{countDisplay} typed tools' },
  'mcp.mcpLanding.statCategories': { one: '{countDisplay} category', other: '{countDisplay} categories' },
  'mcp.mcpLanding.statMcpClients': { one: '{countDisplay} MCP client', other: '{countDisplay} MCP clients' },
  'mcp.mcpLanding.statTransports': { one: '{countDisplay} transport', other: '{countDisplay} transports' },
  'mcp.mcpLanding.statTransportsSublabel': 'stdio · http',
  'mcp.mcpLanding.scrollHint': 'scroll',

  // ── McpLanding: hero wireframe stage + overlays ──
  'mcp.mcpLanding.stepIndicator': '· step {step} / {total}',
  'mcp.mcpLanding.ifcTypeLabel': 'Ifc{type}',
  'mcp.mcpLanding.bsddWallBadge': 'bSDD · IfcWall',
  'mcp.mcpLanding.psetsCount': '{count} Psets',
  'mcp.mcpLanding.schemaOnly': '— schema only —',

  // ── McpLanding: install section ──
  'mcp.mcpLanding.installSectionTitle': 'Pick your client. We brought a snippet.',
  'mcp.mcpLanding.alsoLabel': 'also',
  'mcp.mcpLanding.installInstructionsSr': 'Install instructions',
  'mcp.mcpLanding.oneClickBadge': '{index} / one-click',
  'mcp.mcpLanding.pasteConfigBadge': '{index} / paste config',
  'mcp.mcpLanding.manual': 'manual',
  'mcp.mcpLanding.installSlash': 'install / {name}',
  'mcp.mcpLanding.oneClickOrCopy': 'One click. Or copy.',
  'mcp.mcpLanding.dropInRestart': 'Drop in. Restart.',
  'mcp.mcpLanding.openInClient': 'Open in {name}',
  'mcp.mcpLanding.copied': 'Copied',
  'mcp.mcpLanding.copy': 'Copy',
  'mcp.mcpLanding.copyJsonRpc': 'Copy JSON-RPC',

  // ── McpLanding: recipes carousel ──
  'mcp.mcpLanding.recipesTitle': 'Eight things to ask, once it’s installed.',
  'mcp.mcpLanding.userLabel': 'user',
  'mcp.mcpLanding.recipesScrollCount': '{count} recipes · scroll →',
  'mcp.mcpLanding.scrollLeft': 'Scroll left',
  'mcp.mcpLanding.scrollRight': 'Scroll right',

  // ── McpLanding: catalog ──
  'mcp.mcpLanding.catalogEyebrow': 'Catalog',
  'mcp.mcpLanding.catalogTypedTools': '{count} typed tools.',
  'mcp.mcpLanding.catalogEverything': 'Everything an agent needs.',
  'mcp.mcpLanding.signature': 'Signature',
  'mcp.mcpLanding.parametersCount': 'Parameters · {count}',
  'mcp.mcpLanding.noParameters': 'No parameters — call with {token}.',
  'mcp.mcpLanding.colName': 'name',
  'mcp.mcpLanding.colType': 'type',
  'mcp.mcpLanding.colReq': 'req',
  'mcp.mcpLanding.colDescription': 'description',
  'mcp.mcpLanding.yes': 'yes',
  'mcp.mcpLanding.exampleCall': 'Example call',
  'mcp.mcpLanding.toolShareLink': '# {name} · share link',

  // ── McpLanding: footer ──
  'mcp.mcpLanding.bringYourModel': 'Bring your model.',
  'mcp.mcpLanding.weBroughtTools': 'We brought the tools.',
  'mcp.mcpLanding.openPlayground': 'Open the playground',
  'mcp.mcpLanding.footerBrand': 'ifc-lite/mcp · v{version} · MPL-2.0',
  'mcp.mcpLanding.darkByIntent': 'Dark by intent.',
  'mcp.mcpLanding.footerColSource': 'Source',
  'mcp.mcpLanding.footerColDocs': 'Docs',
  'mcp.mcpLanding.footerColSpec': 'Spec',

  // ── HeroScene ──
  'mcp.heroScene.webglUnavailable': '3D preview unavailable on this device',

  // ── PlaygroundViewer ──
  'mcp.playgroundViewer.webglUnavailableTitle': '3D preview unavailable on this device',
  'mcp.playgroundViewer.webglUnavailableBody':
    'Your browser could not provide graphics for the viewer. Loading, queries and every other tool still work.',
  'mcp.playgroundDispatcher.webglUnavailable':
    'This device cannot provide a WebGL context, so the inline 3D viewer never mounts. Every viewer_* tool is unavailable for the rest of this session. Parsing, queries, validation, BCF and export are unaffected.',
  'mcp.playgroundDispatcher.webglUnavailableHint':
    'Answer with the non-viewer tools; no 3D tool can succeed on this device.',
  'mcp.playgroundViewer.meshCount': {
    one: '{count} mesh',
    other: '{count} meshes',
  },
  'mcp.playgroundViewer.preparing': 'preparing…',
  'mcp.playgroundViewer.loadModelFirst': 'load a model first',
  'mcp.playgroundViewer.bootingPipeline': 'booting geometry pipeline…',
  'mcp.playgroundViewer.extractingGeometry': 'extracting geometry…',
  'mcp.playgroundViewer.noDrawableGeometry': 'No drawable geometry — model may be schema-only.',
} as const satisfies Record<string, TranslationValue>;
