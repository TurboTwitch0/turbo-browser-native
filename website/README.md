# TurboBrowser download site

Buildless distribution website for the TurboBrowser desktop app. Serve `dist/` using any static HTTP server. The desktop browser embeds Chromium through Electron; the website itself is its download and information page.

The verified source repository is [TurboTwitch0/turbo-browser-native](https://github.com/TurboTwitch0/turbo-browser-native). Download links are pinned to the [v0.3.0 Windows installer](https://github.com/TurboTwitch0/turbo-browser-native/releases/download/v0.3.0/TurboBrowser.exe), named exactly `TurboBrowser.exe`. Release notes and checksums link to [the same v0.3.0 release](https://github.com/TurboTwitch0/turbo-browser-native/releases/tag/v0.3.0). Version badges show v0.3.0; the filename intentionally contains no version suffix.

Visitors download `TurboBrowser.exe` and run the installer once. After setup, they launch the installed app from its desktop or Start menu shortcut, rather than rerunning the downloaded installer. First launch opens DuckDuckGo inside TurboBrowser; later launches can restore tab addresses and load background tabs when selected. Downloading does not automatically execute the installer. The release remains unsigned and has no automatic updater.

Device-private tabs use a temporary session and do not save browsing history; they do not hide traffic from websites, internet providers, or the network. Optional Tor private tabs route destination requests through Tor only after connecting and block page requests when the connection fails. The local network can still see Tor in use. Tor may be slower, and this app does not provide the full Tor Browser’s anonymity guarantees. Publish these Tor descriptions only with the verified Tor-enabled release.

The website includes responsive navigation, keyboard-accessible installation tabs, command copying with a manual fallback, and native FAQ disclosures. Fonts use Google Fonts with system-font fallbacks. There are no analytics or application network requests.

Check JavaScript syntax with `node --check dist/app.js`. No dependency installation or build step is required.
