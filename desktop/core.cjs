'use strict';

const NEW_TAB = 'turbo://newtab';
const START_PAGE = 'https://start.duckduckgo.com/';
const ENGINES = Object.freeze({
  duckduckgo: 'https://duckduckgo.com/?q=',
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q='
});
const DEFAULT_SETTINGS = Object.freeze({ searchEngine: 'duckduckgo', theme: 'dark', restoreSession: true });

function safeWebURL(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function normalizeAddress(value, engine = 'duckduckgo') {
  if (typeof value !== 'string') throw new TypeError('Enter a website address or search.');
  const input = value.trim();
  if (!input || input === NEW_TAB || input === 'about:blank') return NEW_TAB;
  if (input.length > 16384 || /[\u0000-\u001f\u007f]/u.test(input)) throw new Error('This address is too long or contains invalid characters.');
  const local = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  if (local) {
    const url = safeWebURL(`http://${input}`);
    if (!url) throw new Error('This website address is not valid.');
    return url;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^\s/:]+\.[^\s/:]+:\d+(?:[/?#]|$)/u.test(input)) {
    const url = safeWebURL(input);
    if (!url) throw new Error('TurboBrowser opens http and https websites. This address is not supported.');
    return url;
  }
  const candidate = input.startsWith('//') ? `https:${input}` : `https://${input}`;
  const url = safeWebURL(candidate);
  if (!/\s/u.test(input) && url) {
    const hostname = new URL(url).hostname;
    if (hostname.includes('.') && !hostname.startsWith('.') && !hostname.endsWith('.')) return url;
  }
  const searchBase = Object.hasOwn(ENGINES, engine) ? ENGINES[engine] : ENGINES.duckduckgo;
  return `${searchBase}${encodeURIComponent(input)}`;
}

function sanitizeSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    searchEngine: Object.hasOwn(ENGINES, input.searchEngine) ? input.searchEngine : DEFAULT_SETTINGS.searchEngine,
    theme: ['dark', 'light'].includes(input.theme) ? input.theme : DEFAULT_SETTINGS.theme,
    restoreSession: typeof input.restoreSession === 'boolean' ? input.restoreSession : DEFAULT_SETTINGS.restoreSession
  };
}

function sanitizeStore(value) {
  const input = value && typeof value === 'object' ? value : {};
  const bookmarks = [];
  const seen = new Set();
  for (const item of (Array.isArray(input.bookmarks) ? input.bookmarks : []).slice(0, 2000)) {
    const url = safeWebURL(item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    bookmarks.push({ url, title: String(item.title || new URL(url).hostname).slice(0, 300) });
    if (bookmarks.length >= 500) break;
  }
  const history = (Array.isArray(input.history) ? input.history : []).slice(0, 1000)
    .filter(item => safeWebURL(item?.url) && Number.isFinite(item.visitedAt) && item.visitedAt > 0)
    .map(item => ({ url: safeWebURL(item.url), title: String(item.title || item.url).slice(0, 300), visitedAt: item.visitedAt }));
  const tabs = (Array.isArray(input.tabs) ? input.tabs : []).slice(0, 50)
    .filter(item => item && !item.private && (item.url === NEW_TAB || safeWebURL(item.url)))
    .map(item => ({ url: item.url === NEW_TAB ? NEW_TAB : safeWebURL(item.url) }));
  return { settings: sanitizeSettings(input.settings), bookmarks, history, tabs };
}

function isTrustedIPC(event, shellContents, shellURL) {
  return Boolean(shellContents && !shellContents.isDestroyed() && event?.sender === shellContents &&
    event.senderFrame && event.senderFrame === shellContents.mainFrame && event.senderFrame.url === shellURL);
}

function startupURLs(value, testing = false) {
  if (testing) return [NEW_TAB];
  const profile = sanitizeStore(value);
  if (profile.settings.restoreSession && profile.tabs.length) return profile.tabs.map(tab => tab.url);
  return [START_PAGE];
}

function rasterDataURL(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536 || typeof contentType !== 'string') return '';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const signature = {
    'image/png': () => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/jpeg': () => bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    'image/gif': () => bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')),
    'image/webp': () => bytes.length >= 12 && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP'
  };
  return Object.hasOwn(signature, mime) && signature[mime]() ? `data:${mime};base64,${bytes.toString('base64')}` : '';
}

async function configureTorProxy(browsingSession, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Tor returned an invalid proxy port.');
  await browsingSession.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
  await browsingSession.closeAllConnections();
  browsingSession.setSpellCheckerEnabled(false);
}

module.exports = { NEW_TAB, START_PAGE, ENGINES, DEFAULT_SETTINGS, safeWebURL, normalizeAddress, sanitizeSettings, sanitizeStore, isTrustedIPC, startupURLs, rasterDataURL, configureTorProxy };
