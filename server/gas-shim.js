/* ============================================================
   gas-shim.js - a faithful stand-in for the Google services the
   original Apps Script project used (Sheets, Cache, Properties,
   Utilities, Session, Drive, UrlFetch, Logger, Lock).

   Because of this file, the ORIGINAL accounting code (Code.gs,
   Tax.gs, DiaryStage.gs, Reports.gs, AI.gs, ZSecurity.gs) runs here
   completely unchanged - every rule, tax calculation and report
   behaves exactly as before.
   ============================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { state, markDirty, FILES_DIR } = require('./store');

const TZ = 'Asia/Karachi';
const TZ_OFFSET_MIN = 5 * 60;   // Pakistan has no daylight saving

/* ---------------- Sheets ---------------- */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function cloneCell(v) { return v instanceof Date ? new Date(v.getTime()) : v; }
function norm(v) {
  if (v === undefined || v === null) return '';
  return v;
}

class Sheet {
  constructor(name) {
    this._name = name;
    if (!state.sheets[name]) state.sheets[name] = { rows: [], textCols: [] };
    this._d = state.sheets[name];
    if (!this._d.textCols) this._d.textCols = [];
  }
  getName() { return this._name; }
  _isText(col0) { return this._d.textCols.indexOf(col0) !== -1; }
  // Google Sheets turns a typed "2026-10-18" into a real date (unless the column is Plain Text).
  _parse(v, col0) {
    v = norm(v);
    if (typeof v === 'string' && DATE_ONLY.test(v) && !this._isText(col0)) {
      const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return dt;
    }
    return v;
  }
  getLastRow() {
    const rows = this._d.rows;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r && r.some(c => c !== '' && c !== null && c !== undefined)) return i + 1;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this._d.rows.forEach(r => {
      for (let i = r.length - 1; i >= max; i--) {
        if (r[i] !== '' && r[i] !== null && r[i] !== undefined) { max = i + 1; break; }
      }
    });
    return max;
  }
  getMaxRows() { return Math.max(1000, this._d.rows.length); }
  insertRowsAfter() { /* rows grow automatically */ }
  setFrozenRows() {}
  _grow(rowCount) { while (this._d.rows.length < rowCount) this._d.rows.push([]); }
  getDataRange() {
    const lr = Math.max(this.getLastRow(), 1), lc = Math.max(this.getLastColumn(), 1);
    return new Range(this, 1, 1, lr, lc);
  }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
  appendRow(arr) {
    const row = this.getLastRow() + 1;
    this._grow(row);
    this._d.rows[row - 1] = arr.map((v, i) => this._parse(v, i));
    markDirty();
    return this;
  }
  deleteRow(n) { return this.deleteRows(n, 1); }
  deleteRows(start, count) {
    this._d.rows.splice(start - 1, count);
    markDirty();
  }
  clear() { this._d.rows = []; markDirty(); }
}

class Range {
  constructor(sheet, r, c, nr, nc) { this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.s._d.rows[this.r - 1 + i] || [];
      const line = [];
      for (let j = 0; j < this.nc; j++) line.push(cloneCell(norm(row[this.c - 1 + j])));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (!Array.isArray(vals)) throw new Error('setValues needs a 2-D array');
    const rowsNeeded = this.r - 1 + vals.length;
    this.s._grow(rowsNeeded);
    vals.forEach((rowVals, i) => {
      const row = this.s._d.rows[this.r - 1 + i];
      rowVals.forEach((v, j) => { row[this.c - 1 + j] = this.s._parse(v, this.c - 1 + j); });
      for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = '';
    });
    markDirty();
    return this;
  }
  setValue(v) {
    this.s._grow(this.r);
    const row = this.s._d.rows[this.r - 1];
    row[this.c - 1] = this.s._parse(v, this.c - 1);
    for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = '';
    markDirty();
    return this;
  }
  setNumberFormat(fmt) {
    if (fmt === '@') {
      for (let j = 0; j < this.nc; j++) {
        const col0 = this.c - 1 + j;
        if (this.s._d.textCols.indexOf(col0) === -1) this.s._d.textCols.push(col0);
      }
      markDirty();
    }
    return this;
  }
  setFontWeight() { return this; }
}

const spreadsheet = {
  getSheetByName(name) { return state.sheets[name] ? new Sheet(name) : null; },
  insertSheet(name) { return new Sheet(name); },
  getSheets() { return Object.keys(state.sheets).map(n => new Sheet(n)); }
};
const SpreadsheetApp = {
  getActiveSpreadsheet() { return spreadsheet; },
  flush() {}
};

/* ---------------- Cache ---------------- */
const cacheMap = new Map();
const scriptCache = {
  get(key) {
    const hit = cacheMap.get(key);
    if (!hit) return null;
    if (hit.exp && hit.exp < Date.now()) { cacheMap.delete(key); return null; }
    return hit.v;
  },
  put(key, value, ttlSeconds) {
    cacheMap.set(key, { v: String(value), exp: Date.now() + (ttlSeconds || 600) * 1000 });
  },
  remove(key) { cacheMap.delete(key); },
  removeAll(keys) { (keys || []).forEach(k => cacheMap.delete(k)); }
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cacheMap) if (v.exp && v.exp < now) cacheMap.delete(k);
}, 60000).unref();
const CacheService = { getScriptCache() { return scriptCache; }, getUserCache() { return scriptCache; } };

/* ---------------- Lock (the server handles one request at a time, so nothing can collide) ---------------- */
const LockService = {
  getScriptLock() { return { waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }; },
  getUserLock() { return this.getScriptLock(); },
  getDocumentLock() { return this.getScriptLock(); }
};

/* ---------------- Script Properties ---------------- */
const scriptProps = {
  getProperty(k) { return Object.prototype.hasOwnProperty.call(state.props, k) ? state.props[k] : null; },
  setProperty(k, v) { state.props[k] = String(v); markDirty(); return this; },
  deleteProperty(k) { delete state.props[k]; markDirty(); return this; },
  getProperties() { return Object.assign({}, state.props); },
  setProperties(o) { Object.keys(o || {}).forEach(k => { state.props[k] = String(o[k]); }); markDirty(); return this; }
};
const PropertiesService = { getScriptProperties() { return scriptProps; }, getUserProperties() { return scriptProps; } };

/* ---------------- Utilities ---------------- */
function toBuffer(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Array.isArray(input) || input instanceof Uint8Array || input instanceof Int8Array) return Buffer.from(Array.from(input).map(b => b & 255));
  return Buffer.from(String(input), 'utf8');
}
function signedBytes(buf) { return Array.from(buf).map(b => (b > 127 ? b - 256 : b)); }

function pad(n, w) { return String(n).padStart(w || 2, '0'); }
function formatDate(date, tz, fmt) {
  const d = (date instanceof Date) ? date : new Date(date);
  const offMin = (tz && tz !== TZ && tz !== 'GMT+5' && tz !== 'Asia/Karachi') ? (tz === 'UTC' || tz === 'GMT' ? 0 : TZ_OFFSET_MIN) : TZ_OFFSET_MIN;
  const t = new Date(d.getTime() + offMin * 60000);
  const Y = t.getUTCFullYear(), M = t.getUTCMonth() + 1, D = t.getUTCDate();
  const h = t.getUTCHours(), mi = t.getUTCMinutes(), s = t.getUTCSeconds(), ms = t.getUTCMilliseconds();
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  let out = '', i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch === "'") {
      let j = i + 1, lit = '';
      while (j < fmt.length && fmt[j] !== "'") { lit += fmt[j]; j++; }
      out += lit || "'"; i = j + 1; continue;
    }
    let j = i; while (j < fmt.length && fmt[j] === ch) j++;
    const n = j - i;
    switch (ch) {
      case 'y': out += n === 2 ? pad(Y % 100) : pad(Y, 4); break;
      case 'M': out += n >= 4 ? MONTHS[M - 1] : n === 3 ? MONTHS[M - 1].slice(0, 3) : pad(M, n); break;
      case 'd': out += pad(D, n); break;
      case 'H': out += pad(h, n); break;
      case 'h': out += pad(h % 12 || 12, n); break;
      case 'm': out += pad(mi, n); break;
      case 's': out += pad(s, n); break;
      case 'S': out += pad(ms, 3).slice(0, n); break;
      case 'a': out += h < 12 ? 'AM' : 'PM'; break;
      case 'E': out += n >= 4 ? DAYS[t.getUTCDay()] : DAYS[t.getUTCDay()].slice(0, 3); break;
      case 'Z': out += '+0500'; break;
      default: out += fmt.slice(i, j);
    }
    i = j;
  }
  return out;
}

class Blob {
  constructor(bytes, mime, name) { this._b = toBuffer(bytes); this._m = mime || 'application/octet-stream'; this._n = name || ''; }
  getBytes() { return signedBytes(this._b); }
  getContentType() { return this._m; }
  getName() { return this._n; }
  setName(n) { this._n = n; return this; }
  getDataAsString() { return this._b.toString('utf8'); }
}

const Utilities = {
  DigestAlgorithm: { MD5: 'md5', SHA_1: 'sha1', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512' },
  computeDigest(algo, input) { return signedBytes(crypto.createHash(algo).update(toBuffer(input)).digest()); },
  getUuid() { return crypto.randomUUID(); },
  formatDate,
  base64Encode(input) { return toBuffer(input).toString('base64'); },
  base64Decode(str) { return signedBytes(Buffer.from(String(str), 'base64')); },
  newBlob(bytes, mime, name) { return new Blob(bytes, mime, name); },
  sleep() {}
};

/* ---------------- Session ---------------- */
const emptyUser = { getEmail() { return ''; } };
const Session = {
  getScriptTimeZone() { return TZ; },
  getActiveUser() { return emptyUser; },      // nobody is the "owner running from the editor" here -
  getEffectiveUser() { return emptyUser; }    // every call must come through a login session
};

/* ---------------- Logger ---------------- */
const Logger = { log(...a) { if (process.env.GAS_LOG) console.log('[gas]', ...a); } };

/* ---------------- Drive (attachments are plain files in data/files) ---------------- */
function safeId(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, ''); }
const DriveApp = {
  createFolder(name) {
    const id = 'folder_' + crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(path.join(FILES_DIR, id), { recursive: true });
    return makeFolder(id);
  },
  getFolderById(id) {
    const dir = path.join(FILES_DIR, safeId(id));
    if (!fs.existsSync(dir)) throw new Error('Folder not found');
    return makeFolder(safeId(id));
  },
  getFileById(id) {
    id = safeId(id);
    const metaFile = path.join(FILES_DIR, 'file_' + id + '.json');
    const dataFile = path.join(FILES_DIR, 'file_' + id + '.bin');
    if (!fs.existsSync(metaFile) || !fs.existsSync(dataFile)) throw new Error('File not found');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return { getId() { return id; }, getName() { return meta.name; }, getBlob() { return new Blob(fs.readFileSync(dataFile), meta.mime, meta.name); } };
  }
};
function makeFolder(folderId) {
  return {
    getId() { return folderId; },
    createFile(blob) {
      const id = crypto.randomBytes(10).toString('hex');
      fs.writeFileSync(path.join(FILES_DIR, 'file_' + id + '.bin'), blob._b);
      fs.writeFileSync(path.join(FILES_DIR, 'file_' + id + '.json'), JSON.stringify({ name: blob.getName(), mime: blob.getContentType(), folder: folderId }));
      return { getId() { return id; }, getName() { return blob.getName(); } };
    }
  };
}

/* ---------------- UrlFetch (only the AI report uses it; it is asynchronous here) ---------------- */
const UrlFetchApp = {
  async fetchAsync(url, opts) {
    opts = opts || {};
    const resp = await fetch(url, {
      method: String(opts.method || 'get').toUpperCase(),
      headers: opts.contentType ? { 'Content-Type': opts.contentType } : undefined,
      body: opts.payload
    });
    const text = await resp.text();
    return { getResponseCode() { return resp.status; }, getContentText() { return text; } };
  }
};

const HtmlService = {};   // never used: the pages are served by the web server instead

module.exports = {
  SpreadsheetApp, CacheService, LockService, PropertiesService, Utilities, Session, Logger, DriveApp, UrlFetchApp, HtmlService
};
