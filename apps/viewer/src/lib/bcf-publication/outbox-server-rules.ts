/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What publication must know about a server beyond the BCF API: the parts of
 * its profile (`services/bcf-server-profiles.ts`) that change how topics are
 * listed. A server without a profile follows the BCF API.
 */

import { bcfServerProfile, type BcfServerProfile } from '../../services/bcf-server-profiles.js';

export type PublicationServerRules = Partial<Pick<BcfServerProfile, 'topicPaging'>>;

/** The connection's own rules when it carries them, else its server's profile. */
export function publicationRules(connection: { serverUrl: string; rules?: PublicationServerRules | null }): PublicationServerRules {
  return connection.rules ?? bcfServerProfile(connection.serverUrl) ?? {};
}
