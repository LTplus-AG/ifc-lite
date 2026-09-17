---
"@ifc-lite/viewer": patch
---

A viewer tab left open across a deploy no longer loses its geometry workers, engine wasm or lazily loaded code when the same browser opens ifclite.com in another tab, refreshes one, or completes an OAuth sign-in popup. Vercel serves every real navigation from the latest deployment, and the deployment pin cookie was browser-wide, so any such navigation re-pinned older tabs to a deployment without their hashed assets ("worker script failed to load"). Each production build now writes its assets under `/assets/<deploymentId>/`, and the pin cookie for those assets is scoped to that directory, so a tab's own requests stay on its own deployment.
