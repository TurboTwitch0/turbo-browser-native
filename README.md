# TurboBrowser

A real desktop web browser: websites render inside TurboBrowser's own Chromium-powered tabs. It does not open your searches in Chrome, Edge, or another installed browser, and it does not embed arbitrary websites in an iframe.

**Windows x64 · Version 0.3.0 · MIT license**

## Download and run

Download [TurboBrowser.exe](https://github.com/TurboTwitch0/turbo-browser-native/releases/latest/download/TurboBrowser.exe), then open it once. It installs for your Windows user and opens TurboBrowser when installation finishes. Enter a website address or search to start browsing.

After installing, use the **TurboBrowser** desktop or Start menu shortcut. These shortcuts launch the installed browser directly, avoiding the portable bundle's unpacking step on every launch. There is no ZIP to extract or multi-step setup wizard, and installation does not require administrator access. No separate browser or Node.js installation is needed. Your bookmarks, history, settings, and website sessions remain in the app's local user-data directory between launches.

Websites cannot automatically run downloaded programs. After downloading, you open the `.exe` yourself. The build is unsigned and has no automatic updater; download a newer release when one becomes available. Do not bypass Windows or browser security warnings to run a download you do not trust. All releases are available on the [Releases](https://github.com/TurboTwitch0/turbo-browser-native/releases) page.

## What works

- Independent tabs with a real address bar, search, back, forward, reload, stop, and page zoom.
- Websites run JavaScript and render through the Chromium engine bundled with the application.
- Links that request a new window open in another TurboBrowser tab.
- Bookmarks, searchable browsing history, downloads, and page find.
- Private tabs use an in-memory browser session and are omitted from app history and restored sessions. Private browsing does not hide traffic from websites, your network, or your internet provider. Files you download remain on disk.
- Optional **Tor private tabs** route their page traffic through the bundled Tor client. Ordinary tabs and ordinary private tabs connect directly.
- Local preferences, a choice of DuckDuckGo, Google, or Bing for searches, and dark/light appearance.
- Optional restoration of regular tabs when the app starts.

This version does not include account sync, a password manager, browser extension installation, a bundled VPN, or an automatic update service. Some websites restrict sign-in from embedded browsers, and protected streaming services may require DRM components this release does not bundle.

## Optional Tor connection

Choose **New Tor private tab** to start a separate in-memory browsing session over Tor. The app starts its own bundled Tor client only when requested and waits for a successful connection before loading pages. Connecting can take up to 90 seconds; Tor browsing is usually slower than a direct connection. If connection fails or the Tor process stops, these tabs fail without falling back to a direct connection. The app does not change Windows proxy, network, VPN, or service settings.

Your local network and internet provider can see that you connect to Tor. Tor-routed destinations receive connections from Tor exits, but signing in, page content, and browser fingerprinting can still identify you. This is a Chromium browser with an optional Tor connection, **not the hardened Tor Browser**, and it does not guarantee anonymity or hide all network activity. Ordinary private tabs protect local history only; use the separate Tor mode when you want its network routing. See the [Tor Project's explanation of other-browser risks](https://support.torproject.org/tor-browser/security/using-tor-with-other-browsers/) and use [Tor Browser](https://www.torproject.org/download/) when you need its full browser protections.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+L` | Focus the address bar |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close current tab |
| `Ctrl+Shift+T` | Reopen a closed tab |
| `Ctrl+Shift+N` | New private tab |
| `Alt+Left` / `Alt+Right` | Back / forward |
| `Ctrl+R` | Reload |
| `Ctrl+D` | Bookmark current page |
| `Ctrl+H` | History |
| `Ctrl+J` | Downloads |
| `Ctrl+F` | Find in page |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |

## Develop locally

Install [Node.js 24 LTS](https://nodejs.org/) and Git, then run:

```sh
git clone https://github.com/TurboTwitch0/turbo-browser-native.git
cd turbo-browser-native
npm ci
npm start
```

The lockfile pins the dependency graph. The application currently uses Electron 45.1.0 and electron-builder 26.18.0. Keep Electron updated as security fixes become available.

For optional Tor mode in development, run `npm run prepare:tor` once. Windows builds run this step automatically before packaging. It downloads the official Windows x86_64 [Tor Expert Bundle 15.0.26](https://dist.torproject.org/torbrowser/15.0.26/), verifies its pinned SHA-256 against the official release checksum, and includes the bundle's license notices. Cached archives are verified on each preparation. Binaries and cache stay under ignored `.vendor/`; no binary is committed to the repository. Update the pinned bundle and checksum together when a reviewed Tor release becomes available.

## Check and build

```sh
npm run check
npm test
npm run smoke
npm run build:win
```

`check` checks JavaScript syntax. The unit suite covers address interpretation, allowed URL schemes, stored-state validation, damaged-profile preservation, the privileged IPC boundary, and Tor startup, failure, process cleanup, and archive-path validation using test processes. These Tor unit tests do not connect to the public Tor network. The smoke runner opens the source application through the installed Electron development dependency, using an isolated temporary profile, and exercises the embedded browser against a local HTTP fixture. It fails if the engine does not produce a successful result or exits unsuccessfully. It does not use or change your normal browsing profile, and it does not test the generated installer. Validate the packaged installer, installed browser, and real Tor routing separately on Windows before a release.

`build:win` produces the one-click per-user installer `artifacts/TurboBrowser.exe`. Its NSIS configuration installs for the current Windows user, creates desktop and Start menu shortcuts named **TurboBrowser**, and opens the app when installation completes. Subsequent launches use the installed app without re-extracting the whole browser. To produce an unpacked Windows build for development instead:

```sh
npm run build:dir
```

The unpacked application executable is `artifacts/win-unpacked/TurboBrowser.exe`; `artifacts/TurboBrowser.exe` is the installer. Windows is the primary tested platform; macOS and Linux packaging require separate validation and signing where applicable.

## Architecture and local data

`desktop/main.cjs` owns the native window, tabs, sessions, navigation, downloads, and persistence. Each website lives in a `WebContentsView`, with sandboxing and context isolation enabled and Node.js integration disabled. Remote websites receive no privileged preload script.

`desktop/preload.cjs` exposes a narrow command bridge to the local browser interface. Main-process handlers verify that requests originate from the trusted interface's main frame. The local interface in `desktop/shell.html`, `shell.css`, and `shell.js` manages the tabs, toolbar, start page, and panels. `desktop/core.cjs` validates addresses and stored state.

Bookmarks, history, preferences, and the regular tab list are stored locally in the app's Electron user-data directory; website sessions store their own cookies and cache in the browser profile. Search queries go to the selected search provider, and websites receive normal browser requests. There is no project-hosted browsing proxy or account-sync backend.

If `browser.json` is damaged, TurboBrowser verifies an exact recovery copy beside it before saving a fresh profile. The recovery filename remains visible in Settings. Profiles that cannot be read, are not regular files, or are 4 MiB or larger are preserved without replacement; changes then last only for the current session. Close the browser before repairing or restoring a profile. Keep the recovery file until you have recovered any bookmarks or history you need.

For automated checks, set `TURBO_PROFILE_DIR` to an isolated absolute directory. This is intended for development and testing.

## Releases

The CI workflow installs dependencies from the lockfile, checks syntax, runs unit and source-app browser smoke tests, and builds the Windows installer. Pushing a version tag such as `v0.3.0` runs the release workflow and verifies that the tag matches `package.json`. Alternatively, run **Release Windows browser** manually from the **Actions** tab with the `main` branch selected; it derives the release tag from `package.json`. Both routes check out the triggering commit, run the checks and build, and attach **TurboBrowser.exe** and its SHA-256 checksum to the corresponding GitHub release. These automated source-app checks do not prove installer behavior. Release jobs receive repository-content write access; ordinary CI runs use read access only.

A push to `main` also runs the release workflow when the commit message starts with **`Release TurboBrowser `**, such as `Release TurboBrowser 0.3.0`. This explicit release prefix lets a reviewed version bump publish without browser-based manual dispatch. Other `main` pushes run CI without publishing a release. Always bump `package.json` and its lockfile before publishing a new version.

The companion Sites website is a download and documentation page. To browse arbitrary websites, run the desktop application.
