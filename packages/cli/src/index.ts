#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite CLI — BIM toolkit for the terminal
 *
 * Query, validate, export, create, merge, convert, diff, and script IFC files
 * from the command line. Designed for both humans and LLM terminals.
 */

import { infoCommand } from './commands/info.js';
import { queryCommand } from './commands/query.js';
import { propsCommand } from './commands/props.js';
import { exportCommand } from './commands/export.js';
import { idsCommand } from './commands/ids.js';
import { bcfCommand } from './commands/bcf.js';
import { createCommand } from './commands/create.js';
import { evalCommand } from './commands/eval.js';
import { runCommand } from './commands/run.js';
import { schemaCommand } from './commands/schema.js';
import { mergeCommand } from './commands/merge.js';
import { convertCommand } from './commands/convert.js';
import { diffCommand } from './commands/diff.js';
import { validateCommand } from './commands/validate.js';
import { bsddCommand } from './commands/bsdd.js';
import { statsCommand } from './commands/stats.js';
import { mutateCommand } from './commands/mutate.js';
import { askCommand } from './commands/ask.js';
import { viewCommand } from './commands/view.js';
import { analyzeCommand } from './commands/analyze.js';
import { lodCommand } from './commands/lod.js';
import { mcpCommand } from './commands/mcp.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    // Try to read from package.json (works in both src/ and dist/)
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.4.0';
  } catch {
    return '0.4.0';
  }
}

const VERSION = getVersion();

const HELP = `
  ifc-lite v${VERSION} — BIM toolkit for the terminal

  Usage: ifc-lite <command> [options]

  Commands:
    info      <file.ifc>                          Model summary (schema, entities, storeys)
    query     <file.ifc> [--type T] [--json]      Query entities by type/properties/quantities
    props     <file.ifc> --id <N>                 All properties for a single entity
    export    <file.ifc> --format csv|json|ifc    Export data to file or stdout
    ids       <file.ifc> <rules.ids>              Validate against IDS rules
    bcf       <create|list|add-comment>           Work with BCF collaboration files
    create    <type> [options] --out F             Create IFC elements (30+ types)
    eval      <file.ifc> "<expression>"           Evaluate SDK expression
    run       <script.js> <file.ifc>              Execute a script against model
    schema                                        Dump SDK API schema (for LLM tools)
    merge     <f1.ifc> <f2.ifc> --out F           Merge multiple IFC files
    convert   <file.ifc> --schema VER --out F     Convert between IFC schema versions
    diff      <f1.ifc> <f2.ifc>                   Compare two IFC files
    validate  <file.ifc>                          Structural validation checks
    bsdd      <class|search|psets|qsets> <arg>     buildingSMART Data Dictionary lookup
    stats     <file.ifc>                          Auto-calculated model KPIs and health check
    mutate    <file.ifc> --id N --set P=V --out F  Modify properties/attributes and save
    ask       <file.ifc> "<question>"            Natural language BIM queries
    view      <file.ifc> [--port N]              Interactive 3D viewer in browser
    analyze   <file.ifc> --viewer <port>        Query + visualize analysis results
    lod       <file.ifc> --level 0|1            Generate lightweight LOD artifacts
    mcp       <file.ifc> [--transport stdio|http] Start an MCP server bound to one or more IFC files

  Options:
    --help, -h       Show help
    --version, -v    Show version
    --json           Output as JSON (machine-readable)
    --out <file>     Write output to file instead of stdout

  Examples:
    ifc-lite info model.ifc
    ifc-lite query model.ifc --type IfcWall --json
    ifc-lite query model.ifc --type IfcDoor --props --limit 5
    ifc-lite query model.ifc --type IfcWall --materials --classifications --json
    ifc-lite query model.ifc --type IfcWall --all --json
    ifc-lite query model.ifc --type IfcWall --quantity-names
    ifc-lite query model.ifc --type IfcWall --sum GrossSideArea
    ifc-lite query model.ifc --type IfcWall --group-by material --json
    ifc-lite query model.ifc --spatial --summary
    ifc-lite query model.ifc --spatial
    ifc-lite props model.ifc --id 42
    ifc-lite export model.ifc --format csv --type IfcWall --columns Name,Type,GlobalId
    ifc-lite export model.ifc --format json --type IfcWall,IfcDoor
    ifc-lite ids model.ifc requirements.ids --json
    ifc-lite bcf create --title "Missing door" --out issue.bcf
    ifc-lite create wall --height 3 --thickness 0.2 --start 0,0,0 --end 5,0,0 --out wall.ifc
    ifc-lite create stair --number-of-risers 12 --riser-height 0.175 --width 1.2 --out stair.ifc
    ifc-lite create door --width 0.9 --height 2.1 --position 0,0,0 --out door.ifc
    ifc-lite create i-shape-beam --start 0,0,3 --end 5,0,3 --out beam.ifc
    ifc-lite create wall --from-json --out w.ifc < params.json
    ifc-lite create wall --pset '{"Name":"Pset_WallCommon","Properties":[{"Name":"IsExternal","NominalValue":true}]}' --out w.ifc
    ifc-lite create wall --material '{"Name":"Concrete","Category":"Structural"}' --out w.ifc
    ifc-lite create wall --color 0.8,0.2,0.2 --out w.ifc
    ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"
    ifc-lite eval model.ifc "bim.storeys().map(s => s.name)"
    ifc-lite run analysis.js model.ifc
    ifc-lite schema
    ifc-lite schema --compact
    ifc-lite merge arch.ifc struct.ifc mep.ifc --out federated.ifc
    ifc-lite convert model.ifc --schema IFC4 --out model-ifc4.ifc
    ifc-lite diff model-v1.ifc model-v2.ifc --json
    ifc-lite diff model-v1.ifc model-v2.ifc --by-entity
    ifc-lite validate model.ifc --json
    ifc-lite bsdd class IfcWall
    ifc-lite bsdd search "concrete wall"
    ifc-lite bsdd psets IfcWall
    ifc-lite ask model.ifc "how many walls?"
    ifc-lite ask model.ifc "window-wall ratio" --json
    ifc-lite ask model.ifc "list materials" --explain
    ifc-lite view model.ifc
    ifc-lite view model.ifc --port 3456
    curl -X POST http://localhost:3456/api/command -H 'Content-Type: application/json' -d '{"action":"colorize","type":"IfcWall","color":[1,0,0,1]}'
    ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --missing "Pset_WallCommon.FireRating" --color red
    ifc-lite analyze model.ifc --viewer 3456 --type IfcSlab --where "GrossArea>100" --color orange --isolate
    ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --heatmap "Qto_WallBaseQuantities.GrossSideArea"
    ifc-lite analyze model.ifc --viewer 3456 --rules rules.json --json
    ifc-lite lod model.ifc --level 0 --out model.lod0.json
    ifc-lite lod model.ifc --level 1 --out model.glb --meta model.lod1.json
    ifc-lite mcp model.ifc
    ifc-lite mcp model.ifc --read-only
    ifc-lite mcp arch.ifc struct.ifc --federate
    ifc-lite mcp model.ifc --transport http --port 8765 --token abc

  Pipe-friendly:
    ifc-lite query model.ifc --type IfcWall --json | jq '.[].name'
    ifc-lite export model.ifc --format csv --type IfcSlab > slabs.csv
    echo '{"Start":[0,0,0],"End":[10,0,0],"Height":3}' | ifc-lite create wall --from-json --out w.ifc

  Create element types:
    wall, slab, column, beam, stair, roof, gable-roof, door, window,
    wall-door, wall-window, ramp, railing, plate, member, footing, pile,
    space, curtain-wall, furnishing, proxy, circular-column,
    hollow-circular-column, i-shape-beam, l-shape-member, t-shape-member,
    u-shape-member, rectangle-hollow-beam

  Learn more: https://ifclite.com
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`ifc-lite ${VERSION}\n`);
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case 'info':
      await infoCommand(commandArgs);
      break;
    case 'query':
      await queryCommand(commandArgs);
      break;
    case 'props':
      await propsCommand(commandArgs);
      break;
    case 'export':
      await exportCommand(commandArgs);
      break;
    case 'ids':
      await idsCommand(commandArgs);
      break;
    case 'bcf':
      await bcfCommand(commandArgs);
      break;
    case 'create':
      await createCommand(commandArgs);
      break;
    case 'eval':
      await evalCommand(commandArgs);
      break;
    case 'run':
      await runCommand(commandArgs);
      break;
    case 'schema':
      await schemaCommand(commandArgs);
      break;
    case 'merge':
      await mergeCommand(commandArgs);
      break;
    case 'convert':
      await convertCommand(commandArgs);
      break;
    case 'diff':
      await diffCommand(commandArgs);
      break;
    case 'validate':
      await validateCommand(commandArgs);
      break;
    case 'bsdd':
      await bsddCommand(commandArgs);
      break;
    case 'stats':
      await statsCommand(commandArgs);
      break;
    case 'mutate':
      await mutateCommand(commandArgs);
      break;
    case 'ask':
      await askCommand(commandArgs);
      break;
    case 'view':
      await viewCommand(commandArgs);
      break;
    case 'analyze':
      await analyzeCommand(commandArgs);
      break;
    case 'lod':
      await lodCommand(commandArgs);
      break;
    case 'mcp':
      await mcpCommand(commandArgs);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.stderr.write(`Run 'ifc-lite --help' for usage.\n`);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Error: ${err.message}\n`);
  if (process.env.DEBUG) {
    process.stderr.write(err.stack ?? '' + '\n');
  }
  process.exit(1);
});
