#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CLI for IFC code generation
 *
 * Generates TypeScript and optionally Rust code from IFC EXPRESS schemas.
 */

import { Command } from 'commander';
import { generateFromFile, type GeneratorOptions } from './generator.js';

const program = new Command();

program
  .name('ifc-codegen')
  .description('Generate TypeScript and Rust code from IFC EXPRESS schemas')
  .version('0.2.0');

program
  .argument('<schema>', 'Path to EXPRESS schema file (.exp)')
  .option('-o, --output <dir>', 'Output directory', './generated')
  .option('-r, --rust', 'Generate Rust code', false)
  .option('--rust-dir <dir>', 'Rust output subdirectory (relative to output)', 'rust')
  .option(
    '--rust-supplemental-schema <path...>',
    'Additional EXPRESS schemas whose entity names extend the Rust IfcType universe'
  )
  .option('--skip-collision-check', 'Skip CRC32 collision check', false)
  .option('-v, --verbose', 'Verbose output', false)
  .action(
    (
      schemaPath: string,
      options: {
        output: string;
        rust: boolean;
        rustDir: string;
        rustSupplementalSchema?: string[];
        skipCollisionCheck: boolean;
        verbose: boolean;
      }
    ) => {
      try {
        console.log('🚀 IFC Code Generator\n');
        console.log(`Schema: ${schemaPath}`);
        console.log(`Output: ${options.output}`);
        if (options.rust) {
          // Check if rustDir is absolute or relative for display
          const rustDisplay = options.rustDir.startsWith('/')
            ? options.rustDir
            : `${options.output}/${options.rustDir}`;
          console.log(`Rust:   ${rustDisplay}`);
        }
        console.log();

        const start = Date.now();

        const genOptions: GeneratorOptions = {
          rust: options.rust,
          rustDir: options.rustDir,
          rustSupplementalSchemaPaths: options.rustSupplementalSchema,
          skipCollisionCheck: options.skipCollisionCheck,
        };

        generateFromFile(schemaPath, options.output, genOptions);

        const elapsed = Date.now() - start;
        console.log(`\n⏱️  Completed in ${elapsed}ms`);
      } catch (error) {
        console.error('\n❌ Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    }
  );

program.parse();
