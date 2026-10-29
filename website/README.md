# Turbo Browser download site

Buildless distribution website for the Turbo Browser desktop app. Serve `dist/` using any static HTTP server. The desktop browser embeds Chromium through Electron; the website itself is its download and information page.

The verified source repository is [TurboTwitch0/turbo-browser-native](https://github.com/TurboTwitch0/turbo-browser-native). Download links point to its latest GitHub release and expect the single-file Windows portable app `Turbo-Browser-0.2.0-win-x64.exe`.

Visitors download the `.exe`, then click the downloaded file to open Turbo. No manual extraction or installer wizard is required. First launch opens DuckDuckGo inside Turbo; later launches can restore the visitor’s tabs when session restoration is enabled. Downloading does not automatically execute the app. The release remains unsigned and has no automatic updater.

The website includes responsive navigation, keyboard-accessible installation tabs, command copying with a manual fallback, and native FAQ disclosures. Fonts use Google Fonts with system-font fallbacks. There are no analytics or application network requests.

Check JavaScript syntax with `node --check dist/app.js`. No dependency installation or build step is required.
