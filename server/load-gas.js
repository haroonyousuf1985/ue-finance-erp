/* ============================================================
   load-gas.js - loads the ORIGINAL Google Apps Script files
   (server/gas/*.gs) and runs them here, exactly as written.
   ZSecurity.gs must load last (it wraps the other functions).
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const shim = require('./gas-shim');

const ORDER = ['Code.gs', 'DiaryStage.gs', 'Reports.gs', 'Tax.gs', 'AI.gs', 'ZSecurity.gs'];

function loadGas() {
  Object.assign(globalThis, shim);

  let source = ORDER.map(f => '\n/* ===== ' + f + ' ===== */\n' + fs.readFileSync(path.join(__dirname, 'gas', f), 'utf8')).join('\n');

  // The one place Google's code waits for the internet: the AI report. Make that single call asynchronous.
  const before = source;
  source = source.replace('function askAIReport(', 'async function askAIReport(');
  source = source.replace('res = UrlFetchApp.fetch(url, {', 'res = await UrlFetchApp.fetchAsync(url, {');
  if (source === before || source.indexOf('fetchAsync') === -1 || source.indexOf('async function askAIReport') === -1) {
    throw new Error('Could not adapt the AI report code - AI.gs does not look like the expected version.');
  }

  vm.runInThisContext(source, { filename: 'gas-bundle.js' });

  return {
    apiLogin: globalThis.apiLogin,
    apiLogout: globalThis.apiLogout,
    apiCall: globalThis.apiCall,
    initializeSystem: globalThis.initializeSystem,
    securityCheck: globalThis.securityCheck
  };
}

module.exports = { loadGas };
