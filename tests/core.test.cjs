'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NEW_TAB, safeWebURL, normalizeAddress, sanitizeStore, sanitizeSettings, isTrustedIPC, startupURLs, rasterDataURL, configureTorProxy } = require('../desktop/core.cjs');

test('addresses load as URLs while phrases use the chosen search engine', () => {
  assert.equal(normalizeAddress('example.com/path?q=a#b'), 'https://example.com/path?q=a#b');
  assert.equal(normalizeAddress('https://example.com'), 'https://example.com/');
  assert.equal(normalizeAddress('http://example.com'), 'http://example.com/');
  assert.equal(normalizeAddress('example.com:8443/path'), 'https://example.com:8443/path');
  assert.equal(normalizeAddress('//example.com/a'), 'https://example.com/a');
  assert.equal(normalizeAddress('localhost:9876/a'), 'http://localhost:9876/a');
  assert.equal(normalizeAddress('127.0.0.1:9876'), 'http://127.0.0.1:9876/');
  assert.equal(normalizeAddress('[::1]:9876/a'), 'http://[::1]:9876/a');
  assert.equal(normalizeAddress('red pandas & otters', 'google'), 'https://www.google.com/search?q=red%20pandas%20%26%20otters');
  assert.equal(normalizeAddress('hello', 'bing'), 'https://www.bing.com/search?q=hello');
  assert.equal(normalizeAddress('hello', '__proto__'), 'https://duckduckgo.com/?q=hello');
  assert.equal(normalizeAddress('  '), NEW_TAB);
});

test('privileged and executable URL schemes never navigate', () => {
  for (const value of ['javascript:alert(1)', 'file:///C:/Windows/test', 'data:text/html,hi', 'vbscript:evil', 'chrome://settings', 'ftp://example.com', 'https://user:pass@example.com', 'https://bad\u0000.example.com', 'https://example.com:99999']) {
    assert.throws(() => normalizeAddress(value), undefined, value);
    assert.equal(safeWebURL(value), null);
  }
  assert.throws(() => normalizeAddress('a'.repeat(16385)));
  assert.throws(() => normalizeAddress({}));
});

test('untrusted profile data is bounded, deduplicated and cannot restore private tabs', () => {
  const value = sanitizeStore({
    settings: { searchEngine: 'fake', theme: 'anything', restoreSession: 'yes' },
    bookmarks: [{url:'javascript:evil',title:'bad'},{url:'https://example.com',title:'x'.repeat(400)},{url:'https://example.com/',title:'dup'}],
    history: [{url:'file:///secret',visitedAt:1},{url:'https://example.com',visitedAt:123,title:'Visited'},{url:'https://example.com/a',visitedAt:'123'}],
    tabs: [{url:'file:///secret'},{url:'https://private.example',private:true},{url:'https://example.com'},{url:NEW_TAB}]
  });
  assert.deepEqual(value.settings, { searchEngine:'duckduckgo',theme:'dark',restoreSession:true });
  assert.equal(value.bookmarks.length, 1);
  assert.equal(value.bookmarks[0].title.length, 300);
  assert.equal(value.history.length, 1);
  assert.deepEqual(value.tabs, [{url:'https://example.com/'},{url:NEW_TAB}]);
  assert.equal(sanitizeStore({history:Array.from({length:2000},()=>({url:'https://example.com',visitedAt:1}))}).history.length,1000);
  assert.deepEqual(sanitizeSettings({theme:'light',restoreSession:false,searchEngine:'bing'}),{theme:'light',restoreSession:false,searchEngine:'bing'});
});

test('only the exact trusted shell main frame receives privileged browser IPC', () => {
  const mainFrame = { url:'file:///app/desktop/shell.html' };
  const trusted = { mainFrame, isDestroyed:()=>false };
  assert.equal(isTrustedIPC({sender:trusted,senderFrame:mainFrame},trusted,mainFrame.url),true);
  assert.equal(isTrustedIPC({sender:{},senderFrame:mainFrame},trusted,mainFrame.url),false);
  assert.equal(isTrustedIPC({sender:trusted,senderFrame:{url:mainFrame.url}},trusted,mainFrame.url),false);
  assert.equal(isTrustedIPC({sender:trusted,senderFrame:mainFrame},trusted,'https://evil.example'),false);
  assert.equal(isTrustedIPC({sender:trusted,senderFrame:mainFrame},{...trusted,isDestroyed:()=>true},mainFrame.url),false);
});

test('fresh startup opens the web, preserves regular sessions, and keeps smoke startup isolated', () => {
  assert.deepEqual(startupURLs(null), ['https://start.duckduckgo.com/']);
  assert.deepEqual(startupURLs({tabs: []}), ['https://start.duckduckgo.com/']);
  const saved = {
    settings: {restoreSession: true},
    tabs: [{url:'https://example.com/a'},{url:NEW_TAB},{url:'https://private.example/',private:true},{url:'file:///secret'}]
  };
  assert.deepEqual(startupURLs(saved), ['https://example.com/a', NEW_TAB]);
  assert.deepEqual(startupURLs({...saved,settings:{restoreSession:false}}), ['https://start.duckduckgo.com/']);
  assert.deepEqual(startupURLs({tabs:[{url:'https://private.example/',private:true},{url:'javascript:evil'}]}), ['https://start.duckduckgo.com/']);
  assert.deepEqual(startupURLs(saved, true), [NEW_TAB]);
  assert.deepEqual(startupURLs(null, true), [NEW_TAB]);
});

test('favicon bridge only emits bounded raster data with matching image signatures', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=', 'base64');
  assert.equal(rasterDataURL(png, 'image/png; charset=binary'), `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(rasterDataURL(png, 'text/html'), '');
  assert.equal(rasterDataURL(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'), '');
  assert.equal(rasterDataURL(Buffer.from('<html>payload</html>'), 'image/png'), '');
  assert.equal(rasterDataURL(Buffer.alloc(65537), 'image/png'), '');
  assert.equal(rasterDataURL(null, 'image/png'), '');
});

test('Tor session setup uses one SOCKS5 endpoint with no direct or implicit loopback bypass', async () => {
  const calls = [];
  const browsingSession = {
    async setProxy(config) { calls.push(['proxy',config]); },
    async closeAllConnections() { calls.push(['close']); },
    setSpellCheckerEnabled(enabled) { calls.push(['spellcheck',enabled]); }
  };
  await configureTorProxy(browsingSession, 9050);
  assert.deepEqual(calls, [
    ['proxy',{mode:'fixed_servers',proxyRules:'socks5://127.0.0.1:9050',proxyBypassRules:'<-loopback>'}],
    ['close'],['spellcheck',false]
  ]);
  for (const port of [0,-1,65536,'9050;DIRECT',NaN]) await assert.rejects(configureTorProxy(browsingSession,port));
  let advanced = false;
  await assert.rejects(configureTorProxy({async setProxy(){throw new Error('proxy failed');},async closeAllConnections(){advanced=true;}},9050));
  assert.equal(advanced,false);
});
