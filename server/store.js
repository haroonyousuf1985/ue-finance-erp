/* ============================================================
   store.js - the "database": one JSON file on disk.
   Holds every sheet (tables) and the script properties (settings
   such as the AI key). Written a moment after every change, safely
   (to a temp file first, then renamed), so a crash never corrupts it.
   To move to a real database later, only this file and gas-shim.js
   need to change - none of the accounting logic does.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const FILES_DIR = path.join(DATA_DIR, 'files');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

// Dates are stored as {"$d": "<ISO text>"} so they come back as real Dates.
function replacer(key, value) {
  const raw = this[key];
  if (raw instanceof Date) return { $d: isNaN(raw) ? null : raw.toISOString() };
  return value;
}
function reviver(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '$d') && Object.keys(value).length === 1) {
    return value.$d === null ? new Date(NaN) : new Date(value.$d);
  }
  return value;
}

const state = { sheets: {}, props: {} };   // sheets[name] = { rows: [[...]], textCols: [colIndex...] }

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'), reviver);
      state.sheets = parsed.sheets || {};
      state.props = parsed.props || {};
    }
  } catch (err) {
    console.error('Could not read the data file (' + err.message + '). Starting empty. A copy of the damaged file was kept.');
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.damaged-' + Date.now()); } catch (e) {}
  }
}

let timer = null, dirty = false;
function writeNow() {
  if (!dirty) return;
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, replacer));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('Could not save data: ' + err.message);
  }
}
function markDirty() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; writeNow(); }, 400);
}
function flushSync() { if (timer) { clearTimeout(timer); timer = null; } writeNow(); }

process.on('exit', flushSync);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { flushSync(); process.exit(0); }));

load();

module.exports = { state, markDirty, flushSync, DATA_DIR, DB_FILE, FILES_DIR };
