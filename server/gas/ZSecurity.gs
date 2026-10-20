/*************************************************************
 * ZSECURITY.GS - server-side sessions + lockdown
 *
 * MUST BE THE LAST FILE in the project's file list (it has to load after
 * every other .gs file, because it wraps their functions).
 *
 * What it does:
 *  1) apiLogin / apiCall / apiLogout are the ONLY entry points the web page uses.
 *     Login issues a secret token; every later call sends that token and the
 *     server works out WHO you are from it (never from what the browser says).
 *  2) Every real function is wrapped so it refuses to run unless the call
 *     came through a valid session (or you, the owner, are running it from the
 *     Apps Script editor). So nobody can call getTable(), updateRowByKey()
 *     and friends directly from a browser any more.
 *  3) The username arguments the page still sends are replaced with the
 *     session's real username before the function runs.
 *************************************************************/

let GUARD_OPEN_ = false;          // true only while apiLogin/apiCall is running
let ACTIVE_SESSION_ = null;       // the verified user of the current call
let FORCE_NO_OWNER_ = false;      // used only by securityCheck's self-test
let OWNER_EXEC_CACHE_ = null;

const SESSION_TTL_SECONDS_ = 21600;                 // 6 hours since the last click (cache maximum)
const SESSION_MAX_AGE_MS_ = 12 * 60 * 60 * 1000;    // never longer than 12 hours in total
const MAX_LOGIN_FAILURES_ = 5;
const LOGIN_LOCK_SECONDS_ = 600;                    // 10 minutes
const MIN_PASSWORD_LENGTH_ = 8;
const DEFAULT_ADMIN_PASSWORD_ = 'admin123';

// Every function the web page may reach. Add any NEW public function here when it is created.
const PROTECTED_FUNCTIONS_ = [
  // Code.gs
  'fixCnicColumnFormatting','getTable','getTableCached','appendRowObj','updateRowByKey','authenticate','changePassword',
  'addUser','getUsers','getCampuses','getBudgetHeads','searchBudgetHeads','getHeadByCode','updateBudgetHead','deleteBudgetHead',
  'saveAllocation','getHeadsForCampus','searchAllocations','deleteAllocation','getBudgetStatus','getAllVendors','searchVendors',
  'searchVendorsAdmin','getVendorByCNIC','getVendorSecurityBalance','getEmployeeById','getAllEmployees','searchEmployees',
  'addEmployee','getBankAccounts','addBankAccount','deactivateBankAccount','getReceivingOffices','addReceivingOffice',
  'deactivateReceivingOffice','getNonUEEmployeeByCNIC','getAllNonUEEmployees','searchNonUEEmployees','getStudentById',
  'getAllStudents','searchStudents','submitEntry','updateEntry','deleteEntry','cancelEntry','searchEntriesAdmin',
  'submitBulkEntry','getBillsByStatus','getBillDetail','getPipelineCounts','markProcessed','markPassed',
  'markPaidAndGenerateIBFT','getPaymentBatches','getBatchDetails','systemCheck','previewSection149CancellationImpact',
  'applySection149CancellationImpact','previewSection149PaidOverDeduction','applySection149PaidOverDeduction',
  'listSection149CreditBalances','getSection149TaxDeductionStatement','getSection149IncomeItems','previewBillRedirect',
  'applyBillRedirect','getFBRTaxAdjustments','recordFBRTaxAdjustment',
  // DiaryStage.gs
  'getDiaryEligibleUsers','createDiaryEntry','getDiaryById','getPendingDiaryItems','getUserDiaryQueue',
  'getUserDiaryStageSummary','getUserDiarySummaryForExport','getHeldItemsForController','resumeHeldItem',
  'reassignReturnedItem','releaseBillHold','adminReassignAny','reassignItem','returnBillForCorrection','forwardLetter',
  'closeLetterWithResponse','closeLetterFiled','returnItem','getDiaryTrail','getPaymentsNeedingConfirmation',
  'getPaymentConfirmCount','getNeedsCorrectionBills','confirmPayments','confirmPayment','markPaymentsFailed',
  'markPaymentFailed','updateFailedPaymentBeneficiary','resubmitFailedPayment','getPaymentHistory','confirmBulkLines',
  'markBulkLinesFailed','resubmitFailedBulkLine','updateFailedBulkLineBeneficiary','getLineLevelConfirmationQueue','getDiaryAttachmentData',
  // Reports.gs
  'getYearlyBudgetReport','getConsumptionReport','getConfirmedPayments','getBudgetControlRegister','getBillStatusReport',
  'getGeneralLedger','getIBFTPaymentReport','getEntriesForSanctionPicker','getSanctionProformaData',
  'getTaxCalculationDetails','getDiaryReport',
  // Tax.gs
  'getTaxSettings','saveTaxSettings','getTaxSlabs','saveTaxSlab','deleteTaxSlab','getIncomeProfile','saveIncomeProfile',
  'previewTaxCalculation','setSection149ManualExclusion',
  // AI.gs
  'saveGeminiApiKey','clearGeminiApiKey','saveGeminiModel','getGeminiKeyStatus','askAIReport',
  // Duplicate Payment Recovery (Code.gs)
  'previewTaxCalculationWithRecovery','lookupRecoverySources','createDuplicateRecoveries','getDuplicateRecoveries','cancelDuplicateRecovery',
  'getRecoveryStatement','getBankReconciliationReport',
  // Diary admin tools + Bill Cycle Report
  'adminSearchDiary','adminUpdateDiary','adminCancelDiary','adminRestoreDiary','adminDelinkDiary','adminLinkDiaryToBill','getBillCycleReport',
  // Move a bill between cost centres
  'previewBillCostCenterTransfer','applyBillCostCenterTransfer'
];

// Protected, but never callable from the web page even when logged in.
const NEVER_FROM_BROWSER_ = {
  authenticate:1, getTable:1, getTableCached:1, appendRowObj:1, updateRowByKey:1, fixCnicColumnFormatting:1
};

// The Diary Clerk role may only use these actions.
const DIARY_CLERK_ALLOWED_ = {
  getDiaryEligibleUsers:1, getReceivingOffices:1, createDiaryEntry:1, getPendingDiaryItems:1, getUserDiaryStageSummary:1,
  getUserDiarySummaryForExport:1, getDiaryTrail:1, getDiaryById:1, getHeldItemsForController:1, resumeHeldItem:1,
  releaseBillHold:1, getUserDiaryQueue:1, changePassword:1, getBillDetail:1, getPaymentHistory:1,
  getCampuses:1, getBankAccounts:1, getGeminiKeyStatus:1, getDiaryReport:1, getDiaryAttachmentData:1
};

// Functions whose "username" argument is a TARGET person (not the caller). Only the Diary Clerk / Admin
// may look at someone else; everyone else is forced back to their own name.
const CONTROLLER_TARGET_PARAMS_ = { getUserDiaryStageSummary: 0, getUserDiarySummaryForExport: 0 };

/* ---------- owner / editor runs ---------- */
function isOwnerExecution_() {
  if (FORCE_NO_OWNER_) return false;
  if (OWNER_EXEC_CACHE_ !== null) return OWNER_EXEC_CACHE_;
  let r = false;
  try {
    const active = Session.getActiveUser().getEmail();
    const effective = Session.getEffectiveUser().getEmail();
    r = !!active && active === effective;   // you, running from the editor (a web visitor never matches)
  } catch (err) { r = false; }
  OWNER_EXEC_CACHE_ = r;
  return r;
}

function parseParams_(fn) {
  try {
    const src = Function.prototype.toString.call(fn);
    const m = src.match(/^[^(]*\(([^)]*)\)/);
    if (!m) return [];
    return m[1].split(',').map(p => p.replace(/\/\*[\s\S]*?\*\//g, '').split('=')[0].trim()).filter(Boolean);
  } catch (e) { return []; }
}

/* ---------- the lockdown itself (runs every time the project loads) ---------- */
(function installLockdown_() {
  const g = (typeof globalThis !== 'undefined') ? globalThis : this;

  PROTECTED_FUNCTIONS_.forEach(name => {
    try {
      const original = g[name];
      if (typeof original !== 'function' || original.__guarded) return;
      const params = parseParams_(original);
      const wrapped = function () {
        if (!GUARD_OPEN_ && !isOwnerExecution_()) throw new Error('SESSION_REQUIRED');
        return original.apply(this, arguments);
      };
      wrapped.__guarded = true;
      wrapped.__params = params;
      g[name] = wrapped;
    } catch (e) { /* leave this one alone - securityCheck will report it */ }
  });

  // Maintenance functions: harmless to run, so they may open the guard themselves (so you can run them from the editor).
  ['initializeSystem', 'repairEntryStatuses', 'debugAdminLogin'].forEach(name => {
    try {
      const original = g[name];
      if (typeof original !== 'function' || original.__opened) return;
      const opened = function () {
        const was = GUARD_OPEN_;
        GUARD_OPEN_ = true;
        try { return original.apply(this, arguments); } finally { GUARD_OPEN_ = was; }
      };
      opened.__opened = true;
      g[name] = opened;
    } catch (e) {}
  });

  // The admin-password reset only works if YOU first add the script property ALLOW_ADMIN_RESET = yes.
  try {
    const originalReset = g['resetAdminPassword'];
    if (typeof originalReset === 'function' && !originalReset.__opened) {
      const safeReset = function () {
        const props = PropertiesService.getScriptProperties();
        if (props.getProperty('ALLOW_ADMIN_RESET') !== 'yes') {
          throw new Error('Blocked. To reset the admin password: Project Settings > Script properties > add ALLOW_ADMIN_RESET = yes, run this again, and it will remove the property after one use.');
        }
        props.deleteProperty('ALLOW_ADMIN_RESET');
        const was = GUARD_OPEN_;
        GUARD_OPEN_ = true;
        try { return originalReset.apply(this, arguments); } finally { GUARD_OPEN_ = was; }
      };
      safeReset.__opened = true;
      g['resetAdminPassword'] = safeReset;
    }
  } catch (e) {}
})();

/* ================= LOGIN / LOGOUT / SESSION ================= */
function apiLogin(username, password) {
  const uname = String(username || '').trim().slice(0, 100);
  password = String(password || '');
  if (!uname || !password) return { success: false, message: 'Enter your username and password.' };

  const cache = CacheService.getScriptCache();
  const lockKey = 'F_' + uname.toLowerCase();
  const failures = Number(cache.get(lockKey) || 0);
  if (failures >= MAX_LOGIN_FAILURES_) {
    return { success: false, message: 'Too many failed attempts. Please wait 10 minutes and try again.' };
  }

  GUARD_OPEN_ = true;
  try {
    const res = authenticate(uname, password);
    if (!res || !res.success) {
      cache.put(lockKey, String(failures + 1), LOGIN_LOCK_SECONDS_);
      return { success: false, message: 'Invalid username or password.' };
    }
    cache.remove(lockKey);
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    cache.put('S_' + token, JSON.stringify({ u: res.username, c: Date.now() }), SESSION_TTL_SECONDS_);
    return {
      success: true, token: token, username: res.username, fullName: res.fullName, role: res.role,
      weakPassword: password === DEFAULT_ADMIN_PASSWORD_
    };
  } finally {
    GUARD_OPEN_ = false;
  }
}

function apiLogout(token) {
  try { CacheService.getScriptCache().remove('S_' + String(token || '')); } catch (e) {}
  return true;
}

// Checks the token AND re-reads the user's row (so a deactivated user or a changed role takes effect immediately).
function resolveSession_(token) {
  token = String(token || '');
  if (token.length < 40) throw new Error('SESSION_EXPIRED');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('S_' + token);
  if (!raw) throw new Error('SESSION_EXPIRED');
  let s;
  try { s = JSON.parse(raw); } catch (e) { throw new Error('SESSION_EXPIRED'); }
  if (!s || !s.u || (Date.now() - Number(s.c || 0)) > SESSION_MAX_AGE_MS_) {
    cache.remove('S_' + token);
    throw new Error('SESSION_EXPIRED');
  }
  const user = getUsersTable_().find(r => String(r.Username).trim() === s.u);
  if (!user || user.Active === false || user.Active === 'FALSE') {
    cache.remove('S_' + token);
    throw new Error('SESSION_EXPIRED');
  }
  cache.put('S_' + token, raw, SESSION_TTL_SECONDS_);   // sliding expiry
  return { username: String(user.Username).trim(), fullName: user.FullName, role: user.Role };
}

/* ================= THE ONE DOOR THE WEB PAGE USES ================= */
function apiCall(token, fnName, args) {
  GUARD_OPEN_ = true;
  try {
    const sess = resolveSession_(token);
    fnName = String(fnName || '');
    const g = (typeof globalThis !== 'undefined') ? globalThis : this;
    const fn = g[fnName];
    if (/_$/.test(fnName) || typeof fn !== 'function' || !fn.__guarded || NEVER_FROM_BROWSER_[fnName]) {
      throw new Error('That action is not available.');
    }
    if (sess.role === 'DiaryClerk' && !DIARY_CLERK_ALLOWED_[fnName]) {
      throw new Error('Your role does not have access to this action.');
    }

    args = Array.isArray(args) ? args.slice() : [];

    // Password rules (checked here so the Code.gs functions did not need to change).
    if ((fnName === 'addUser' || fnName === 'changePassword') && String(args[2] || '').length < MIN_PASSWORD_LENGTH_) {
      throw new Error('Password must be at least ' + MIN_PASSWORD_LENGTH_ + ' characters.');
    }

    // Identity: whatever username the browser sent is replaced with the real one.
    (fn.__params || []).forEach((p, i) => {
      if (p === 'actorUsername') {
        args[i] = sess.username;
      } else if (p === 'username') {
        const isController = (sess.role === 'Admin' || sess.role === 'DiaryClerk');
        if (CONTROLLER_TARGET_PARAMS_[fnName] === i && isController && args[i]) { /* keep the requested person */ }
        else args[i] = sess.username;
      }
    });

    ACTIVE_SESSION_ = sess;
    return fn.apply(null, args);
  } finally {
    ACTIVE_SESSION_ = null;
    GUARD_OPEN_ = false;
  }
}

/* ================= CHECK (run this from the editor after deploying) ================= */
function securityCheck() {
  const g = (typeof globalThis !== 'undefined') ? globalThis : this;
  const out = [];
  let guarded = 0;
  const missing = [], notWrapped = [];
  PROTECTED_FUNCTIONS_.forEach(n => {
    const f = g[n];
    if (typeof f !== 'function') missing.push(n);
    else if (f.__guarded) guarded++;
    else notWrapped.push(n);
  });

  // Self-test: with the owner exception switched off, a direct call must be refused.
  FORCE_NO_OWNER_ = true; OWNER_EXEC_CACHE_ = null;
  let blocked = false, testError = '';
  try { getTable('Users'); } catch (e) { testError = String(e && e.message); blocked = testError.indexOf('SESSION_REQUIRED') !== -1; }
  FORCE_NO_OWNER_ = false; OWNER_EXEC_CACHE_ = null;

  // Public functions that exist but are NOT protected (for example leftover one-time scripts).
  const known = {};
  PROTECTED_FUNCTIONS_.forEach(n => known[n] = true);
  ['doGet','include','apiLogin','apiCall','apiLogout','securityCheck','initializeSystem','repairEntryStatuses','debugAdminLogin','resetAdminPassword','repairBulkParentTotalsAfterIsolation']
    .forEach(n => known[n] = true);
  const unprotected = [];
  try {
    Object.getOwnPropertyNames(g).forEach(n => {
      if (/_$/.test(n) || known[n]) return;
      let f; try { f = g[n]; } catch (e) { return; }
      if (typeof f !== 'function') return;
      let src = ''; try { src = Function.prototype.toString.call(f); } catch (e) { return; }
      if (src.indexOf('[native code]') !== -1) return;
      if (!/^\s*function\b/.test(src)) return;
      unprotected.push(n);
    });
  } catch (e) { out.push('(Could not list all functions: ' + e.message + ')'); }

  out.push('Protected functions: ' + guarded + ' of ' + PROTECTED_FUNCTIONS_.length + '.');
  if (missing.length) out.push('NOT FOUND (file missing, or ZSecurity is not the LAST file?): ' + missing.join(', '));
  if (notWrapped.length) out.push('FOUND BUT NOT PROTECTED: ' + notWrapped.join(', '));
  out.push('Direct-call test (getTable without a session): ' + (blocked ? 'BLOCKED - good.' : 'NOT BLOCKED - problem. ' + testError));
  if (unprotected.length) out.push('Public functions that are NOT protected (delete any leftover one-time scripts, or tell me): ' + unprotected.join(', '));
  out.push((blocked && !missing.length && !notWrapped.length)
    ? 'LOCKDOWN ACTIVE. Tip: also confirm Deploy > Manage deployments says "Execute as: Me".'
    : 'LOCKDOWN NOT FULLY ACTIVE - please send me this log.');
  const text = out.join('\n');
  Logger.log(text);
  return text;
}