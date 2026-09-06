/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { join, relative, isAbsolute, sep } from 'node:path';

/** Return only lexical descendants; malformed escapes and sibling prefixes fail closed. */
export function browserStaticPath(root: string, request: string): string | null {
  let path: string;
  try { path = decodeURIComponent(request.split('?')[0]); }
  catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  const file = join(root, path === '/' ? '/index.html' : path);
  const within = relative(root, file);
  return within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) ? null : file;
}
