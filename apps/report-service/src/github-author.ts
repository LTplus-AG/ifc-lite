/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isRecord } from "@ifc-lite/report-contract";
import type { Config } from "./config.js";

export interface GithubAppAuthor {
  appId: number;
  userId: number;
  login: string;
}

/** Resolve identity from the authenticated App, never from issue body/login text. */
export async function authenticatedAppAuthor(
  config: Config,
  fetcher: typeof fetch,
  jwt: string,
  installationToken: string,
): Promise<GithubAppAuthor> {
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const appResponse = await fetcher("https://api.github.com/app", {
    headers: headers(jwt),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!appResponse.ok) throw new Error("github_app_identity_unavailable");
  const app: unknown = await appResponse.json();
  if (
    !isRecord(app) || typeof app.id !== "number" || !Number.isSafeInteger(app.id) ||
    app.id <= 0 || String(app.id) !== config.githubAppId || typeof app.slug !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(app.slug)
  ) throw new Error("github_app_identity_invalid");
  const login = `${app.slug}[bot]`;
  const userResponse = await fetcher(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: headers(installationToken),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!userResponse.ok) throw new Error("github_bot_identity_unavailable");
  const user: unknown = await userResponse.json();
  if (
    !isRecord(user) || user.type !== "Bot" || user.login !== login ||
    typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0
  ) throw new Error("github_bot_identity_invalid");
  return { appId: app.id, userId: user.id, login };
}

/** Issues can have null App metadata; both issues/comments carry the author. */
export function hasTrustedAppAuthor(
  value: unknown,
  author: GithubAppAuthor,
): boolean {
  if (!isRecord(value)) return false;
  const user = value.user;
  if (
    !isRecord(user) || user.id !== author.userId ||
    user.login !== author.login || user.type !== "Bot"
  ) return false;
  const app = value.performed_via_github_app;
  // If GitHub provides App attribution it must agree, never override a foreign author.
  return app == null || (isRecord(app) && app.id === author.appId);
}
