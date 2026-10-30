'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set([
  'get-state', 'new-tab', 'navigate', 'switch-tab', 'close-tab', 'back', 'forward',
  'reload', 'stop', 'home', 'bookmark', 'remove-bookmark', 'clear-history', 'settings',
  'set-overlay', 'open-download', 'clear-downloads', 'zoom-in', 'zoom-out', 'zoom-reset',
  'find', 'stop-find', 'minimize', 'maximize', 'close-window', 'reopen-tab', 'focus-page',
  'mute-tab', 'duplicate-tab', 'tab-menu'
]);

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('turbo', Object.freeze({
  command(action, payload = {}) {
    if (!actions.has(action)) return Promise.reject(new Error('Unknown browser command.'));
    return ipcRenderer.invoke('turbo:command', action, payload);
  },
  onState: callback => subscribe('turbo:state', callback),
  onShortcut: callback => subscribe('turbo:shortcut', callback)
}));
