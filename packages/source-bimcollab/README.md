# @ifc-lite/source-bimcollab

BIMcollab Documents `FileSourceProvider` for IFC, IFCZIP, IFCXML and IFCX.
The host supplies its existing BCF session; this package never starts OAuth or
stores tokens. A 401 throws `BimcollabHttpError` with
`reauthenticationRequired: true`; a 403 means no document access in the space.

```ts
import {
  BimcollabProvider, RelayBimcollabTransport,
  spaceIdFromAccessToken, spaceLabelFromServerUrl,
} from '@ifc-lite/source-bimcollab';

// Supplied by the host: its BCF login (with refresh), the saved BCF server
// URL, and a fetch that can only reach the same-origin relay.
declare const getAccessToken: () => Promise<string>;
declare const savedBcfServerUrl: string;
declare const approvedRelayFetch: typeof fetch;

const session = {
  spaceGuid: spaceIdFromAccessToken(await getAccessToken()),
  spaceLabel: spaceLabelFromServerUrl(savedBcfServerUrl),
  getAccessToken,
};
const provider = new BimcollabProvider({
  session,
  transport: new RelayBimcollabTransport('/api/bimcollab', approvedRelayFetch),
  legacyDownloadFallback: true,
});
```

`spaceIdFromAccessToken` decodes claims only; it does not authenticate a JWT.
Invalid input returns an empty string. The URL helper accepts a single space
label under HTTPS `bimcollab.com`. The constructor rejects invalid session ids.

The default transport uses `ctx.fetch` and `/api/bimcollab`; a host that validates
only upstream URLs (including the current viewer SourceHost) must inject a
host-approved same-origin fetch as shown above. Its upstream rewrite alone
cannot express the relay's two route families. Register the provider only when
a BIMcollab BCF session is available; surface login/refresh through that existing
host flow. Manifest auth is `preferences` with no fields because the host owns
authentication. No separate interactive auth UI is declared. Viewer registration
and relay implementation are separate tasks.

Relay requests carry bearer authorization, omit cookies, reject redirects and
forward abort signals. `docs/<spaceGuid>/…` serves the public Documents API;
`space/<label>/index?locationId=N` and `space/<label>/download/<versionId>` serve
the legacy workaround. SAS downloads use `ctx.fetchPublic`, without bearer
headers; the host must enforce credential omission and the public-network
allowlist. Progress reports actual bytes through `DownloadOptions.onProgress`.

Locations × projects map to projects with `locationId` and `locationName` metadata.
Every project offers a `root` container (documents attached to the project itself), then one leaf container per phase.
Listings page incrementally (maximum 100 raw documents); filtered pages may be
empty with a continuation cursor. Search runs `searchText` over the project level, then each phase, paging one container after another; every hit carries its real container.
Archived and confidential records are excluded. Revisions use public GUIDs.

On the specific public download-unavailable 404, the default fallback reads the
web-app indexes of numeric locations 1–100 in parallel batches (an empty location
reads like a missing one, so all are read), keeps every row belonging
to the project (by project name, or by phase name for phase-attached documents)
from every readable location, caches them for 60 seconds, and requires exactly
one document-number/version-number match across all of them. Location names are
never used to pick between candidates; an incomplete or over-limit index aborts.
Because the index names projects and phases only by name, the fallback requires the
project name to be unique among the user's accessible projects (otherwise it
refuses) and ignores phase-only rows whose phase name another project shares, so a
location outside the scan can make a document "not found" but never mistaken. It honors `allowDownload: false`. An inaccessible or ambiguous match fails
explicitly. The index exposes current versions only, so the fallback serves only a
document's current version; an older revision downloads only if the public
endpoint serves it, and is otherwise refused (never substituted). An index the
user is refused (403) or that does not exist (404) counts as an empty location;
a 401 surfaces as re-authentication, and any other index failure aborts the
fallback. Set
`legacyDownloadFallback: false` once BIMcollab fixes its public endpoint.

For Node/CLI, inject `new DirectBimcollabTransport(fetchFn)` (optional second
argument: regional HTTPS origin). This supports public API downloads without a
relay. Legacy web-app downloads require the relay transport.

`watchRevisions` is omitted: `newVersionSinceDateTime` reports new versions but
cannot establish deletions or reconcile an initial tracked-ref baseline. The
manifest therefore declares `changeDetection: false`.

Tests use fake fetch only; no BIMcollab account or network access is needed.
