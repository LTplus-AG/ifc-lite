/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const GITHUB_RECONCILIATION_PAGE_LIMIT = 10;

/** GitHub's Link header determines completeness; page length does not.
 * Both callers keep constructing their own trusted API URL for numeric pages,
 * so an upstream Link URL can never redirect installation credentials.
 * https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api */
export function hasNextGithubPage(response: Response, page: number, limitError: string): boolean {
  const next = response.headers.get('link')?.includes('rel="next"') ?? false;
  if (next && page >= GITHUB_RECONCILIATION_PAGE_LIMIT) throw new Error(limitError);
  return next;
}
