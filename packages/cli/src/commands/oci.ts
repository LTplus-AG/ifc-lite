/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite oci <command>`: OCI registry operations. Reading a model from a
 * registry needs no command (any model argument may be `oci://...`); this
 * group holds what does: publishing.
 */

import { ociPushCommand } from './oci-push.js';

export async function ociCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    printUsage();
    return;
  }
  switch (sub) {
    case 'push':
      await ociPushCommand(rest);
      return;
    default:
      process.stderr.write(`Unknown oci subcommand: ${sub}\n`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stdout.write(`Usage: ifc-lite oci <command> [...args]

Commands:
  push <oci://host/repository:tag> <model.ifc>
                           Publish one IFC-SPF file as an OCI artifact:
                           artifactType application/vnd.ifc-lite.ifc.v1, the
                           OCI empty config, one application/x-step layer
                           titled with the file name.
                           Flags: --overwrite (replace an existing tag),
                                  --annotation key=value (repeatable; manifest
                                  annotation, a later duplicate wins),
                                  --json

The file is checked as IFC before any request; .ifczip is not supported yet.
The tag must be given; a digest reference is refused. localhost, 127.0.0.1 and
[::1] use plain http, every other host https. Credentials:
IFC_LITE_OCI_USERNAME + IFC_LITE_OCI_PASSWORD, or IFC_LITE_OCI_TOKEN.
SOURCE_DATE_EPOCH, when set, fixes org.opencontainers.image.created.

Reading needs no command: any model argument may be oci://host/repository:tag.

Exit codes: 0 pushed, 1 any error (including an existing tag without --overwrite).
`);
}
