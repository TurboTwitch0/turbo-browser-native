import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, rename, rm, mkdtemp, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOR_BUNDLE = Object.freeze({
  version: '15.0.26',
  filename: 'tor-expert-bundle-windows-x86_64-15.0.26.tar.gz',
  origin: 'https://dist.torproject.org/torbrowser/15.0.26/',
  // Official sha256sums-signed-build.txt, also matches unsigned-build manifest.
  sha256: 'c1988c701de2f24f7d098d1d6d7f507b58f27740d097f29c246e0524d639b252'
});

export function validateArchivePaths(names) {
  if (!names.length) throw new Error('The Tor archive is empty.');
  for (const name of names) {
    if (!name || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') ||
        name.split('/').some(part => part === '..' || part === '.') ||
        !/^(?:tor|data|docs)\//.test(name)) {
      throw new Error(`Unsafe Tor archive entry: ${name}`);
    }
  }
  if (!names.includes('tor/tor.exe') || !names.includes('docs/tor.txt')) throw new Error('The Tor bundle is missing its executable or license notices.');
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function runTar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Tor bundle archive operation failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

async function walkFiles(directory, prefix = '') {
  const result = {};
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name === 'bundle-manifest.json') continue;
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    const file = path.join(directory, item.name);
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) throw new Error('Links are not allowed in the bundled Tor directory.');
    if (metadata.isDirectory()) Object.assign(result, await walkFiles(file, relative));
    else if (metadata.isFile()) result[relative] = await sha256(file);
    else throw new Error('Unsupported Tor bundle file type.');
  }
  return result;
}

export async function prepareTor(projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const vendor = path.resolve(projectRoot, '.vendor');
  const cache = path.join(vendor, 'cache');
  const destination = path.join(vendor, 'tor');
  const archive = path.join(cache, TOR_BUNDLE.filename);
  const priorVendor = await lstat(vendor).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (priorVendor?.isSymbolicLink()) throw new Error('The Tor vendor directory must not be a link.');
  await mkdir(vendor, { recursive: true });
  if (path.dirname(await realpath(vendor)) !== await realpath(projectRoot)) throw new Error('The Tor vendor directory must remain inside this project.');
  await mkdir(cache, { recursive: true });
  let validArchive = false;
  try { validArchive = await sha256(archive) === TOR_BUNDLE.sha256; } catch {}
  if (!validArchive) {
    const response = await fetch(`${TOR_BUNDLE.origin}${TOR_BUNDLE.filename}`, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Official Tor download failed (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 80 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== TOR_BUNDLE.sha256) {
      throw new Error('Official Tor download failed the pinned SHA-256 verification.');
    }
    const temporaryArchive = `${archive}.download`;
    await writeFile(temporaryArchive, bytes);
    await rename(temporaryArchive, archive);
  }
  // Re-hash cached bytes each build; a marker file alone never authenticates a bundle.
  if (await sha256(archive) !== TOR_BUNDLE.sha256) throw new Error('Tor cache verification failed.');
  // Always re-extract from authenticated archive bytes. A mutable extracted-file
  // manifest must not be enough to authorize a modified executable for packaging.
  const names = runTar(['-tf', archive]).trim().split(/\r?\n/);
  validateArchivePaths(names);
  const verbose = runTar(['-tvf', archive]).trim().split(/\r?\n/);
  if (verbose.some(line => !/^[d-]/.test(line))) throw new Error('Tor archives containing links or special files are not allowed.');
  const staging = await mkdtemp(path.join(vendor, 'tor-stage-'));
  try {
    runTar(['-xf', archive, '-C', staging]);
    const files = await walkFiles(staging);
    if (!files['tor/tor.exe'] || !files['docs/tor.txt']) throw new Error('The extracted Tor bundle is incomplete.');
    await writeFile(path.join(staging, 'bundle-manifest.json'), JSON.stringify({ ...TOR_BUNDLE, files }, null, 2));
    // Resolved targets are fixed direct children of this project's .vendor directory.
    if (path.dirname(destination) !== vendor || path.dirname(staging) !== vendor) throw new Error('Invalid Tor bundle destination.');
    const priorDestination = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (priorDestination?.isSymbolicLink()) throw new Error('The Tor bundle destination must not be a link.');
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    console.log(`Prepared SHA-256 verified official Tor ${TOR_BUNDLE.version} bundle, including license notices.`);
    return destination;
  } catch (error) {
    if (path.dirname(staging) === vendor && path.basename(staging).startsWith('tor-stage-')) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareTor().catch(error => { console.error(error.message); process.exitCode = 1; });
}
