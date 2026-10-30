'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sanitizeStore } = require('./core.cjs');
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;

function validShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    ['bookmarks', 'history', 'tabs'].every(key => value[key] === undefined || Array.isArray(value[key])) &&
    (value.settings === undefined || value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings));
}

function createProfileRepository(profilePath, io = fs) {
  let damagedBytes = null;
  let loaded = false;
  let blocked = false;
  let recoveryNotice = '';
  let recoveryPath = '';
  let message = '';
  const sessionOnly = 'Changes will last for this session only.';

  return {
    load() {
      loaded = true;
      damagedBytes = null; blocked = false; recoveryNotice = ''; recoveryPath = ''; message = '';
      try {
        const info = io.lstatSync(profilePath);
        if (!info.isFile() || info.size >= MAX_PROFILE_BYTES) {
          blocked = true;
          message = `Your original browser profile was preserved because it is too large or is not a regular file. ${sessionOnly}`;
          return { store: sanitizeStore(null), message };
        }
        const bytes = io.readFileSync(profilePath);
        try {
          const value = JSON.parse(bytes.toString('utf8'));
          if (!validShape(value)) throw new Error('Invalid profile shape');
          return { store: sanitizeStore(value), message };
        } catch {
          damagedBytes = bytes;
          message = 'Your saved browser profile is damaged. It will be preserved in a recovery copy before new changes are saved.';
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          blocked = true;
          message = `Your original browser profile could not be read and will not be replaced. ${sessionOnly}`;
        }
      }
      return { store: sanitizeStore(null), message };
    },
    save(snapshot) {
      if (!loaded) return { saved: false, message: `Your browser profile has not been loaded. ${sessionOnly}` };
      if (blocked) return { saved: false, message };
      let temporary;
      try {
        io.mkdirSync(path.dirname(profilePath), { recursive: true });
        if (damagedBytes) {
          // Recheck the source so a profile repaired outside the app is not replaced.
          if (!io.readFileSync(profilePath).equals(damagedBytes)) {
            blocked = true;
            message = `Your original browser profile changed during recovery and was preserved. ${sessionOnly}`;
            return { saved: false, message };
          }
          if (!recoveryPath) {
            const candidate = `${profilePath}.recovery-${randomUUID()}.json`;
            io.writeFileSync(candidate, damagedBytes, { flag: 'wx', mode: 0o600 });
            if (!io.readFileSync(candidate).equals(damagedBytes)) throw new Error('Recovery verification failed');
            recoveryPath = candidate;
          }
          if (!io.readFileSync(recoveryPath).equals(damagedBytes)) throw new Error('Recovery verification failed');
          recoveryNotice = `Your previous damaged profile is preserved at ${recoveryPath}.`;
        }
        temporary = `${profilePath}.${randomUUID()}.tmp`;
        io.writeFileSync(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
        io.renameSync(temporary, profilePath);
        damagedBytes = null;
        message = recoveryNotice;
        return { saved: true, message };
      } catch {
        message = damagedBytes && !recoveryPath ? `Your original damaged profile was preserved because a recovery copy could not be verified. ${sessionOnly}`
          : `Changes could not be saved to your browser profile. ${sessionOnly}${recoveryNotice ? ` ${recoveryNotice}` : ''}`;
        return { saved: false, message };
      } finally {
        if (temporary) { try { io.rmSync(temporary, { force: true }); } catch { /* Retain an incomplete temporary file if cleanup is unavailable. */ } }
      }
    },
  };
}

module.exports = { createProfileRepository, MAX_PROFILE_BYTES };
