---
'@ifc-lite/viewer': patch
---

Fix the MCP playground chat attaching two files with the same basename in one batch showing two chips for what the upload store treats as one attachment.

`playground-uploads.ts`'s `UploadStore` intentionally de-dupes uploads by basename (last file wins — see its `add()` comment), but `PlaygroundChat`'s `attachFiles` tracked its own `pendingAttachments` list independently, pushing every resolved entry with no such de-dupe. Attaching `spec.ids` (A) and `spec.ids` (B) in one drop produced two chips while the store held only B: the first file's content became unreachable through `ids_validate`/`ids_explain` (which resolve by name through the store) even though its chip was still shown as attached, the duplicate `key={f.name}` in the chip list violated React's key-uniqueness contract, and clicking Remove on either chip — filtering by name — dropped both at once.

The chat panel now tracks only the pending *names* for the current turn and projects them through the store's live contents on every render, so the chip list can no longer disagree with what the store actually holds — there is structurally only one thing to render per name. The store's last-wins behavior is unchanged.

The outbound chat-turn text was never affected: `describeAttachment` reads each in-memory attachment object directly, not through the store.
