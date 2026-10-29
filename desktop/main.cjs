'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, shell, session, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { NEW_TAB, safeWebURL, normalizeAddress, sanitizeSettings, sanitizeStore, isTrustedIPC } = require('./core.cjs');

const smokeMode = process.argv.includes('--smoke-test');
if (process.env.TURBO_PROFILE_DIR && path.isAbsolute(process.env.TURBO_PROFILE_DIR)) app.setPath('userData', process.env.TURBO_PROFILE_DIR);
else if (smokeMode) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'turbobrowser-smoke-')));
app.setName('TurboBrowser');
app.enableSandbox();

const shellURL = pathToFileURL(path.join(__dirname, 'shell.html')).href;
const profilePath = path.join(app.getPath('userData'), 'browser.json');
const tabs = [];
const recentlyClosed = [];
const downloads = [];
const configuredSessions = new WeakSet();
let store = sanitizeStore(null);
let win;
let activeId;
let overlayOpen = false;
let persistTimer;
let shutdown = false;
let storageError = '';
let findResult = null;
let privatePartition = `private-${randomUUID()}`;

function loadProfile() {
  try {
    if (fs.existsSync(profilePath) && fs.statSync(profilePath).size < 4 * 1024 * 1024) {
      store = sanitizeStore(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
    }
  } catch { storageError = 'Your saved profile could not be read. This session starts with the default settings.'; }
}

function persist() {
  clearTimeout(persistTimer);
  const snapshot = {
    settings: store.settings,
    bookmarks: store.bookmarks,
    history: store.history,
    tabs: store.settings.restoreSession ? tabs.filter(tab => !tab.private).map(tab => ({ url: tab.url })) : []
  };
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    const temporary = `${profilePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporary, profilePath);
    storageError = '';
  } catch { storageError = 'Changes could not be saved to your browser profile. They will last for this session.'; }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  if (!shutdown) persistTimer = setTimeout(persist, 200);
}

function currentTab() { return tabs.find(tab => tab.id === activeId); }
function liveContents(tab = currentTab()) { return tab?.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null; }
function tabState(tab) {
  const contents = liveContents(tab);
  return {
    id: tab.id, title: tab.title, url: tab.url, private: tab.private,
    loading: tab.loading, error: tab.error || '',
    canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
    canGoForward: Boolean(contents?.navigationHistory.canGoForward()),
    zoom: contents?.getZoomFactor() || 1
  };
}
function state() {
  return {
    tabs: tabs.map(tabState), activeId,
    bookmarks: store.bookmarks, history: store.history,
    downloads: downloads.map(({ item, private: isPrivate, ...download }) => download),
    settings: store.settings,
    versions: { electron: process.versions.electron, chromium: process.versions.chrome },
    isMaximized: Boolean(win && !win.isDestroyed() && win.isMaximized()),
    storageError, findResult, overlayOpen
  };
}
function broadcast() {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('turbo:state', state());
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  for (const tab of tabs) {
    if (!tab.view) continue;
    const visible = tab.id === activeId && tab.url !== NEW_TAB && !tab.error && !overlayOpen;
    tab.view.setVisible(visible);
    if (visible) tab.view.setBounds({ x: 0, y: 106, width, height: Math.max(0, height - 106) });
  }
}
function shortcut(name) {
  if (!win || win.isDestroyed()) return;
  win.webContents.focus();
  win.webContents.send('turbo:shortcut', name);
}

function bindShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const primary = input.control || input.meta;
    let handled = true;
    if (primary && key === 'l') shortcut('focus-address');
    else if (primary && key === 't' && input.shift) reopenTab();
    else if (primary && key === 't') { if (tabs.length < 50) createTab(NEW_TAB, false); shortcut('focus-address'); }
    else if (primary && key === 'n' && input.shift) { if (tabs.length < 50) createTab(NEW_TAB, true); shortcut('focus-address'); }
    else if (primary && key === 'w') closeTab(activeId);
    else if (primary && key === 'r') reloadCurrent(input.shift);
    else if (primary && key === 'd') toggleBookmark();
    else if (primary && key === 'h') shortcut('history');
    else if (primary && key === 'j') shortcut('downloads');
    else if (primary && key === 'b') shortcut('toggle-bookmarks');
    else if (primary && key === 'f') shortcut('find');
    else if (primary && ['+', '='].includes(key)) zoom(0.1);
    else if (primary && key === '-') zoom(-0.1);
    else if (primary && key === '0') zoom(0, true);
    else if (primary && key === 'tab') cycleTab(input.shift ? -1 : 1);
    else if (primary && /^[1-9]$/.test(key)) { const tab = tabs[key === '9' ? tabs.length - 1 : Number(key) - 1]; if (tab) switchTab(tab.id); }
    else if (input.alt && key === 'arrowleft') goHistory('back');
    else if (input.alt && key === 'arrowright') goHistory('forward');
    else if (key === 'f5') reloadCurrent(input.shift);
    else if (key === 'f11') win.setFullScreen(!win.isFullScreen());
    else if (key === 'escape') { liveContents()?.stop(); if (win.isFullScreen()) win.setFullScreen(false); shortcut('escape'); }
    else handled = false;
    if (handled) event.preventDefault();
  });
}

function configureSession(ses) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  const grants = new Set();
  const supportedPermissions = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'fullscreen', 'pointerLock']);
  ses.setPermissionCheckHandler((_contents, permission, origin) => grants.has(`${origin}|${permission}`));
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const tab = tabs.find(item => liveContents(item) === contents);
    const requestingURL = details.requestingUrl || contents.getURL();
    const safeURL = safeWebURL(requestingURL);
    const topURL = safeWebURL(contents.getURL());
    if (!tab || !safeURL || !topURL || !supportedPermissions.has(permission) || !win || win.isDestroyed()) { callback(false); return; }
    const origin = new URL(safeURL).origin;
    // Cross-origin frames cannot ask for device access on behalf of the page.
    // Match the actual top-level HTTP(S) origin before showing a native prompt.
    if (new URL(topURL).origin !== origin) { callback(false); return; }
    const key = `${origin}|${permission}`;
    if (grants.has(key)) { callback(true); return; }
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: 'Website permission',
        message: `${origin} wants permission for ${permission === 'media' ? 'your camera or microphone' : permission}.`,
        detail: 'Allow this website for the current browser session?',
        buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, noLink: true
      });
      const allowed = result.response === 1 && tabs.includes(tab) && new URL(contents.getURL()).origin === origin;
      if (allowed) grants.add(key);
      callback(allowed);
    } catch { callback(false); }
  });
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (_event, item, source) => {
    const tab = tabs.find(candidate => liveContents(candidate) === source);
    const download = {
      id: randomUUID(), filename: item.getFilename(), path: '',
      state: 'progressing', received: 0, total: item.getTotalBytes(), item, private: Boolean(tab?.private)
    };
    if (smokeMode) {
      item.setSavePath(path.join(app.getPath('userData'), path.basename(item.getFilename())));
    } else {
      item.setSaveDialogOptions({
        title: 'Save download', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())),
        buttonLabel: 'Save', properties: ['showOverwriteConfirmation']
      });
    }
    downloads.unshift(download);
    if (downloads.length > 100) downloads.splice(100);
    item.on('updated', (_updateEvent, status) => {
      download.state = status;
      download.received = item.getReceivedBytes();
      download.total = item.getTotalBytes();
      broadcast();
    });
    item.once('done', (_doneEvent, status) => {
      download.state = status;
      download.path = item.getSavePath();
      download.received = item.getReceivedBytes();
      download.total = item.getTotalBytes();
      broadcast();
    });
    broadcast();
  });
}

function remember(tab) {
  if (tab.private || tab.url === NEW_TAB || !safeWebURL(tab.url) || tab.error) return;
  const last = store.history[0];
  if (last?.url === tab.url) { last.title = tab.title; last.visitedAt = Date.now(); }
  else store.history.unshift({ url: tab.url, title: tab.title, visitedAt: Date.now() });
  store.history = store.history.slice(0, 1000);
  schedulePersist();
}

function createView(tab) {
  const ses = session.fromPartition(tab.partition);
  configureSession(ses);
  const view = new WebContentsView({ webPreferences: {
    session: ses, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    safeDialogs: true, navigateOnDragDrop: false
  } });
  tab.view = view;
  win.contentView.addChildView(view);
  view.setVisible(false);
  const contents = view.webContents;
  bindShortcuts(contents);
  contents.setWindowOpenHandler(details => {
    const url = safeWebURL(details.url);
    if (url && tabs.length < 50) createTab(url, tab.private, details.disposition === 'background-tab');
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!safeWebURL(url)) { event.preventDefault(); tab.error = 'This link uses an unsupported address. TurboBrowser opens http and https websites.'; layout(); broadcast(); }
  });
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !safeWebURL(url)) { event.preventDefault(); tab.error = 'This website redirected to an unsupported address.'; layout(); broadcast(); }
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('did-start-loading', () => { if (tab.url !== NEW_TAB) { tab.loading = true; broadcast(); } });
  contents.on('did-stop-loading', () => { tab.loading = false; layout(); broadcast(); });
  const navigated = (_event, url) => {
    if (tab.url === NEW_TAB || !safeWebURL(url)) return;
    tab.url = url; tab.error = ''; tab.title = contents.getTitle() || new URL(url).hostname;
    remember(tab); layout(); broadcast();
  };
  contents.on('did-navigate', navigated);
  contents.on('did-navigate-in-page', (event, url, isMainFrame) => { if (isMainFrame) navigated(event, url); });
  contents.on('page-title-updated', (_event, title) => {
    if (tab.url === NEW_TAB) return;
    tab.title = title.slice(0, 300) || new URL(tab.url).hostname;
    if (!tab.private && store.history[0]?.url === tab.url) { store.history[0].title = tab.title; schedulePersist(); }
    broadcast();
  });
  contents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3 || tab.url === NEW_TAB) return;
    tab.loading = false;
    if (safeWebURL(validatedURL)) tab.url = validatedURL;
    tab.error = `This page could not be loaded. ${description} (${code}). Check the address and your connection, then try again.`;
    layout(); broadcast();
  });
  contents.on('render-process-gone', (_event, details) => {
    if (!tabs.includes(tab) || shutdown) return;
    tab.loading = false; tab.error = `This tab stopped responding (${details.reason}). Reload to try again.`;
    layout(); broadcast();
  });
  contents.on('found-in-page', (_event, result) => {
    if (tab.id === activeId) { findResult = { matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal }; broadcast(); }
  });
  contents.on('context-menu', (_event, params) => {
    const entries = [];
    const link = safeWebURL(params.linkURL);
    if (link) entries.push({ label: 'Open link in new tab', click: () => createTab(link, tab.private) });
    if (params.selectionText) entries.push({ role: 'copy' });
    if (params.isEditable) entries.push({ role: 'cut' }, { role: 'paste' }, { role: 'selectAll' });
    if (entries.length) entries.push({ type: 'separator' });
    entries.push({ label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Reload', click: () => contents.reload() });
    Menu.buildFromTemplate(entries).popup({ window: win });
  });
  return contents;
}

function createTab(value = NEW_TAB, isPrivate = false, background = false) {
  if (tabs.length >= 50) throw new Error('You have 50 tabs open. Close a tab before opening another.');
  const url = normalizeAddress(value, store.settings.searchEngine);
  const tab = { id: randomUUID(), title: isPrivate ? 'Private tab' : 'New tab', url: NEW_TAB, private: Boolean(isPrivate), partition: isPrivate ? privatePartition : 'persist:turbobrowser', loading: false, error: '', view: null };
  tabs.push(tab);
  if (!background || !activeId) activeId = tab.id;
  overlayOpen = false;
  if (url !== NEW_TAB) navigateTab(tab, url);
  schedulePersist(); layout(); broadcast();
  return tab;
}

function navigateTab(tab, value) {
  const url = normalizeAddress(value, store.settings.searchEngine);
  tab.error = ''; findResult = null;
  overlayOpen = false;
  if (url === NEW_TAB) {
    const contents = liveContents(tab);
    contents?.stop();
    tab.url = NEW_TAB; tab.title = tab.private ? 'Private tab' : 'New tab'; tab.loading = false;
    // Replace the document so media, timers and network requests from the old
    // site do not continue behind the internal start page. Keep Chromium's
    // navigation stack so Back can still return to the previous website.
    contents?.loadURL('about:blank').catch(() => {});
  } else {
    tab.url = url; tab.title = new URL(url).hostname; tab.loading = true;
    const contents = liveContents(tab) || createView(tab);
    contents.loadURL(url).catch(error => {
      if (!tabs.includes(tab) || tab.url === NEW_TAB || error.code === 'ERR_ABORTED') return;
      if (!tab.error) { tab.error = `This page could not be loaded. ${error.code || 'Check your connection and try again.'}`; tab.loading = false; layout(); broadcast(); }
    });
    if (tab.id === activeId) contents.focus();
  }
  schedulePersist(); layout(); broadcast();
}

function switchTab(id) {
  const tab = tabs.find(candidate => candidate.id === id);
  if (!tab) return;
  activeId = id; overlayOpen = false; findResult = null;
  layout(); broadcast();
  if (tab.url !== NEW_TAB && !tab.error) liveContents(tab)?.focus();
}
function cycleTab(offset) {
  const index = tabs.findIndex(tab => tab.id === activeId);
  if (tabs.length) switchTab(tabs[(index + offset + tabs.length) % tabs.length].id);
}
function closeTab(id) {
  const index = tabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  const tab = tabs[index];
  if (!tab.private) { recentlyClosed.unshift({url:tab.url}); recentlyClosed.splice(20); }
  tabs.splice(index, 1);
  if (tab.view) {
    win.contentView.removeChildView(tab.view);
    const contents = liveContents(tab);
    if (contents) contents.close({ waitForBeforeUnload: false });
  }
  if (tab.private && !tabs.some(candidate => candidate.private)) {
    for (const download of downloads.filter(item => item.private)) { if (download.state === 'progressing' || download.state === 'interrupted') download.item?.cancel(); }
    for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].private) downloads.splice(i, 1);
    session.fromPartition(tab.partition).clearStorageData().catch(() => {});
    session.fromPartition(tab.partition).clearCache().catch(() => {});
    privatePartition = `private-${randomUUID()}`;
  }
  if (!tabs.length) createTab();
  else if (activeId === id) switchTab(tabs[Math.min(index, tabs.length - 1)].id);
  schedulePersist(); layout(); broadcast();
}
function reopenTab() { if (tabs.length >= 50) return; const entry = recentlyClosed.shift(); if (entry) createTab(entry.url); }
function goHistory(direction) {
  const tab = currentTab();
  const contents = liveContents(tab);
  if (!contents) return;
  const nav = contents.navigationHistory;
  if (direction === 'back' && nav.canGoBack()) {
    tab.error = ''; tab.url = nav.getEntryAtIndex(nav.getActiveIndex() - 1).url;
    if (tab.url === 'about:blank') { tab.url = NEW_TAB; tab.title = tab.private ? 'Private tab' : 'New tab'; }
    nav.goBack();
  } else if (direction === 'forward' && nav.canGoForward()) {
    tab.error = ''; tab.url = nav.getEntryAtIndex(nav.getActiveIndex() + 1).url;
    if (tab.url === 'about:blank') { tab.url = NEW_TAB; tab.title = tab.private ? 'Private tab' : 'New tab'; }
    nav.goForward();
  }
  overlayOpen = false; layout(); broadcast();
}
function reloadCurrent(ignoreCache = false) {
  const tab = currentTab();
  if (!tab || tab.url === NEW_TAB) return;
  tab.error = ''; overlayOpen = false;
  const contents = liveContents(tab);
  if (!contents) navigateTab(tab, tab.url);
  else if (ignoreCache) contents.reloadIgnoringCache();
  else contents.reload();
  layout(); broadcast();
}
function toggleBookmark() {
  const tab = currentTab();
  if (!tab || !safeWebURL(tab.url)) return;
  const index = store.bookmarks.findIndex(bookmark => bookmark.url === tab.url);
  if (index >= 0) store.bookmarks.splice(index, 1);
  else if (store.bookmarks.length < 500) store.bookmarks.unshift({ url: tab.url, title: tab.title });
  schedulePersist(); broadcast();
}
function zoom(delta, reset = false) {
  const contents = liveContents();
  if (contents) contents.setZoomFactor(reset ? 1 : Math.max(0.5, Math.min(2.5, Math.round((contents.getZoomFactor() + delta) * 10) / 10)));
  broadcast();
}

async function command(action, payload = {}) {
  const data = payload && typeof payload === 'object' ? payload : {};
  switch (action) {
    case 'get-state': break;
    case 'new-tab': createTab(typeof data.url === 'string' ? data.url : NEW_TAB, data.private === true); break;
    case 'navigate': if (currentTab()) navigateTab(currentTab(), data.value); break;
    case 'switch-tab': switchTab(data.id); break;
    case 'close-tab': closeTab(data.id || activeId); break;
    case 'reopen-tab': reopenTab(); break;
    case 'back': goHistory('back'); break;
    case 'forward': goHistory('forward'); break;
    case 'reload': reloadCurrent(); break;
    case 'stop': liveContents()?.stop(); break;
    case 'home': navigateTab(currentTab(), NEW_TAB); break;
    case 'bookmark': toggleBookmark(); break;
    case 'remove-bookmark': store.bookmarks = store.bookmarks.filter(bookmark => bookmark.url !== data.url); schedulePersist(); break;
    case 'clear-history': store.history = []; schedulePersist(); break;
    case 'settings': store.settings = sanitizeSettings({...store.settings, ...data}); nativeTheme.themeSource = store.settings.theme; schedulePersist(); break;
    case 'set-overlay': overlayOpen = data.open === true; layout(); break;
    case 'open-download': {
      const download = downloads.find(item => item.id === data.id && item.state === 'completed');
      if (download?.path && fs.existsSync(download.path)) shell.showItemInFolder(download.path);
      break;
    }
    case 'clear-downloads': for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1); break;
    case 'zoom-in': zoom(0.1); break;
    case 'zoom-out': zoom(-0.1); break;
    case 'zoom-reset': zoom(0, true); break;
    case 'find': {
      const contents = liveContents();
      const text = typeof data.text === 'string' ? data.text.slice(0, 1000) : '';
      if (contents && text) contents.findInPage(text, { forward: data.forward !== false, findNext: true });
      else { contents?.stopFindInPage('clearSelection'); findResult = null; }
      break;
    }
    case 'stop-find': liveContents()?.stopFindInPage('clearSelection'); findResult = null; break;
    case 'focus-page': liveContents()?.focus(); break;
    case 'minimize': win.minimize(); break;
    case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'close-window': win.close(); break;
    default: throw new Error('Unknown browser command.');
  }
  broadcast();
  return state();
}

async function createWindow() {
  shutdown = false;
  win = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 600,
    title: 'TurboBrowser', backgroundColor: '#101219', frame: false, show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
      webviewTag: false, navigateOnDragDrop: false
    }
  });
  win.webContents.on('will-navigate', (event, url) => { if (url !== shellURL) event.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  bindShortcuts(win.webContents);
  win.on('resize', layout);
  win.on('maximize', broadcast);
  win.on('unmaximize', broadcast);
  win.on('close', () => {
    persist(); shutdown = true;
    clearTimeout(persistTimer);
    for (const tab of tabs) {
      if (!tab.view) continue;
      win.contentView.removeChildView(tab.view);
      liveContents(tab)?.close({ waitForBeforeUnload: false });
    }
    tabs.length = 0; activeId = null;
  });
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  await win.loadFile(path.join(__dirname, 'shell.html'));
  const restored = store.settings.restoreSession ? store.tabs : [];
  if (restored.length && !smokeMode) {
    for (const entry of restored) createTab(entry.url, false, tabs.length > 0);
  } else createTab();
  broadcast();
}

ipcMain.handle('turbo:command', (event, action, payload) => {
  if (!isTrustedIPC(event, win?.webContents, shellURL)) throw new Error('Browser commands are only available to the trusted browser interface.');
  return command(action, payload);
});

Menu.setApplicationMenu(null);
app.whenReady().then(async () => {
  loadProfile();
  nativeTheme.themeSource = store.settings.theme;
  await createWindow();
  if (smokeMode) await runSmokeTest();
}).catch(error => {
  if (smokeMode) finishSmoke({ passed: false, error: error.stack || String(error) }, 1);
  else { dialog.showErrorBox('TurboBrowser could not start', error.message); app.quit(); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smokeMode) app.quit(); });
app.on('activate', () => { if (!win) { loadProfile(); createWindow().catch(error => dialog.showErrorBox('TurboBrowser could not start', error.message)); } });
app.on('before-quit', () => { if (!shutdown) persist(); });

// This mode uses an isolated temporary profile and an owned local fixture. It is
// deliberately unavailable through renderer IPC and never touches a normal profile.
async function runSmokeTest() {
  const http = require('node:http');
  const assert = require('node:assert/strict');
  const checks = [];
  let server;
  const waitFor = async (predicate, label, timeout = 15000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    server = http.createServer((request, response) => {
      if (request.url === '/download') {
        response.writeHead(200, {'Content-Type':'text/plain', 'Content-Disposition':'attachment; filename="turbo-smoke.txt"'});
        response.end('TurboBrowser download fixture'); return;
      }
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      response.end(`<!doctype html><html><head><title>Turbo ${request.url === '/two' ? 'Two' : 'One'}</title></head><body><h1 id="message">Rendered in TurboBrowser</h1><script>document.body.dataset.javascript = 'working';</script><a href="/two">Next</a></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const first = currentTab();
    navigateTab(first, `${origin}/one`);
    await waitFor(() => !first.loading && first.title === 'Turbo One', 'render first page');
    const contents = liveContents(first);
    assert.equal(await contents.executeJavaScript('document.body.dataset.javascript'), 'working');
    assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), 'Rendered in TurboBrowser');
    checks.push('WebContentsView renders real HTML and runs website JavaScript');
    assert.deepEqual(await contents.executeJavaScript('[typeof require, typeof process, typeof window.turbo]'), ['undefined','undefined','undefined']);
    const preferences = contents.getLastWebPreferences();
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
    checks.push('Remote renderer has no Node.js or privileged browser bridge and remains sandboxed');
    navigateTab(first, `${origin}/two`);
    await waitFor(() => !first.loading && first.title === 'Turbo Two', 'navigate second page');
    assert.equal(contents.navigationHistory.canGoBack(), true);
    goHistory('back');
    await waitFor(() => !first.loading && first.title === 'Turbo One', 'back navigation');
    goHistory('forward');
    await waitFor(() => !first.loading && first.title === 'Turbo Two', 'forward navigation');
    checks.push('Independent Chromium back and forward navigation works');
    toggleBookmark(); assert.equal(store.bookmarks[0].url, `${origin}/two`);
    toggleBookmark(); assert.equal(store.bookmarks.length, 0);
    checks.push('Bookmark add and remove works');
    const beforePopup = tabs.length;
    await contents.executeJavaScript(`window.open(${JSON.stringify(`${origin}/one`)}, '_blank'); void 0;`, true);
    await waitFor(() => tabs.length === beforePopup + 1 && currentTab().title === 'Turbo One' && !currentTab().loading, 'popup opens in own browser tab');
    checks.push('Website popup links open in TurboBrowser tabs without an external browser');
    closeTab(activeId); switchTab(first.id);
    const privateTab = createTab(`${origin}/private`, true);
    await waitFor(() => !privateTab.loading && !privateTab.error, 'private tab');
    assert.notEqual(liveContents(privateTab).session, contents.session);
    assert.equal(store.history.some(entry => entry.url === `${origin}/private`), false);
    persist();
    assert.equal(JSON.parse(fs.readFileSync(profilePath, 'utf8')).tabs.some(entry => entry.url === `${origin}/private`), false);
    checks.push('Private tabs use a separate in-memory session and never persist history or tab URLs');
    closeTab(privateTab.id); switchTab(first.id);
    contents.downloadURL(`${origin}/download`);
    await waitFor(() => downloads.some(download => download.state === 'completed'), 'download completes');
    const downloaded = downloads.find(download => download.state === 'completed');
    assert.equal(fs.readFileSync(downloaded.path,'utf8'), 'TurboBrowser download fixture');
    checks.push('Chromium downloads write the expected file and report completion');
    overlayOpen = true; layout(); assert.equal(first.view.getVisible(), false);
    overlayOpen = false; layout(); assert.equal(first.view.getVisible(), true);
    checks.push('Browser overlays correctly hide and restore the native page view');
    navigateTab(first, NEW_TAB);
    await waitFor(() => contents.getURL() === 'about:blank' && !contents.isLoading(), 'home replaces old document');
    assert.equal(first.url, NEW_TAB);
    assert.equal(first.view.getVisible(), false);
    goHistory('back');
    await waitFor(() => !first.loading && first.title === 'Turbo Two', 'back from home');
    checks.push('Home stops the old website document and Back returns to it');
    const shellInfo = await win.webContents.executeJavaScript('({bridge:typeof window.turbo?.command, title:document.title})');
    assert.equal(shellInfo.bridge,'function');
    const ipcState = await win.webContents.executeJavaScript('window.turbo.command("get-state")');
    assert.equal(ipcState.tabs.length,tabs.length);
    checks.push('Trusted shell preload and IPC state retrieval work');
    if (process.argv.includes('--smoke-screenshots')) {
      const outputArg = process.argv.find(value => value.startsWith('--smoke-output='));
      const outputDir = outputArg ? path.dirname(outputArg.slice('--smoke-output='.length)) : app.getPath('userData');
      await fs.promises.mkdir(outputDir,{recursive:true});
      fs.writeFileSync(path.join(outputDir,'browser-rendered.png'), (await win.webContents.capturePage()).toPNG());
      navigateTab(first,NEW_TAB);
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(path.join(outputDir,'browser-newtab.png'), (await win.webContents.capturePage()).toPNG());
    }
    finishSmoke({ passed:true, checks, versions:process.versions, profile:app.getPath('userData') }, 0);
  } catch (error) { finishSmoke({passed:false,checks,error:error.stack || String(error)},1); }
  finally { server?.close(); }
}

function finishSmoke(result, exitCode) {
  const argument = process.argv.find(value => value.startsWith('--smoke-output='));
  if (argument) {
    const destination = argument.slice('--smoke-output='.length);
    if (path.isAbsolute(destination)) { fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.writeFileSync(destination, JSON.stringify(result,null,2)); }
  }
  console.log(JSON.stringify(result));
  process.exitCode = exitCode;
  app.exit(exitCode);
}
