---
"@ifc-lite/viewer": patch
---

SpaceMouse navigation can now go through the 3Dconnexion driver (#9131). Turn on **Use the 3Dconnexion driver** in Settings → Display → SpaceMouse to keep 3DxWare running while you navigate; speed, axes and navigation mode then come from your 3Dconnexion settings, and the device's Fit key fits the view. The setting is off by default. WebHID stays the default and the fallback: if the driver is not running, nothing changes. The 3Dconnexion SDK is loaded only while the setting is on, and the About tab shows the attribution its licence requires.
