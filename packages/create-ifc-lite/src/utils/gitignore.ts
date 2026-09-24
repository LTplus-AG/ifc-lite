/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Write the .gitignore every scaffolded project needs. Without one, the first
 * `git add .` in a fresh project commits `node_modules/` and `dist/` — and the
 * viewer templates' `dist/` carries an 8 MB wasm bundle.
 */
export function writeGitignore(targetDir: string) {
  writeFileSync(join(targetDir, '.gitignore'), `# Dependencies
node_modules/

# Build output
dist/

# Environment files
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
`);
}
