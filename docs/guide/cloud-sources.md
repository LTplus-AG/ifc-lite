# Cloud sources

Open **Open from cloud** in the viewer to choose a source. On a hosted deployment with vendor sign-in enabled, select **Sign in** beside Autodesk, Dropbox or OneDrive. Complete the vendor's account selection and consent screen, then return to IFClite to browse and load files. End users do not enter access tokens, client IDs or app secrets.

Dropbox reads the signed-in account's files. OneDrive reads the signed-in user's own drive, for either a personal Microsoft account or a work/school account whose administrator permits consent. Hosted OneDrive does not browse other SharePoint sites or document libraries. Autodesk lists only projects and exchanges that the signed-in account can access; a successful sign-in with an empty list means there are no accessible projects in that source. Tenant administrators may need to approve an application before users can access their organisation's data.

IFClite requests read access. Cloud credentials remain on the backend, in a session identified by a secure HttpOnly cookie. Files download through the gateway; vendor access tokens and signed download URLs are not sent to the viewer. Sign out ends the IFClite cloud session. It does not sign the user out of the vendor's other applications.

If the browser blocks the sign-in popup, IFClite continues sign-in in the current tab and returns to the previous viewer route. This reloads the viewer; save local work before signing in with a popup blocker enabled. Only an expiring transaction state and return location are kept in session storage, and they are removed when the viewer resumes. Closing a popup may leave the attempt waiting because browser isolation prevents reliable detection; use **Cancel sign-in** or wait for the timeout before trying again.

Deployment administrators configure the vendor applications on the cloud gateway and enable `VITE_CLOUD_HOSTED=true` for the viewer build. The viewer must proxy `/api/cloud/dropbox/*` and `/api/cloud/msgraph/*` to the configured gateway on the same public origin. Register the exact `/api/cloud/{vendor}/callback` URLs with the vendors and serve the matching `/oauth/{vendor}/callback` static pages. Follow [the gateway deployment instructions](../../deploy/cloud/railway.md). Autodesk uses its separate `VITE_AUTODESK_HOSTED=true` gateway configuration.

The cloud session ends when the gateway restarts. Reconnect if IFClite reports that it expired. Unconfigured sources explain that an administrator needs to enable the application. Failed sign-out keeps the account visible so users can retry.

Self-hosted deployments without `VITE_CLOUD_HOSTED=true` retain the direct SDK sign-in setup described in the [Dropbox package](../../packages/source-dropbox/README.md) and [Microsoft Graph package](../../packages/source-msgraph/README.md). Dalux currently uses the vendor's API credentials; hosted OAuth for Dropbox and Microsoft does not change that source.
