'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, shell, session, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { NEW_TAB, safeWebURL, normalizeAddress, sanitizeSettings, sanitizeStore, isTrustedIPC, startupURLs, rasterDataURL, configureTorProxy } = require('./core.cjs');
const { createProfileRepository } = require('./profile.cjs');

const smokeMode = process.argv.includes('--smoke-test');
if (process.env.TURBO_PROFILE_DIR && path.isAbsolute(process.env.TURBO_PROFILE_DIR)) app.setPath('userData', process.env.TURBO_PROFILE_DIR);
else if (smokeMode) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'turbobrowser-smoke-')));
app.setName('TurboBrowser');
app.enableSandbox();

const shellURL = pathToFileURL(path.join(__dirname, 'shell.html')).href;
const profilePath = path.join(app.getPath('userData'), 'browser.json');
const profileRepository = createProfileRepository(profilePath);
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
let torPartition = `tor-private-${randomUUID()}`;
let torManager;
let torGeneration = 0;
let torLifecycleState = 'stopped';
let torProgress = 0;
const torSessionPromises = new Map();
let torDataDirectory;
let torQuitInProgress = false;
const ownedTorDirectories = new Set();

async function stopOwnedTor() {
  const child = torManager?.child;
  const directory = torDataDirectory;
  torDataDirectory = null;
  torManager?.close();
  if (!directory || !ownedTorDirectories.has(directory)) return;
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('turbobrowser-tor-')) return;
  if (child && child.exitCode == null) await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  try { await fs.promises.rm(resolved, {recursive:true,force:true,maxRetries:5,retryDelay:150}); ownedTorDirectories.delete(directory); }
  catch { /* A locked Tor metadata cache may remain in its controlled temp directory; no browsing profile is stored there. */ }
}

function failTorTabs(message) {
  torSessionPromises.clear();
  for (const tab of tabs.filter(candidate => candidate.privateMode === 'tor')) {
    tab.networkStatus = 'error'; tab.loading = false;
    tab.error = `${message} This tab has not fallen back to a direct connection. Retry to reconnect to Tor.`;
    const contents = liveContents(tab);
    if (contents) {
      contents.stop(); tab.view.setVisible(false);
      win?.contentView.removeChildView(tab.view);
      contents.close({ waitForBeforeUnload: false }); tab.view = null;
    }
  }
  layout(); broadcast();
}

function getTorManager() {
  if (torManager && !['error', 'stopped'].includes(torLifecycleState)) return torManager;
  const generation = ++torGeneration;
  void stopOwnedTor();
  const { TorManager } = require('./tor.cjs');
  const executablePath = app.isPackaged ? path.join(process.resourcesPath, 'tor', 'tor', 'tor.exe')
    : path.join(__dirname, '..', '.vendor', 'tor', 'tor', 'tor.exe');
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'turbobrowser-tor-'));
  torDataDirectory = dataDirectory; ownedTorDirectories.add(dataDirectory);
  torLifecycleState = 'starting';
  torManager = new TorManager({ executablePath, dataDirectory, onStatus(status) {
    if (generation !== torGeneration || shutdown) return;
    torLifecycleState = status.state; torProgress = status.progress || 0;
    if (['error', 'stopped'].includes(status.state)) failTorTabs(status.message || 'Tor is unavailable.');
    else if (['starting', 'connecting'].includes(status.state)) {
      for (const tab of tabs.filter(candidate => candidate.privateMode === 'tor')) tab.networkStatus = 'connecting';
      broadcast();
    }
    // A daemon being ready is not enough: each browsing session must have its
    // fixed proxy configured before that tab can be marked connected.
  } });
  return torManager;
}

async function ensureTorSession(tab) {
  if (tab.privateMode !== 'tor') return;
  tab.networkStatus = 'connecting'; broadcast();
  let pending = torSessionPromises.get(tab.partition);
  if (!pending) {
    pending = (async () => {
      const manager = getTorManager();
      const generation = torGeneration;
      const port = await manager.connect();
      const browsingSession = session.fromPartition(tab.partition);
      await configureTorProxy(browsingSession, port);
      if (generation !== torGeneration || torLifecycleState !== 'connected') throw new Error('The Tor connection ended before this tab was ready.');
    })();
    torSessionPromises.set(tab.partition, pending);
    pending.catch(() => { if (torSessionPromises.get(tab.partition) === pending) torSessionPromises.delete(tab.partition); });
  }
  try {
    await pending;
    if (torLifecycleState !== 'connected') throw new Error('Tor is no longer connected.');
    if (tabs.includes(tab)) { tab.networkStatus = 'connected'; broadcast(); }
  } catch (error) {
    if (tabs.includes(tab)) { tab.networkStatus = 'error'; tab.loading = false; tab.error = `Tor could not connect. ${error.message} No direct connection was used.`; layout(); broadcast(); }
    throw error;
  }
}

function loadProfile() {
  const loaded = profileRepository.load();
  store = loaded.store;
  storageError = loaded.message;
}

function persist() {
  clearTimeout(persistTimer);
  const snapshot = {
    settings: store.settings,
    bookmarks: store.bookmarks,
    history: store.history,
    tabs: store.settings.restoreSession ? tabs.filter(tab => !tab.private).map(tab => ({ url: tab.url })) : []
  };
  storageError = profileRepository.save(snapshot).message;
  broadcast();
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
    favicon: tab.favicon || '', muted: contents ? contents.isAudioMuted() : Boolean(tab.muted), suspended: Boolean(tab.lazy),
    privateMode: tab.privateMode, networkStatus: tab.networkStatus, torProgress: tab.privateMode === 'tor' ? torProgress : 0,
    canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
    canGoForward: Boolean(contents?.navigationHistory.canGoForward()),
    zoom: contents?.getZoomFactor() || 1
  };
}
function state() {
  return {
    tabs: tabs.map(tabState), activeId,
    bookmarks: store.bookmarks, history: store.history,
    downloads: downloads.map(({ item, private: isPrivate, partition, ...download }) => download),
    settings: store.settings,
    versions: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome },
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
    if (tab?.privateMode === 'tor' && ['media', 'geolocation', 'notifications'].includes(permission)) { callback(false); return; }
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
      state: 'progressing', received: 0, total: item.getTotalBytes(), item, private: Boolean(tab?.private), partition: tab?.partition
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

async function loadFavicon(tab, candidates) {
  // Keep image requests in the owning browsing session. The privileged shell
  // only receives bounded raster data, so it never makes an external request.
  const url = Array.isArray(candidates) ? candidates.map(safeWebURL).find(Boolean) : null;
  if (!url || tab.private || tab.url === NEW_TAB || !tabs.includes(tab)) return;
  tab.faviconController?.abort();
  const controller = new AbortController();
  tab.faviconController = controller;
  const pageURL = tab.url;
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await liveContents(tab)?.session.fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
    if (!response?.ok || Number(response.headers.get('content-length')) > 65536 || !response.body) return;
    const mime = response.headers.get('content-type') || '';
    if (!/^image\/(?:png|jpeg|gif|webp)(?:;|$)/i.test(mime)) return;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); return; }
      chunks.push(Buffer.from(value));
    }
    if (tabs.includes(tab) && tab.faviconController === controller && tab.url === pageURL) {
      tab.favicon = rasterDataURL(Buffer.concat(chunks), mime);
      broadcast();
    }
  } catch { /* A favicon is optional; failed images leave the built-in tab icon. */ }
  finally { clearTimeout(timer); if (tab.faviconController === controller) tab.faviconController = null; }
}

function createView(tab) {
  if (tab.privateMode === 'tor' && tab.networkStatus !== 'connected') throw new Error('A Tor tab cannot load before its proxy is connected.');
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
  if (tab.privateMode === 'tor') contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.setAudioMuted(Boolean(tab.muted));
  bindShortcuts(contents);
  contents.setWindowOpenHandler(details => {
    const url = safeWebURL(details.url);
    if (url && tabs.length < 50) createTab(url, tab.private, details.disposition === 'background-tab', false, tab.privateMode === 'tor');
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
  contents.on('page-favicon-updated', (_event, favicons) => { void loadFavicon(tab, favicons); });
  contents.on('audio-state-changed', () => broadcast());
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
    if (link) entries.push({ label: 'Open link in new tab', enabled: tabs.length < 50, click: () => createTab(link, tab.private, false, false, tab.privateMode === 'tor') });
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

function createTab(value = NEW_TAB, isPrivate = false, background = false, deferLoad = false, isTor = false) {
  if (tabs.length >= 50) throw new Error('You have 50 tabs open. Close a tab before opening another.');
  const url = normalizeAddress(value, store.settings.searchEngine);
  isPrivate = Boolean(isPrivate || isTor);
  const tab = { id: randomUUID(), title: isTor ? 'Tor private tab' : isPrivate ? 'Private tab' : 'New tab', url: NEW_TAB, private: isPrivate,
    privateMode: isTor ? 'tor' : 'device', networkStatus: isTor ? 'connecting' : null,
    partition: isTor ? torPartition : isPrivate ? privatePartition : 'persist:turbobrowser', loading: false, error: '', view: null, lazy: false, muted: false, favicon: '', navigationId: 0 };
  tabs.push(tab);
  if (!background || !activeId) activeId = tab.id;
  overlayOpen = false;
  if (url !== NEW_TAB && deferLoad && background && tab.id !== activeId) {
    tab.url = url; tab.title = new URL(url).hostname; tab.lazy = true;
  } else if (url !== NEW_TAB) navigateTab(tab, url);
  else if (isTor) void ensureTorSession(tab).catch(() => {});
  schedulePersist(); layout(); broadcast();
  return tab;
}

function navigateTab(tab, value) {
  const url = normalizeAddress(value, store.settings.searchEngine);
  tab.error = ''; tab.lazy = false; findResult = null;
  const navigationId = ++tab.navigationId;
  tab.faviconController?.abort(); tab.faviconController = null; tab.favicon = '';
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
    void (async () => {
      if (tab.privateMode === 'tor') await ensureTorSession(tab);
      if (!tabs.includes(tab) || tab.navigationId !== navigationId || tab.url !== url) return;
      const contents = liveContents(tab) || createView(tab);
      await contents.loadURL(url);
      if (tab.id === activeId) contents.focus();
    })().catch(error => {
      if (!tabs.includes(tab) || tab.navigationId !== navigationId || tab.url === NEW_TAB || error.code === 'ERR_ABORTED') return;
      if (!tab.error) { tab.error = `This page could not be loaded. ${error.code || error.message || 'Check your connection and try again.'}`; tab.loading = false; layout(); broadcast(); }
    });
  }
  schedulePersist(); layout(); broadcast();
}

function switchTab(id) {
  const tab = tabs.find(candidate => candidate.id === id);
  if (!tab) return;
  activeId = id; overlayOpen = false; findResult = null;
  if (tab.lazy) navigateTab(tab, tab.url);
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
  tab.faviconController?.abort();
  if (!tab.private) { recentlyClosed.unshift({url:tab.url}); recentlyClosed.splice(20); }
  tabs.splice(index, 1);
  if (tab.view) {
    win.contentView.removeChildView(tab.view);
    const contents = liveContents(tab);
    if (contents) contents.close({ waitForBeforeUnload: false });
  }
  if (tab.private && !tabs.some(candidate => candidate.partition === tab.partition)) {
    for (const download of downloads.filter(item => item.partition === tab.partition)) { if (download.state === 'progressing' || download.state === 'interrupted') download.item?.cancel(); }
    for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].partition === tab.partition) downloads.splice(i, 1);
    session.fromPartition(tab.partition).clearStorageData().catch(() => {});
    session.fromPartition(tab.partition).clearCache().catch(() => {});
    torSessionPromises.delete(tab.partition);
    if (tab.privateMode === 'tor') torPartition = `tor-private-${randomUUID()}`;
    else privatePartition = `private-${randomUUID()}`;
  }
  if (!tabs.length) createTab();
  else if (activeId === id) switchTab(tabs[Math.min(index, tabs.length - 1)].id);
  schedulePersist(); layout(); broadcast();
}
function reopenTab() { if (tabs.length >= 50) return; const entry = recentlyClosed.shift(); if (entry) createTab(entry.url); }
function muteTab(id = activeId, muted) {
  const tab = tabs.find(candidate => candidate.id === id);
  if (!tab) return;
  tab.muted = typeof muted === 'boolean' ? muted : !tab.muted;
  liveContents(tab)?.setAudioMuted(tab.muted);
  broadcast();
}
function duplicateTab(id = activeId) {
  const source = tabs.find(candidate => candidate.id === id);
  if (!source) return null;
  const duplicate = createTab(source.url, source.private, false, false, source.privateMode === 'tor');
  muteTab(duplicate.id, Boolean(source.muted));
  return duplicate;
}
function showTabMenu(id) {
  const tab = tabs.find(candidate => candidate.id === id);
  if (!tab) return;
  Menu.buildFromTemplate([
    { label: 'Duplicate tab', enabled: tabs.length < 50, click: () => duplicateTab(tab.id) },
    { label: tab.muted ? 'Unmute tab' : 'Mute tab', click: () => muteTab(tab.id) },
    { label: 'Reload tab', enabled: tab.url !== NEW_TAB, click: () => { const contents = liveContents(tab); if (contents) contents.reload(); else navigateTab(tab, tab.url); } },
    { type: 'separator' },
    { label: 'Close tab', click: () => closeTab(tab.id) }
  ]).popup({ window: win });
}
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
  if (!tab) return;
  if (tab.url === NEW_TAB) {
    if (tab.privateMode === 'tor') { tab.error = ''; void ensureTorSession(tab).catch(() => {}); }
    return;
  }
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
    case 'new-tab': createTab(typeof data.url === 'string' ? data.url : NEW_TAB, data.private === true, false, false, data.tor === true); break;
    case 'navigate': if (currentTab()) navigateTab(currentTab(), data.value); break;
    case 'switch-tab': switchTab(data.id); break;
    case 'close-tab': closeTab(data.id || activeId); break;
    case 'reopen-tab': reopenTab(); break;
    case 'mute-tab': muteTab(data.id || activeId, data.muted); break;
    case 'duplicate-tab': duplicateTab(data.id || activeId); break;
    case 'tab-menu': showTabMenu(data.id || activeId); break;
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
      tab.faviconController?.abort();
      win.contentView.removeChildView(tab.view);
      liveContents(tab)?.close({ waitForBeforeUnload: false });
    }
    tabs.length = 0; activeId = null;
  });
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  await win.loadFile(path.join(__dirname, 'shell.html'));
  for (const url of startupURLs(store, smokeMode)) createTab(url, false, tabs.length > 0, true);
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
app.on('before-quit', event => {
  if (!shutdown) persist();
  if (torManager && !torQuitInProgress) {
    torQuitInProgress = true; ++torGeneration; event.preventDefault();
    void stopOwnedTor().finally(() => app.quit());
  }
});
app.on('will-quit', () => { torManager?.close(); });

// This mode uses an isolated temporary profile and an owned local fixture. It is
// deliberately unavailable through renderer IPC and never touches a normal profile.
async function runSmokeTest() {
  const http = require('node:http');
  const assert = require('node:assert/strict');
  const checks = [];
  const requests = new Map();
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
      requests.set(request.url, (requests.get(request.url) || 0) + 1);
      if (request.url === '/favicon.png') {
        response.writeHead(200, {'Content-Type':'image/png'});
        response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=', 'base64')); return;
      }
      if (request.url === '/download') {
        response.writeHead(200, {'Content-Type':'text/plain', 'Content-Disposition':'attachment; filename="turbo-smoke.txt"'});
        response.end('TurboBrowser download fixture'); return;
      }
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      response.end(`<!doctype html><html><head><title>Turbo ${request.url === '/two' ? 'Two' : 'One'}</title><link rel="icon" type="image/png" href="/favicon.png"></head><body><h1 id="message">Rendered in TurboBrowser</h1><script>document.body.dataset.javascript = 'working';</script><a href="/two">Next</a></body></html>`);
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
    await waitFor(() => first.favicon.startsWith('data:image/png;base64,'), 'session-owned raster favicon');
    checks.push('Favicons are fetched in the owning session and exposed as bounded raster data');
    const viewsBeforeRestore = tabs.filter(tab => tab.view).length;
    const deferredOne = createTab(`${origin}/deferred-one`, false, true, true);
    const deferredTwo = createTab(`${origin}/deferred-two`, false, true, true);
    assert.equal(tabs.filter(tab => tab.view).length, viewsBeforeRestore);
    assert.equal(deferredOne.view, null); assert.equal(deferredTwo.view, null);
    assert.equal(deferredOne.lazy, true); assert.equal(tabState(deferredTwo).suspended, true);
    assert.equal(requests.has('/deferred-one'), false); assert.equal(requests.has('/deferred-two'), false);
    assert.equal(store.history.some(entry => entry.url.includes('/deferred-')), false);
    persist();
    assert.equal(JSON.parse(fs.readFileSync(profilePath, 'utf8')).tabs.some(entry => entry.url === `${origin}/deferred-two`), true);
    switchTab(deferredOne.id);
    await waitFor(() => !deferredOne.loading && deferredOne.title === 'Turbo One', 'activate restored tab');
    assert.ok(deferredOne.view); assert.equal(deferredOne.lazy, false); assert.equal(deferredTwo.view, null);
    assert.equal(requests.get('/deferred-one'), 1); assert.equal(requests.has('/deferred-two'), false);
    closeTab(deferredOne.id); closeTab(deferredTwo.id); switchTab(first.id);
    checks.push('Restored background tabs allocate no renderer or requests until their first activation');
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
    await command('mute-tab', {id:first.id,muted:true});
    assert.equal(contents.isAudioMuted(), true);
    const duplicate = duplicateTab(first.id);
    await waitFor(() => !duplicate.loading && duplicate.title === 'Turbo Two', 'duplicate page');
    assert.notEqual(liveContents(duplicate), contents);
    assert.equal(duplicate.url, first.url); assert.equal(liveContents(duplicate).isAudioMuted(), true);
    closeTab(duplicate.id); switchTab(first.id);
    await command('mute-tab', {id:first.id,muted:false});
    assert.equal(contents.isAudioMuted(), false);
    checks.push('Tab muting controls Chromium audio and duplicate tabs own independent page contents');
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
    const probe = require('node:net').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const unavailablePort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const blockedPath = '/proxy-must-not-be-direct';
    const blocked = createTab(NEW_TAB, true);
    blocked.privateMode = 'tor'; blocked.networkStatus = 'connected';
    blocked.partition = `tor-offline-smoke-${randomUUID()}`;
    blocked.url = `${origin}${blockedPath}`;
    await configureTorProxy(session.fromPartition(blocked.partition), unavailablePort);
    const blockedContents = createView(blocked);
    assert.equal(blockedContents.getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp');
    let failedAsExpected = false;
    try { await blockedContents.loadURL(blocked.url); } catch { failedAsExpected = true; }
    assert.equal(failedAsExpected, true);
    assert.equal(requests.has(blockedPath), false);
    closeTab(blocked.id); switchTab(first.id);
    checks.push('Unavailable SOCKS5 proxy fails closed without any direct loopback fixture request; WebRTC is restricted');
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
    if (process.argv.includes('--smoke-tor')) {
      const torTab = createTab('https://check.torproject.org/api/ip', true, false, false, true);
      await waitFor(() => torTab.error || torTab.networkStatus === 'connected' && !torTab.loading, 'live Tor route', 120000);
      assert.equal(torTab.error, '', 'The live Tor page must load through its configured SOCKS5 session');
      const verification = await liveContents(torTab).executeJavaScript('JSON.parse(document.body.innerText)');
      assert.equal(verification.IsTor, true, 'Tor Project must confirm the Chromium session uses Tor');
      assert.equal(liveContents(torTab).getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp');
      assert.equal(store.history.some(entry => entry.url.startsWith('https://check.torproject.org/')), false);
      checks.push('Optional live Chromium Tor routing confirmed by Tor Project (IsTor=true; no IP logged)');
      torManager.close();
      await waitFor(() => torTab.networkStatus === 'error' && !torTab.view, 'Tor daemon stop closes its web contents');
      checks.push('Losing the owned Tor daemon destroys Tor page contents instead of falling back directly');
      reloadCurrent();
      await waitFor(() => torTab.error || torTab.networkStatus === 'connected' && !torTab.loading, 'retry Tor after daemon stop', 120000);
      assert.equal(torTab.error, '', 'Retry must clear stale daemon errors only after a fresh protected navigation');
      assert.equal((await liveContents(torTab).executeJavaScript('JSON.parse(document.body.innerText)')).IsTor, true);
      assert.equal(torTab.view.getVisible(), true);
      checks.push('Tor retry reconnects through a new protected session without stale errors hiding the page');
      closeTab(torTab.id); switchTab(first.id);
    }
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

async function finishSmoke(result, exitCode) {
  ++torGeneration;
  await stopOwnedTor();
  const argument = process.argv.find(value => value.startsWith('--smoke-output='));
  if (argument) {
    const destination = argument.slice('--smoke-output='.length);
    if (path.isAbsolute(destination)) { fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.writeFileSync(destination, JSON.stringify(result,null,2)); }
  }
  console.log(JSON.stringify(result));
  process.exitCode = exitCode;
  app.exit(exitCode);
}
