/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Read only Cargo dependency declarations. Keep quoted target cfg expressions
// intact: their embedded dots and double quotes are not TOML path separators.
function splitPath(input) {
  const parts = [];
  let part = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') quote = '';
      else part += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '.') {
      parts.push(part.trim());
      part = '';
    } else part += char;
  }
  if (quote) throw new Error(`Unterminated TOML key: ${input}`);
  parts.push(part.trim());
  if (parts.some((item) => !item)) throw new Error(`Invalid TOML key: ${input}`);
  return parts;
}

function scan(input, delimiter) {
  const parts = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === delimiter && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts;
}

function uncomment(input) {
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return input.slice(0, i).trim();
  }
  return input.trim();
}

function dependencySection(path, workspace) {
  if (workspace) return path.length >= 2 && path[0] === 'workspace' && path[1] === 'dependencies';
  const section = path[0] === 'target' && path.length >= 3 ? path.slice(2) : path;
  if (path[0] === 'target' && path.length < 3) return false;
  return ['dependencies', 'dev-dependencies', 'build-dependencies'].includes(section[0]);
}

function completeValue(input) {
  let quote = '';
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth < 0) throw new Error(`Invalid dependency value: ${input}`);
  }
  return depth === 0 && !quote;
}

function value(raw) {
  const text = raw.trim();
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw new Error(`Incomplete dependency declaration: ${text}`);
    const result = {};
    for (const member of scan(text.slice(1, -1), ',')) {
      if (!member) continue;
      const [key, ...rest] = scan(member, '=');
      if (!rest.length) throw new Error(`Invalid dependency property: ${member}`);
      set(result, splitPath(key), value(rest.join('=')));
    }
    return result;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^(["']).*\1$/s.test(text)) return text.slice(1, -1);
  return text;
}

function set(object, path, entry) {
  let cursor = object;
  for (const key of path.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[path.at(-1)] = entry;
}

function dependencyTables(toml, workspace) {
  const deps = {};
  let section = [];
  let pending = '';
  const lines = toml.split('\n');
  for (const raw of lines) {
    const line = uncomment(raw);
    if (!line) continue;
    if (!pending && line.startsWith('[')) {
      const match = line.match(/^\[\[?(.+?)\]\]?$/);
      if (!match) throw new Error(`Invalid TOML section: ${line}`);
      section = splitPath(match[1]);
      continue;
    }
    if (!dependencySection(section, workspace)) continue;
    pending += (pending ? '\n' : '') + line;
    const [key, ...rest] = scan(pending, '=');
    if (!rest.length) throw new Error(`Invalid dependency declaration: ${pending}`);
    const rawValue = rest.join('=');
    // Inline tables and arrays may span lines; wait for the closing delimiter.
    if (!completeValue(rawValue)) continue;
    const path = [...section.slice(section[0] === 'target' ? 3 : workspace ? 2 : 1), ...splitPath(key)];
    set(deps, path, value(rawValue));
    pending = '';
  }
  if (pending) throw new Error(`Incomplete dependency declaration: ${pending}`);
  return deps;
}

/** Return published ifc-lite package names with a versioned Cargo edge. */
export function versionedIfcDeps(manifestToml, workspaceToml) {
  const deps = dependencyTables(manifestToml, false);
  const inherited = dependencyTables(workspaceToml, true);
  const result = new Set();
  for (const [alias, declared] of Object.entries(deps)) {
    const local = typeof declared === 'string' ? { version: declared } : declared;
    const base = local.workspace === true ? inherited[alias] : undefined;
    if (local.workspace === true && base === undefined) {
      throw new Error(`Workspace dependency ${alias} has no [workspace.dependencies] entry`);
    }
    const baseProps = typeof base === 'string' ? { version: base } : base ?? {};
    const name = local.package ?? baseProps.package ?? alias;
    if (name.startsWith('ifc-lite-') && (local.version !== undefined || baseProps.version !== undefined)) {
      result.add(name);
    }
  }
  return [...result];
}
