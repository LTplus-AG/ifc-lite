---
"@ifc-lite/viewer": patch
---

Product analytics no longer redacts `file:*` command ids (Open, Add model, Share, Refresh, federation setup) from `command_executed`; `file:` and `blob:` URLs are still redacted.
