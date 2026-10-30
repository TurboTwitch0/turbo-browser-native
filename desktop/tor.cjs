'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

class TorManager {
  constructor({ executablePath, dataDirectory, onStatus = () => {}, spawnProcess = spawn,
    allocatePort = allocateLoopbackPort, startupTimeoutMs = 90000 }) {
    if (!path.isAbsolute(executablePath || '') || !path.isAbsolute(dataDirectory || '')) {
      throw new Error('Tor requires absolute executable and data-directory paths.');
    }
    this.executablePath = executablePath;
    this.dataDirectory = dataDirectory;
    this.onStatus = onStatus;
    this.spawnProcess = spawnProcess;
    this.allocatePort = allocatePort;
    this.startupTimeoutMs = Math.max(1, Math.min(90000, startupTimeoutMs));
    this.child = null;
    this.port = null;
    this.pending = null;
    this.generation = 0;
    this.rejectStartup = null;
  }

  status(state, progress, message, extra = {}) {
    try { this.onStatus({ state, progress, message, ...extra }); } catch { /* UI callbacks cannot disrupt process cleanup. */ }
  }

  connect() {
    if (this.port && this.child) return Promise.resolve(this.port);
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    this.status('starting', 0, 'Starting the bundled Tor connection…');
    const operation = this.start(generation).catch(error => {
      if (generation === this.generation) {
        this.port = null;
        this.stopOwnedChild();
        this.status('error', 0, error.message);
      }
      throw error;
    });
    this.pending = operation;
    operation.finally(() => {
      if (this.pending === operation) this.pending = null;
    }).catch(() => {});
    return operation;
  }

  async start(generation) {
    const alive = () => {
      if (generation !== this.generation) throw new Error('Tor connection was closed.');
    };
    const executable = await fs.stat(this.executablePath);
    if (!executable.isFile()) throw new Error('The bundled Tor executable is unavailable.');
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const config = path.join(this.dataDirectory, 'turbobrowser-torrc');
    try { await fs.writeFile(config, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.lstat(config);
      if (!existing.isFile() || existing.size !== 0) throw new Error('Tor needs an empty, controlled configuration file.');
    }
    alive();
    const port = await this.allocatePort();
    alive();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A loopback Tor port could not be allocated.');
    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let lastNotice = '';
      const rejectOnce = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.rejectStartup = null;
        reject(error);
      };
      const timer = setTimeout(() => rejectOnce(new Error('Tor could not connect within 90 seconds. No direct connection was used.')), this.startupTimeoutMs);
      this.rejectStartup = rejectOnce;
      const args = ['--defaults-torrc', config, '-f', config, '--ClientOnly', '1',
        '--SocksPort', `127.0.0.1:${port}`, '--DataDirectory', this.dataDirectory,
        '--AvoidDiskWrites', '1', '--Log', 'notice stdout', '--ControlPort', '0'];
      let child;
      try {
        child = this.spawnProcess(this.executablePath, args, {
          cwd: path.dirname(this.executablePath), windowsHide: true,
          shell: false, stdio: ['ignore', 'pipe', 'pipe']
        });
        this.child = child;
      } catch (error) { rejectOnce(new Error(`The bundled Tor process could not start: ${error.message}`)); return; }
      const readLine = line => {
        if (generation !== this.generation) return;
        const match = /Bootstrapped\s+(\d+)%/i.exec(line);
        if (match) {
          const progress = Math.max(0, Math.min(100, Number(match[1])));
          if (progress < 100) this.status('connecting', progress, `Connecting to Tor… ${progress}%`);
          else if (!settled) {
            connected = true;
            settled = true;
            clearTimeout(timer);
            this.rejectStartup = null;
            this.port = port;
            this.status('connected', 100, 'Tor connected.', { port });
            resolve(port);
          }
        }
        if (/\[(?:warn|err)\]/i.test(line)) lastNotice = line.slice(-400);
      };
      for (const stream of [child.stdout, child.stderr]) {
        let buffer = '';
        stream?.on('data', chunk => {
          buffer = (buffer + String(chunk)).slice(-32768);
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) readLine(line);
          // Bootstrap notices are a single line; support a final line without newline.
          if (/Bootstrapped\s+100%/.test(buffer)) { readLine(buffer); buffer = ''; }
        });
      }
      child.once('error', error => {
        const failure = new Error(`Tor process error: ${error.message}`);
        if (connected && generation === this.generation) {
          this.stopOwnedChild();
          this.status('error', 0, failure.message);
        } else rejectOnce(failure);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (generation !== this.generation) return;
        if (this.child === child) this.child = null;
        this.port = null;
        const detail = lastNotice ? ` ${lastNotice}` : '';
        const error = new Error(`Tor stopped (${signal || code || 'closed'}). No direct connection was used.${detail}`);
        if (connected) this.status('error', 0, error.message);
        else rejectOnce(error);
      });
    });
  }

  stopOwnedChild() {
    const child = this.child;
    this.child = null;
    this.port = null;
    if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
    try { child.kill(); } catch { return; }
    const force = setTimeout(() => { if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch {} } }, 1500);
    force.unref?.();
    child.once('exit', () => clearTimeout(force));
  }

  close() {
    ++this.generation;
    this.rejectStartup?.(new Error('Tor connection was closed.'));
    this.rejectStartup = null;
    this.stopOwnedChild();
    this.pending = null;
    this.status('stopped', 0, 'Tor disconnected.');
  }
}

module.exports = { TorManager, allocateLoopbackPort };
