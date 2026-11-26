/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite view <file.ifc> [--port N] [--no-open]
 *
 * Thin CLI wrapper around @ifc-lite/viewer — launches the viewer server
 * and wires up arg parsing, stdin interaction, and browser opening.
 */

import { basename } from 'node:path';
import { fatal, getFlag, hasFlag } from '../output.js';
import {
  startViewerServer,
  VALID_ACTIONS,
  type CreateHandler,
  type ViewerServer,
  viewerUrl,
} from '@ifc-lite/viewer-core';

export { VALID_ACTIONS };

export async function viewCommand(args: string[]): Promise<void> {
  const noOpen = hasFlag(args, '--no-open');
  const portStr = getFlag(args, '--port');
  const requestedPort = portStr ? parseInt(portStr, 10) : 0;

  // Check for --send mode: send a command to an already-running viewer
  const sendPayload = getFlag(args, '--send');
  if (sendPayload && portStr) {
    const port = parseInt(portStr, 10);
    try {
      const resp = await fetch(viewerUrl(port, '/api/command'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sendPayload,
      });
      if (!resp.ok) {
        fatal(`Viewer HTTP ${resp.status}: ${resp.statusText}`);
      }
      const result = (await resp.json()) as { ok: boolean; error?: string };
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.ok) {
        process.exitCode = 1;
      }
    } catch (e: unknown) {
      fatal(`Could not connect to viewer at port ${port}: ${(e as Error).message}`);
    }
    return;
  }

  // Find the IFC file argument (optional with --empty)
  const emptyMode = hasFlag(args, '--empty');
  const positional = args.filter(a => !a.startsWith('-') && !['--port', '--send'].includes(args[args.indexOf(a) - 1] ?? ''));
  if (positional.length === 0 && !emptyMode) {
    fatal('Usage: ifc-lite view <file.ifc> [--port N] [--no-open]\n       ifc-lite view --empty --port N');
  }
  const filePath = emptyMode ? null : positional[0];
  const fileName = filePath ? basename(filePath) : 'Empty Scene';

  // Build create handler using CLI's addElement
  const createHandler: CreateHandler = async (elements) => {
    const { IfcCreator } = await import('@ifc-lite/create');
    const { addElement: addEl, ELEMENT_TYPES } = await import('./create.js');

    for (const el of elements) {
      if (!ELEMENT_TYPES.includes(el.type.toLowerCase())) {
        throw new Error(`Unknown type: ${el.type}. Valid: ${ELEMENT_TYPES.join(', ')}`);
      }
    }

    const creator = new IfcCreator({ Name: elements[0].project ?? 'Live Edit' });
    const storeyId = creator.addIfcBuildingStorey({
      Name: elements[0].storey ?? 'Created',
      Elevation: 0,
    });

    for (const el of elements) {
      addEl(creator, storeyId, el.type, el.params ?? {});
    }
    return creator.toIfc();
  };

  let viewer: ViewerServer;
  try {
    viewer = await startViewerServer({
      filePath,
      fileName,
      port: requestedPort,
      createHandler,
      onReady: (port, url) => {
        process.stderr.write(`\n  3D Viewer started → ${url}\n`);
        process.stderr.write(`  Model: ${fileName}\n`);
        process.stderr.write(`\n  Send commands via REST API:\n`);
        process.stderr.write(`    curl -X POST ${url}/api/command -H 'Content-Type: application/json' \\\n`);
        process.stderr.write(`      -d '{"action":"colorize","type":"IfcWall","color":[1,0,0,1]}'\n`);
        process.stderr.write(`\n  Or use the CLI:\n`);
        process.stderr.write(`    ifc-lite view --port ${port} --send '{"action":"isolate","types":["IfcWall"]}'\n`);
        process.stderr.write(`\n  Press Ctrl+C to stop.\n\n`);

        if (!noOpen) {
          openBrowser(url);
        }

        setupStdinCommands(port, viewer);
      },
      onError: (err) => {
        if (err.code === 'EADDRINUSE') {
          fatal(`Port ${requestedPort} is already in use. Use --port to pick a different port.`);
        }
        fatal(`Server error: ${err.message}`);
      },
    });
  } catch (e: unknown) {
    fatal(`Failed to start viewer: ${(e as Error).message}`);
  }
}

/** Open URL in default browser (cross-platform) */
function openBrowser(url: string): void {
  const { platform } = process;
  let cmd: string;
  if (platform === 'darwin') cmd = `open "${url}"`;
  else if (platform === 'win32') cmd = `start "${url}"`;
  else cmd = `xdg-open "${url}"`;

  import('node:child_process').then(({ exec }) => {
    exec(cmd, () => { /* ignore errors */ });
  });
}

/** Listen for interactive commands on stdin */
function setupStdinCommands(port: number, viewer: ViewerServer): void {
  if (!process.stdin.isTTY) return;

  process.stderr.write('  Interactive commands: colorize, isolate, view, showall, reset, quit\n');
  process.stderr.write('  > ');

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (data: string) => {
    const line = data.trim();
    if (!line) {
      process.stderr.write('  > ');
      return;
    }

    if (line === 'quit' || line === 'exit' || line === 'q') {
      process.exit(0);
    }

    const parts = line.split(/\s+/);
    const action = parts[0];

    const COLORS: Record<string, [number, number, number, number]> = {
      red: [1, 0, 0, 1],
      green: [0, 0.7, 0, 1],
      blue: [0, 0.3, 1, 1],
      yellow: [1, 0.9, 0, 1],
      orange: [1, 0.5, 0, 1],
      purple: [0.6, 0.2, 0.8, 1],
      cyan: [0, 0.8, 0.8, 1],
      white: [1, 1, 1, 1],
      pink: [1, 0.4, 0.7, 1],
    };

    let command: Record<string, unknown> | null = null;

    switch (action) {
      case 'colorize': {
        const type = parts[1];
        const colorName = parts[2] ?? 'red';
        const color = COLORS[colorName] ?? [1, 0, 0, 1];
        if (!type) {
          process.stderr.write('  Usage: colorize <IfcType> [color]\n');
        } else {
          command = { action: 'colorize', type, color };
        }
        break;
      }
      case 'isolate': {
        const types = parts.slice(1);
        if (types.length === 0) {
          process.stderr.write('  Usage: isolate <IfcType> [IfcType...]\n');
        } else {
          command = { action: 'isolate', types };
        }
        break;
      }
      case 'xray': {
        const type = parts[1];
        const opacity = parseFloat(parts[2] ?? '0.15');
        if (!type) {
          process.stderr.write('  Usage: xray <IfcType> [opacity]\n');
        } else {
          command = { action: 'xray', type, opacity };
        }
        break;
      }
      case 'highlight': {
        const ids = parts.slice(1).map(Number).filter(n => !isNaN(n));
        if (ids.length === 0) {
          process.stderr.write('  Usage: highlight <id> [id...]\n');
        } else {
          command = { action: 'highlight', ids };
        }
        break;
      }
      case 'flyto': {
        const type = parts[1];
        if (!type) {
          process.stderr.write('  Usage: flyto <IfcType | id>\n');
        } else if (/^\d+$/.test(type)) {
          command = { action: 'flyto', ids: [parseInt(type, 10)] };
        } else {
          command = { action: 'flyto', type };
        }
        break;
      }
      case 'view': {
        const viewName = parts[1];
        if (!viewName) {
          process.stderr.write('  Usage: view <front|back|left|right|top|iso>\n');
        } else {
          command = { action: 'setView', view: viewName };
        }
        break;
      }
      case 'storey':
      case 'colorByStorey':
        command = { action: 'colorByStorey' };
        break;
      case 'section': {
        const axis = parts[1] ?? 'y';
        const rawPos = parts[2] ?? 'center';
        const position = rawPos === 'center' || rawPos.endsWith('%') ? rawPos : parseFloat(rawPos);
        command = { action: 'section', axis, position };
        break;
      }
      case 'clearSection':
      case 'clearsection':
        command = { action: 'clearSection' };
        break;
      case 'clear':
      case 'clearCreated':
        fetch(viewerUrl(port, '/api/clear-created'), { method: 'POST' })
          .then((res) => { if (!res.ok) process.stderr.write(`clear failed: HTTP ${res.status}\n`); })
          .catch((err: unknown) => process.stderr.write(`clear failed: ${String(err)}\n`));
        break;
      case 'showall':
        command = { action: 'showall' };
        break;
      case 'reset':
        command = { action: 'reset' };
        break;
      default:
        try {
          command = JSON.parse(line);
        } catch {
          process.stderr.write(`  Unknown command: ${action}\n`);
          process.stderr.write('  Commands: colorize, isolate, xray, highlight, flyto, view, storey, section, clear, showall, reset, quit\n');
        }
    }

    if (command) {
      viewer.broadcast(command);
      process.stderr.write(`  → sent: ${JSON.stringify(command)}\n`);
    }
    process.stderr.write('  > ');
  });
}
