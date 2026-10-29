# Turbo Browser

A real desktop web browser: websites render inside Turbo Browser's own Chromium-powered tabs. It does not open your searches in Chrome, Edge, or another installed browser, and it does not embed arbitrary websites in an iframe.

**Windows x64 · Version 0.1.0 · MIT license**

## Download and run

Download `Turbo-Browser-0.1.0-win-x64.zip` from this repository's [Releases](https://github.com/TurboTwitch0/turbo-browser-native/releases) page. Extract **the entire ZIP** into a folder, then open `Turbo Browser.exe` inside that folder. Keep its accompanying files together. No Node.js installation is required to run a packaged release.

The initial release is unsigned. There is no automatic updater; install a newer release when one becomes available. Do not bypass Windows or browser security warnings to run a download you do not trust.

## What works

- Independent tabs with a real address bar, search, back, forward, reload, stop, and page zoom.
- Websites run JavaScript and render through the Chromium engine bundled with the application.
- Links that request a new window open in another Turbo Browser tab.
- Bookmarks, searchable browsing history, downloads, and page find.
- Private tabs use an in-memory browser session and are omitted from app history and restored sessions. Private browsing does not hide traffic from websites, your network, or your internet provider. Files you download remain on disk.
- Local preferences, a choice of DuckDuckGo, Google, or Bing for searches, and dark/light appearance.
- Optional restoration of regular tabs when the app starts.

This first version does not include account sync, a password manager, browser extension installation, or an automatic update service. Some websites restrict sign-in from embedded browsers, and protected streaming services may require DRM components this release does not bundle.

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

## Check and build

```sh
npm run check
npm test
npm run smoke
npm run build:win
```

`check` checks JavaScript syntax. The unit suite covers address interpretation, allowed URL schemes, stored-state validation, and the privileged IPC boundary. The smoke runner opens the actual Electron application with an isolated temporary profile and exercises the embedded browser against a local HTTP fixture. It fails if the engine does not produce a successful result or exits unsuccessfully. It does not use or change your normal browsing profile.

`build:win` produces `artifacts/Turbo-Browser-0.1.0-win-x64.zip`. To produce an unpacked Windows build instead:

```sh
npm run build:dir
```

The packaged executable is `artifacts/win-unpacked/Turbo Browser.exe`. Windows is the primary tested platform; macOS and Linux packaging require separate validation and signing where applicable.

## Architecture and local data

`desktop/main.cjs` owns the native window, tabs, sessions, navigation, downloads, and persistence. Each website lives in a `WebContentsView`, with sandboxing and context isolation enabled and Node.js integration disabled. Remote websites receive no privileged preload script.

`desktop/preload.cjs` exposes a narrow command bridge to the local browser interface. Main-process handlers verify that requests originate from the trusted interface's main frame. The local interface in `desktop/shell.html`, `shell.css`, and `shell.js` manages the tabs, toolbar, start page, and panels. `desktop/core.cjs` validates addresses and stored state.

Bookmarks, history, preferences, and the regular tab list are stored locally in the app's Electron user-data directory; website sessions store their own cookies and cache in the browser profile. Search queries go to the selected search provider, and websites receive normal browser requests. There is no project-hosted browsing proxy or account-sync backend.

For automated checks, set `TURBO_PROFILE_DIR` to an isolated absolute directory. This is intended for development and testing.

## Releases

The CI workflow installs dependencies from the lockfile, checks syntax, runs unit and browser smoke tests, and builds a Windows archive. Pushing a version tag such as `v0.1.0` runs the release workflow and verifies that the tag matches `package.json`. Alternatively, run **Release Windows browser** manually from the **Actions** tab with the `main` branch selected; it derives the release tag from `package.json`. Both routes check out the triggering commit, run the checks and build, and attach the Windows ZIP and its SHA-256 checksum to the corresponding GitHub release. Release jobs receive repository-content write access; ordinary CI runs use read access only.

The companion Sites website is a download and documentation page. To browse arbitrary websites, run the desktop application.
