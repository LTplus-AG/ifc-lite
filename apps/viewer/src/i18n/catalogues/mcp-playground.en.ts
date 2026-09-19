/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * `/mcp/playground` (#4918 sweep): `McpPlayground.tsx` (the 3-column
 * workspace shell — sidebar sample picker, model summary, downloads panel,
 * footer links, inline viewer toggle) and `PlaygroundChat.tsx` (the BYOK
 * Anthropic chat panel — header, composer, tool-call cards, welcome state).
 *
 * Deliberately NOT covered — genuinely runtime/user-authored content, not
 * UI copy written in these files:
 *  - chat message bodies (`msg.text`), tool-call `args`/`result` payloads,
 *    and `download.label`/`download.filename` — echoed model output or
 *    tool-produced data, not prose this repo authors.
 *  - `SYSTEM_PROMPT` — sent to the Anthropic API, never rendered to a user.
 *  - sample-entry `label`/`blurb` text (`SAMPLES`) — could move here in a
 *    later slice, but reads as fixture/catalogue data today, same class as
 *    `SCRIPT_TEMPLATES` in the command-palette catalogue's exclusions.
 */
export const mcpPlaygroundEn = {
  // ── McpPlayground: sidebar + shell ──
  'mcp.mcpPlayground.title': 'Playground.',
  'mcp.mcpPlayground.subtitle':
    'Pick a sample IFC. Then chat. The agent drives the same {count} tools the stdio MCP exposes — query, mutate, validate, BCF, export. Models stay in your browser.',
  'mcp.mcpPlayground.backToMcp': 'back to /mcp',
  'mcp.mcpPlayground.topBarViewerLink': 'viewer',
  'mcp.mcpPlayground.playgroundPath': '/mcp/playground',
  'mcp.mcpPlayground.unload': 'unload',
  'mcp.mcpPlayground.sampleModels': 'sample models',
  'mcp.mcpPlayground.dropHint': 'drop an .ifc/.ifczip, or click to pick',
  'mcp.mcpPlayground.schema': 'schema',
  'mcp.mcpPlayground.entities': 'entities',
  'mcp.mcpPlayground.file': 'file',
  'mcp.mcpPlayground.topEntityTypes': 'top entity types',
  'mcp.mcpPlayground.footerTools': 'tools',
  'mcp.mcpPlayground.footerGithub': 'github',
  'mcp.mcpPlayground.footerNpm': 'npm',
  'mcp.mcpPlayground.footerViewer': 'viewer',
  'mcp.mcpPlayground.downloadsCount': 'downloads · {count}',
  'mcp.mcpPlayground.clear': 'clear',
  'mcp.mcpPlayground.fromSource': 'from {source}',
  'mcp.mcpPlayground.removeAriaLabel': 'Remove',
  'mcp.mcpPlayground.removeTitle': 'Remove from list',
  'mcp.mcpPlayground.download': 'download',
  'mcp.mcpPlayground.viewer3d': '3D viewer',
  'mcp.mcpPlayground.statusOn': 'on',
  'mcp.mcpPlayground.statusOff': 'off',
  'mcp.mcpPlayground.viewerStatusSuffix': '· inline · agent-driven',
  'mcp.mcpPlayground.loadModelFirst': 'load a model first',

  // ── PlaygroundChat: composer + header ──
  'mcp.playgroundChat.removeFile': 'Remove {name}',
  'mcp.playgroundChat.attachFileTitle': 'Attach a file (.ids, .xml, …)',
  'mcp.playgroundChat.placeholderNoModel': 'Load a sample model first.',
  'mcp.playgroundChat.placeholderNoKey': 'Set an Anthropic key first.',
  'mcp.playgroundChat.placeholderAddNote': 'Add a note (or just send to validate the attached file)…',
  'mcp.playgroundChat.placeholderDefault': 'Ask the agent — drop a .ids onto the chat to validate it.',
  'mcp.playgroundChat.send': 'Send',
  'mcp.playgroundChat.footerHintNoAttachments':
    'BYOK · {tools} tools · enter to send · ⇧+enter for newline · drop files to attach',
  'mcp.playgroundChat.footerHintWithAttachments': {
    one: 'BYOK · {tools} tools · {count} attached file · enter to send · ⇧+enter for newline · drop files to attach',
    other: 'BYOK · {tools} tools · {count} attached files · enter to send · ⇧+enter for newline · drop files to attach',
  },
  'mcp.playgroundChat.releaseToAttach': 'release to attach',
  'mcp.playgroundChat.brand': 'ifc-lite/mcp · agent',
  'mcp.playgroundChat.modelTooltip': 'Anthropic model used for tool-calling agent loops',
  'mcp.playgroundChat.modelLabel': 'model',
  'mcp.playgroundChat.selectModelAria': 'Select Claude model',
  'mcp.playgroundChat.manageKeyAria': 'Manage Anthropic API key',
  'mcp.playgroundChat.addKeyAria': 'Add Anthropic API key',
  'mcp.playgroundChat.keySetLabel': 'key set · {masked}',
  'mcp.playgroundChat.setKeyLabel': 'set Anthropic key',

  // ── PlaygroundChat: welcome + status copy ──
  'mcp.playgroundChat.askAboutModel': 'Ask the agent about {name}.',
  'mcp.playgroundChat.loadModelAskAgent': 'Load a model. Ask the agent.',
  'mcp.playgroundChat.toolsIntro':
    'Claude drives the same {count} tools the stdio MCP exposes — query, mutate, validate, BCF, export. Tool calls render inline.',
  'mcp.playgroundChat.try': 'try',
  'mcp.playgroundChat.starterPrompt1': 'Run model_audit and tell me the score. Then list any issues.',
  'mcp.playgroundChat.starterPrompt2': 'How many IfcWall vs IfcWindow vs IfcDoor are in this model?',
  'mcp.playgroundChat.starterPrompt3':
    'Find every IfcWall where Pset_WallCommon.IsExternal = true. Tell me their GlobalIds.',
  'mcp.playgroundChat.starterPrompt4': 'Look up Pset_WallCommon in bSDD and list its canonical properties.',
  'mcp.playgroundChat.starterPrompt5': 'Group the entities by storey. Which storey has the most elements?',
  'mcp.playgroundChat.composingAnswer': '… composing answer …',
  'mcp.playgroundChat.thinking': '… thinking …',
  'mcp.playgroundChat.msSuffix': '{ms} ms',
  'mcp.playgroundChat.statusError': 'error',
  'mcp.playgroundChat.statusOk': 'ok',
  'mcp.playgroundChat.argsLabel': 'args',
  'mcp.playgroundChat.resultLabel': 'result',
  'mcp.playgroundChat.savedLabel': 'Saved — click again to re-download',

  // ── PlaygroundChat: error / status strings surfaced through setError or a
  //    synthesised transcript line (not echoed model/tool content) ──
  'mcp.playgroundChat.anthropicKeyRequired': 'Set an Anthropic key (top right).',
  'mcp.playgroundChat.fileTooLarge': '{name} is over 25 MB — too large for chat attachments. Use the sample picker instead.',
  'mcp.playgroundChat.failedToReadFile': 'Failed to read {name}: {error}',
  'mcp.playgroundChat.requestFailed': '— request failed —',
} as const satisfies Record<string, TranslationValue>;
