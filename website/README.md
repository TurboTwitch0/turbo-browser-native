# Turbo Browser download site

Buildless distribution website for the Turbo Browser desktop app. Serve `dist/` using any static HTTP server. The desktop browser embeds Chromium through Electron; the website itself is its download and information page.

The verified source repository is [TurboTwitch0/turbo-browser-native](https://github.com/TurboTwitch0/turbo-browser-native). Download links point to its latest GitHub release and expect a ZIP named `Turbo-Browser-0.1.0-win-x64.zip`.

The website includes responsive navigation, keyboard-accessible installation tabs, command copying with a manual fallback, and native FAQ disclosures. Fonts use Google Fonts with system-font fallbacks. There are no analytics or application network requests.

Check JavaScript syntax with `node --check dist/app.js`. No dependency installation or build step is required.
