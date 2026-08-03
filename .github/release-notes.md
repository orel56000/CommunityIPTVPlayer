## Install

The assets below are named `ctv_<version>_<platform>.<ext>`. On an Apple Silicon Mac take **macos-arm64** — the **macos-x64** build still runs, through Rosetta, but transcodes noticeably slower.

## macOS: "Apple could not verify…"

The macOS builds are not notarized with Apple, so the first launch of a downloaded copy is blocked by Gatekeeper:

> **"Community IPTV Player" Not Opened** — Apple could not verify "Community IPTV Player" is free of malware that may harm your Mac or compromise your privacy.

That dialog offers only **Move to Trash** and **Done**, and since macOS 15 the old Control-click → Open bypass no longer applies to it. It means Gatekeeper cannot trace the app to a developer registered with Apple, not that anything was found in it — clearing it for good requires notarizing every build, which requires a paid Apple Developer Program membership.

Drag the app to your Applications folder, then apply either fix below. Both are one-time, and the app opens normally on every launch afterwards.

**In the terminal:**

```sh
xattr -dr com.apple.quarantine "/Applications/Community IPTV Player.app"
```

**Without the terminal:** open the app, dismiss the warning with **Done**, then go to System Settings → Privacy & Security, scroll down to the Security section, and click **Open Anyway** next to the app's name.
