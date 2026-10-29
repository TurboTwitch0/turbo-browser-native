import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.resolve(tmpdir());
const directory = await mkdtemp(path.join(temporaryRoot, 'turbo-browser-smoke-'));
const outputPath = path.join(directory, 'result.json');
const childEnvironment = { ...process.env, TURBO_PROFILE_DIR: path.join(directory, 'profile') };
delete childEnvironment.ELECTRON_RUN_AS_NODE;

let passed = false;
try {
  const executable = require('electron');
  console.log('Opening the real Chromium browser with an isolated test profile…');
  const child = spawn(executable, [root, '--smoke-test', `--smoke-output=${outputPath}`], {
    cwd: root,
    env: childEnvironment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => { logs = (logs + String(data)).slice(-60000); });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 90000);
  timer.unref();
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? -1 : code));
  }).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error('The embedded browser smoke test exceeded 90 seconds.');

  let result;
  try { result = JSON.parse(await readFile(outputPath, 'utf8')); }
  catch { throw new Error(`The browser did not write a valid smoke-test result (exit ${exitCode}).\n${logs}`); }
  console.log(JSON.stringify(result, null, 2));
  if (exitCode !== 0 || result.passed !== true) {
    throw new Error(`Embedded browser smoke test failed (exit ${exitCode}).\n${logs}`);
  }
  passed = true;
  console.log('Embedded browser smoke test passed.');
} catch (error) {
  console.error(error?.message || String(error));
  console.error(`Test profile and diagnostics retained at: ${directory}`);
  process.exitCode = 1;
} finally {
  // Delete only the unique temporary directory this invocation just created.
  const resolvedDirectory = path.resolve(directory);
  if (passed && path.dirname(resolvedDirectory) === temporaryRoot && path.basename(resolvedDirectory).startsWith('turbo-browser-smoke-')) {
    await rm(resolvedDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
