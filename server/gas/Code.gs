/*************************************************************
 * ERP & BUDGET UTILIZATION MODULE - UE FINANCE - v4
 * Backend: Google Sheets. Frontend: Apps Script Web App.
 *
 * FILES IN THIS PROJECT:
 *   Code.gs (includes Duplicate Payment Recovery at the end), DiaryStage.gs, Reports.gs, Tax.gs, AI.gs
 *   Index.html, Styles.html, Scripts.html (+ ScriptsDiary.html), Diary.html, Entry.html,
 *   Processing.html, Passing.html, Payment.html, PaymentConfirmation.html,
 *   Reconciliation.html, ReportsView.html, Admin.html
 *
 * Any time you edit code: Deploy > Manage deployments > pencil icon >
 * Version: "New version" > Deploy. This step is required every time or the
 * live web app keeps running the old code. After changing the sheet layout
 * (SCHEMA below), run "initializeSystem" once.
 *************************************************************/

const SS = SpreadsheetApp.getActiveSpreadsheet();

const SHEETS = {
  USERS: 'Users', CAMPUSES: 'Campuses', HEADS: 'BudgetHeads',
  ALLOC: 'Allocations', VENDORS: 'Vendors', EMPLOYEES: 'Employees', NONUE: 'NonUEEmployees', STUDENTS: 'Students',
  HEADSPLITS: 'EntryHeadSplits',
  ENTRIES: 'Entries', BULKITEMS: 'BulkLineItems', BATCHES: 'PaymentBatches', SETTINGS: 'Settings',
  INCOMEPROFILES: 'IncomeProfiles', TAXSLABS: 'TaxSlabs149', S149CREDITS: 'Section149Credits', S149EXCLUSIONS: 'Section149Exclusions',
  VENDORENTRIES: 'VendorEntries', EMPLOYEEENTRIES: 'EmployeeEntries', STUDENTENTRIES: 'StudentEntries',
  BANKACCOUNTS: 'BankAccounts', OFFICES: 'ReceivingOffices',
  DIARY: 'Diary', PAYMENTCONFIRM: 'PaymentConfirmations', LETTERMOVEMENTS: 'LetterMovements', LETTERATTACH: 'LetterAttachments',
  FBRTAXADJUSTMENTS: 'FBRTaxAdjustments',
  DUPREC: 'DuplicateRecoveries', DUPRECAPP: 'DuplicateRecoveryApplications',
  CCTRANSFERS: 'CostCentreTransfers'
};

// The status word "Passed" is the data value; the tab label is "Passing".
const STATUS = { RECEIVED: 'Received', PROCESSED: 'Processed', PASSED: 'Passed', PAID: 'Paid', CANCELLED: 'Cancelled' };

// Single default Financial Year used to prefill every FY field in the UI.
// Change this string once per year - every screen picks it up automatically.
const DEFAULT_FY = '2026-27';

// FY comparison is normalized: two FY values are the same year if they start with the same
// 4-digit year. A blank filter value means "every year - no filter".
function normalizeFY_(fy) {
  const s = String(fy == null ? '' : fy).trim();
  const m = s.match(/\d{4}/);
  return m ? m[0] : s.toLowerCase();
}
function fyMatches_(entryFY, filterFY) {
  if (!filterFY) return true;
  return normalizeFY_(entryFY) === normalizeFY_(filterFY);
}

const SCHEMA = {
  Users: ['Username','PasswordHash','FullName','Role','Active'],
  Campuses: ['CampusID','CampusName','Active'],
  BudgetHeads: ['HeadID','HeadCode','HeadName','Active'],
  Allocations: ['CampusID','HeadID','FY','AllocatedAmount'],
  BankAccounts: ['AccountID','AccountTitle','BankName','AccountNumber','Active'],
  ReceivingOffices: ['OfficeID','OfficeName','Active'],
  Vendors: ['VendorName','CNIC_NTN','IBAN','BankName','Phone'],
  Employees: ['EmployeeID','Name','CNIC','IBAN','BankName','Department','Designation'],
  NonUEEmployees: ['CNIC','Name','IBAN','BankName'],
  Students: ['StudentID','Name','CNIC','IBAN','Program','Session','Shift'],
  IncomeProfiles: ['Key','PayeeType','FY','Name','AnnualTaxableIncome','AffidavitLowIncome'],
  TaxSlabs149: ['Threshold','FixedAmount','Rate','Label'],
  // Section 149 "owed back" credit ledger - one row per (Key, PayeeType, FY).
  Section149Credits: ['Key','PayeeType','FY','CreditAmount','Notes','LastUpdated'],
  // Manual, Admin-controlled override of which bills/lines count toward a person's Section 149 annual income.
  Section149Exclusions: ['Key','PayeeType','FY','ItemID','Excluded','Reason','SetBy','SetDate'],
  Entries: ['EntryID','Timestamp','EntryDate','FY','CampusID','CampusName','HeadID','HeadCode','HeadName',
    'PayeeType','EmployeeID','VendorName','CNIC_NTN','IBAN','Amount','BillDescription','BillNo','EnteredBy','Status',
    'ProcessedBy','ProcessedDate','PassedBy','PassedDate','PaidBy','PaidDate','BatchID',
    // --- Student payee fields ---
    'StudentID','Program','Session','Shift',
    // --- Tax / deduction fields ---
    'BillNature','RefundCategory','FBRStatus','ServiceCategory','TaxpayerType','PRAStatus',
    'IncomeTaxSection','IncomeTaxRate','IncomeTaxAmount',
    'SalesTaxApplied','SalesTaxRate','SalesTaxAmount',
    'PSTApplied','PSTRate','PSTAmount',
    // --- Other deductions (Mode is 'rate' or 'amount') ---
    'SecurityApplied','SecurityMode','SecurityBasis','SecurityRate','SecurityAmount',
    'PenaltyApplied','PenaltyMode','PenaltyBasis','PenaltyRate','PenaltyAmount',
    'OtherDeductionApplied','OtherDeductionMode','OtherDeductionCategory','OtherDeductionBasis','OtherDeductionRate','OtherDeductionAmount',
    'StudentDeductionApplied','StudentDeductionCategory','StudentDeductionBasis','StudentDeductionAmount',
    // --- Section 149 ---
    'EmployeeCategory','ExamSubCategory','AffidavitLowIncome','IncomeBeforeThisBill','IncomeAfterThisBill','Designation',
    'ThesisClass','ThesisStudentName','BenevolentFundSubCategory','NonUETaxMethod',
    'VisitingProgram','VisitingSubject','VisitingCrHrs','VisitingRate','VisitingLectures',
    'PayFromAccountID','PayFromAccountLabel','PayFromAccountNumber','ReceivingOfficeID','ReceivingOffice',
    'PSTInvoiceNo','VendorInvoiceDate','ContractCategory','ManualTaxOverride','ManualTaxSection','ManualTaxMode','ManualTaxRate','ManualTaxAmount',
    'ManualSalesTaxOverride','SalesTaxMode','ManualPSTOverride','PSTMode',
    // Budget Position, LOCKED at the moment this bill was saved.
    'BudgetAllocatedAtEntry','BudgetExpensesBeforeThisBill','BudgetAfterThisBill',
    'CancelledBy','CancelledDate','CancellationReason','StatusBeforeCancellation',
    'Section149CreditApplied','Section149PaidCreditRecorded',
    // --- Wrong-beneficiary redirect audit trail ---
    'RedirectedFromEntryID','RedirectedToEntryID',
    // --- Stage 0 Diary linkage ---
    'DiaryID','DiaryBypassReason','DiaryIDs',
    // --- Payment Confirmation ---
    'PaymentStatus','PaymentConfirmedDate','PaymentConfirmedBy',
    'PaymentFailureReason','PaymentFailureLoggedBy','PaymentFailureDate','PaymentRetryOfEntryID','PaymentRetryCount',
    // --- Return / On-Hold ---
    'OnHold','HoldReason','HoldBy','HoldDate','ReleasedBy','ReleasedDate',
    // --- Isolated bulk beneficiary: set on a bill like E123-A, pointing back at the bulk bill (E123) and its line number ---
    'SplitFromEntryID','SplitFromLineNo',
    // --- Duplicate-payment recovery deducted from this bill's net ---
    'RecoveryDeducted',
    // Fingerprint of a bulk upload - lets the same upload arriving twice be recognised instead of saved twice.
    'UploadFingerprint',
    'NetAmount'],
  get VendorEntries() { return SCHEMA.Entries; },
  get EmployeeEntries() { return SCHEMA.Entries; },
  get StudentEntries() { return SCHEMA.Entries; },
  PaymentBatches: ['BatchID','Date','GeneratedBy','TotalAmount','EntryIDs'],
  // One row per beneficiary in a bulk-uploaded bill. SplitToEntryID is set when this line's payment failed
  // and it was isolated into its own bill (e.g. E123-A).
  BulkLineItems: ['ParentEntryID','LineNo','PayeeType','EmployeeID','StudentID','VendorName','CNIC_NTN','IBAN','BankName',
    'Program','Session','Shift','BillNature','ThesisClass','ThesisStudentName','BenevolentFundSubCategory',
    'VisitingProgram','VisitingSubject','VisitingCrHrs','VisitingRate','VisitingLectures',
    'ReceivingOfficeID','ReceivingOffice','PayFromAccountID','PayFromAccountLabel','PayFromAccountNumber',
    'Amount','IncomeTaxAmount','IncomeTaxSection','SalesTaxAmount','PSTAmount',
    'SecurityAmount','PenaltyAmount','OtherDeductionAmount','NetAmount','BillDescription','Section149CreditApplied',
    'RedirectedToEntryID','RedirectedBy','RedirectedDate',
    'Section149PaidCreditRecorded',
    'LinePaymentStatus','LinePaymentConfirmedDate','LinePaymentConfirmedBy',
    'LinePaymentFailureReason','LinePaymentFailureLoggedBy','LinePaymentFailureDate','LinePaymentRetryCount',
    'SplitToEntryID','RecoveryDeducted'],
  EntryHeadSplits: ['ParentEntryID','CampusID','HeadID','HeadCode','HeadName','FY','EntryDate','Amount',
    'BudgetAllocatedAtEntry','BudgetExpensesBeforeThisBill','BudgetAfterThisBill'],
  // Stage 0 (Diary/Receiving) - one row per bill OR letter logged as physically received.
  // HeldByUsername/HeldDate/HeldReason: who returned it or sent it to another office, when, and why.
  Diary: ['DiaryID','DateReceived','SenderReferenceDate','LoggedBy','ItemType',
    'SenderType','VendorName','EmployeeID','CNIC_NTN','SenderOfficeName','SenderReferenceNo',
    'OriginatingOfficeID','OriginatingOfficeName','OriginatingOfficeOther',
    'RoughDescription','AssignedToUsername','AssignedDate','AssignedBy',
    'PendingOfficeConfirmation','OfficeName',
    'Status','LinkedEntryID','ClosedDate','ClosedBy',
    'HeldByUsername','HeldDate','HeldReason','Amount','BillType'],
  LetterMovements: ['MovementID','DiaryID','ActionType','FromUser','ToUser','ActionDate',
    'ResponseRefNo','ResponseDate','Details',
    'ReturnObjection','ReturnRefNo','ReturnDate','ReturnReceiverName'],
  // Files attached to a Diary item's movements (original letter, response letter, objection letter) - stored in Google Drive.
  LetterAttachments: ['AttachmentID','DiaryID','MovementID','Kind','FileName','MimeType','FileSize','DriveFileId','UploadedBy','UploadedDate'],
  PaymentConfirmations: ['ConfirmationID','EntryID','BatchID','EventType','EventDate','LoggedBy','Notes'],
  FBRTaxAdjustments: ['AdjustmentID','WrongBeneficiaryKey','WrongBeneficiaryName','WrongBeneficiaryPayeeType',
    'OriginalEntryID','RedirectedToEntryID','TaxAmount','AmountAdjusted','DepositStatus','Status',
    'CreatedDate','CreatedBy','Notes','LastAdjustedDate','LastAdjustedBy'],
  Settings: ['Key','Value'],
  // Amounts paid twice by mistake outside the system, to be recovered from the beneficiary's next bills.
  DuplicateRecoveries: ['RecoveryID','SourceEntryID','PayeeType','BeneficiaryKey','BeneficiaryName','EmployeeID','CNIC_NTN','IBAN',
    'SourceNetPaid','AmountPaidTwice','Notes','Status','CreatedBy','CreatedDate','CancelledBy','CancelledDate','CancelReason'],
  // One row per deduction made from a bill/line's net amount.
  DuplicateRecoveryApplications: ['ApplicationID','RecoveryID','EntryID','Amount','AppliedDate','AppliedBy','Status'],
  // A bill moved from one cost centre / budget head to another by Admin (the trail behind the Budget Control Register's reversal rows).
  CostCentreTransfers: ['TransferID','EntryID','FY','Amount','FromCampusID','FromCampusName','FromHeadID','FromHeadCode','FromHeadName',
    'ToCampusID','ToCampusName','ToHeadID','ToHeadCode','ToHeadName','BillStatusAtTransfer','Reason','TransferredBy','TransferDate']
};

/* ================= SETUP ================= */

function initializeSystem() {
  Object.keys(SCHEMA).forEach(name => ensureSheetAndColumns_(name, SCHEMA[name]));
  const users = getTable(SHEETS.USERS);
  if (users.length === 0) {
    appendRowObj(SHEETS.USERS, { Username:'admin', PasswordHash: hashPassword_('admin123'), FullName:'Administrator', Role:'Admin', Active:true });
  }
  seedDefaultTaxSlabsIfEmpty_();
  SpreadsheetApp.flush();
  return 'Ready. Default login (if new): admin / admin123 - please change it.';
}

// CNIC/NTN and IBAN values are identifiers, never numbers - the column is forced to Plain Text
// so Google Sheets never reinterprets them as numbers.
const CNIC_COLUMNS = { Entries:'CNIC_NTN', Vendors:'CNIC_NTN', Employees:'CNIC', NonUEEmployees:'CNIC', Students:'CNIC', BulkLineItems:'CNIC_NTN' };
const IBAN_COLUMNS = { Entries:'IBAN', Vendors:'IBAN', Employees:'IBAN', NonUEEmployees:'IBAN', Students:'IBAN', BulkLineItems:'IBAN' };
function forceTextColumns_(sh, headers) {
  [CNIC_COLUMNS[sh.getName()], IBAN_COLUMNS[sh.getName()]].forEach(colName => {
    if (!colName) return;
    const idx = headers.indexOf(colName);
    if (idx === -1) return;
    sh.getRange(2, idx + 1, 5000, 1).setNumberFormat('@');
  });
}
function ensureSheetAndColumns_(name, requiredHeaders) {
  let sh = SS.getSheetByName(name);
  if (!sh) {
    sh = SS.insertSheet(name);
    sh.appendRow(requiredHeaders);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,requiredHeaders.length).setFontWeight('bold');
    forceTextColumns_(sh, requiredHeaders);
    return sh;
  }
  const lastCol = sh.getLastColumn();
  const current = lastCol > 0 ? sh.getRange(1,1,1,lastCol).getValues()[0] : [];
  const missing = requiredHeaders.filter(h => current.indexOf(h) === -1);
  if (missing.length) {
    sh.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    sh.getRange(1, current.length + 1, 1, missing.length).setFontWeight('bold');
  }
  return sh;
}

// Admin-only, one-time fix for sheets created before CNIC/IBAN columns were forced to Plain Text.
function fixCnicColumnFormatting(username) {
  requireAdmin_(username);
  const fixed = [];
  const sheetNames = Array.from(new Set(Object.keys(CNIC_COLUMNS).concat(Object.keys(IBAN_COLUMNS))));
  sheetNames.forEach(sheetName => {
    const sh = SS.getSheetByName(sheetName);
    if (!sh) return;
    const lastCol = sh.getLastColumn();
    if (!lastCol) return;
    const headers = sh.getRange(1,1,1,lastCol).getValues()[0];
    forceTextColumns_(sh, headers);
    fixed.push(sheetName);
  });
  return { success:true, fixed };
}

function doGet(e) {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('ERP & Budget Utilization Module - UE Finance')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function include(filename) {
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
  } catch (err) {
    throw new Error('Could not load HTML file "' + filename + '". Make sure a file named exactly "' + filename + '" (no .html extension in the Apps Script editor) exists in this project. Original error: ' + err.message);
  }
}

/* ================= LOW-LEVEL HELPERS (name-based, not position-based) ================= */

// Everything read from a sheet must survive the trip to the browser: errors/objects become
// plain strings, dates become ISO strings.
function sanitizeValue_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString();
  if (typeof v === 'object') {
    try { return String(v); } catch (err) { return ''; }
  }
  return v;
}

// Every sheet access goes through here. A missing sheet is created on the spot with the right columns.
function getOrCreateSheet_(sheetName) {
  let sh = SS.getSheetByName(sheetName);
  if (sh) return sh;
  if (!SCHEMA[sheetName]) throw new Error('"' + sheetName + '" is not a known sheet name - check for a typo in the code.');
  return ensureSheetAndColumns_(sheetName, SCHEMA[sheetName]);
}

function getTable(sheetName) {
  const sh = getOrCreateSheet_(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return values.map(row => {
    const obj = {};
    headers.forEach((h,i) => { if (h) obj[h] = sanitizeValue_(row[i]); });
    return obj;
  });
}

const CACHEABLE_SHEETS = { Campuses:1, BudgetHeads:1, Allocations:1, BankAccounts:1, ReceivingOffices:1 };
function getTableCached(sheetName) {
  if (!CACHEABLE_SHEETS[sheetName]) return getTable(sheetName);
  const cache = CacheService.getScriptCache();
  const key = 'tbl_' + sheetName;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const data = getTable(sheetName);
  try { cache.put(key, JSON.stringify(data), 30); } catch (err) { /* payload too big for cache - ignore */ }
  return data;
}
let USERS_MEMO_ = null;
function invalidateCache_(sheetName) {
  if (sheetName === SHEETS.USERS) USERS_MEMO_ = null;
  if (sheetName === SHEETS.SETTINGS) { try { SETTINGS_MEMO_ = null; } catch (e) {} }
  try { CacheService.getScriptCache().remove('tbl_' + sheetName); } catch (err) {}
}
// Users sheet read once per request (and kept for 45 seconds) instead of 2-3 times on every click.
function getUsersTable_() {
  if (USERS_MEMO_) return USERS_MEMO_;
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('tbl_Users'); if (hit) { USERS_MEMO_ = JSON.parse(hit); return USERS_MEMO_; } } catch (e) {}
  const data = getTable(SHEETS.USERS);
  USERS_MEMO_ = data;
  try { cache.put('tbl_Users', JSON.stringify(data), 45); } catch (e) {}
  return data;
}

function appendRowObj(sheetName, rowObj) {
  const sh = getOrCreateSheet_(sheetName);
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0];
  sh.appendRow(headers.map(h => (h && rowObj[h] !== undefined) ? rowObj[h] : ''));
  invalidateCache_(sheetName);
}

function updateRowByKey(sheetName, keyCol, keyVal, updates) {
  const sh = getOrCreateSheet_(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const kIdx = headers.indexOf(keyCol);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][kIdx]) === String(keyVal)) {
      Object.keys(updates).forEach(col => {
        const cIdx = headers.indexOf(col);
        if (cIdx !== -1) sh.getRange(i+1, cIdx+1).setValue(updates[col]);
      });
      invalidateCache_(sheetName);
      return true;
    }
  }
  return false;
}

// Deletes every row matching keyVal in keyCol (child rows like EntryHeadSplits/BulkLineItems).
function deleteRowsByKey_(sheetName, keyCol, keyVal) {
  const sh = getOrCreateSheet_(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const kIdx = headers.indexOf(keyCol);
  if (kIdx === -1) return 0;
  const hit = [];
  for (let i = 1; i < values.length; i++) { if (String(values[i][kIdx]) === String(keyVal)) hit.push(i + 1); }
  if (!hit.length) return 0;
  // Contiguous rows (e.g. all lines of one bulk bill) are removed in ONE call, bottom-up.
  let end = hit.length - 1;
  while (end >= 0) {
    let start = end;
    while (start > 0 && hit[start - 1] === hit[start] - 1) start--;
    sh.deleteRows(hit[start], end - start + 1);
    end = start - 1;
  }
  invalidateCache_(sheetName);
  return hit.length;
}

// Concurrency-safe ID + append, so 2 people saving at the same instant never collide
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nextId_(prefix, sheetName, idColName) {
  const data = getTable(sheetName);
  let max = 0;
  data.forEach(r => {
    const num = parseInt(String(r[idColName] || '').replace(prefix, ''), 10);
    if (!isNaN(num) && num > max) max = num;
  });
  return prefix + (max + 1);
}

/* ================= AUTH ================= */

function hashPassword_(pw) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw + '::salt_v1');
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2,'0')).join('');
}

function authenticate(username, password) {
  const uname = String(username||'').trim();
  const user = getTable(SHEETS.USERS).find(r => String(r.Username).trim() === uname
    && r.PasswordHash === hashPassword_(password) && r.Active !== false && r.Active !== 'FALSE');
  if (!user) return { success:false, message:'Invalid username or password.' };
  return { success:true, username:String(user.Username).trim(), fullName:user.FullName, role:user.Role };
}

function changePassword(username, oldPassword, newPassword) {
  const uname = String(username||'').trim();
  const user = getTable(SHEETS.USERS).find(r => String(r.Username).trim() === uname);
  if (!user) return { success:false, message:'User not found.' };
  if (user.PasswordHash !== hashPassword_(oldPassword)) return { success:false, message:'Old password incorrect.' };
  if (!newPassword || newPassword.length < 4) return { success:false, message:'New password too short.' };
  updateRowByKey(SHEETS.USERS, 'Username', username, { PasswordHash: hashPassword_(newPassword) });
  return { success:true };
}

function requireAdmin_(username) {
  const uname = String(username||'').trim();
  const u = getUsersTable_().find(r => String(r.Username).trim() === uname);
  if (!u || u.Role !== 'Admin') throw new Error('Admin permission required for this action.');
}

// Role model: Admin (everything), Accounts (Entry + Reports), RA (Passing + Reports), IBFT, ReportsOnly,
// DiaryClerk, AllExceptAdmin. 'Entry' is kept as an alias for Accounts.
function getUserRole_(username) {
  const uname = String(username||'').trim();
  const u = getUsersTable_().find(r => String(r.Username).trim() === uname);
  return u ? u.Role : null;
}
function requireRole_(username, allowedRoles) {
  const role = getUserRole_(username);
  const normalized = role === 'Entry' ? 'Accounts' : role;
  // Admin always passes. AllExceptAdmin passes every bill-lifecycle check (only requireAdmin_ blocks it).
  if (role === 'Admin' || role === 'AllExceptAdmin') return;
  if (!normalized || allowedRoles.indexOf(normalized) === -1) {
    throw new Error('Your role (' + (role||'unknown') + ') does not have permission to perform this action.');
  }
}

// Anyone with access to the Reports tab (every role except DiaryClerk).
function requireReportsAccess_(username) {
  const role = getUserRole_(username);
  if (role === 'DiaryClerk' || !role) throw new Error('Your role (' + (role||'unknown') + ') does not have access to Reports.');
}

function addUser(actorUsername, newUsername, newPassword, fullName, role) {
  requireAdmin_(actorUsername);
  newUsername = (newUsername || '').trim();
  if (!newUsername || !newPassword || !fullName) return { success:false, message:'All fields are required.' };
  return withLock_(() => {
    if (getTable(SHEETS.USERS).find(r => r.Username === newUsername)) {
      return { success:false, message:'Username already exists.' };
    }
    appendRowObj(SHEETS.USERS, { Username:newUsername, PasswordHash:hashPassword_(newPassword), FullName:fullName, Role: role || 'Entry', Active:true });
    return { success:true };
  });
}

function getUsers(actorUsername) {
  requireAdmin_(actorUsername);
  return getTable(SHEETS.USERS).map(u => ({ Username:u.Username, FullName:u.FullName, Role:u.Role }));
}

/* ================= CAMPUSES & BUDGET HEADS (admin-managed) ================= */

function getCampuses() {
  const rows = getTableCached(SHEETS.CAMPUSES).filter(c => c.Active !== false && c.Active !== 'FALSE');
  const seen = new Set();
  return rows.filter(c => {
    const key = String(c.CampusName).trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addCampus_(name, actorUsername) {
  requireAdmin_(actorUsername);
  name = (name || '').trim();
  if (!name) return { success:false, message:'Campus name required.' };
  return withLock_(() => {
    const existing = getTable(SHEETS.CAMPUSES).find(c => c.CampusName.toLowerCase() === name.toLowerCase());
    if (existing) return { success:true, id:existing.CampusID, existed:true };
    const id = nextId_('CMP', SHEETS.CAMPUSES, 'CampusID');
    appendRowObj(SHEETS.CAMPUSES, { CampusID:id, CampusName:name, Active:true });
    return { success:true, id:id, existed:false };
  });
}

function getBudgetHeads() {
  const rows = getTableCached(SHEETS.HEADS).filter(h => h.Active !== false && h.Active !== 'FALSE');
  const seen = new Set();
  return rows.filter(h => {
    const key = String(h.HeadCode).trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
// Admin's Budget Heads browse table - includes inactive heads too.
function searchBudgetHeads(query) {
  query = (query||'').toLowerCase();
  const rows = getTable(SHEETS.HEADS);
  const matched = !query ? rows : rows.filter(h =>
    String(h.HeadCode).toLowerCase().includes(query) || String(h.HeadName).toLowerCase().includes(query));
  return matched.slice(0, 50);
}

function getHeadByCode(code) {
  code = String(code || '').trim().toLowerCase();
  if (!code) return null;
  return getTable(SHEETS.HEADS).find(h => String(h.HeadCode).toLowerCase() === code) || null;
}

function addBudgetHead_(code, name, actorUsername) {
  requireAdmin_(actorUsername);
  code = (code || '').trim(); name = (name || '').trim();
  if (!code || !name) return { success:false, message:'Budget code and name are both required.' };
  return withLock_(() => {
    const existing = getTable(SHEETS.HEADS).find(h => String(h.HeadCode).toLowerCase() === code.toLowerCase());
    if (existing) return { success:true, id:existing.HeadID, existed:true, name:existing.HeadName };
    const id = nextId_('BH', SHEETS.HEADS, 'HeadID');
    appendRowObj(SHEETS.HEADS, { HeadID:id, HeadCode:code, HeadName:name, Active:true });
    return { success:true, id:id, name:name, existed:false };
  });
}

function updateBudgetHead(actorUsername, headId, code, name) {
  requireAdmin_(actorUsername);
  code = (code||'').trim(); name = (name||'').trim();
  if (!code || !name) return { success:false, message:'Budget code and name are both required.' };
  const ok = updateRowByKey(SHEETS.HEADS, 'HeadID', headId, { HeadCode:code, HeadName:name });
  invalidateCache_(SHEETS.HEADS);
  return ok ? { success:true } : { success:false, message:'Budget head not found.' };
}

function deleteBudgetHead(actorUsername, headId) {
  requireAdmin_(actorUsername);
  const ok = updateRowByKey(SHEETS.HEADS, 'HeadID', headId, { Active:false });
  invalidateCache_(SHEETS.HEADS);
  return ok ? { success:true } : { success:false, message:'Budget head not found.' };
}

/* ================= ALLOCATIONS (admin only) ================= */

function saveAllocation(actorUsername, params) {
  requireAdmin_(actorUsername);
  return withLock_(() => {
    let campusId = params.campusId;
    if (!campusId && params.newCampusName) {
      const c = addCampus_(params.newCampusName, actorUsername);
      if (!c.success) return c;
      campusId = c.id;
    }
    let headId = params.headId;
    if (!headId && params.headCode) {
      const existingHead = getHeadByCode(params.headCode);
      if (existingHead) { headId = existingHead.HeadID; }
      else {
        if (!params.headName) return { success:false, message:'New budget code needs a name too.' };
        const h = addBudgetHead_(params.headCode, params.headName, actorUsername);
        if (!h.success) return h;
        headId = h.id;
      }
    }
    const fy = String(params.fy || DEFAULT_FY).trim();
    if (!campusId || !headId || !fy || !params.amount) {
      return { success:false, message:'Campus, budget code, financial year and amount are all required.' };
    }
    const amount = Math.round(Number(params.amount) || 0);
    const sh = getOrCreateSheet_(SHEETS.ALLOC);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const cCol = headers.indexOf('CampusID'), hCol = headers.indexOf('HeadID'),
          fCol = headers.indexOf('FY'), aCol = headers.indexOf('AllocatedAmount');
    for (let i = 1; i < values.length; i++) {
      if (values[i][cCol] === campusId && values[i][hCol] === headId && String(values[i][fCol]).trim() === fy) {
        sh.getRange(i+1, aCol+1).setValue(amount);
        invalidateCache_(SHEETS.ALLOC);
        return { success:true, updated:true };
      }
    }
    appendRowObj(SHEETS.ALLOC, { CampusID:campusId, HeadID:headId, FY:fy, AllocatedAmount:amount });
    return { success:true, updated:false };
  });
}

function getHeadsForCampus(campusId, fy) {
  fy = String(fy || DEFAULT_FY).trim();
  const allocs = getTableCached(SHEETS.ALLOC).filter(a => a.CampusID === campusId && fyMatches_(a.FY, fy));
  const heads = getBudgetHeads();
  return allocs.map(a => {
    const h = heads.find(x => x.HeadID === a.HeadID);
    return h ? { HeadID:h.HeadID, HeadCode:h.HeadCode, HeadName:h.HeadName, Allocated:a.AllocatedAmount } : null;
  }).filter(Boolean);
}

function searchAllocations(filters) {
  filters = filters || {};
  let allocs = getTableCached(SHEETS.ALLOC);
  const campuses = getTable(SHEETS.CAMPUSES);
  const heads = getTable(SHEETS.HEADS);
  if (filters.campusId) allocs = allocs.filter(a => a.CampusID === filters.campusId);
  if (filters.fy) allocs = allocs.filter(a => fyMatches_(a.FY, filters.fy));
  if (filters.headQuery) {
    const q = filters.headQuery.toLowerCase();
    allocs = allocs.filter(a => {
      const h = heads.find(x => x.HeadID === a.HeadID);
      return h && (String(h.HeadCode).toLowerCase().includes(q) || String(h.HeadName).toLowerCase().includes(q));
    });
  }
  return allocs.slice(0, 200).map(a => {
    const c = campuses.find(x => x.CampusID === a.CampusID);
    const h = heads.find(x => x.HeadID === a.HeadID);
    return { CampusID:a.CampusID, CampusName:c?c.CampusName:a.CampusID, HeadID:a.HeadID,
      HeadCode:h?h.HeadCode:'', HeadName:h?h.HeadName:a.HeadID, FY:a.FY, AllocatedAmount:a.AllocatedAmount };
  });
}
function deleteAllocation(actorUsername, campusId, headId, fy) {
  requireAdmin_(actorUsername);
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.ALLOC);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const cCol = headers.indexOf('CampusID'), hCol = headers.indexOf('HeadID'), fCol = headers.indexOf('FY');
    for (let i = 1; i < values.length; i++) {
      if (values[i][cCol] === campusId && values[i][hCol] === headId && fyMatches_(values[i][fCol], fy)) {
        sh.deleteRow(i+1);
        invalidateCache_(SHEETS.ALLOC);
        return { success:true };
      }
    }
    return { success:false, message:'Allocation not found.' };
  });
}

// Shared read for "how much has been spent against this campus+head" (includes multi-head split bills).
function getHeadSpendRows_(campusId, headId, fy, excludeEntryId) {
  const normal = getTable(SHEETS.ENTRIES)
    .filter(e => e.CampusID===campusId && e.HeadID===headId && fyMatches_(e.FY, fy) && isBudgetImpacting_(e.BillNature) && e.EntryID !== excludeEntryId && !statusEquals_(e.Status, STATUS.CANCELLED) && !e.SplitFromEntryID)
    .map(e => ({ entryId:e.EntryID, date:e.EntryDate, description:e.BillDescription, vendor:e.VendorName,
      billNo:e.BillNo, amount:Number(e.Amount||0), status:e.Status }));

  const splits = getTable(SHEETS.HEADSPLITS).filter(sp => sp.CampusID===campusId && sp.HeadID===headId && fyMatches_(sp.FY, fy) && sp.ParentEntryID !== excludeEntryId);
  if (!splits.length) return normal;
  const parentIds = new Set(splits.map(s => s.ParentEntryID));
  const parents = {};
  getTable(SHEETS.ENTRIES).filter(e => parentIds.has(e.EntryID)).forEach(e => parents[e.EntryID] = e);
  const splitRows = splits
    .filter(sp => !statusEquals_((parents[sp.ParentEntryID] || {}).Status, STATUS.CANCELLED))
    .map(sp => {
      const parent = parents[sp.ParentEntryID] || {};
      return { entryId:sp.ParentEntryID, date:sp.EntryDate, description:parent.BillDescription, vendor:parent.VendorName,
        billNo:parent.BillNo, amount:Number(sp.Amount||0), status:parent.Status };
    });
  return normal.concat(splitRows);
}

function getBudgetStatus(campusId, headId, fy, excludeEntryId) {
  fy = String(fy || DEFAULT_FY).trim();
  const allocRow = getTableCached(SHEETS.ALLOC).find(a => a.CampusID===campusId && a.HeadID===headId && fyMatches_(a.FY, fy));
  const allocated = allocRow ? Number(allocRow.AllocatedAmount) : 0;
  const spent = getHeadSpendRows_(campusId, headId, fy, excludeEntryId).reduce((s,r) => s + r.amount, 0);
  return { allocated, spent, remaining: allocated - spent, hasAllocation: !!allocRow };
}

/* ================= VENDORS ================= */

function getAllVendors() {
  return getTable(SHEETS.VENDORS);
}

function searchVendors(query) {
  query = (query || '').toLowerCase();
  if (!query) return [];
  return getTable(SHEETS.VENDORS).filter(v => (v.VendorName||'').toLowerCase().includes(query)).slice(0, 15);
}
function searchVendorsAdmin(query) {
  query = (query||'').toLowerCase();
  const rows = getTable(SHEETS.VENDORS);
  if (!query) return rows.slice(0, 30);
  return rows.filter(v => String(v.VendorName).toLowerCase().includes(query) || String(v.CNIC_NTN).toLowerCase().includes(query)).slice(0, 30);
}

function getVendorByCNIC(cnic) {
  return getTable(SHEETS.VENDORS).find(v => String(v.CNIC_NTN).trim() === String(cnic).trim()) || null;
}

// How much security is currently held for a vendor (PAID bills only; a Release of Security reduces it).
function getVendorSecurityBalance(vendorName) {
  vendorName = String(vendorName||'').trim().toLowerCase();
  if (!vendorName) return { held: 0 };
  const paidBills = getTable(SHEETS.ENTRIES).filter(e =>
    statusEquals_(e.Status, STATUS.PAID) && String(e.VendorName).trim().toLowerCase() === vendorName);
  let held = 0;
  paidBills.forEach(e => {
    if (e.BillNature === 'Release of Security') held -= Number(e.Amount||0);
    else held += Number(e.SecurityAmount||0);
  });
  return { held: Math.max(0, held) };
}

/* ---------- Employees (pre-registered by Admin, looked up by Employee ID) ---------- */
function getEmployeeById(employeeId) {
  employeeId = String(employeeId||'').trim();
  if (!employeeId) return null;
  return getTable(SHEETS.EMPLOYEES).find(e => String(e.EmployeeID).trim().toLowerCase() === employeeId.toLowerCase()) || null;
}
function getAllEmployees() {
  return getTable(SHEETS.EMPLOYEES);
}
function searchEmployees(query) {
  query = (query||'').toLowerCase();
  const rows = getTable(SHEETS.EMPLOYEES);
  if (!query) return rows.slice(0, 30);
  return rows.filter(e => String(e.Name).toLowerCase().includes(query) || String(e.EmployeeID).toLowerCase().includes(query)).slice(0, 30);
}
function addEmployee(actorUsername, emp) {
  requireAdmin_(actorUsername);
  const id = String(emp.employeeId||'').trim();
  if (!id || !emp.name) return { success:false, message:'Employee ID and Name are required.' };
  return withLock_(() => {
    if (getTable(SHEETS.EMPLOYEES).find(e => String(e.EmployeeID).trim().toLowerCase() === id.toLowerCase())) {
      updateRowByKey(SHEETS.EMPLOYEES, 'EmployeeID', id,
        { Name:emp.name, CNIC:emp.cnic||'', IBAN:emp.iban||'', BankName:emp.bankName||'', Department:emp.department||'', Designation:emp.designation||'' });
      return { success:true, updated:true };
    }
    appendRowObj(SHEETS.EMPLOYEES, { EmployeeID:id, Name:emp.name, CNIC:emp.cnic||'', IBAN:emp.iban||'', BankName:emp.bankName||'', Department:emp.department||'', Designation:emp.designation||'' });
    return { success:true, updated:false };
  });
}

/* ---------- Bank Accounts (predefined "pay from" accounts, Admin-managed) ---------- */
function getBankAccounts() {
  return getTableCached(SHEETS.BANKACCOUNTS).filter(a => a.Active !== false && a.Active !== 'FALSE');
}
function addBankAccount(actorUsername, acct) {
  requireAdmin_(actorUsername);
  if (!acct || !acct.accountTitle || !acct.bankName) return { success:false, message:'Account Title and Bank Name are required.' };
  const id = nextId_('BA', SHEETS.BANKACCOUNTS, 'AccountID');
  appendRowObj(SHEETS.BANKACCOUNTS, { AccountID:id, AccountTitle:acct.accountTitle, BankName:acct.bankName, AccountNumber:acct.accountNumber||'', Active:true });
  return { success:true, accountId:id };
}
function deactivateBankAccount(actorUsername, accountId) {
  requireAdmin_(actorUsername);
  updateRowByKey(SHEETS.BANKACCOUNTS, 'AccountID', accountId, { Active:false });
  return { success:true };
}

/* ---------- Receiving Offices (predefined, Admin-managed) ---------- */
function getReceivingOffices() {
  return getTableCached(SHEETS.OFFICES).filter(o => o.Active !== false && o.Active !== 'FALSE');
}
function addReceivingOffice(actorUsername, officeName) {
  requireAdmin_(actorUsername);
  if (!officeName) return { success:false, message:'Office name is required.' };
  const id = nextId_('OF', SHEETS.OFFICES, 'OfficeID');
  appendRowObj(SHEETS.OFFICES, { OfficeID:id, OfficeName:officeName, Active:true });
  return { success:true, officeId:id };
}
function deactivateReceivingOffice(actorUsername, officeId) {
  requireAdmin_(actorUsername);
  updateRowByKey(SHEETS.OFFICES, 'OfficeID', officeId, { Active:false });
  return { success:true };
}

/* ---------- Non-UE Employees (ad-hoc/visiting, keyed by CNIC) ---------- */
function getNonUEEmployeeByCNIC(cnic) {
  cnic = String(cnic||'').trim();
  if (!cnic) return null;
  return getTable(SHEETS.NONUE).find(e => String(e.CNIC).trim() === cnic) || null;
}
function getAllNonUEEmployees() {
  return getTable(SHEETS.NONUE);
}
function upsertNonUEEmployee_(rec) {
  const cnic = String(rec.cnic||'').trim();
  if (!cnic) return;
  if (getNonUEEmployeeByCNIC(cnic)) {
    updateRowByKey(SHEETS.NONUE, 'CNIC', cnic, { Name:rec.name||'', IBAN:rec.iban||'', BankName:rec.bankName||'' });
  } else {
    appendRowObj(SHEETS.NONUE, { CNIC:cnic, Name:rec.name||'', IBAN:rec.iban||'', BankName:rec.bankName||'' });
  }
}
function searchNonUEEmployees(query) {
  query = (query||'').toLowerCase();
  const rows = getTable(SHEETS.NONUE);
  if (!query) return rows.slice(0, 30);
  return rows.filter(e => String(e.Name).toLowerCase().includes(query) || String(e.CNIC).toLowerCase().includes(query)).slice(0, 30);
}

/* ---------- Students (keyed by Student ID / Form Number) ---------- */
function getStudentById(studentId) {
  studentId = String(studentId||'').trim();
  if (!studentId) return null;
  return getTable(SHEETS.STUDENTS).find(s => String(s.StudentID).trim().toLowerCase() === studentId.toLowerCase()) || null;
}
function getAllStudents() {
  return getTable(SHEETS.STUDENTS);
}
function upsertStudent_(rec) {
  const id = String(rec.studentId||'').trim();
  if (!id) return;
  const fields = { Name:rec.name||'', CNIC:rec.cnic||'', IBAN:rec.iban||'', Program:rec.program||'', Session:rec.session||'', Shift:rec.shift||'' };
  if (getStudentById(id)) {
    updateRowByKey(SHEETS.STUDENTS, 'StudentID', id, fields);
  } else {
    appendRowObj(SHEETS.STUDENTS, Object.assign({ StudentID:id }, fields));
  }
}
function searchStudents(query) {
  query = (query||'').toLowerCase();
  const rows = getTable(SHEETS.STUDENTS);
  if (!query) return rows.slice(0, 30);
  return rows.filter(s => String(s.Name).toLowerCase().includes(query) || String(s.StudentID).toLowerCase().includes(query) || String(s.CNIC||'').toLowerCase().includes(query)).slice(0, 30);
}

// One extra row appended to a payee-type sheet purely so each type can be browsed on its own tab.
function mirrorLogEntry_(payeeType, rowObj) {
  const target = payeeType === 'Vendor' ? SHEETS.VENDORENTRIES
    : (payeeType === 'Student' ? SHEETS.STUDENTENTRIES : SHEETS.EMPLOYEEENTRIES);
  try { appendRowObj(target, rowObj); } catch (err) { Logger.log('mirrorLogEntry_ failed for ' + target + ': ' + err); }
}

function upsertVendor_(vendor) {
  const sh = getOrCreateSheet_(SHEETS.VENDORS);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const nameCol = headers.indexOf('VendorName');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][nameCol]).toLowerCase() === (vendor.VendorName||'').toLowerCase()) {
      updateRowByKey(SHEETS.VENDORS, 'VendorName', values[i][nameCol],
        { CNIC_NTN:vendor.CNIC_NTN, IBAN:vendor.IBAN, BankName:vendor.BankName || '' });
      return;
    }
  }
  appendRowObj(SHEETS.VENDORS, { VendorName:vendor.VendorName, CNIC_NTN:vendor.CNIC_NTN||'',
    IBAN:vendor.IBAN||'', BankName:vendor.BankName||'', Phone:vendor.Phone||'' });
}

/* ================= BILL LIFECYCLE =================
   Stage 1: submitEntry()             -> Received  (automatic)
   Stage 2: markProcessed()           -> Received  -> Processed
   Stage 3: markPassed()              -> Processed -> Passed   ("Passing" stage)
   Stage 4: markPaidAndGenerateIBFT() -> Passed    -> Paid (+ IBFT report)
==================================================== */

// Server-side mirrors of the client-side format checks.
const BILL_DESCRIPTION_MAX_LENGTH = 40;
function isValidCnicFormat_(v) {
  return /^\d{5}-\d{7}-\d{1}$/.test(String(v || '').trim());
}
function isValidNtnFormat_(v) {
  return /^\d{8}$/.test(String(v || '').trim());
}
function isValidCnicOrNtnFormat_(v) {
  const s = String(v || '').trim();
  return isValidCnicFormat_(s) || isValidNtnFormat_(s);
}

// Validates everything and computes tax/deductions, but does NOT write anything.
// excludeEntryId (only when editing) makes every budget check ignore that bill's own current amount.
function resolveEntryForWrite_(entry, excludeEntryId) {
  const amount = Math.round(Number(entry.amount) || 0);
  if (!amount || amount <= 0) return { error: 'Enter a valid amount.' };
  if (!String(entry.billDescription||'').trim()) return { error: 'Bill Description is required.' };
  if (String(entry.billDescription).trim().length > BILL_DESCRIPTION_MAX_LENGTH) {
    return { error: 'Bill Description must be ' + BILL_DESCRIPTION_MAX_LENGTH + ' characters or fewer.' };
  }
  if (!String(entry.billNature||'').trim()) return { error: 'Select a Nature of Bill.' };
  const headSplits = Array.isArray(entry.headSplits) ? entry.headSplits.filter(s => s.headId && Number(s.amount) > 0) : [];
  const isMultiHead = headSplits.length > 0;
  if (!entry.campusId || (!isMultiHead && !entry.headId)) return { error: 'Campus and budget code are required.' };
  if (isMultiHead) {
    const splitTotal = headSplits.reduce((s,x) => s + Number(x.amount), 0);
    if (Math.abs(splitTotal - amount) > 0.01) {
      return { error: 'The budget head splits (' + splitTotal.toLocaleString() + ') must add up to the bill amount (' + amount.toLocaleString() + ').' };
    }
    if (headSplits.length < 2) return { error: 'Multi-head requires at least two budget heads - use single-head entry otherwise.' };
  }

  let payeeName, payeeCnic, payeeIban, payeeBank, payeeDesignation = '';
  if (entry.payeeType === 'Employee') {
    const emp = getEmployeeById(entry.employeeId);
    if (!emp) return { error: 'Employee ID not found. Ask your Admin to add this employee first (Admin > Employees).' };
    payeeName = emp.Name; payeeCnic = emp.CNIC; payeeIban = emp.IBAN; payeeBank = emp.BankName; payeeDesignation = emp.Designation || '';
  } else if (entry.payeeType === 'NonUEEmployee') {
    if (!entry.cnic) return { error: 'CNIC is required to identify a Non-UE Employee.' };
    if (!isValidCnicFormat_(entry.cnic)) return { error: 'CNIC must be in the format 35201-1222334-4.' };
    if (!entry.vendorName) return { error: 'Name is required.' };
    payeeName = entry.vendorName; payeeCnic = entry.cnic; payeeIban = entry.iban; payeeBank = entry.bankName;
  } else if (entry.payeeType === 'Student') {
    if (!entry.beneficiaryAccountTitle) return { error: 'Beneficiary account title is required.' };
    if (!entry.studentId) return { error: 'Student ID / Form Number is required.' };
    if (entry.studentCnic && !isValidCnicFormat_(entry.studentCnic)) return { error: "Beneficiary's CNIC must be in the format 35201-1222334-4." };
    payeeName = entry.beneficiaryAccountTitle; payeeCnic = entry.studentCnic || ''; payeeIban = entry.beneficiaryIban; payeeBank = '';
  } else {
    if (!entry.vendorName) return { error: 'Vendor name is required.' };
    if (entry.cnic && !isValidCnicOrNtnFormat_(entry.cnic)) return { error: 'CNIC/NTN must be a CNIC (35201-1222334-4) or an NTN (12345678).' };
    payeeName = entry.vendorName; payeeCnic = entry.cnic; payeeIban = entry.iban; payeeBank = entry.bankName;
  }

  if (entry.payeeType === 'Student' && STUDENT_BILL_NATURES.indexOf(entry.billNature) === -1) {
    return { error: 'For a Student, Nature of Bill must be Scholarship or Refund of Fee.' };
  }
  if (entry.payeeType !== 'Student' && STUDENT_BILL_NATURES.indexOf(entry.billNature) !== -1) {
    return { error: 'That Nature of Bill is only valid for a Student payee.' };
  }
  if (entry.billNature === 'Refund of Fee' && !String(entry.refundCategory||'').trim()) {
    return { error: 'Select or enter a Refund category.' };
  }
  if (entry.payeeType === 'Employee') {
    const isTaxableCategory = EMPLOYEE_149_CATEGORIES.indexOf(entry.billNature) !== -1 || UE_ONLY_TAXABLE_NATURES.indexOf(entry.billNature) !== -1;
    const isNonTaxable = UE_NON_TAXABLE_NATURES.indexOf(entry.billNature) !== -1;
    if (!isTaxableCategory && !isNonTaxable) return { error: 'Invalid Nature of Bill for a UE Employee.' };
    if (entry.billNature === 'Benevolent Fund' && !String(entry.benevolentFundSubCategory||'').trim()) {
      return { error: 'Select a Benevolent Fund sub-category.' };
    }
  }
  if (entry.payeeType === 'NonUEEmployee' && EMPLOYEE_149_CATEGORIES.indexOf(entry.billNature) === -1 && entry.billNature !== SECTION_156_NATURE) {
    return { error: 'For a Non-UE Employee, Nature of Bill must be one of the Section 149 categories or Honoraria to Statutory Body Meeting\'s Member - there is no non-taxable option.' };
  }
  if (entry.billNature === 'Conduct of Exam' && !String(entry.examSubCategory||'').trim()) {
    return { error: 'Enter the Conduct of Exam sub-category.' };
  }
  if (entry.billNature === 'Thesis Evaluation' && (!String(entry.thesisClass||'').trim() || !String(entry.thesisStudentName||'').trim())) {
    return { error: 'Enter the Class and Student Name for Thesis Evaluation.' };
  }
  if (['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature) !== -1 &&
      (!String(entry.visitingProgram||'').trim() || !String(entry.visitingSubject||'').trim() || !String(entry.visitingCrHrs||'').trim() ||
       !String(entry.visitingRate||'').trim() || !String(entry.visitingLectures||'').trim())) {
    return { error: 'Enter Program, Subject, Cr. Hrs., Rate, and Lectures.' };
  }
  if (!entry.payFromAccountId) {
    return { error: 'Select the bank account this bill is to be paid from.' };
  }
  if (!entry.receivingOfficeId) {
    return { error: 'Select the office this bill was received from.' };
  }
  if (entry.payeeType === 'Vendor' && entry.applyPST && (!String(entry.pstInvoiceNo||'').trim() || !entry.vendorInvoiceDate)) {
    return { error: 'Invoice Number and Vendor\'s Invoice Date are required when Punjab Sales Tax is deducted.' };
  }

  if (entry.billNature === 'Release of Security') {
    const secBalance = getVendorSecurityBalance(payeeName).held;
    if (amount > secBalance) {
      return { error: 'Release amount exceeds the security currently held for ' + payeeName + ' (' + secBalance.toLocaleString() + ' available).' };
    }
  }

  const fy = String(entry.fy || DEFAULT_FY).trim();
  // Budget Position is LOCKED onto the bill at the moment it is saved (captured here once).
  const budgetSnapshots = [];
  if (isMultiHead) {
    for (const split of headSplits) {
      const splitStatus = getBudgetStatus(entry.campusId, split.headId, fy, excludeEntryId);
      if (splitStatus.hasAllocation && Number(split.amount) > splitStatus.remaining && isBudgetImpacting_(entry.billNature)) {
        return { error: 'Budget exceeded for ' + (split.headCode||split.headId) + '. Remaining balance is only ' + splitStatus.remaining.toLocaleString() + '.' };
      }
      budgetSnapshots.push({
        headId: split.headId, headCode: split.headCode, headName: split.headName,
        allocated: splitStatus.allocated, expensesBefore: splitStatus.spent,
        afterThisBill: splitStatus.spent + Number(split.amount), hasAllocation: splitStatus.hasAllocation
      });
    }
  } else {
    const status = getBudgetStatus(entry.campusId, entry.headId, fy, excludeEntryId);
    if (status.hasAllocation && amount > status.remaining && isBudgetImpacting_(entry.billNature)) {
      return { error: 'Budget exceeded. Remaining balance for this budget code is only ' + status.remaining.toLocaleString() + '.' };
    }
    budgetSnapshots.push({
      headId: entry.headId, headCode: entry.headCode, headName: entry.headName,
      allocated: status.allocated, expensesBefore: status.spent, afterThisBill: status.spent + amount, hasAllocation: status.hasAllocation
    });
  }

  // Tax/deduction amounts are ALWAYS recomputed here, server-side.
  const tax = computeTaxes_({
    grossAmount: amount, billNature: entry.billNature, payeeType: entry.payeeType,
    fbrStatus: entry.fbrStatus, serviceCategory: entry.serviceCategory, taxpayerType: entry.taxpayerType, praStatus: entry.praStatus,
    fy: fy, employeeId: entry.employeeId, cnic: payeeCnic, examSubCategory: entry.examSubCategory,
    nonUeTaxMethod: entry.nonUeTaxMethod, affidavitLowIncome: !!entry.affidavitLowIncome,
    applyIncomeTax: !!entry.applyIncomeTax, applySalesTax: !!entry.applySalesTax, applyPST: !!entry.applyPST,
    applySecurity: !!entry.applySecurity, securityMode: entry.securityMode, securityRate: entry.securityRate, securityAmount: entry.securityAmount,
    applyPenalty: !!entry.applyPenalty, penaltyMode: entry.penaltyMode, penaltyRate: entry.penaltyRate, penaltyAmount: entry.penaltyAmount,
    applyOtherDeduction: !!entry.applyOtherDeduction, otherDeductionMode: entry.otherDeductionMode, otherDeductionRate: entry.otherDeductionRate, otherDeductionAmount: entry.otherDeductionAmount,
    applyStudentDeduction: !!entry.applyStudentDeduction, studentDeductionAmount: entry.studentDeductionAmount,
    contractCategory: entry.contractCategory,
    manualTaxOverride: !!entry.manualTaxOverride, manualTaxSection: entry.manualTaxSection,
    manualTaxMode: entry.manualTaxMode, manualTaxRate: entry.manualTaxRate, manualTaxAmount: entry.manualTaxAmount,
    manualSalesTaxOverride: !!entry.manualSalesTaxOverride, salesTaxMode: entry.salesTaxMode,
    salesTaxManualRate: entry.salesTaxManualRate, salesTaxManualAmount: entry.salesTaxManualAmount,
    manualPSTOverride: !!entry.manualPSTOverride, pstMode: entry.pstMode,
    pstManualRate: entry.pstManualRate, pstManualAmount: entry.pstManualAmount
  });

  // Duplicate-payment recovery: whatever this beneficiary still owes back is taken from this bill's NET (tax is untouched).
  applyRecoveryToTax_(tax, { payeeType: entry.payeeType, employeeId: entry.employeeId, studentId: entry.studentId,
    cnic: payeeCnic, name: payeeName, iban: payeeIban }, newRecoverySession_(excludeEntryId));

  const payFromAccount = getBankAccounts().find(a => a.AccountID === entry.payFromAccountId);
  if (!payFromAccount) return { error: 'Selected bank account was not found - it may have been deactivated.' };
  const payFromAccountLabel = payFromAccount.AccountTitle + ' - ' + payFromAccount.BankName + (payFromAccount.AccountNumber ? ' (' + payFromAccount.AccountNumber + ')' : '');
  const receivingOffice = getReceivingOffices().find(o => o.OfficeID === entry.receivingOfficeId);
  if (!receivingOffice) return { error: 'Selected receiving office was not found - it may have been deactivated.' };

  return { amount, headSplits, isMultiHead, payeeName, payeeCnic, payeeIban, payeeBank, payeeDesignation, fy, tax,
    payFromAccountLabel, payFromAccountNumber: payFromAccount.AccountNumber || '', receivingOfficeName: receivingOffice.OfficeName,
    budgetSnapshots };
}

function submitEntry(entry, username) {
  requireRole_(username, ['Admin','Accounts','Entry']);
  const diaryCheck = resolveDiaryForEntry_(entry.diaryId, entry.diaryBypassReason, username);
  if (diaryCheck.error) return { success:false, message: diaryCheck.error };
  const r = resolveEntryForWrite_(entry, null);
  if (r.error) return { success:false, message: r.error };
  const { amount, headSplits, isMultiHead, payeeName, payeeCnic, payeeIban, payeeBank, fy, tax } = r;

  return withLock_(() => {
    if (entry.payeeType === 'Vendor') {
      upsertVendor_({ VendorName:payeeName, CNIC_NTN:payeeCnic, IBAN:payeeIban, BankName:payeeBank });
    } else if (entry.payeeType === 'NonUEEmployee') {
      upsertNonUEEmployee_({ cnic:payeeCnic, name:payeeName, iban:payeeIban, bankName:payeeBank });
    } else if (entry.payeeType === 'Student') {
      upsertStudent_({ studentId:entry.studentId, name:payeeName, cnic:payeeCnic, iban:payeeIban, program:entry.program, session:entry.session, shift:entry.shift });
    }
    const id = nextId_('E', SHEETS.ENTRIES, 'EntryID');
    const rowObj = {
      EntryID:id, Timestamp:new Date(), EntryDate:entry.entryDate, FY:fy,
      CampusID:entry.campusId, CampusName:entry.campusName,
      HeadID: isMultiHead ? '' : entry.headId,
      HeadCode: isMultiHead ? '(Multiple)' : entry.headCode,
      HeadName: isMultiHead ? ('Multiple Budget Heads (' + headSplits.length + ')') : entry.headName,
      PayeeType: entry.payeeType || 'Vendor', EmployeeID: entry.payeeType==='Employee' ? entry.employeeId : '',
      VendorName:payeeName, CNIC_NTN:payeeCnic, IBAN:payeeIban, Amount:amount, BillDescription:entry.billDescription,
      BillNo:entry.billNo, EnteredBy:username, Status:STATUS.RECEIVED,
      ProcessedBy:'', ProcessedDate:'', PassedBy:'', PassedDate:'', PaidBy:'', PaidDate:'', BatchID:'',
      StudentID: entry.payeeType==='Student' ? entry.studentId : '', Program: entry.payeeType==='Student' ? entry.program : '',
      Session: entry.payeeType==='Student' ? entry.session : '', Shift: entry.payeeType==='Student' ? entry.shift : '',
      BillNature: entry.billNature || '', RefundCategory: entry.billNature==='Refund of Fee' ? entry.refundCategory : '',
      FBRStatus: entry.fbrStatus || '', ServiceCategory: entry.serviceCategory || '',
      TaxpayerType: entry.taxpayerType || '', PRAStatus: entry.praStatus || '',
      IncomeTaxSection: tax.incomeTaxSection, IncomeTaxRate: tax.incomeTaxRate, IncomeTaxAmount: tax.incomeTaxAmount,
      SalesTaxApplied: !!entry.applySalesTax, SalesTaxRate: tax.salesTaxRate, SalesTaxAmount: tax.salesTaxAmount,
      PSTApplied: !!entry.applyPST, PSTRate: tax.pstRate, PSTAmount: tax.pstAmount,
      SecurityApplied: !!entry.applySecurity, SecurityMode: entry.securityMode||'', SecurityBasis: entry.securityBasis||'', SecurityRate: tax.securityRate, SecurityAmount: tax.securityAmount,
      PenaltyApplied: !!entry.applyPenalty, PenaltyMode: entry.penaltyMode||'', PenaltyBasis: entry.penaltyBasis||'', PenaltyRate: tax.penaltyRate, PenaltyAmount: tax.penaltyAmount,
      OtherDeductionApplied: !!entry.applyOtherDeduction, OtherDeductionMode: entry.otherDeductionMode||'', OtherDeductionCategory: entry.otherDeductionCategory||'',
      OtherDeductionBasis: entry.otherDeductionBasis||'', OtherDeductionRate: tax.otherDeductionRate, OtherDeductionAmount: tax.otherDeductionAmount,
      StudentDeductionApplied: !!entry.applyStudentDeduction, StudentDeductionCategory: entry.studentDeductionCategory||'',
      StudentDeductionBasis: entry.studentDeductionBasis||'', StudentDeductionAmount: tax.studentDeductionAmount,
      EmployeeCategory: (EMPLOYEE_149_CATEGORIES.indexOf(entry.billNature) !== -1 || UE_ONLY_TAXABLE_NATURES.indexOf(entry.billNature) !== -1) ? entry.billNature : '',
      ExamSubCategory: entry.billNature==='Conduct of Exam' ? (entry.examSubCategory||'') : '',
      ThesisClass: entry.billNature==='Thesis Evaluation' ? (entry.thesisClass||'') : '',
      ThesisStudentName: entry.billNature==='Thesis Evaluation' ? (entry.thesisStudentName||'') : '',
      VisitingProgram: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingProgram||'') : '',
      VisitingSubject: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingSubject||'') : '',
      VisitingCrHrs: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingCrHrs||'') : '',
      VisitingRate: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingRate||'') : '',
      VisitingLectures: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingLectures||'') : '',
      BenevolentFundSubCategory: entry.billNature==='Benevolent Fund' ? (entry.benevolentFundSubCategory||'') : '',
      NonUETaxMethod: entry.payeeType==='NonUEEmployee' ? (entry.nonUeTaxMethod||'Section149') : '',
      Designation: r.payeeDesignation || '',
      PayFromAccountID: entry.payFromAccountId||'', PayFromAccountLabel: r.payFromAccountLabel||'', PayFromAccountNumber: r.payFromAccountNumber||'',
      ReceivingOfficeID: entry.receivingOfficeId||'', ReceivingOffice: r.receivingOfficeName||'',
      PSTInvoiceNo: (entry.payeeType==='Vendor' && entry.applyPST) ? (entry.pstInvoiceNo||'') : '',
      VendorInvoiceDate: (entry.payeeType==='Vendor' && entry.applyPST) ? (entry.vendorInvoiceDate||'') : '',
      ContractCategory: entry.billNature==='Contract' ? (entry.contractCategory||'NewProjects') : '',
      ManualTaxOverride: !!entry.manualTaxOverride, ManualTaxSection: entry.manualTaxOverride ? (entry.manualTaxSection||'') : '',
      ManualTaxMode: entry.manualTaxOverride ? (entry.manualTaxMode||'') : '',
      ManualTaxRate: entry.manualTaxOverride ? (entry.manualTaxRate||'') : '',
      ManualTaxAmount: entry.manualTaxOverride ? (entry.manualTaxAmount||'') : '',
      ManualSalesTaxOverride: !!entry.manualSalesTaxOverride, SalesTaxMode: entry.manualSalesTaxOverride ? (entry.salesTaxMode||'') : '',
      ManualPSTOverride: !!entry.manualPSTOverride, PSTMode: entry.manualPSTOverride ? (entry.pstMode||'') : '',
      BudgetAllocatedAtEntry: (!isMultiHead && r.budgetSnapshots[0]) ? r.budgetSnapshots[0].allocated : '',
      BudgetExpensesBeforeThisBill: (!isMultiHead && r.budgetSnapshots[0]) ? r.budgetSnapshots[0].expensesBefore : '',
      BudgetAfterThisBill: (!isMultiHead && r.budgetSnapshots[0]) ? r.budgetSnapshots[0].afterThisBill : '',
      AffidavitLowIncome: !!entry.affidavitLowIncome,
      IncomeBeforeThisBill: tax.section149 ? tax.section149.incomeBefore : '',
      IncomeAfterThisBill: tax.section149 ? tax.section149.incomeAfter : '',
      Section149CreditApplied: tax.section149 ? tax.section149.creditApplied : 0,
      DiaryID: diaryCheck.diaryId || '', DiaryBypassReason: diaryCheck.bypassReason || '',
      PaymentStatus: '',
      RecoveryDeducted: tax.recoveryDeducted || 0,
      NetAmount: tax.netAmount
    };
    appendRowObj(SHEETS.ENTRIES, rowObj);
    mirrorLogEntry_(entry.payeeType, rowObj);
    saveRecoveryApplications_(id, tax.recoveryAllocations, username);
    linkDiaryToEntry_(diaryCheck.diaryId, id);
    // Consume whatever Section 149 credit this bill's tax calculation just used.
    if (tax.section149 && tax.section149.creditApplied > 0) {
      const creditKey = entry.payeeType === 'Employee' ? entry.employeeId : payeeCnic;
      adjustSection149CreditBalance_(creditKey, entry.payeeType, fy, -tax.section149.creditApplied, 'Consumed by bill ' + id);
    }
    if (isMultiHead) {
      headSplits.forEach(split => {
        const snap = r.budgetSnapshots.find(s => s.headId === split.headId) || {};
        appendRowObj(SHEETS.HEADSPLITS, {
          ParentEntryID:id, CampusID:entry.campusId, HeadID:split.headId, HeadCode:split.headCode||'', HeadName:split.headName||'',
          FY:fy, EntryDate:entry.entryDate, Amount:Math.round(Number(split.amount)||0),
          BudgetAllocatedAtEntry: snap.allocated||'', BudgetExpensesBeforeThisBill: snap.expensesBefore||'', BudgetAfterThisBill: snap.afterThisBill||''
        });
      });
    }
    // Confirmation summary for the post-save popup - one row per Budget Head touched.
    const budgetSummary = isMultiHead
      ? headSplits.map(split => {
          const st = getBudgetStatus(entry.campusId, split.headId, fy);
          return { headCode: split.headCode, headName: split.headName, allocated: st.allocated,
            billAmount: Math.round(Number(split.amount)||0), alreadyConsumed: st.spent - Math.round(Number(split.amount)||0),
            newTotal: st.spent, remainingBalance: st.remaining };
        })
      : [(() => {
          const st = getBudgetStatus(entry.campusId, entry.headId, fy);
          return { headCode: entry.headCode, headName: entry.headName, allocated: st.allocated,
            billAmount: amount, alreadyConsumed: st.spent - amount, newTotal: st.spent, remainingBalance: st.remaining };
        })()];
    return { success:true, entryId:id, tax:tax, campusName: entry.campusName, budgetSummary,
      diaryWarnings: diaryMismatchWarnings_(diaryCheck.diaryRow, amount, false),
      status: isMultiHead ? null : getBudgetStatus(entry.campusId, entry.headId, fy) };
  });
}

// Edits an existing bill IN PLACE - only while the bill is still at Received status.
function updateEntry(entryId, entry, username) {
  requireRole_(username, ['Admin','Accounts','Entry']);
  const existing = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
  if (!existing) return { success:false, message:'Bill not found.' };
  if (!statusEquals_(existing.Status, STATUS.RECEIVED)) {
    return { success:false, message:'This bill is already at "' + existing.Status + '" and can no longer be edited here.' };
  }

  return withLock_(() => {
    const existingCreditKey = existing.PayeeType === 'Employee' ? existing.EmployeeID : existing.CNIC_NTN;
    const hadCredit = Number(existing.Section149CreditApplied||0) > 0 && (existing.PayeeType === 'Employee' || existing.PayeeType === 'NonUEEmployee');
    if (hadCredit) {
      adjustSection149CreditBalance_(existingCreditKey, existing.PayeeType, existing.FY, Number(existing.Section149CreditApplied), 'Refunded before edit of ' + entryId);
    }

    const r = resolveEntryForWrite_(entry, entryId);
    if (r.error) {
      if (hadCredit) {
        adjustSection149CreditBalance_(existingCreditKey, existing.PayeeType, existing.FY, -Number(existing.Section149CreditApplied), 'Re-applied - edit of ' + entryId + ' failed validation');
      }
      return { success:false, message: r.error };
    }
    const { amount, headSplits, isMultiHead, payeeName, payeeCnic, payeeIban, payeeBank, fy, tax } = r;

    if (entry.payeeType === 'Vendor') {
      upsertVendor_({ VendorName:payeeName, CNIC_NTN:payeeCnic, IBAN:payeeIban, BankName:payeeBank });
    } else if (entry.payeeType === 'NonUEEmployee') {
      upsertNonUEEmployee_({ cnic:payeeCnic, name:payeeName, iban:payeeIban, bankName:payeeBank });
    } else if (entry.payeeType === 'Student') {
      upsertStudent_({ studentId:entry.studentId, name:payeeName, cnic:payeeCnic, iban:payeeIban, program:entry.program, session:entry.session, shift:entry.shift });
    }

    const updates = {
      EntryDate:entry.entryDate, FY:fy, CampusID:entry.campusId, CampusName:entry.campusName,
      HeadID: isMultiHead ? '' : entry.headId, HeadCode: isMultiHead ? '(Multiple)' : entry.headCode,
      HeadName: isMultiHead ? ('Multiple Budget Heads (' + headSplits.length + ')') : entry.headName,
      PayeeType: entry.payeeType || 'Vendor', EmployeeID: entry.payeeType==='Employee' ? entry.employeeId : '',
      VendorName:payeeName, CNIC_NTN:payeeCnic, IBAN:payeeIban, Amount:amount, BillDescription:entry.billDescription,
      BillNo:entry.billNo,
      StudentID: entry.payeeType==='Student' ? entry.studentId : '', Program: entry.payeeType==='Student' ? entry.program : '',
      Session: entry.payeeType==='Student' ? entry.session : '', Shift: entry.payeeType==='Student' ? entry.shift : '',
      BillNature: entry.billNature || '', RefundCategory: entry.billNature==='Refund of Fee' ? entry.refundCategory : '',
      FBRStatus: entry.fbrStatus || '', ServiceCategory: entry.serviceCategory || '',
      TaxpayerType: entry.taxpayerType || '', PRAStatus: entry.praStatus || '',
      IncomeTaxSection: tax.incomeTaxSection, IncomeTaxRate: tax.incomeTaxRate, IncomeTaxAmount: tax.incomeTaxAmount,
      SalesTaxApplied: !!entry.applySalesTax, SalesTaxRate: tax.salesTaxRate, SalesTaxAmount: tax.salesTaxAmount,
      PSTApplied: !!entry.applyPST, PSTRate: tax.pstRate, PSTAmount: tax.pstAmount,
      SecurityApplied: !!entry.applySecurity, SecurityMode: entry.securityMode||'', SecurityBasis: entry.securityBasis||'', SecurityRate: tax.securityRate, SecurityAmount: tax.securityAmount,
      PenaltyApplied: !!entry.applyPenalty, PenaltyMode: entry.penaltyMode||'', PenaltyBasis: entry.penaltyBasis||'', PenaltyRate: tax.penaltyRate, PenaltyAmount: tax.penaltyAmount,
      OtherDeductionApplied: !!entry.applyOtherDeduction, OtherDeductionMode: entry.otherDeductionMode||'', OtherDeductionCategory: entry.otherDeductionCategory||'',
      OtherDeductionBasis: entry.otherDeductionBasis||'', OtherDeductionRate: tax.otherDeductionRate, OtherDeductionAmount: tax.otherDeductionAmount,
      StudentDeductionApplied: !!entry.applyStudentDeduction, StudentDeductionCategory: entry.studentDeductionCategory||'',
      StudentDeductionBasis: entry.studentDeductionBasis||'', StudentDeductionAmount: tax.studentDeductionAmount,
      EmployeeCategory: (EMPLOYEE_149_CATEGORIES.indexOf(entry.billNature) !== -1 || UE_ONLY_TAXABLE_NATURES.indexOf(entry.billNature) !== -1) ? entry.billNature : '',
      ExamSubCategory: entry.billNature==='Conduct of Exam' ? (entry.examSubCategory||'') : '',
      ThesisClass: entry.billNature==='Thesis Evaluation' ? (entry.thesisClass||'') : '',
      ThesisStudentName: entry.billNature==='Thesis Evaluation' ? (entry.thesisStudentName||'') : '',
      VisitingProgram: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingProgram||'') : '',
      VisitingSubject: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingSubject||'') : '',
      VisitingCrHrs: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingCrHrs||'') : '',
      VisitingRate: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingRate||'') : '',
      VisitingLectures: ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(entry.billNature)!==-1 ? (entry.visitingLectures||'') : '',
      BenevolentFundSubCategory: entry.billNature==='Benevolent Fund' ? (entry.benevolentFundSubCategory||'') : '',
      NonUETaxMethod: entry.payeeType==='NonUEEmployee' ? (entry.nonUeTaxMethod||'Section149') : '',
      Designation: r.payeeDesignation || '',
      PayFromAccountID: entry.payFromAccountId||'', PayFromAccountLabel: r.payFromAccountLabel||'', PayFromAccountNumber: r.payFromAccountNumber||'',
      ReceivingOfficeID: entry.receivingOfficeId||'', ReceivingOffice: r.receivingOfficeName||'',
      PSTInvoiceNo: (entry.payeeType==='Vendor' && entry.applyPST) ? (entry.pstInvoiceNo||'') : '',
      VendorInvoiceDate: (entry.payeeType==='Vendor' && entry.applyPST) ? (entry.vendorInvoiceDate||'') : '',
      ContractCategory: entry.billNature==='Contract' ? (entry.contractCategory||'NewProjects') : '',
      ManualTaxOverride: !!entry.manualTaxOverride, ManualTaxSection: entry.manualTaxOverride ? (entry.manualTaxSection||'') : '',
      ManualTaxMode: entry.manualTaxOverride ? (entry.manualTaxMode||'') : '',
      ManualTaxRate: entry.manualTaxOverride ? (entry.manualTaxRate||'') : '',
      ManualTaxAmount: entry.manualTaxOverride ? (entry.manualTaxAmount||'') : '',
      ManualSalesTaxOverride: !!entry.manualSalesTaxOverride, SalesTaxMode: entry.manualSalesTaxOverride ? (entry.salesTaxMode||'') : '',
      ManualPSTOverride: !!entry.manualPSTOverride, PSTMode: entry.manualPSTOverride ? (entry.pstMode||'') : '',
      BudgetAllocatedAtEntry: (!isMultiHead && r.budgetSnapshots[0]) ? r.budgetSnapshots[0].allocated : '',
      BudgetExpensesBeforeThisBill: (!isMultiHead && r.budgetSnapshots[0]) ? r.budgetSnapshots[0].expensesBefore : '',
      BudgetAfterThisBill: (!isMultiHead && r.budgetSnapshots[0]) ? r.budgetSnapshots[0].afterThisBill : '',
      AffidavitLowIncome: !!entry.affidavitLowIncome,
      IncomeBeforeThisBill: tax.section149 ? tax.section149.incomeBefore : '',
      IncomeAfterThisBill: tax.section149 ? tax.section149.incomeAfter : '',
      Section149CreditApplied: tax.section149 ? tax.section149.creditApplied : 0,
      RecoveryDeducted: tax.recoveryDeducted || 0,
      NetAmount: tax.netAmount
    };
    updateRowByKey(SHEETS.ENTRIES, 'EntryID', entryId, updates);
    deleteRecoveryApplicationsForBill_(entryId);
    saveRecoveryApplications_(entryId, tax.recoveryAllocations, username);
    invalidateCache_(SHEETS.ENTRIES);
    if (tax.section149 && tax.section149.creditApplied > 0) {
      const newCreditKey = entry.payeeType === 'Employee' ? entry.employeeId : payeeCnic;
      adjustSection149CreditBalance_(newCreditKey, entry.payeeType, fy, -tax.section149.creditApplied, 'Consumed by edit of ' + entryId);
    }

    // Replace any existing head splits for this bill with the new set.
    const sh = getOrCreateSheet_(SHEETS.HEADSPLITS);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const pCol = headers.indexOf('ParentEntryID');
    for (let i = values.length - 1; i >= 1; i--) {
      if (values[i][pCol] === entryId) sh.deleteRow(i+1);
    }
    if (isMultiHead) {
      headSplits.forEach(split => {
        const snap = r.budgetSnapshots.find(s => s.headId === split.headId) || {};
        appendRowObj(SHEETS.HEADSPLITS, {
          ParentEntryID:entryId, CampusID:entry.campusId, HeadID:split.headId, HeadCode:split.headCode||'', HeadName:split.headName||'',
          FY:fy, EntryDate:entry.entryDate, Amount:Math.round(Number(split.amount)||0),
          BudgetAllocatedAtEntry: snap.allocated||'', BudgetExpensesBeforeThisBill: snap.expensesBefore||'', BudgetAfterThisBill: snap.afterThisBill||''
        });
      });
    }

    const budgetSummary = isMultiHead
      ? headSplits.map(split => {
          const st = getBudgetStatus(entry.campusId, split.headId, fy);
          return { headCode: split.headCode, headName: split.headName, allocated: st.allocated,
            billAmount: Math.round(Number(split.amount)||0), alreadyConsumed: st.spent - Math.round(Number(split.amount)||0),
            newTotal: st.spent, remainingBalance: st.remaining };
        })
      : [(() => {
          const st = getBudgetStatus(entry.campusId, entry.headId, fy);
          return { headCode: entry.headCode, headName: entry.headName, allocated: st.allocated,
            billAmount: amount, alreadyConsumed: st.spent - amount, newTotal: st.spent, remainingBalance: st.remaining };
        })()];
    return { success:true, entryId, tax, campusName: entry.campusName, budgetSummary };
  });
}

// Admin-only. Only a bill still at Received can be deleted (permanent, no audit trail).
function deleteEntry(entryId, username) {
  requireAdmin_(username);
  const existing = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
  if (!existing) return { success:false, message:'Bill not found.' };
  if (!statusEquals_(existing.Status, STATUS.RECEIVED)) {
    return { success:false, message:'This bill is already at "' + existing.Status + '" and can no longer be deleted - only bills still at Received can be removed. Use Cancel instead.' };
  }
  return withLock_(() => {
    if (Number(existing.Section149CreditApplied||0) > 0 && (existing.PayeeType === 'Employee' || existing.PayeeType === 'NonUEEmployee')) {
      const key = existing.PayeeType === 'Employee' ? existing.EmployeeID : existing.CNIC_NTN;
      adjustSection149CreditBalance_(key, existing.PayeeType, existing.FY, Number(existing.Section149CreditApplied), 'Refunded - bill ' + entryId + ' was deleted');
    }
    deleteRowsByKey_(SHEETS.ENTRIES, 'EntryID', entryId);
    deleteRowsByKey_(SHEETS.HEADSPLITS, 'ParentEntryID', entryId);
    deleteRowsByKey_(SHEETS.BULKITEMS, 'ParentEntryID', entryId);
    deleteRecoveryApplicationsForBill_(entryId);
    return { success:true };
  });
}

// Admin-only. Works at ANY stage, including Paid - the row is never removed, only marked Cancelled,
// and is excluded from every budget/consumption/payment calculation from then on. Cancelling a Paid
// bill does NOT reverse the actual money movement.
function cancelEntry(entryId, reason, username) {
  requireAdmin_(username);
  const existing = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
  if (!existing) return { success:false, message:'Bill not found.' };
  if (statusEquals_(existing.Status, STATUS.CANCELLED)) return { success:false, message:'This bill is already cancelled.' };
  const previousStatus = existing.Status;
  return withLock_(() => {
    if (existing.PayeeType === 'Bulk') {
      const lines = getTable(SHEETS.BULKITEMS).filter(li => li.ParentEntryID === entryId);
      lines.forEach(li => {
        if (Number(li.Section149CreditApplied||0) > 0 && (li.PayeeType === 'Employee' || li.PayeeType === 'NonUEEmployee')) {
          const key = li.PayeeType === 'Employee' ? li.EmployeeID : li.CNIC_NTN;
          adjustSection149CreditBalance_(key, li.PayeeType, existing.FY, Number(li.Section149CreditApplied), 'Refunded - bulk bill ' + entryId + ' line ' + li.LineNo + ' was cancelled');
        }
      });
    } else if (Number(existing.Section149CreditApplied||0) > 0 && (existing.PayeeType === 'Employee' || existing.PayeeType === 'NonUEEmployee')) {
      const key = existing.PayeeType === 'Employee' ? existing.EmployeeID : existing.CNIC_NTN;
      adjustSection149CreditBalance_(key, existing.PayeeType, existing.FY, Number(existing.Section149CreditApplied), 'Refunded - bill ' + entryId + ' was cancelled');
    }
    updateRowByKey(SHEETS.ENTRIES, 'EntryID', entryId, {
      Status: STATUS.CANCELLED, CancelledBy: username, CancelledDate: new Date(), CancellationReason: reason || '', StatusBeforeCancellation: previousStatus
    });
    return { success:true, previousStatus };
  });
}

// Admin-only search over Entries for the Admin > Manage Entries panel (one row per actual bill).
function searchEntriesAdmin(filters, username) {
  requireAdmin_(username);
  return getEntriesForSanctionPicker(filters);
}

/* ================= BULK UPLOAD (multiple beneficiaries under one bill) =================
   Creates ONE consolidated row in Entries (ticked as one bill through Processing/Passing/
   Payment), plus one row per beneficiary in BulkLineItems. Lines resurface when an IBFT
   report is generated (see expandBulkItems_). ====================================== */
function submitBulkEntry(parentMeta, lineItems, username) {
  requireRole_(username, ['Admin','Accounts','Entry']);
  // Make sure the columns used for safe saving exist, then recognise an upload that was already saved
  // (double click, or a retry after a dropped connection) and answer with the earlier bill instead of saving a second one.
  ensureSheetAndColumns_(SHEETS.ENTRIES, SCHEMA.Entries);
  ensureSheetAndColumns_(SHEETS.BULKITEMS, SCHEMA.BulkLineItems);
  const fingerprint = computeBulkFingerprint_(parentMeta, lineItems);
  const earlier = withLock_(() => {
    const ex = findBulkByFingerprint_(fingerprint);
    if (ex) repairBulkDiaryLinks_(parentMeta, ex.EntryID);
    return ex;
  });
  if (earlier) return duplicateBulkReply_(earlier);
  const diaryCheck = resolveDiaryForEntry_(parentMeta.diaryId, parentMeta.diaryBypassReason, username);
  if (diaryCheck.error) return { success:false, message: diaryCheck.error };
  // One bulk bill (one Bill ID) can cover SEVERAL Diary numbers - same cost centre and budget head.
  const extraDiaryRows = [];
  const extraIds = Array.from(new Set((parentMeta.extraDiaryIds || []).map(x => String(x || '').trim()).filter(Boolean)));
  if (extraIds.length) {
    if (!diaryCheck.diaryId) return { success:false, message:'Other Diary numbers can only be combined into a bulk bill together with a main Diary Number (not with Admin bypass).' };
    for (let k = 0; k < extraIds.length; k++) {
      if (extraIds[k] === diaryCheck.diaryId) continue;
      const xr = resolveDiaryForEntry_(extraIds[k], '', username);
      if (xr.error) return { success:false, message: xr.error };
      extraDiaryRows.push(xr.diaryRow);
    }
  }
  if (!lineItems || !lineItems.length) return { success:false, message:'No line items to submit.' };
  if (!parentMeta.campusId || !parentMeta.headId) return { success:false, message:'Campus and budget code are required.' };
  if (!String(parentMeta.billDescription||'').trim()) return { success:false, message:'Bill Description (whole bill) is required.' };
  if (String(parentMeta.billDescription).trim().length > BILL_DESCRIPTION_MAX_LENGTH) {
    return { success:false, message: 'Bill Description (whole bill) must be ' + BILL_DESCRIPTION_MAX_LENGTH + ' characters or fewer.' };
  }
  if (lineItems.length > 500) return { success:false, message:'Too many rows in one upload (500 max) - split into smaller batches.' };

  // Resolve and validate every row BEFORE writing anything.
  const resolved = [];
  const sessionClaimed149 = {};
  const sessionCreditByKey = {};
  const recSession = newRecoverySession_('');
  // Reference data looked up ONCE for the whole file instead of once per row.
  const officesAll = getReceivingOffices(), accountsAll = getBankAccounts();
  let empMapCache = null, s149ctx = null;
  const lookupEmp = id => {
    if (!empMapCache) { empMapCache = {}; getTable(SHEETS.EMPLOYEES).forEach(e => { empMapCache[String(e.EmployeeID).trim().toLowerCase()] = e; }); }
    return empMapCache[String(id || '').trim().toLowerCase()] || null;
  };
  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    const rowLabel = 'Row ' + (i + 2) + ' (line ' + (i + 1) + ' of data)';
    const amount = Math.round(Number(li.amount) || 0);
    if (!amount || amount <= 0) return { success:false, message: rowLabel + ': invalid or missing Amount.' };
    if (li.description && String(li.description).trim().length > BILL_DESCRIPTION_MAX_LENGTH) {
      return { success:false, message: rowLabel + ': Description must be ' + BILL_DESCRIPTION_MAX_LENGTH + ' characters or fewer.' };
    }

    const payeeType = li.payeeType || 'Vendor';
    let name, cnic, iban, bank;
    if (payeeType === 'Employee') {
      const emp = lookupEmp(li.employeeId);
      if (!emp) return { success:false, message: rowLabel + ': Employee ID "' + li.employeeId + '" not found in Admin > Employees.' };
      name = emp.Name; cnic = emp.CNIC; iban = emp.IBAN; bank = emp.BankName;
    } else if (payeeType === 'Student') {
      if (!li.name || !li.studentId) return { success:false, message: rowLabel + ': Student ID and Name are both required.' };
      if (li.cnic && !isValidCnicFormat_(li.cnic)) return { success:false, message: rowLabel + ': CNIC must be in the format 35201-1222334-4.' };
      name = li.name; cnic = li.cnic || ''; iban = li.iban || ''; bank = '';
    } else {
      if (!li.name) return { success:false, message: rowLabel + ': ' + (payeeType === 'NonUEEmployee' ? 'Name is required.' : 'Vendor name is required.') };
      if (payeeType === 'NonUEEmployee' && !isValidCnicFormat_(li.cnic)) return { success:false, message: rowLabel + ': CNIC must be in the format 35201-1222334-4.' };
      if (payeeType === 'Vendor' && li.cnic && !isValidCnicOrNtnFormat_(li.cnic)) return { success:false, message: rowLabel + ': CNIC/NTN must be a CNIC (35201-1222334-4) or an NTN (12345678).' };
      name = li.name; cnic = li.cnic || ''; iban = li.iban || ''; bank = li.bankName || '';
    }

    const salesTax = Math.round(Number(li.salesTaxAmount)||0), pst = Math.round(Number(li.pstAmount)||0),
          security = Math.round(Number(li.securityAmount)||0), penalty = Math.round(Number(li.penaltyAmount)||0), other = Math.round(Number(li.otherDeductionAmount)||0);

    // Income Tax for Employee/NonUEEmployee is ALWAYS computed here (never taken from the CSV)
    // using the same engine as a single New Entry bill. A Vendor line takes the FBR Section
    // typed in the CSV's FBRSection column, if any.
    // A Vendor line's Income Tax is the amount typed in the CSV, and the FBR section it was calculated under is then REQUIRED.
    let finalIncomeTax = (payeeType === 'Vendor') ? Math.round(Number(li.incomeTaxAmount) || 0) : 0;
    let finalIncomeTaxSection = (payeeType === 'Vendor') ? String(li.fbrSection || '').trim() : '';
    if (payeeType === 'Vendor' && finalIncomeTax > 0 && !finalIncomeTaxSection) {
      return { success:false, message: rowLabel + ': FBRSection is required when IncomeTaxAmount is entered - state the FBR section the tax was calculated under (e.g. 153(1)(a) - Supply of Goods).' };
    }
    let rowCreditApplied = 0;
    if (payeeType === 'Employee' || payeeType === 'NonUEEmployee') {
      const isTaxableNature = EMPLOYEE_149_CATEGORIES.indexOf(li.billNature) !== -1 ||
        (payeeType === 'Employee' && UE_ONLY_TAXABLE_NATURES.indexOf(li.billNature) !== -1);
      const isSection156 = payeeType === 'NonUEEmployee' && li.billNature === SECTION_156_NATURE;
      if (isTaxableNature || isSection156) {
        if (payeeType === 'NonUEEmployee' && li.nonUeTaxMethod === 'Section153_1b' && li.fbrStatus !== 'Filer' && li.fbrStatus !== 'NonFiler') {
          return { success:false, message: rowLabel + ': Taxpayer Status (Active/Inactive) is required when using Section 153(1)(b).' };
        }
        const key = payeeType === 'Employee' ? li.employeeId : cnic;
        const sessionKey = payeeType + '|' + String(key||'').trim().toLowerCase();
        if (sessionCreditByKey[sessionKey] === undefined) {
          if (!s149ctx) s149ctx = loadSection149BatchContext_();
          sessionCreditByKey[sessionKey] = getSection149CreditBalanceFromCtx_(s149ctx, key, payeeType, parentMeta.fy || DEFAULT_FY);
        }
        const tax = computeTaxes_({
          payeeType: payeeType, billNature: li.billNature, grossAmount: amount, applyIncomeTax: true,
          employeeId: li.employeeId, cnic: cnic, fy: parentMeta.fy || DEFAULT_FY,
          examSubCategory: li.examSubCategory, affidavitLowIncome: !!li.affidavitLowIncome,
          fbrStatus: li.fbrStatus || 'NonFiler', nonUeTaxMethod: li.nonUeTaxMethod,
          extraClaimed149: sessionClaimed149[sessionKey] || 0,
          section149CreditOverride: sessionCreditByKey[sessionKey], section149Ctx: s149ctx
        });
        finalIncomeTax = tax.incomeTaxAmount;
        finalIncomeTaxSection = tax.incomeTaxSection || '';
        if (isTaxableNature) sessionClaimed149[sessionKey] = (sessionClaimed149[sessionKey] || 0) + amount;
        if (tax.section149 && tax.section149.creditApplied > 0) {
          rowCreditApplied = tax.section149.creditApplied;
          sessionCreditByKey[sessionKey] = Math.max(0, sessionCreditByKey[sessionKey] - rowCreditApplied);
        }
      }
    }
    const netBeforeRecovery = amount - finalIncomeTax - salesTax - pst - security - penalty - other;
    // Duplicate-payment recovery for this beneficiary, taken from the net (rows of the same person draw it down in turn).
    const rowRecovery = allocateRecovery_(recSession, recoveryIdentity_({ payeeType: payeeType, employeeId: li.employeeId, studentId: li.studentId,
      cnic: cnic, name: name, iban: iban }), netBeforeRecovery);
    consumeRecoverySession_(recSession, rowRecovery.allocations);
    const net = netBeforeRecovery - rowRecovery.deducted;

    if (li.billNature === 'Thesis Evaluation' && (!String(li.thesisClass||'').trim() || !String(li.thesisStudentName||'').trim())) {
      return { success:false, message: rowLabel + ': Thesis Evaluation requires both Class and Student Name.' };
    }
    if (li.billNature === 'Benevolent Fund' && !String(li.benevolentFundSubCategory||'').trim()) {
      return { success:false, message: rowLabel + ': Benevolent Fund requires a sub-category.' };
    }
    if (['UE Visiting Faculty','Paper Setting/Marking'].indexOf(li.billNature) !== -1 &&
        (!String(li.visitingProgram||'').trim() || !String(li.visitingSubject||'').trim() || !String(li.visitingCrHrs||'').trim() ||
         !String(li.visitingRate||'').trim() || !String(li.visitingLectures||'').trim())) {
      return { success:false, message: rowLabel + ': Program, Subject, Cr. Hrs., Rate, and Lectures are all required for ' + li.billNature + '.' };
    }

    // Receiving Office / Pay From Account: Student and Employee rows may name their own;
    // a blank row falls back to the bill's default. Vendor bulk uses one office/account for the whole bill.
    let rowOfficeId = '', rowOffice = null, rowAccountId = '', rowAccount = null;
    if (payeeType === 'Student' || payeeType === 'Employee' || payeeType === 'NonUEEmployee') {
      rowOfficeId = li.receivingOfficeId || parentMeta.receivingOfficeId || '';
      rowAccountId = li.payFromAccountId || parentMeta.payFromAccountId || '';
      if (!rowOfficeId) return { success:false, message: rowLabel + ': no Receiving Office - fill the ReceivingOffice column for this row, or pick a default office on the form above.' };
      if (!rowAccountId) return { success:false, message: rowLabel + ': no Pay From Account - fill the PayFromAccount column for this row, or pick a default account on the form above.' };
      rowOffice = officesAll.find(o => o.OfficeID === rowOfficeId);
      rowAccount = accountsAll.find(a => a.AccountID === rowAccountId);
      if (!rowOffice) return { success:false, message: rowLabel + ': the resolved Receiving Office was not found - it may have been deactivated.' };
      if (!rowAccount) return { success:false, message: rowLabel + ': the resolved Pay From Account was not found - it may have been deactivated.' };
    } else {
      if (!parentMeta.receivingOfficeId) return { success:false, message: 'Select the office this bill was received from.' };
      if (!parentMeta.payFromAccountId) return { success:false, message: 'Select the bank account this bill is to be paid from.' };
      rowOfficeId = parentMeta.receivingOfficeId;
      rowAccountId = parentMeta.payFromAccountId;
    }

    resolved.push({
      payeeType, employeeId: li.employeeId || '', studentId: li.studentId || '',
      program: li.program || '', session: li.session || '', shift: li.shift || '', billNature: li.billNature || '',
      thesisClass: li.thesisClass || '', thesisStudentName: li.thesisStudentName || '', benevolentFundSubCategory: li.benevolentFundSubCategory || '',
      visitingProgram: li.visitingProgram || '', visitingSubject: li.visitingSubject || '', visitingCrHrs: li.visitingCrHrs || '',
      visitingRate: li.visitingRate || '', visitingLectures: li.visitingLectures || '',
      receivingOfficeId: rowOfficeId, receivingOfficeName: rowOffice ? rowOffice.OfficeName : '',
      payFromAccountId: rowAccountId,
      payFromAccountLabel: rowAccount ? (rowAccount.AccountTitle + ' - ' + rowAccount.BankName) : '',
      payFromAccountNumber: rowAccount ? (rowAccount.AccountNumber||'') : '',
      name, cnic, iban, bank, amount, incomeTax: finalIncomeTax, incomeTaxSection: finalIncomeTaxSection, salesTax, pst, security, penalty, other, net,
      creditApplied: rowCreditApplied, creditKey: (payeeType === 'Employee') ? li.employeeId : cnic,
      recoveryDeducted: rowRecovery.deducted, recoveryAllocations: rowRecovery.allocations,
      description: li.description || parentMeta.billDescription || ''
    });
  }

  const totalGross = resolved.reduce((s,r) => s + r.amount, 0);
  if (resolved.some(r => r.pst > 0) && (!parentMeta.pstInvoiceNo || !parentMeta.vendorInvoiceDate)) {
    return { success:false, message: "Invoice Number and Vendor's Invoice Date are required - at least one row has Punjab Sales Tax deducted." };
  }
  const fy = String(parentMeta.fy || DEFAULT_FY).trim();
  const status = getBudgetStatus(parentMeta.campusId, parentMeta.headId, fy);
  if (status.hasAllocation && totalGross > status.remaining) {
    return { success:false, message:'Budget exceeded. Remaining balance for this budget code is only ' + status.remaining.toLocaleString() + ', bulk total is ' + totalGross.toLocaleString() + '.' };
  }

  return withLock_(() => {
    // (1) The same upload may have arrived while this one was being checked.
    const again = findBulkByFingerprint_(fingerprint);
    if (again) return duplicateBulkReply_(again);
    // (2) Budget re-checked at the very moment of saving (someone else may have saved a bill in between).
    const stNow = getBudgetStatus(parentMeta.campusId, parentMeta.headId, fy);
    if (stNow.hasAllocation && totalGross > stNow.remaining) {
      return { success:false, message:'Budget exceeded. Remaining balance for this budget code is only ' + stNow.remaining.toLocaleString() + ', bulk total is ' + totalGross.toLocaleString() + '.' };
    }

    const totals = resolved.reduce((acc,r) => {
      acc.incomeTax += r.incomeTax; acc.salesTax += r.salesTax; acc.pst += r.pst;
      acc.security += r.security; acc.penalty += r.penalty; acc.other += r.other; acc.net += r.net;
      return acc;
    }, { incomeTax:0, salesTax:0, pst:0, security:0, penalty:0, other:0, net:0 });
    const totalRecovery = resolved.reduce((s,r) => s + (r.recoveryDeducted || 0), 0);

    const id = nextId_('E', SHEETS.ENTRIES, 'EntryID');
    const distinctOfficeIds = Array.from(new Set(resolved.map(r => r.receivingOfficeId)));
    const distinctAccountIds = Array.from(new Set(resolved.map(r => r.payFromAccountId)));
    const bulkReceivingOffice = distinctOfficeIds.length === 1 ? officesAll.find(o => o.OfficeID === distinctOfficeIds[0]) : null;
    const bulkPayFromAccount = distinctAccountIds.length === 1 ? accountsAll.find(a => a.AccountID === distinctAccountIds[0]) : null;

    // ALL-OR-NOTHING: lines first (one write), the bill row LAST, then the saved data is read back and checked.
    // Anything wrong -> everything is removed again and nothing is left half-saved.
    try {
      // (3) Leftover lines from an earlier cut-off attempt that used this same Bill ID are cleared first.
      deleteRowsByKey_(SHEETS.BULKITEMS, 'ParentEntryID', id);
      deleteRecoveryApplicationsForBill_(id);

      appendRowsBatch_(SHEETS.BULKITEMS, resolved.map((r, idx) => ({
        ParentEntryID:id, LineNo: idx + 1, PayeeType:r.payeeType, EmployeeID:r.employeeId, StudentID:r.studentId,
        VendorName:r.name, CNIC_NTN:r.cnic, IBAN:r.iban, BankName:r.bank, Program:r.program, Session:r.session, Shift:r.shift,
        BillNature:r.billNature, ThesisClass:r.thesisClass, ThesisStudentName:r.thesisStudentName, BenevolentFundSubCategory:r.benevolentFundSubCategory,
        VisitingProgram:r.visitingProgram, VisitingSubject:r.visitingSubject, VisitingCrHrs:r.visitingCrHrs, VisitingRate:r.visitingRate, VisitingLectures:r.visitingLectures,
        ReceivingOfficeID:r.receivingOfficeId, ReceivingOffice:r.receivingOfficeName,
        PayFromAccountID:r.payFromAccountId, PayFromAccountLabel:r.payFromAccountLabel, PayFromAccountNumber:r.payFromAccountNumber,
        Amount:r.amount, IncomeTaxAmount:r.incomeTax, IncomeTaxSection:r.incomeTaxSection||'', SalesTaxAmount:r.salesTax, PSTAmount:r.pst,
        SecurityAmount:r.security, PenaltyAmount:r.penalty, OtherDeductionAmount:r.other, NetAmount:r.net,
        BillDescription:r.description, Section149CreditApplied:r.creditApplied||0, RecoveryDeducted:r.recoveryDeducted||0
      })));
      saveRecoveryApplicationsMany_(resolved.map((r, idx) => ({ entryId: id + '-' + (idx + 1), allocations: r.recoveryAllocations })), username);

      appendRowObj(SHEETS.ENTRIES, {
        EntryID:id, Timestamp:new Date(), EntryDate:parentMeta.entryDate, FY:fy,
        CampusID:parentMeta.campusId, CampusName:parentMeta.campusName, HeadID:parentMeta.headId,
        HeadCode:parentMeta.headCode, HeadName:parentMeta.headName,
        PayeeType:'Bulk', EmployeeID:'', VendorName:'Bulk Bill - ' + resolved.length + ' beneficiaries',
        CNIC_NTN:'', IBAN:'', Amount:totalGross, BillDescription:parentMeta.billDescription || '',
        BillNo:parentMeta.billNo || '', EnteredBy:username, Status:STATUS.RECEIVED,
        BudgetAllocatedAtEntry: stNow.allocated, BudgetExpensesBeforeThisBill: stNow.spent, BudgetAfterThisBill: stNow.spent + totalGross,
        ProcessedBy:'', ProcessedDate:'', PassedBy:'', PassedDate:'', PaidBy:'', PaidDate:'', BatchID:'',
        StudentID:'', Program:'', Session:'', Shift:'',
        BillNature:'Bulk', RefundCategory:'', FBRStatus:'', ServiceCategory:'', TaxpayerType:'', PRAStatus:'',
        PayFromAccountID: distinctAccountIds.length === 1 ? distinctAccountIds[0] : '',
        PayFromAccountLabel: bulkPayFromAccount ? (bulkPayFromAccount.AccountTitle + ' - ' + bulkPayFromAccount.BankName) : (distinctAccountIds.length > 1 ? '(Multiple)' : ''),
        PayFromAccountNumber: bulkPayFromAccount ? (bulkPayFromAccount.AccountNumber||'') : '',
        ReceivingOfficeID: distinctOfficeIds.length === 1 ? distinctOfficeIds[0] : '',
        ReceivingOffice: bulkReceivingOffice ? bulkReceivingOffice.OfficeName : (distinctOfficeIds.length > 1 ? '(Multiple)' : ''),
        PSTInvoiceNo: parentMeta.pstInvoiceNo||'', VendorInvoiceDate: parentMeta.vendorInvoiceDate||'',
        IncomeTaxSection:'', IncomeTaxRate:'', IncomeTaxAmount: totals.incomeTax,
        SalesTaxApplied: totals.salesTax > 0, SalesTaxRate:'', SalesTaxAmount: totals.salesTax,
        PSTApplied: totals.pst > 0, PSTRate:'', PSTAmount: totals.pst,
        SecurityApplied: totals.security > 0, SecurityMode:'', SecurityBasis:'', SecurityRate:'', SecurityAmount: totals.security,
        PenaltyApplied: totals.penalty > 0, PenaltyMode:'', PenaltyBasis:'', PenaltyRate:'', PenaltyAmount: totals.penalty,
        OtherDeductionApplied: totals.other > 0, OtherDeductionMode:'', OtherDeductionCategory:'', OtherDeductionBasis:'', OtherDeductionRate:'', OtherDeductionAmount: totals.other,
        StudentDeductionApplied:false, StudentDeductionCategory:'', StudentDeductionBasis:'', StudentDeductionAmount:0,
        DiaryID: diaryCheck.diaryId || '', DiaryBypassReason: diaryCheck.bypassReason || '',
        DiaryIDs: diaryCheck.diaryId ? [diaryCheck.diaryId].concat(extraDiaryRows.map(dr => dr.DiaryID)).join(', ') : '',
        PaymentStatus: '',
        RecoveryDeducted: totalRecovery,
        UploadFingerprint: fingerprint,
        NetAmount: totals.net
      });

      const check = verifyBulkSaved_(id, resolved.length, totalGross, totals.net);
      if (!check.ok) {
        rollbackBulkSave_(id);
        return { success:false, message:'Nothing has been saved (' + check.reason + '). It is safe to upload the same file again.' };
      }
    } catch (err) {
      rollbackBulkSave_(id);
      return { success:false, message:'Nothing has been saved (' + (err && err.message ? err.message : err) + '). It is safe to upload the same file again.' };
    }

    // The bill is saved and verified. Now the follow-up steps.
    linkDiaryToEntry_(diaryCheck.diaryId, id);
    extraDiaryRows.forEach(dr => linkDiaryToEntry_(dr.DiaryID, id));
    if (extraDiaryRows.length) {
      const allDiaryIds = [diaryCheck.diaryId].concat(extraDiaryRows.map(dr => dr.DiaryID));
      allDiaryIds.forEach(did => appendRowObj(SHEETS.LETTERMOVEMENTS, {
        MovementID: nextMovementId_(), DiaryID: did, ActionType: 'CombinedIntoBulkBill',
        FromUser: username, ToUser: '', ActionDate: new Date(), ResponseRefNo: '', ResponseDate: '',
        Details: 'Entered as bulk bill ' + id + ' together with Diary No.: ' + allDiaryIds.filter(x => x !== did).join(', '),
        ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
      }));
    }

    // Consume the Section 149 credit each row used - summed per employee.
    const creditByKey = {};
    resolved.forEach(r => {
      if (!r.creditApplied) return;
      const k = r.payeeType + '|' + String(r.creditKey||'').trim().toLowerCase();
      if (!creditByKey[k]) creditByKey[k] = { payeeType:r.payeeType, key:r.creditKey, total:0 };
      creditByKey[k].total += r.creditApplied;
    });
    Object.values(creditByKey).forEach(g => {
      adjustSection149CreditBalance_(g.key, g.payeeType, fy, -g.total, 'Consumed by bulk bill ' + id);
    });

    // Saved Vendor / Non-UE / Student lists are refreshed LAST, in one write each - a problem here can never damage the bill.
    let payeeWarning = '';
    try { upsertPayeesBatch_(resolved); } catch (err) { payeeWarning = 'The bill is saved, but the saved-payee lists could not be refreshed: ' + (err && err.message ? err.message : err); }

    return { success:true, entryId:id, totalGross, totalNet: totals.net, lineCount: resolved.length,
      recoveryDeducted: totalRecovery, verified: true, payeeWarning: payeeWarning,
      diaryWarnings: diaryMismatchWarningsMulti_([diaryCheck.diaryRow].concat(extraDiaryRows), totalGross),
      status: getBudgetStatus(parentMeta.campusId, parentMeta.headId, fy) };
  });
}

// Single source of truth for the IBFT column layout (Stage 4 export, batch re-downloads, Reports > IBFT Payment).
function mapEntryToIBFTRow_(e) {
  const taxpayerStatus = e.FBRStatus === 'Filer' ? 'Active' : (e.FBRStatus === 'NonFiler' ? 'Inactive' : '');
  const iban = String(e.IBAN || '').replace(/\s+/g, '').toUpperCase();
  const bankShortName = iban.length >= 8 ? iban.substring(4, 8) : '';
  // A resubmitted (previously Failed) payment shows a "-N" retry marker on the Bill ID:
  // E658 -> E658-1; bulk line E658-25 -> E658-25-1; an isolated bill E658-A -> E658-A-1.
  const retryCount = Number(e.PaymentRetryCount || 0);
  const billId = retryCount > 0 ? (e.EntryID || '') + '-' + retryCount : (e.EntryID || '');
  return {
    bankAccountNo: e.PayFromAccountNumber || '',
    taxpayerStatus: taxpayerStatus,
    cnicNtn: e.CNIC_NTN || '',
    billPassedDate: e.PassedDate ? fmtDate_(e.PassedDate) : '',
    receivingOffice: e.ReceivingOffice || '',
    description: e.BillDescription || '',
    billId: billId,
    invoiceNo: e.PSTInvoiceNo || e.BillNo || '',
    invoiceDate: e.VendorInvoiceDate ? fmtDate_(e.VendorInvoiceDate) : '',
    billNature: e.BillNature || '',
    beneficiary: e.VendorName || '',
    iban: e.IBAN || '',
    bankShortName: bankShortName,
    grossAmount: Number(e.Amount || 0),
    fbrSection: effectiveIncomeTaxSection_(e),
    incomeTax: Number(e.IncomeTaxAmount || 0),
    salesTax: Number(e.SalesTaxAmount || 0),
    punjabSalesTax: Number(e.PSTAmount || 0),
    security: Number(e.SecurityAmount || 0),
    penalty: Number(e.PenaltyAmount || 0),
    otherDeduction: Number(e.OtherDeductionAmount || 0),
    netPayment: Number(netOf_(e))
  };
}
// The Net Amount of a bill/line. A real 0 stays 0 (e.g. fully recovered) - only a BLANK falls back to Gross (very old bills).
function netOf_(r) {
  const n = r.NetAmount;
  return (n === '' || n === undefined || n === null) ? Number(r.Amount || 0) : Number(n);
}
function fmtDate_(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return isNaN(dt) ? String(d) : Utilities.formatDate(dt, Session.getScriptTimeZone() || 'Asia/Karachi', 'yyyy-MM-dd');
}

// Expands any "Bulk" parent rows into their individual beneficiary lines (each inheriting the
// parent's stage/date/batch info but with its OWN payee/amount/deduction/FBR Section detail).
function expandBulkItems_(entries) {
  const out = [];
  const bulkEntries = entries.filter(it => it.PayeeType === 'Bulk');
  const allLines = bulkEntries.length ? getTable(SHEETS.BULKITEMS) : [];
  const linesByParent = {};
  allLines.forEach(li => {
    (linesByParent[li.ParentEntryID] || (linesByParent[li.ParentEntryID] = [])).push(li);
  });
  entries.forEach(it => {
    if (it.PayeeType !== 'Bulk') { out.push(it); return; }
    const lines = linesByParent[it.EntryID] || [];
    lines.forEach(li => out.push(Object.assign({}, it, {
      EntryID: it.EntryID + '-' + li.LineNo,
      PayeeType: li.PayeeType,
      EmployeeID: li.EmployeeID, StudentID: li.StudentID, Program: li.Program, Session: li.Session, Shift: li.Shift,
      VendorName: li.VendorName, CNIC_NTN: li.CNIC_NTN, IBAN: li.IBAN, BankName: li.BankName, BillNature: li.BillNature || it.BillNature,
      // This beneficiary's OWN FBR Section (the parent bulk row has none).
      IncomeTaxSection: effectiveIncomeTaxSection_(li),
      ThesisClass: li.ThesisClass, ThesisStudentName: li.ThesisStudentName, BenevolentFundSubCategory: li.BenevolentFundSubCategory,
      VisitingProgram: li.VisitingProgram, VisitingSubject: li.VisitingSubject, VisitingCrHrs: li.VisitingCrHrs, VisitingRate: li.VisitingRate, VisitingLectures: li.VisitingLectures,
      ReceivingOfficeID: li.ReceivingOfficeID || it.ReceivingOfficeID,
      ReceivingOffice: li.ReceivingOffice || it.ReceivingOffice,
      PayFromAccountID: li.PayFromAccountID || it.PayFromAccountID,
      PayFromAccountLabel: li.PayFromAccountLabel || it.PayFromAccountLabel,
      PayFromAccountNumber: li.PayFromAccountNumber || it.PayFromAccountNumber,
      Amount: li.Amount, IncomeTaxAmount: li.IncomeTaxAmount, SalesTaxAmount: li.SalesTaxAmount, PSTAmount: li.PSTAmount,
      SecurityAmount: li.SecurityAmount, PenaltyAmount: li.PenaltyAmount, OtherDeductionAmount: li.OtherDeductionAmount,
      NetAmount: li.NetAmount, BillDescription: li.BillDescription,
      RecoveryDeducted: li.RecoveryDeducted,
      RedirectedToEntryID: li.RedirectedToEntryID,
      // Set when this beneficiary's payment failed and it was isolated into its own bill (E123-A ...).
      SplitToEntryID: li.SplitToEntryID || '',
      LinePaymentStatus: li.LinePaymentStatus || '', LinePaymentConfirmedDate: li.LinePaymentConfirmedDate,
      LinePaymentConfirmedBy: li.LinePaymentConfirmedBy, LinePaymentFailureReason: li.LinePaymentFailureReason,
      LinePaymentFailureLoggedBy: li.LinePaymentFailureLoggedBy, LinePaymentFailureDate: li.LinePaymentFailureDate,
      LinePaymentRetryCount: li.LinePaymentRetryCount
    })));
  });
  return out;
}

// Trimmed, case-insensitive status compare.
function statusEquals_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
function isOnHold_(e) {
  return e.OnHold === true || e.OnHold === 'TRUE' || e.OnHold === 'true';
}

// fy is OPTIONAL: blank returns bills from every year. A bill On Hold is excluded from every stage queue.
function getBillsByStatus(status, fy) {
  try {
    let rows = getTable(SHEETS.ENTRIES).filter(e => statusEquals_(e.Status, status) && fyMatches_(e.FY, fy) && !isOnHold_(e));
    return rows.sort((a,b) => new Date(b.EntryDate) - new Date(a.EntryDate));
  } catch (err) {
    Logger.log('getBillsByStatus failed: ' + err);
    throw new Error('Could not read the Entries sheet: ' + err.message);
  }
}

// Full detail for ONE bill, for the Bill Audit View. A bulk-beneficiary ID like "E5-2" opens its
// parent bill; an isolated bill like "E5-A" is a real bill of its own and opens as itself.
function getBillDetail(entryId) {
  const idStr = String(entryId);
  const baseId = isSplitBillId_(idStr) ? idStr : (idStr.includes('-') ? idStr.split('-')[0] : entryId);
  const bill = getTable(SHEETS.ENTRIES).find(e => e.EntryID === baseId);
  if (!bill) return { success:false, message:'Bill not found.' };
  const headSplits = getTable(SHEETS.HEADSPLITS).filter(sp => sp.ParentEntryID === baseId);
  const bulkItems = bill.PayeeType === 'Bulk' ? getTable(SHEETS.BULKITEMS).filter(li => li.ParentEntryID === baseId) : [];

  // Budget Position is LOCKED at the moment the bill was saved. A bill saved before locking existed
  // falls back to a live calculation.
  const headRows = headSplits.length
    ? headSplits.map(sp => ({ HeadID:sp.HeadID, HeadCode:sp.HeadCode, HeadName:sp.HeadName, Amount:sp.Amount,
        allocated:sp.BudgetAllocatedAtEntry, expensesBefore:sp.BudgetExpensesBeforeThisBill, afterThisBill:sp.BudgetAfterThisBill }))
    : [{ HeadID:bill.HeadID, HeadCode:bill.HeadCode, HeadName:bill.HeadName, Amount:bill.Amount,
        allocated:bill.BudgetAllocatedAtEntry, expensesBefore:bill.BudgetExpensesBeforeThisBill, afterThisBill:bill.BudgetAfterThisBill }];
  const budgetPosition = headRows.map(h => {
    const isLocked = h.allocated !== '' && h.allocated !== undefined && h.expensesBefore !== '' && h.expensesBefore !== undefined;
    let allocated, expensesBefore, afterThisBill;
    if (isLocked) {
      allocated = Number(h.allocated); expensesBefore = Number(h.expensesBefore); afterThisBill = Number(h.afterThisBill);
    } else {
      const status = getBudgetStatus(bill.CampusID, h.HeadID, bill.FY, baseId);
      allocated = status.allocated; expensesBefore = status.spent; afterThisBill = status.spent + Number(h.Amount||0);
    }
    return {
      headCode: h.HeadCode, headName: h.HeadName, currentBill: Number(h.Amount||0),
      expensesSoFar: expensesBefore, afterThisBill: afterThisBill, allocated: allocated,
      balance: allocated - afterThisBill, hasAllocation: allocated > 0, locked: isLocked
    };
  });

  // An isolated beneficiary bill (E123-A) is never charged to the budget - its amount is already charged through its parent bulk bill.
  if (bill.SplitFromEntryID) budgetPosition.length = 0;
  // Always show which FBR section the Income Tax was calculated under.
  bill.IncomeTaxSection = effectiveIncomeTaxSection_(bill);
  bulkItems.forEach(li => { li.IncomeTaxSection = effectiveIncomeTaxSection_(li); });
  return { success:true, bill, headSplits, bulkItems, budgetPosition, transfers: getBillTransfers_(baseId) };
}

// Counts of bills currently in each stage - powers the badge numbers next to each tab.
function getPipelineCounts(fy) {
  const rows = getTable(SHEETS.ENTRIES).filter(e => fyMatches_(e.FY, fy));
  const counts = { Received:0, Processed:0, Passed:0, Paid:0 };
  rows.forEach(e => {
    Object.keys(counts).forEach(s => { if (statusEquals_(e.Status, s)) counts[s]++; });
  });
  return counts;
}

// Bulk stage transition - reads the sheet ONCE, mutates in memory, writes back in ONE call.
function transitionBills_(entryIds, expectedStatus, newStatus, actorUsername, byColName, dateColName, extra) {
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.ENTRIES);
    const range = sh.getDataRange();
    const values = range.getValues();
    const headers = values[0];
    const idCol = headers.indexOf('EntryID');
    const statusCol = headers.indexOf('Status');
    const byCol = headers.indexOf(byColName);
    const dateCol = headers.indexOf(dateColName);
    const extraCols = extra ? Object.keys(extra).map(k => ({ col: headers.indexOf(k), val: extra[k] })) : [];

    const idSet = new Set(entryIds.map(String));
    const invalid = [];
    for (let i = 1; i < values.length; i++) {
      if (idSet.has(String(values[i][idCol])) && !statusEquals_(values[i][statusCol], expectedStatus)) invalid.push(values[i][idCol]);
    }
    if (invalid.length) {
      return { success:false, message:'These bills are not currently "' + expectedStatus + '": ' + invalid.join(', ') };
    }

    const today = new Date();
    let count = 0;
    const items = [];
    for (let i = 1; i < values.length; i++) {
      if (idSet.has(String(values[i][idCol]))) {
        values[i][statusCol] = newStatus;
        values[i][byCol] = actorUsername;
        values[i][dateCol] = today;
        extraCols.forEach(ec => { if (ec.col !== -1) values[i][ec.col] = ec.val; });
        count++;
        if (extra) {
          const rowObj = {};
          headers.forEach((h, idx) => { if (h) rowObj[h] = values[i][idx]; });
          items.push(rowObj);
        }
      }
    }
    range.setValues(values);
    return { success:true, count, items };
  });
}

function markProcessed(entryIds, actorUsername) {
  requireRole_(actorUsername, []);
  return transitionBills_(entryIds, STATUS.RECEIVED, STATUS.PROCESSED, actorUsername, 'ProcessedBy', 'ProcessedDate');
}

function markPassed(entryIds, actorUsername) {
  requireRole_(actorUsername, ['RA']);
  return transitionBills_(entryIds, STATUS.PROCESSED, STATUS.PASSED, actorUsername, 'PassedBy', 'PassedDate');
}

function markPaidAndGenerateIBFT(entryIds, paidDate, actorUsername) {
  requireRole_(actorUsername, ['IBFT']);
  const batchId = nextId_('B', SHEETS.BATCHES, 'BatchID');
  const result = transitionBills_(entryIds, STATUS.PASSED, STATUS.PAID, actorUsername, 'PaidBy', 'PaidDate', { BatchID: batchId, PaymentStatus: 'Submitted' });
  if (!result.success) return result;
  // Bulk bills were ticked/passed/paid as ONE consolidated row - the bank file pays every beneficiary individually.
  const ibftItems = expandBulkItems_(result.items);
  const total = ibftItems.reduce((s,it) => s + Number(it.Amount||0), 0);
  appendRowObj(SHEETS.BATCHES, { BatchID:batchId, Date:paidDate, GeneratedBy:actorUsername, TotalAmount:total, EntryIDs:entryIds.join(',') });
  // A beneficiary whose whole net was recovered (net = 0) has nothing to transfer, so is left out of the bank file.
  const allRows = ibftItems.map(mapEntryToIBFTRow_);
  const bankRows = allRows.filter(r => r.netPayment > 0);
  return { success:true, batchId, date:paidDate, total, items: bankRows, zeroNetSkipped: allRows.length - bankRows.length };
}

// Every past IBFT batch, most recent first.
function getPaymentBatches() {
  return getTable(SHEETS.BATCHES).sort((a,b) => new Date(b.Date) - new Date(a.Date));
}

// Full entry-level detail for every bill in a given batch (bulk parents expanded into beneficiaries).
function getBatchDetails(batchId) {
  return expandBulkItems_(getTable(SHEETS.ENTRIES).filter(e => e.BatchID === batchId)).map(mapEntryToIBFTRow_).filter(r => r.netPayment > 0);
}

/* ================= DIAGNOSTICS (Admin tab "System Check" button) ================= */

function systemCheck(actorUsername) {
  requireAdmin_(actorUsername);
  const report = [];
  Object.keys(SCHEMA).forEach(name => {
    const sh = SS.getSheetByName(name);
    if (!sh) { report.push({ sheet:name, ok:false, message:'Sheet missing entirely.' }); return; }
    const lastCol = sh.getLastColumn();
    const headers = lastCol > 0 ? sh.getRange(1,1,1,lastCol).getValues()[0] : [];
    const missing = SCHEMA[name].filter(h => headers.indexOf(h) === -1);
    report.push({
      sheet:name, ok: missing.length===0, rowCount: sh.getLastRow()-1,
      message: missing.length ? ('Missing columns: ' + missing.join(', ')) : 'OK'
    });
  });
  const entries = getTable(SHEETS.ENTRIES);
  const knownStatuses = Object.values(STATUS);
  const badStatusRows = entries.filter(e => !knownStatuses.some(s => statusEquals_(e.Status, s)));
  report.push({
    sheet:'Entries (Status values)', ok: badStatusRows.length===0, rowCount: entries.length,
    message: badStatusRows.length
      ? ('Found ' + badStatusRows.length + ' bill(s) with an unrecognised Status - these will not appear in any stage. IDs: ' + badStatusRows.map(r=>r.EntryID).join(', '))
      : 'All Status values are clean.'
  });
  // Bulk bills must have all their lines, adding up to the bill total (a cut-off upload would show up here).
  const allLines = getTable(SHEETS.BULKITEMS);
  const linesByParent = {};
  allLines.forEach(li => { (linesByParent[li.ParentEntryID] || (linesByParent[li.ParentEntryID] = [])).push(li); });
  const bulkParents = entries.filter(e => e.PayeeType === 'Bulk' && !statusEquals_(e.Status, STATUS.CANCELLED));
  const bulkIds = new Set(entries.filter(e => e.PayeeType === 'Bulk').map(e => e.EntryID));
  const bulkProblems = [];
  bulkParents.forEach(e => {
    const ls = linesByParent[e.EntryID] || [];
    if (!ls.length) { bulkProblems.push(e.EntryID + ': no beneficiary lines'); return; }
    const sum = ls.filter(li => !li.RedirectedToEntryID).reduce((s, li) => s + Number(li.Amount || 0), 0);
    if (Math.abs(sum - Number(e.Amount || 0)) > 1) bulkProblems.push(e.EntryID + ': lines total ' + Math.round(sum).toLocaleString() + ' but bill total is ' + Math.round(Number(e.Amount || 0)).toLocaleString());
  });
  const orphanParents = Object.keys(linesByParent).filter(id => !bulkIds.has(id));
  report.push({
    sheet: 'Bulk bills (integrity)', ok: !bulkProblems.length && !orphanParents.length, rowCount: bulkParents.length,
    message: (bulkProblems.length ? 'Problem bulk bill(s): ' + bulkProblems.join(' | ') + '. ' : '') +
      (orphanParents.length ? 'Leftover lines with no bulk bill (from a cut-off upload; harmless, removed automatically if that ID is reused): ' + orphanParents.join(', ') + '.' : '') +
      (!bulkProblems.length && !orphanParents.length ? 'Every bulk bill has all its lines and they add up to its total.' : '')
  });
  return report;
}

/* ================= LOGIN DIAGNOSTICS =================
   Run these directly from the Apps Script editor (they work even if the web app login is broken). */
function debugAdminLogin() {
  const table = getTable(SHEETS.USERS);
  Logger.log('Users sheet contents: ' + JSON.stringify(table));
  const result = authenticate('admin', 'admin123');
  Logger.log('authenticate("admin","admin123") returned: ' + JSON.stringify(result));
}

function resetAdminPassword() {
  ensureSheetAndColumns_(SHEETS.USERS, SCHEMA.Users);
  const users = getTable(SHEETS.USERS);
  const admin = users.find(u => u.Username === 'admin');
  if (admin) {
    updateRowByKey(SHEETS.USERS, 'Username', 'admin', { PasswordHash: hashPassword_('admin123'), Role:'Admin', Active:true });
    Logger.log('Existing admin row found - password reset to admin123.');
  } else {
    appendRowObj(SHEETS.USERS, { Username:'admin', PasswordHash: hashPassword_('admin123'), FullName:'Administrator', Role:'Admin', Active:true });
    Logger.log('No admin row existed - created admin / admin123.');
  }
  return 'Done. Now try logging in with admin / admin123.';
}

function repairEntryStatuses() {
  const sh = getOrCreateSheet_(SHEETS.ENTRIES);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const statusCol = headers.indexOf('Status');
  const knownStatuses = Object.values(STATUS);
  let fixed = 0;
  for (let i = 1; i < values.length; i++) {
    const raw = values[i][statusCol];
    const match = knownStatuses.find(s => statusEquals_(raw, s));
    if (match && match !== raw) { values[i][statusCol] = match; fixed++; }
  }
  if (fixed) sh.getDataRange().setValues(values);
  return 'Checked ' + (values.length-1) + ' bill(s), fixed ' + fixed + ' Status value(s).';
}

/* ================= SECTION 149: cancelled-bill income-threshold repair =================
   One-time (safe to re-run) catch-up for bills saved with an inflated Section 149 threshold
   because a since-cancelled bill was still being counted. Only bills NOT YET Paid are touched.
   Preview reports what WOULD change; Apply writes the corrected figures. ============== */
function previewSection149CancellationImpact(actorUsername) {
  requireAdmin_(actorUsername);
  return computeSection149CancellationFixes_();
}
function applySection149CancellationImpact(actorUsername) {
  requireAdmin_(actorUsername);
  const fixes = computeSection149CancellationFixes_();
  const toApply = fixes.singleEntryFixes.filter(f => f.changed);
  if (!toApply.length) return { success:true, applied:0, checked: fixes.singleEntryFixes.length, message:'Nothing to fix - every checked bill already matches the corrected calculation.' };
  return withLock_(() => {
    // Batched writes: each sheet is read ONCE and written back ONCE.
    const singleFixes = toApply.filter(f => !f.isBulkLine);
    const bulkFixes = toApply.filter(f => f.isBulkLine);
    const parentDeltas = {};

    if (singleFixes.length) {
      const sh = getOrCreateSheet_(SHEETS.ENTRIES);
      const range = sh.getDataRange();
      const values = range.getValues();
      const headers = values[0];
      const idCol = headers.indexOf('EntryID'), itCol = headers.indexOf('IncomeTaxAmount'), irCol = headers.indexOf('IncomeTaxRate'),
            netCol = headers.indexOf('NetAmount'), ibCol = headers.indexOf('IncomeBeforeThisBill'),
            iaCol = headers.indexOf('IncomeAfterThisBill'), caCol = headers.indexOf('Section149CreditApplied');
      const byId = {};
      singleFixes.forEach(f => byId[f.entryId] = f);
      for (let i = 1; i < values.length; i++) {
        const f = byId[values[i][idCol]];
        if (!f) continue;
        values[i][itCol] = f.newTax; values[i][irCol] = f.newRate; values[i][netCol] = f.newNet;
        values[i][ibCol] = f.newIncomeBefore; values[i][iaCol] = f.newIncomeAfter; values[i][caCol] = f.creditApplied || 0;
      }
      range.setValues(values);
    }

    if (bulkFixes.length) {
      const sh = getOrCreateSheet_(SHEETS.BULKITEMS);
      const range = sh.getDataRange();
      const values = range.getValues();
      const headers = values[0];
      const pCol = headers.indexOf('ParentEntryID'), lCol = headers.indexOf('LineNo'),
            itCol = headers.indexOf('IncomeTaxAmount'), netCol = headers.indexOf('NetAmount'), caCol = headers.indexOf('Section149CreditApplied');
      const byKey = {};
      bulkFixes.forEach(f => { byKey[f.parentEntryId + '|' + f.lineNo] = f; });
      for (let i = 1; i < values.length; i++) {
        const f = byKey[values[i][pCol] + '|' + values[i][lCol]];
        if (!f) continue;
        values[i][itCol] = f.newTax; values[i][netCol] = f.newNet; values[i][caCol] = f.creditApplied || 0;
        parentDeltas[f.parentEntryId] = (parentDeltas[f.parentEntryId] || 0) + (f.newTax - f.oldTax);
      }
      range.setValues(values);
    }

    if (Object.keys(parentDeltas).length) {
      const sh = getOrCreateSheet_(SHEETS.ENTRIES);
      const range = sh.getDataRange();
      const values = range.getValues();
      const headers = values[0];
      const idCol = headers.indexOf('EntryID'), itCol = headers.indexOf('IncomeTaxAmount'), netCol = headers.indexOf('NetAmount'), amtCol = headers.indexOf('Amount');
      for (let i = 1; i < values.length; i++) {
        const delta = parentDeltas[values[i][idCol]];
        if (delta === undefined) continue;
        values[i][itCol] = round0_(Number(values[i][itCol]||0) + delta);
        values[i][netCol] = round0_(Number(values[i][netCol]||values[i][amtCol]||0) - delta);
      }
      range.setValues(values);
    }
    invalidateCache_(SHEETS.ENTRIES);
    invalidateCache_(SHEETS.BULKITEMS);
    const creditByKey = {};
    toApply.forEach(f => {
      if (!f.creditApplied) return;
      const k = f.payeeType + '|' + String(f.creditKey||'').trim().toLowerCase() + '|' + f.fy;
      if (!creditByKey[k]) creditByKey[k] = { payeeType:f.payeeType, key:f.creditKey, fy:f.fy, total:0 };
      creditByKey[k].total += f.creditApplied;
    });
    Object.values(creditByKey).forEach(g => {
      adjustSection149CreditBalance_(g.key, g.payeeType, g.fy, -g.total, 'Consumed by cancellation-repair pass');
    });
    return { success:true, applied: toApply.length, checked: fixes.singleEntryFixes.length, fixes: toApply };
  });
}
// Shared by both functions above - never writes anything itself, only computes.
function computeSection149CancellationFixes_() {
  const ctx = loadSection149BatchContext_();
  const allEntries = ctx.entries;
  const bulkParentById = ctx.bulkParentById;

  const singleCandidates = allEntries.filter(e =>
    !statusEquals_(e.Status, STATUS.CANCELLED) && !statusEquals_(e.Status, STATUS.PAID) &&
    (e.PayeeType === 'Employee' || e.PayeeType === 'NonUEEmployee') &&
    e.EmployeeCategory && !e.ManualTaxOverride && String(e.IncomeTaxSection||'').indexOf('149') === 0
  ).map(e => ({ kind:'single', timestamp: e.Timestamp, row: e }));

  const ueBulkCandidates = ctx.bulkItems.filter(li => {
    const parent = bulkParentById[li.ParentEntryID];
    if (!parent) return false;
    if (statusEquals_(parent.Status, STATUS.CANCELLED) || statusEquals_(parent.Status, STATUS.PAID)) return false;
    if (li.PayeeType !== 'Employee') return false;
    if (li.RedirectedToEntryID) return false;
    const isTaxableNature = EMPLOYEE_149_CATEGORIES.indexOf(li.BillNature) !== -1 || UE_ONLY_TAXABLE_NATURES.indexOf(li.BillNature) !== -1;
    return isTaxableNature;
  }).map(li => ({ kind:'bulk', timestamp: bulkParentById[li.ParentEntryID].Timestamp, row: li, parent: bulkParentById[li.ParentEntryID] }));

  const combined = singleCandidates.concat(ueBulkCandidates).sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

  const sessionCreditByKey = {};
  const allFixes = combined.map(item => {
    if (item.kind === 'single') {
      const e = item.row;
      const payeeType = e.PayeeType;
      const key = payeeType === 'Employee' ? e.EmployeeID : e.CNIC_NTN;
      const sessionKey = payeeType + '|' + String(key||'').trim().toLowerCase();
      if (sessionCreditByKey[sessionKey] === undefined) {
        sessionCreditByKey[sessionKey] = getSection149CreditBalanceFromCtx_(ctx, key, payeeType, e.FY);
      }
      const result = computeSection149Tax_(payeeType, key, e.FY, Number(e.Amount||0), !!e.AffidavitLowIncome, 0, {
        asOfTimestamp: e.Timestamp, excludeEntryId: e.EntryID, creditOverride: sessionCreditByKey[sessionKey], ctx
      });
      if (result.creditApplied > 0) sessionCreditByKey[sessionKey] = Math.max(0, sessionCreditByKey[sessionKey] - result.creditApplied);

      const gross = Number(e.Amount||0);
      const oldTax = round0_(e.IncomeTaxAmount);
      const newTax = result.additionalTax;
      const otherDeductions = Number(e.SalesTaxAmount||0) + Number(e.PSTAmount||0) + Number(e.SecurityAmount||0) + Number(e.PenaltyAmount||0) + Number(e.OtherDeductionAmount||0);
      return {
        isBulkLine:false, entryId: e.EntryID, payeeType, name: e.VendorName, fy: e.FY, status: e.Status, gross,
        oldTax, newTax, newRate: gross > 0 ? newTax / gross : 0,
        oldNet: round0_(netOf_(e)), newNet: round0_(gross - newTax - otherDeductions - Number(e.RecoveryDeducted||0)),
        newIncomeBefore: result.incomeBefore, newIncomeAfter: result.incomeAfter, changed: newTax !== oldTax,
        creditKey: key, creditApplied: result.creditApplied
      };
    } else {
      const li = item.row, parent = item.parent;
      const key = li.EmployeeID;
      const sessionKey = 'Employee|' + String(key||'').trim().toLowerCase();
      if (sessionCreditByKey[sessionKey] === undefined) {
        sessionCreditByKey[sessionKey] = getSection149CreditBalanceFromCtx_(ctx, key, 'Employee', parent.FY);
      }
      const result = computeSection149Tax_('Employee', key, parent.FY, Number(li.Amount||0), false, 0, {
        asOfTimestamp: parent.Timestamp, excludeBulkLine: { parentEntryId: li.ParentEntryID, lineNo: li.LineNo },
        creditOverride: sessionCreditByKey[sessionKey], ctx
      });
      if (result.creditApplied > 0) sessionCreditByKey[sessionKey] = Math.max(0, sessionCreditByKey[sessionKey] - result.creditApplied);

      const gross = Number(li.Amount||0);
      const oldTax = round0_(li.IncomeTaxAmount);
      const newTax = result.additionalTax;
      const otherDeductions = Number(li.SalesTaxAmount||0) + Number(li.PSTAmount||0) + Number(li.SecurityAmount||0) + Number(li.PenaltyAmount||0) + Number(li.OtherDeductionAmount||0);
      return {
        isBulkLine:true, entryId: li.ParentEntryID + '-' + li.LineNo, parentEntryId: li.ParentEntryID, lineNo: li.LineNo,
        payeeType:'Employee', name: li.VendorName, fy: parent.FY, status: parent.Status, gross,
        oldTax, newTax, newRate: gross > 0 ? newTax / gross : 0,
        oldNet: round0_(netOf_(li)), newNet: round0_(gross - newTax - otherDeductions - Number(li.RecoveryDeducted||0)),
        changed: newTax !== oldTax, creditKey: key, creditApplied: result.creditApplied
      };
    }
  });

  // Bulk Non-UE lines can't be safely recomputed automatically - flagged for manual review.
  const bulkLineFlags = ctx.bulkItems.filter(li => {
    const parent = bulkParentById[li.ParentEntryID];
    if (!parent) return false;
    if (statusEquals_(parent.Status, STATUS.CANCELLED) || statusEquals_(parent.Status, STATUS.PAID)) return false;
    if (li.PayeeType !== 'NonUEEmployee') return false;
    if (li.RedirectedToEntryID) return false;
    return EMPLOYEE_149_CATEGORIES.indexOf(li.BillNature) !== -1;
  }).map(li => ({
    parentEntryId: li.ParentEntryID, lineNo: li.LineNo, payeeType: li.PayeeType, name: li.VendorName,
    key: li.CNIC_NTN, fy: bulkParentById[li.ParentEntryID].FY,
    gross: Number(li.Amount||0), currentTax: Number(li.IncomeTaxAmount||0), status: bulkParentById[li.ParentEntryID].Status
  }));

  return {
    singleEntryFixes: allFixes, bulkLineFlags,
    changedCount: allFixes.filter(f=>f.changed).length,
    bulkFlagCount: bulkLineFlags.length
  };
}

/* ================= SECTION 149: employee-level statement builder =================
   One person's ENTIRE Section 149 history walked chronologically ONCE, tracking cumulative
   taxable income and, for every slab-taxed transaction, which bracket(s) it fell into. Used by
   both the credit tool and the Tax Deduction Statement. */
function buildSection149EmployeeStatement_(ctx, key, payeeType, fy) {
  const keyLower = String(key||'').trim().toLowerCase();
  const profile = getIncomeProfileFromCtx_(ctx, key, payeeType, fy);
  const annualIncomeAtStart = profile ? round0_(profile.AnnualTaxableIncome) : 0;
  const manualExclusions = getSection149ManualExclusionsFromCtx_(ctx, key, payeeType, fy);

  const txns = [];
  (ctx.entriesByKey[payeeType + '|' + keyLower] || []).forEach(e => {
    if (!fyMatches_(e.FY, fy)) return;
    const isSlab = !!e.EmployeeCategory && String(e.IncomeTaxSection||'').indexOf('149') === 0 && !e.ManualTaxOverride;
    const isSection156 = payeeType === 'NonUEEmployee' && e.BillNature === SECTION_156_NATURE;
    const isFlat1531b = payeeType === 'NonUEEmployee' && e.EmployeeCategory && e.NonUETaxMethod === 'Section153_1b';
    if (!isSlab && !isSection156 && !isFlat1531b) return;
    const cancelled = statusEquals_(e.Status, STATUS.CANCELLED);
    const manuallyExcluded = manualExclusions.has(String(e.EntryID).trim());
    txns.push({
      source:'single', id: e.EntryID, timestamp: e.Timestamp, date: e.EntryDate, status: e.Status, name: e.VendorName,
      billNature: e.BillNature, gross: Number(e.Amount||0), actualTax: Number(e.IncomeTaxAmount||0),
      creditApplied: Number(e.Section149CreditApplied||0),
      section: isSlab ? '149' : (isSection156 ? '156' : '153(1)(b)'), method: isSlab ? 'slab' : 'flat',
      flatRate: e.IncomeTaxRate,
      countsTowardThreshold: isSlab && !cancelled && !manuallyExcluded,
      excludedReason: !isSlab ? '' : (cancelled ? 'Cancelled' : (manuallyExcluded ? 'Manually excluded' : '')),
      isPaid: statusEquals_(e.Status, STATUS.PAID), creditRecorded: !!e.Section149PaidCreditRecorded, methodUncertain: false
    });
  });
  (ctx.bulkByKey[payeeType + '|' + keyLower] || []).forEach(li => {
    const parent = ctx.bulkParentById[li.ParentEntryID];
    if (!parent || !fyMatches_(parent.FY, fy)) return;
    const isTaxableNature = EMPLOYEE_149_CATEGORIES.indexOf(li.BillNature) !== -1 ||
      (payeeType === 'Employee' && UE_ONLY_TAXABLE_NATURES.indexOf(li.BillNature) !== -1);
    const isSection156 = payeeType === 'NonUEEmployee' && li.BillNature === SECTION_156_NATURE;
    if (!isTaxableNature && !isSection156) return;
    const parentCancelled = statusEquals_(parent.Status, STATUS.CANCELLED);
    const redirected = !!li.RedirectedToEntryID;
    const itemId = li.ParentEntryID + '-' + li.LineNo;
    const manuallyExcluded = manualExclusions.has(itemId);
    const methodUncertain = payeeType === 'NonUEEmployee' && !isSection156;
    txns.push({
      source:'bulk', id: itemId, parentId: li.ParentEntryID, lineNo: li.LineNo, timestamp: parent.Timestamp,
      date: parent.EntryDate, status: parent.Status, name: li.VendorName,
      billNature: li.BillNature, gross: Number(li.Amount||0), actualTax: Number(li.IncomeTaxAmount||0),
      creditApplied: Number(li.Section149CreditApplied||0),
      section: isSection156 ? '156' : '149', method: isSection156 ? 'flat' : 'slab', flatRate: null,
      countsTowardThreshold: !isSection156 && !methodUncertain && !parentCancelled && !redirected && !manuallyExcluded,
      excludedReason: parentCancelled ? 'Bulk bill Cancelled' : (redirected ? 'Redirected to ' + li.RedirectedToEntryID : (manuallyExcluded ? 'Manually excluded' : (methodUncertain ? 'Tax method not verifiable for a bulk Non-UE line' : ''))),
      isPaid: statusEquals_(parent.Status, STATUS.PAID), creditRecorded: !!li.Section149PaidCreditRecorded, methodUncertain
    });
  });

  txns.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

  let cumulative = annualIncomeAtStart;
  txns.forEach(t => {
    if (t.method === 'slab' && t.countsTowardThreshold) {
      t.incomeBefore = cumulative;
      t.incomeAfter = round0_(cumulative + t.gross);
      t.slabBreakdown = computeSlabBreakdown_(t.incomeBefore, t.incomeAfter, ctx.slabs);
      t.correctTax = round0_(t.slabBreakdown.reduce((s,seg) => s + seg.taxOnPortion, 0));
      cumulative = t.incomeAfter;
    } else if (t.method === 'slab') {
      t.incomeBefore = null; t.incomeAfter = null; t.slabBreakdown = []; t.correctTax = 0;
    } else {
      t.incomeBefore = null; t.incomeAfter = null; t.slabBreakdown = []; t.correctTax = t.actualTax;
    }
  });

  const slabTxns = txns.filter(t => t.method === 'slab' && t.countsTowardThreshold);
  return {
    key, payeeType, fy, annualIncomeAtStart, finalCumulativeIncome: cumulative, slabs: ctx.slabs,
    transactions: txns,
    totalSlabGross: round0_(slabTxns.reduce((s,t) => s + t.gross, 0)),
    totalSlabActualTax: round0_(slabTxns.reduce((s,t) => s + t.actualTax, 0)),
    totalSlabCorrectTax: round0_(slabTxns.reduce((s,t) => s + t.correctTax, 0)),
    totalCreditApplied: round0_(txns.reduce((s,t) => s + (t.creditApplied||0), 0)),
    currentLedgerBalance: getSection149CreditBalanceFromCtx_(ctx, key, payeeType, fy)
  };
}

/* ================= SECTION 149: credit/outstanding setup from already-PAID transactions =================
   A Paid bill's own record is never rewritten; an over-/under-deduction on it becomes a CREDIT
   (or OUTSTANDING amount) that the employee's next Section 149 transaction settles automatically.
   Computed cumulatively per employee. Preview reports only; Apply creates the credit and marks
   each contributing transaction so it is never double-counted. */
function previewSection149PaidOverDeduction(actorUsername) {
  requireAdmin_(actorUsername);
  return computeSection149PaidOverDeduction_();
}
function applySection149PaidOverDeduction(actorUsername) {
  requireAdmin_(actorUsername);
  const result = computeSection149PaidOverDeduction_();
  const toApply = result.employees.filter(g => g.netAdjustment !== 0);
  if (!toApply.length) return { success:true, applied:0, creditsCreated:0, checked: result.checkedTransactionCount, message:'Nothing to adjust - every checked employee\'s Paid transactions already reconcile correctly.' };
  return withLock_(() => {
    toApply.forEach(g => {
      const billIds = g.transactions.map(t => t.id).join(', ');
      adjustSection149CreditBalance_(g.key, g.payeeType, g.fy, g.netAdjustment,
        (g.netAdjustment > 0 ? 'Over-deduction credit' : 'Under-deduction outstanding') + ' from Paid transaction(s): ' + billIds);
    });
    const singleIds = new Set();
    const bulkKeys = new Set();
    toApply.forEach(g => g.transactions.forEach(t => {
      if (t.source === 'bulk') bulkKeys.add(t.parentId + '|' + t.lineNo); else singleIds.add(t.id);
    }));
    if (singleIds.size) {
      const sh = getOrCreateSheet_(SHEETS.ENTRIES);
      const range = sh.getDataRange();
      const values = range.getValues();
      const headers = values[0];
      const idCol = headers.indexOf('EntryID'), rCol = headers.indexOf('Section149PaidCreditRecorded');
      for (let i = 1; i < values.length; i++) { if (singleIds.has(values[i][idCol])) values[i][rCol] = true; }
      range.setValues(values);
    }
    if (bulkKeys.size) {
      const sh = getOrCreateSheet_(SHEETS.BULKITEMS);
      const range = sh.getDataRange();
      const values = range.getValues();
      const headers = values[0];
      const pCol = headers.indexOf('ParentEntryID'), lCol = headers.indexOf('LineNo'), rCol = headers.indexOf('Section149PaidCreditRecorded');
      for (let i = 1; i < values.length; i++) { if (bulkKeys.has(values[i][pCol] + '|' + values[i][lCol])) values[i][rCol] = true; }
      range.setValues(values);
    }
    invalidateCache_(SHEETS.ENTRIES);
    invalidateCache_(SHEETS.BULKITEMS);
    return { success:true, applied: toApply.reduce((s,g)=>s+g.transactions.length,0), creditsCreated: toApply.length,
      checked: result.checkedTransactionCount, employees: toApply.map(g => ({ payeeType:g.payeeType, key:g.key, fy:g.fy, netAdjustment:g.netAdjustment })) };
  });
}
function computeSection149PaidOverDeduction_() {
  const ctx = loadSection149BatchContext_();

  const candidateKeys = new Set();
  ctx.entries.forEach(e => {
    if (!statusEquals_(e.Status, STATUS.PAID)) return;
    if (e.PayeeType !== 'Employee' && e.PayeeType !== 'NonUEEmployee') return;
    if (!e.EmployeeCategory || String(e.IncomeTaxSection||'').indexOf('149') !== 0) return;
    if (e.ManualTaxOverride || e.Section149PaidCreditRecorded) return;
    candidateKeys.add(e.PayeeType + '|' + (e.PayeeType === 'Employee' ? e.EmployeeID : e.CNIC_NTN) + '|' + e.FY);
  });
  ctx.bulkItems.forEach(li => {
    const parent = ctx.bulkParentById[li.ParentEntryID];
    if (!parent || !statusEquals_(parent.Status, STATUS.PAID)) return;
    if (li.PayeeType !== 'Employee' || li.RedirectedToEntryID || li.Section149PaidCreditRecorded) return;
    const isTaxableNature = EMPLOYEE_149_CATEGORIES.indexOf(li.BillNature) !== -1 || UE_ONLY_TAXABLE_NATURES.indexOf(li.BillNature) !== -1;
    if (!isTaxableNature) return;
    candidateKeys.add('Employee|' + li.EmployeeID + '|' + parent.FY);
  });

  const employees = [];
  let checkedTransactionCount = 0;
  candidateKeys.forEach(k => {
    const firstDash = k.indexOf('|'), lastDash = k.lastIndexOf('|');
    const payeeType = k.substring(0, firstDash), key = k.substring(firstDash+1, lastDash), fy = k.substring(lastDash+1);
    const statement = buildSection149EmployeeStatement_(ctx, key, payeeType, fy);
    const unrecorded = statement.transactions.filter(t =>
      t.method === 'slab' && t.countsTowardThreshold && t.isPaid && !t.creditRecorded);
    checkedTransactionCount += unrecorded.length;
    if (!unrecorded.length) return;
    const totalActualTax = round0_(unrecorded.reduce((s,t) => s + t.actualTax, 0));
    const totalCorrectTax = round0_(unrecorded.reduce((s,t) => s + t.correctTax, 0));
    employees.push({
      payeeType, key, fy, name: unrecorded[0].name,
      transactions: unrecorded, totalActualTax, totalCorrectTax,
      netAdjustment: round0_(totalActualTax - totalCorrectTax) // positive = credit owed to employee; negative = outstanding owed by them
    });
  });

  return {
    employees, checkedTransactionCount,
    totalNetAdjustment: round0_(employees.reduce((s,g) => s + g.netAdjustment, 0)),
    affectedCount: employees.filter(g => g.netAdjustment !== 0).length
  };
}

// Admin-only: every employee currently holding an outstanding Section 149 credit or due.
function listSection149CreditBalances(actorUsername) {
  requireAdmin_(actorUsername);
  return getTable(SHEETS.S149CREDITS).filter(r => round0_(r.CreditAmount) !== 0)
    .map(r => ({ key:r.Key, payeeType:r.PayeeType, fy:r.FY, creditAmount: round0_(r.CreditAmount), notes:r.Notes, lastUpdated:r.LastUpdated }))
    .sort((a,b) => Math.abs(b.creditAmount) - Math.abs(a.creditAmount));
}

/* ================= SECTION 149: Tax Deduction Statement ================= */
function getSection149TaxDeductionStatement(key, payeeType, fy, actorUsername) {
  requireReportsAccess_(actorUsername);
  key = String(key||'').trim();
  if (!key) return { success:false, message:'Enter an Employee ID / CNIC.' };
  const ctx = loadSection149BatchContext_();
  const statement = buildSection149EmployeeStatement_(ctx, key, payeeType, fy);
  if (!statement.transactions.length) {
    return { success:false, message:'No income-tax-bearing Section 149/153(1)(b)/156 transactions found for this person in this FY.' };
  }
  let displayName = statement.transactions[statement.transactions.length-1].name;
  let designation = '';
  if (payeeType === 'Employee') {
    const emp = getEmployeeById(key);
    if (emp) { displayName = emp.Name; designation = emp.Designation || ''; }
  }
  return { success:true, displayName, designation, statement };
}

/* ================= SECTION 149: manual income inclusion/exclusion override ================= */
function getSection149IncomeItems(key, payeeType, fy, actorUsername) {
  requireAdmin_(actorUsername);
  key = String(key||'').trim();
  if (!key) return [];
  const keyLower = key.toLowerCase();
  const manualExclusions = getTable(SHEETS.S149EXCLUSIONS).filter(r =>
    String(r.Key).trim().toLowerCase() === keyLower && r.PayeeType === payeeType && fyMatches_(r.FY, fy));
  const manualByItemId = {};
  manualExclusions.forEach(r => { manualByItemId[String(r.ItemID).trim()] = { excluded: (r.Excluded===true||r.Excluded==='TRUE'||r.Excluded==='true'), reason:r.Reason }; });

  const items = [];
  getTable(SHEETS.ENTRIES).filter(e =>
    fyMatches_(e.FY, fy) && e.PayeeType === payeeType && e.EmployeeCategory &&
    ((payeeType === 'Employee' && String(e.EmployeeID).trim().toLowerCase() === keyLower) ||
     (payeeType === 'NonUEEmployee' && String(e.CNIC_NTN).trim().toLowerCase() === keyLower))
  ).forEach(e => {
    const itemId = e.EntryID;
    const manual = manualByItemId[itemId];
    items.push({
      itemId, source:'single', billId: e.EntryID, date: e.EntryDate, status: e.Status, billNature: e.BillNature,
      amount: Number(e.Amount||0), incomeTaxAmount: Number(e.IncomeTaxAmount||0),
      autoExcluded: statusEquals_(e.Status, STATUS.CANCELLED), autoExcludedReason: statusEquals_(e.Status, STATUS.CANCELLED) ? 'Cancelled' : '',
      manuallyExcluded: !!(manual && manual.excluded), manualReason: manual ? manual.reason : ''
    });
  });
  const bulkParentById = {};
  getTable(SHEETS.ENTRIES).filter(e => e.PayeeType === 'Bulk').forEach(e => bulkParentById[e.EntryID] = e);
  getTable(SHEETS.BULKITEMS).filter(li => {
    const parent = bulkParentById[li.ParentEntryID];
    if (!parent || !fyMatches_(parent.FY, fy)) return false;
    if (li.PayeeType !== payeeType) return false;
    const isTaxableNature = EMPLOYEE_149_CATEGORIES.indexOf(li.BillNature) !== -1 ||
      (payeeType === 'Employee' && UE_ONLY_TAXABLE_NATURES.indexOf(li.BillNature) !== -1);
    if (!isTaxableNature) return false;
    return (payeeType === 'Employee' && String(li.EmployeeID).trim().toLowerCase() === keyLower) ||
           (payeeType === 'NonUEEmployee' && String(li.CNIC_NTN).trim().toLowerCase() === keyLower);
  }).forEach(li => {
    const parent = bulkParentById[li.ParentEntryID];
    const itemId = li.ParentEntryID + '-' + li.LineNo;
    const manual = manualByItemId[itemId];
    const autoExcluded = statusEquals_(parent.Status, STATUS.CANCELLED) || !!li.RedirectedToEntryID;
    items.push({
      itemId, source:'bulk', billId: itemId, date: parent.EntryDate, status: parent.Status, billNature: li.BillNature,
      amount: Number(li.Amount||0), incomeTaxAmount: Number(li.IncomeTaxAmount||0),
      autoExcluded, autoExcludedReason: statusEquals_(parent.Status, STATUS.CANCELLED) ? 'Bulk bill Cancelled' : (li.RedirectedToEntryID ? 'Redirected to ' + li.RedirectedToEntryID : ''),
      manuallyExcluded: !!(manual && manual.excluded), manualReason: manual ? manual.reason : ''
    });
  });

  return items.sort((a,b) => new Date(a.date) - new Date(b.date));
}

/* ================= SECTION 149: redirect a Paid bill to the correct beneficiary =================
   For a Section 149 UE/Non-UE Employee bill PAID to the WRONG person by mistake: the original is
   excluded, the wrong beneficiary's own prior credit is returned, a new bill is created for the
   correct beneficiary (tax computed against THEIR own threshold), the two are cross-linked, and the
   tax already withheld under the wrong name is tracked as an FBR Tax Adjustment. Money already sent
   is NOT reversed by this system. */

// Splits a bulk-beneficiary ID like "E345-2" into ParentEntryID and LineNo. A plain bill ID "E345" and
// an isolated bill ID "E345-A" (a real bill of its own) both return null.
function parseBulkLineId_(id) {
  const s = String(id||'').trim();
  if (isSplitBillId_(s)) return null;
  const dashIdx = s.indexOf('-');
  if (dashIdx === -1) return null;
  const parentId = s.substring(0, dashIdx);
  const lineNo = s.substring(dashIdx + 1);
  if (!parentId || !lineNo) return null;
  return { parentId, lineNo };
}
// Updates ONE specific beneficiary line within a bulk bill (matches ParentEntryID + LineNo together).
function updateBulkLineItemByParentAndLineNo_(parentId, lineNo, updates) {
  const sh = getOrCreateSheet_(SHEETS.BULKITEMS);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const pCol = headers.indexOf('ParentEntryID'), lCol = headers.indexOf('LineNo');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][pCol]) === String(parentId) && String(values[i][lCol]) === String(lineNo)) {
      Object.keys(updates).forEach(col => {
        const cIdx = headers.indexOf(col);
        if (cIdx !== -1) sh.getRange(i+1, cIdx+1).setValue(updates[col]);
      });
      invalidateCache_(SHEETS.BULKITEMS);
      return true;
    }
  }
  return false;
}

function validateRedirectRequest_(originalEntryId, correctBeneficiary) {
  const bulkRef = parseBulkLineId_(originalEntryId);

  if (bulkRef) {
    const parent = getTable(SHEETS.ENTRIES).find(e => e.EntryID === bulkRef.parentId && e.PayeeType === 'Bulk');
    if (!parent) return { error:'Bulk bill ' + bulkRef.parentId + ' not found.' };
    if (!statusEquals_(parent.Status, STATUS.PAID)) {
      return { error:'This bulk bill is at "' + parent.Status + '", not Paid - this tool is only for bills already Paid.' };
    }
    const line = getTable(SHEETS.BULKITEMS).find(li => li.ParentEntryID === bulkRef.parentId && String(li.LineNo) === String(bulkRef.lineNo));
    if (!line) return { error:'Beneficiary line ' + bulkRef.lineNo + ' was not found in bulk bill ' + bulkRef.parentId + '.' };
    if (line.RedirectedToEntryID) return { error:'This beneficiary line has already been redirected, to Bill ' + line.RedirectedToEntryID + '.' };
    if (line.SplitToEntryID) return { error:'This beneficiary line was isolated into its own bill ' + line.SplitToEntryID + ' - redirect that bill instead.' };
    if (line.PayeeType !== 'Employee') {
      return { error:'This tool only supports UE Employee lines within a bulk bill (a bulk Non-UE Employee line does not retain enough information to safely redirect automatically) - correct it manually instead.' };
    }
    const isTaxableNature = EMPLOYEE_149_CATEGORIES.indexOf(line.BillNature) !== -1 || UE_ONLY_TAXABLE_NATURES.indexOf(line.BillNature) !== -1;
    if (!isTaxableNature) return { error:'This beneficiary line was not a taxable Section 149 nature.' };

    const existing = {
      EntryID: originalEntryId, PayeeType: 'Employee', EmployeeID: line.EmployeeID, CNIC_NTN: line.CNIC_NTN,
      VendorName: line.VendorName, Amount: Number(line.Amount||0), IncomeTaxAmount: Number(line.IncomeTaxAmount||0),
      Section149CreditApplied: Number(line.Section149CreditApplied||0), NetAmount: Number(netOf_(line)),
      FY: parent.FY, BillNature: line.BillNature, ExamSubCategory: line.ExamSubCategory||'', NonUETaxMethod: '',
      EmployeeCategory: line.BillNature, IncomeTaxSection: '149 - Salary (Slab)'
    };
    const correctPayeeType = correctBeneficiary.payeeType || existing.PayeeType;
    if (correctPayeeType === 'Employee' && String(existing.EmployeeID||'').trim().toLowerCase() === String(correctBeneficiary.employeeId||'').trim().toLowerCase()) {
      return { error:'The correct beneficiary is the same person as this line - nothing to redirect.' };
    }
    return { existing, correctPayeeType, isBulkLine:true, bulkParent: parent, bulkLine: line, bulkRef };
  }

  const existing = getTable(SHEETS.ENTRIES).find(e => e.EntryID === originalEntryId);
  if (!existing) return { error:'Original bill not found.' };
  if (!statusEquals_(existing.Status, STATUS.PAID)) {
    return { error:'This tool is only for bills already Paid - for anything still Received/Processed/Passed, use Edit or Cancel instead.' };
  }
  if (existing.PayeeType !== 'Employee' && existing.PayeeType !== 'NonUEEmployee') {
    return { error:'This tool only supports UE/Non-UE Employee bills (Section 149).' };
  }
  if (!existing.EmployeeCategory || String(existing.IncomeTaxSection||'').indexOf('149') !== 0) {
    return { error:'This bill was not taxed under the Section 149 slab system - correct it manually instead.' };
  }
  if (existing.RedirectedToEntryID) {
    return { error:'This bill has already been redirected, to Bill ' + existing.RedirectedToEntryID + '.' };
  }
  const correctPayeeType = correctBeneficiary.payeeType || existing.PayeeType;
  if (correctPayeeType === existing.PayeeType) {
    const existingKey = existing.PayeeType === 'Employee' ? existing.EmployeeID : existing.CNIC_NTN;
    const newKey = correctPayeeType === 'Employee' ? correctBeneficiary.employeeId : correctBeneficiary.cnic;
    if (String(existingKey||'').trim() && String(existingKey||'').trim().toLowerCase() === String(newKey||'').trim().toLowerCase()) {
      return { error:'The correct beneficiary is the same person as the original bill - nothing to redirect.' };
    }
  }
  return { existing, correctPayeeType, isBulkLine:false };
}
// Shared by preview and apply - never writes anything itself.
function computeBillRedirect_(existing, correctPayeeType, correctBeneficiary) {
  let correctName, correctCnic, correctIban, correctBank, correctDesignation = '';
  if (correctPayeeType === 'Employee') {
    const emp = getEmployeeById(correctBeneficiary.employeeId);
    if (!emp) return { error:'Correct beneficiary Employee ID not found - add them first (Admin > Employees).' };
    correctName = emp.Name; correctCnic = emp.CNIC; correctIban = emp.IBAN; correctBank = emp.BankName; correctDesignation = emp.Designation || '';
  } else {
    if (!correctBeneficiary.cnic || !correctBeneficiary.name) return { error:'CNIC and Name are required for a Non-UE correct beneficiary.' };
    if (!isValidCnicFormat_(correctBeneficiary.cnic)) return { error: 'CNIC must be in the format 35201-1222334-4.' };
    correctName = correctBeneficiary.name; correctCnic = correctBeneficiary.cnic;
    correctIban = correctBeneficiary.iban || ''; correctBank = correctBeneficiary.bankName || '';
  }
  const gross = Number(existing.Amount || 0);
  const nonUeTaxMethod = correctPayeeType === 'NonUEEmployee'
    ? (correctBeneficiary.nonUeTaxMethod === 'Section153_1b' ? 'Section153_1b' : 'Section149')
    : existing.NonUETaxMethod;
  if (correctPayeeType === 'NonUEEmployee' && nonUeTaxMethod === 'Section153_1b' &&
      correctBeneficiary.fbrStatus !== 'Filer' && correctBeneficiary.fbrStatus !== 'NonFiler') {
    return { error: 'Select the correct beneficiary\'s Taxpayer Status (Active/Inactive) for Section 153(1)(b).' };
  }
  const tax = computeTaxes_({
    grossAmount: gross, billNature: existing.BillNature, payeeType: correctPayeeType,
    fy: existing.FY, employeeId: correctBeneficiary.employeeId, cnic: correctCnic,
    examSubCategory: existing.ExamSubCategory, affidavitLowIncome: !!correctBeneficiary.affidavitLowIncome,
    applyIncomeTax: true, nonUeTaxMethod: nonUeTaxMethod, fbrStatus: correctBeneficiary.fbrStatus || 'NonFiler'
  });
  const wrongKey = existing.PayeeType === 'Employee' ? existing.EmployeeID : existing.CNIC_NTN;
  // Only the wrong beneficiary's OWN prior credit is refunded to them; the Income Tax actually
  // withheld under their name on THIS bill is tracked as an FBR Tax Adjustment instead.
  const creditToWrongBeneficiary = round0_(Number(existing.Section149CreditApplied || 0));
  const fbrAdjustmentAmount = round0_(Number(existing.IncomeTaxAmount || 0));
  return { correctName, correctCnic, correctIban, correctBank, correctDesignation, gross, tax, wrongKey,
    creditToWrongBeneficiary, fbrAdjustmentAmount };
}
function previewBillRedirect(originalEntryId, correctBeneficiary, username) {
  requireAdmin_(username);
  const v = validateRedirectRequest_(originalEntryId, correctBeneficiary);
  if (v.error) return { success:false, message: v.error };
  const calc = computeBillRedirect_(v.existing, v.correctPayeeType, correctBeneficiary);
  if (calc.error) return { success:false, message: calc.error };
  const existing = v.existing;
  return { success:true,
    original: { entryId: existing.EntryID, name: existing.VendorName, gross: Number(existing.Amount||0),
      oldTax: Number(existing.IncomeTaxAmount||0), oldNet: Number(netOf_(existing)), fy: existing.FY },
    correct: { name: calc.correctName, cnic: calc.correctCnic, payeeType: v.correctPayeeType },
    creditToWrongBeneficiary: calc.creditToWrongBeneficiary,
    fbrAdjustmentAmount: calc.fbrAdjustmentAmount,
    newIncomeTaxSection: calc.tax.incomeTaxSection, newIncomeTax: calc.tax.incomeTaxAmount, newNet: calc.tax.netAmount
  };
}
function applyBillRedirect(originalEntryId, correctBeneficiary, username) {
  requireAdmin_(username);
  const v = validateRedirectRequest_(originalEntryId, correctBeneficiary);
  if (v.error) return { success:false, message: v.error };
  const existing = v.existing, correctPayeeType = v.correctPayeeType;
  const meta = v.isBulkLine ? v.bulkParent : existing;
  return withLock_(() => {
    const calc = computeBillRedirect_(existing, correctPayeeType, correctBeneficiary);
    if (calc.error) return { success:false, message: calc.error };
    const { correctName, correctCnic, correctIban, correctBank, correctDesignation, gross, tax, wrongKey, creditToWrongBeneficiary, fbrAdjustmentAmount } = calc;

    // ---- 1: exclude the original FIRST (rolled back if the budget check below fails) ----
    let rollback;
    if (v.isBulkLine) {
      const freshParent = getTable(SHEETS.ENTRIES).find(e => e.EntryID === v.bulkRef.parentId);
      const priorAmount = Number(freshParent.Amount||0), priorTax = Number(freshParent.IncomeTaxAmount||0), priorNet = Number(netOf_(freshParent));
      updateBulkLineItemByParentAndLineNo_(v.bulkRef.parentId, v.bulkRef.lineNo, {
        RedirectedBy: username, RedirectedDate: new Date()
      });
      updateRowByKey(SHEETS.ENTRIES, 'EntryID', v.bulkRef.parentId, {
        Amount: round0_(priorAmount - existing.Amount),
        IncomeTaxAmount: round0_(priorTax - existing.IncomeTaxAmount),
        NetAmount: round0_(priorNet - existing.NetAmount)
      });
      rollback = () => {
        updateBulkLineItemByParentAndLineNo_(v.bulkRef.parentId, v.bulkRef.lineNo, { RedirectedBy:'', RedirectedDate:'' });
        updateRowByKey(SHEETS.ENTRIES, 'EntryID', v.bulkRef.parentId, { Amount: priorAmount, IncomeTaxAmount: priorTax, NetAmount: priorNet });
      };
    } else {
      updateRowByKey(SHEETS.ENTRIES, 'EntryID', originalEntryId, {
        Status: STATUS.CANCELLED, CancelledBy: username, CancelledDate: new Date(),
        CancellationReason: 'Redirected to correct beneficiary (' + correctName + ') - originally paid to ' + existing.VendorName + ' in error.',
        StatusBeforeCancellation: existing.Status
      });
      rollback = () => {
        updateRowByKey(SHEETS.ENTRIES, 'EntryID', originalEntryId, {
          Status: existing.Status, CancelledBy:'', CancelledDate:'', CancellationReason:'', StatusBeforeCancellation:''
        });
      };
    }

    const budgetStatus = getBudgetStatus(meta.CampusID, meta.HeadID, meta.FY);
    if (budgetStatus.hasAllocation && gross > budgetStatus.remaining && isBudgetImpacting_(existing.BillNature)) {
      rollback();
      return { success:false, message:'Budget exceeded for this head - remaining balance (after excluding the original wrongly-paid bill) is only ' + budgetStatus.remaining.toLocaleString() + '. Adjust the allocation first, then try again.' };
    }

    // ---- 2: refund the wrong beneficiary's OWN prior credit only ----
    if (creditToWrongBeneficiary > 0) {
      adjustSection149CreditBalance_(wrongKey, existing.PayeeType, existing.FY, creditToWrongBeneficiary,
        'Own prior credit returned - bill ' + originalEntryId + ' redirected to correct beneficiary');
    }

    // ---- 3 & 4: fresh bill for the correct beneficiary, cross-linked ----
    const newId = nextId_('E', SHEETS.ENTRIES, 'EntryID');
    const newRowObj = {
      EntryID:newId, Timestamp:new Date(), EntryDate: fmtDate_(new Date()), FY: existing.FY,
      CampusID: meta.CampusID, CampusName: meta.CampusName,
      HeadID: meta.HeadID, HeadCode: meta.HeadCode, HeadName: meta.HeadName,
      PayeeType: correctPayeeType, EmployeeID: correctPayeeType==='Employee' ? correctBeneficiary.employeeId : '',
      VendorName: correctName, CNIC_NTN: correctCnic, IBAN: correctIban, Amount: gross,
      BillDescription: '[Redirected from ' + originalEntryId + ' - paid to wrong beneficiary in error] ' + (existing.BillDescription||meta.BillDescription||''),
      BillNo: meta.BillNo||'', EnteredBy: username, Status: STATUS.RECEIVED,
      ProcessedBy:'', ProcessedDate:'', PassedBy:'', PassedDate:'', PaidBy:'', PaidDate:'', BatchID:'',
      BillNature: existing.BillNature, RefundCategory:'', FBRStatus: existing.FBRStatus||'', ServiceCategory:'', TaxpayerType:'', PRAStatus:'',
      IncomeTaxSection: tax.incomeTaxSection, IncomeTaxRate: tax.incomeTaxRate, IncomeTaxAmount: tax.incomeTaxAmount,
      SalesTaxApplied:false, SalesTaxRate:0, SalesTaxAmount:0, PSTApplied:false, PSTRate:0, PSTAmount:0,
      SecurityApplied:false, SecurityMode:'', SecurityBasis:'', SecurityRate:0, SecurityAmount:0,
      PenaltyApplied:false, PenaltyMode:'', PenaltyBasis:'', PenaltyRate:0, PenaltyAmount:0,
      OtherDeductionApplied:false, OtherDeductionMode:'', OtherDeductionCategory:'', OtherDeductionBasis:'', OtherDeductionRate:0, OtherDeductionAmount:0,
      StudentDeductionApplied:false, StudentDeductionCategory:'', StudentDeductionBasis:'', StudentDeductionAmount:0,
      EmployeeCategory: existing.EmployeeCategory, ExamSubCategory: existing.ExamSubCategory||'',
      ThesisClass: existing.ThesisClass||'', ThesisStudentName: existing.ThesisStudentName||'',
      VisitingProgram: existing.VisitingProgram||'', VisitingSubject: existing.VisitingSubject||'', VisitingCrHrs: existing.VisitingCrHrs||'',
      VisitingRate: existing.VisitingRate||'', VisitingLectures: existing.VisitingLectures||'',
      BenevolentFundSubCategory: existing.BenevolentFundSubCategory||'',
      NonUETaxMethod: correctPayeeType==='NonUEEmployee' ? (existing.NonUETaxMethod||'Section149') : '',
      Designation: correctDesignation,
      PayFromAccountID: meta.PayFromAccountID||'', PayFromAccountLabel: meta.PayFromAccountLabel||'', PayFromAccountNumber: meta.PayFromAccountNumber||'',
      ReceivingOfficeID: meta.ReceivingOfficeID||'', ReceivingOffice: meta.ReceivingOffice||'',
      PSTInvoiceNo:'', VendorInvoiceDate:'', ContractCategory:'',
      ManualTaxOverride:false, ManualTaxSection:'', ManualTaxMode:'', ManualTaxRate:'', ManualTaxAmount:'',
      ManualSalesTaxOverride:false, SalesTaxMode:'', ManualPSTOverride:false, PSTMode:'',
      BudgetAllocatedAtEntry: budgetStatus.allocated, BudgetExpensesBeforeThisBill: budgetStatus.spent, BudgetAfterThisBill: budgetStatus.spent + gross,
      AffidavitLowIncome: !!correctBeneficiary.affidavitLowIncome,
      IncomeBeforeThisBill: tax.section149 ? tax.section149.incomeBefore : '',
      IncomeAfterThisBill: tax.section149 ? tax.section149.incomeAfter : '',
      Section149CreditApplied: tax.section149 ? tax.section149.creditApplied : 0,
      RedirectedFromEntryID: originalEntryId, RedirectedToEntryID:'',
      NetAmount: tax.netAmount
    };
    appendRowObj(SHEETS.ENTRIES, newRowObj);
    mirrorLogEntry_(correctPayeeType, newRowObj);
    if (v.isBulkLine) {
      updateBulkLineItemByParentAndLineNo_(v.bulkRef.parentId, v.bulkRef.lineNo, { RedirectedToEntryID: newId });
    } else {
      updateRowByKey(SHEETS.ENTRIES, 'EntryID', originalEntryId, { RedirectedToEntryID: newId });
    }
    if (tax.section149 && tax.section149.creditApplied > 0) {
      const correctKey = correctPayeeType === 'Employee' ? correctBeneficiary.employeeId : correctCnic;
      adjustSection149CreditBalance_(correctKey, correctPayeeType, existing.FY, -tax.section149.creditApplied, 'Consumed by redirected bill ' + newId);
    }
    if (correctPayeeType === 'NonUEEmployee') {
      upsertNonUEEmployee_({ cnic:correctCnic, name:correctName, iban:correctIban, bankName:correctBank });
    }
    // ---- 5: record the FBR Tax Adjustment for the IBFT/Payment user ----
    if (fbrAdjustmentAmount > 0) {
      const depositStatus = existing.PaymentStatus === 'Confirmed' ? 'Deposited' : 'NotYetDeposited';
      appendRowObj(SHEETS.FBRTAXADJUSTMENTS, {
        AdjustmentID: nextId_('FA', SHEETS.FBRTAXADJUSTMENTS, 'AdjustmentID'),
        WrongBeneficiaryKey: wrongKey, WrongBeneficiaryName: existing.VendorName, WrongBeneficiaryPayeeType: existing.PayeeType,
        OriginalEntryID: originalEntryId, RedirectedToEntryID: newId, TaxAmount: fbrAdjustmentAmount, AmountAdjusted: 0,
        DepositStatus: depositStatus, Status: 'Open', CreatedDate: new Date(), CreatedBy: username,
        Notes: '', LastAdjustedDate: '', LastAdjustedBy: ''
      });
    }
    invalidateCache_(SHEETS.ENTRIES);
    invalidateCache_(SHEETS.BULKITEMS);
    return { success:true, originalEntryId, newEntryId:newId, creditToWrongBeneficiary, fbrAdjustmentAmount,
      wrongBeneficiary: existing.VendorName, correctBeneficiary: correctName,
      gross, newIncomeTax: tax.incomeTaxAmount, newNet: tax.netAmount };
  });
}

/* ================= FBR TAX ADJUSTMENTS (IBFT/Payment user) ================= */
function getFBRTaxAdjustments(filters, actorUsername) {
  requireRole_(actorUsername, ['IBFT']);
  filters = filters || {};
  let rows = getTable(SHEETS.FBRTAXADJUSTMENTS);
  if (!filters.includeResolved) rows = rows.filter(r => r.Status !== 'Resolved');
  if (filters.depositStatus) rows = rows.filter(r => r.DepositStatus === filters.depositStatus);
  return rows.map(r => ({
    adjustmentId: r.AdjustmentID, wrongBeneficiaryName: r.WrongBeneficiaryName, wrongBeneficiaryKey: r.WrongBeneficiaryKey,
    payeeType: r.WrongBeneficiaryPayeeType, originalEntryId: r.OriginalEntryID, redirectedToEntryId: r.RedirectedToEntryID,
    taxAmount: Number(r.TaxAmount||0), amountAdjusted: Number(r.AmountAdjusted||0),
    remaining: round0_(Number(r.TaxAmount||0) - Number(r.AmountAdjusted||0)),
    depositStatus: r.DepositStatus, status: r.Status, createdDate: r.CreatedDate, notes: r.Notes
  })).sort((a,b) => new Date(b.createdDate) - new Date(a.createdDate));
}
// amount: how much was just reconciled with FBR this time (partial amounts are fine).
function recordFBRTaxAdjustment(adjustmentId, amount, notes, username) {
  requireRole_(username, ['IBFT']);
  const amt = round0_(amount);
  if (!amt || amt <= 0) return { success:false, message:'Enter a valid adjustment amount.' };
  return withLock_(() => {
    const row = getTable(SHEETS.FBRTAXADJUSTMENTS).find(r => r.AdjustmentID === adjustmentId);
    if (!row) return { success:false, message:'Adjustment record not found.' };
    if (row.Status === 'Resolved') return { success:false, message:'This adjustment is already fully resolved.' };
    const newAdjusted = round0_(Number(row.AmountAdjusted||0) + amt);
    if (newAdjusted > Number(row.TaxAmount||0)) {
      return { success:false, message:'That would adjust more than the ' + Number(row.TaxAmount||0).toLocaleString() + ' actually owed - enter the remaining amount instead.' };
    }
    const newStatus = newAdjusted >= Number(row.TaxAmount||0) ? 'Resolved' : 'PartiallyResolved';
    updateRowByKey(SHEETS.FBRTAXADJUSTMENTS, 'AdjustmentID', adjustmentId, {
      AmountAdjusted: newAdjusted, Status: newStatus, LastAdjustedDate: new Date(), LastAdjustedBy: username,
      Notes: (row.Notes ? row.Notes + ' | ' : '') + (notes || ('Adjusted ' + amt))
    });
    appendRowObj(SHEETS.PAYMENTCONFIRM, {
      ConfirmationID: nextConfirmationId_(), EntryID: row.OriginalEntryID, BatchID: '',
      EventType: newStatus === 'Resolved' ? 'Reconciled' : 'PartiallyReconciled', EventDate: new Date(), LoggedBy: username,
      Notes: 'FBR tax adjustment: ' + num_(amt) + ' reconciled (' + num_(newAdjusted) + ' of ' + num_(Number(row.TaxAmount||0)) + ' total).' + (notes ? ' ' + notes : '')
    });
    return { success:true, newAdjusted, status: newStatus };
  });
}
function num_(n) { return Math.round(Number(n)||0).toLocaleString(); }


/* =====================================================================
   DUPLICATE PAYMENT RECOVERY
   ---------------------------------------------------------------------
   For money that was paid to a beneficiary TWICE by mistake outside this
   system (e.g. a bank batch run twice). Admin registers the affected paid
   bills/lines (Admin > Recover Duplicate Payments). From then on, every
   new bill for the same beneficiary automatically has the outstanding
   amount deducted from its NET amount (after tax - tax is unaffected),
   bill after bill, until fully recovered.
   Nothing here touches the original bill, the budget, or any report
   figure of the original bill - it only reduces the Net Amount of FUTURE
   bills. The "recovered so far" figure is always derived live from the
   bills that actually carry a deduction, so Cancelling/Deleting such a bill
   automatically puts its deduction back as outstanding.
   ===================================================================== */
function normIban_(v) { return String(v || '').replace(/\s+/g, '').toUpperCase(); }

// Who is this beneficiary? Employee ID / Student ID, otherwise CNIC-NTN, otherwise name; IBAN is a second way to match.
function recoveryIdentity_(p) {
  p = p || {};
  const t = p.payeeType || 'Vendor';
  let key = '';
  if (t === 'Employee') {
    const id = String(p.employeeId || '').trim().toLowerCase();
    key = id ? 'emp|' + id : '';
  } else if (t === 'Student') {
    const id = String(p.studentId || '').trim().toLowerCase();
    key = id ? 'stu|' + id : '';
  } else {
    const c = String(p.cnic || '').trim().toLowerCase();
    const n = String(p.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    key = c ? 'cnic|' + c : (n ? 'name|' + n : '');
  }
  return { key: key, iban: normIban_(p.iban) };
}

// A deduction counts only while the bill that carries it still exists and is not Cancelled.
function recoveryAppIsActive_(app, entriesById) {
  if (String(app.Status) === 'Reversed') return false;
  const id = String(app.EntryID);
  let e = entriesById[id];
  if (!e) {
    const ref = parseBulkLineId_(id);
    if (ref) e = entriesById[ref.parentId];
  }
  if (!e) return false;
  return !statusEquals_(e.Status, STATUS.CANCELLED);
}

// Sum (and list) of deductions actually in force, per recovery record.
function buildRecoveryActiveApps_(excludeEntryId) {
  const sums = {}, byRecovery = {};
  const apps = getTable(SHEETS.DUPRECAPP);
  if (!apps.length) return { sums: sums, byRecovery: byRecovery };
  const entriesById = {};
  getTable(SHEETS.ENTRIES).forEach(e => { entriesById[e.EntryID] = e; });
  apps.forEach(a => {
    if (excludeEntryId && String(a.EntryID) === String(excludeEntryId)) return;
    if (!recoveryAppIsActive_(a, entriesById)) return;
    const rid = a.RecoveryID;
    sums[rid] = (sums[rid] || 0) + Number(a.Amount || 0);
    (byRecovery[rid] || (byRecovery[rid] = [])).push({ entryId: a.EntryID, amount: Number(a.Amount || 0), date: a.AppliedDate });
  });
  return { sums: sums, byRecovery: byRecovery };
}

// A "session" loads the recovery data once and lets several bills (e.g. the rows of a bulk file) draw it down in turn.
function newRecoverySession_(excludeEntryId) {
  return { excludeEntryId: excludeEntryId || '', loaded: false, recoveries: [], outstanding: {}, used: {} };
}
function loadRecoverySession_(s) {
  if (s.loaded) return;
  s.loaded = true;
  s.recoveries = getTable(SHEETS.DUPREC).filter(r => String(r.Status) !== 'Cancelled');
  if (!s.recoveries.length) return;
  const act = buildRecoveryActiveApps_(s.excludeEntryId);
  s.recoveries.forEach(r => {
    s.outstanding[r.RecoveryID] = Math.max(0, round0_(Number(r.AmountPaidTwice || 0) - (act.sums[r.RecoveryID] || 0)));
  });
  s.recoveries.sort((a, b) => (new Date(a.CreatedDate) - new Date(b.CreatedDate)) || String(a.RecoveryID).localeCompare(String(b.RecoveryID), undefined, { numeric: true }));
}
function allocateRecovery_(session, identity, netBefore) {
  const none = { deducted: 0, allocations: [], balanceBefore: 0 };
  netBefore = round0_(netBefore);
  if (netBefore <= 0 || (!identity.key && !identity.iban)) return none;
  loadRecoverySession_(session);
  if (!session.recoveries.length) return none;
  const matching = session.recoveries.filter(r =>
    (identity.key && String(r.BeneficiaryKey) === identity.key) ||
    (identity.iban && normIban_(r.IBAN) === identity.iban));
  let balance = 0;
  const avail = {};
  matching.forEach(r => {
    avail[r.RecoveryID] = Math.max(0, (session.outstanding[r.RecoveryID] || 0) - (session.used[r.RecoveryID] || 0));
    balance += avail[r.RecoveryID];
  });
  let remainingNet = netBefore;
  const allocations = [];
  matching.forEach(r => {
    const a = avail[r.RecoveryID];
    if (a <= 0 || remainingNet <= 0) return;
    const take = Math.min(a, remainingNet);
    allocations.push({ recoveryId: r.RecoveryID, amount: take });
    remainingNet -= take;
  });
  return { deducted: netBefore - remainingNet, allocations: allocations, balanceBefore: balance };
}
function consumeRecoverySession_(session, allocations) {
  (allocations || []).forEach(a => { session.used[a.recoveryId] = (session.used[a.recoveryId] || 0) + a.amount; });
}
// Reduces tax.netAmount by whatever is owed back. Income/sales tax figures are left exactly as calculated.
function applyRecoveryToTax_(tax, payee, session) {
  const r = allocateRecovery_(session, recoveryIdentity_(payee), tax.netAmount);
  tax.netAmountBeforeRecovery = tax.netAmount;
  tax.recoveryBalanceBefore = r.balanceBefore;
  tax.recoveryDeducted = r.deducted;
  tax.recoveryAllocations = r.allocations;
  tax.netAmount = round0_(tax.netAmount - r.deducted);
  return tax;
}
// Called by the New Entry screen for the live preview (same maths as when the bill is saved).
function previewTaxCalculationWithRecovery(params) {
  const tax = computeTaxes_(params);
  applyRecoveryToTax_(tax, {
    payeeType: params.payeeType, employeeId: params.employeeId, studentId: params.studentId,
    cnic: params.cnic, name: params.vendorName, iban: params.iban
  }, newRecoverySession_(params.recoveryExcludeEntryId));
  return tax;
}

// Caller already holds the script lock (submitEntry / updateEntry / submitBulkEntry).
function saveRecoveryApplications_(entryId, allocations, username) {
  if (!allocations || !allocations.length) return;
  let max = 0;
  getTable(SHEETS.DUPRECAPP).forEach(r => {
    const n = parseInt(String(r.ApplicationID || '').replace('RA', ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  allocations.forEach(a => {
    appendRowObj(SHEETS.DUPRECAPP, {
      ApplicationID: 'RA' + (++max), RecoveryID: a.recoveryId, EntryID: entryId,
      Amount: a.amount, AppliedDate: new Date(), AppliedBy: username, Status: 'Active'
    });
  });
}
// Removes the deductions recorded against one bill (and, for a bulk bill, all its lines).
function deleteRecoveryApplicationsForBill_(entryId) {
  entryId = String(entryId);
  const sh = getOrCreateSheet_(SHEETS.DUPRECAPP);
  const values = sh.getDataRange().getValues();
  const c = values[0].indexOf('EntryID');
  if (c === -1) return;
  for (let i = values.length - 1; i >= 1; i--) {
    const id = String(values[i][c]);
    if (id === entryId || id.indexOf(entryId + '-') === 0) sh.deleteRow(i + 1);
  }
  invalidateCache_(SHEETS.DUPRECAPP);
}

/* ---------- Admin: find the paid bills/lines that were paid twice ---------- */
function buildRecoverySourceCtx_() {
  const entries = getTable(SHEETS.ENTRIES);
  const entriesById = {};
  entries.forEach(e => { entriesById[e.EntryID] = e; });
  let bulkCache = null;
  const registered = {};
  getTable(SHEETS.DUPREC).filter(r => String(r.Status) !== 'Cancelled').forEach(r => { registered[String(r.SourceEntryID)] = true; });
  return { entriesById: entriesById, registered: registered,
    bulkLines: () => (bulkCache || (bulkCache = getTable(SHEETS.BULKITEMS))) };
}
function recoveryItemFromEntry_(e) {
  return { sourceId: e.EntryID, name: e.VendorName, payeeType: e.PayeeType, employeeId: e.EmployeeID || '', studentId: e.StudentID || '',
    cnic: e.CNIC_NTN || '', iban: e.IBAN || '', netPaid: round0_(netOf_(e)), batchId: e.BatchID || '' };
}
function recoveryItemFromLine_(li, parent) {
  return { sourceId: li.ParentEntryID + '-' + li.LineNo, name: li.VendorName, payeeType: li.PayeeType, employeeId: li.EmployeeID || '',
    studentId: li.StudentID || '', cnic: li.CNIC_NTN || '', iban: li.IBAN || '', netPaid: round0_(netOf_(li)), batchId: parent.BatchID || '' };
}
// One Bill ID / Line ID -> the beneficiary payment(s) it stands for. A bulk bill's own ID gives every line.
function resolveRecoverySource_(id, ctx) {
  const out = { items: [], warnings: [] };
  const bulkRef = parseBulkLineId_(id);
  const baseId = bulkRef ? bulkRef.parentId : id;
  const e = ctx.entriesById[baseId];
  if (!e) { out.warnings.push(id + ': no such bill.'); return out; }
  if (!statusEquals_(e.Status, STATUS.PAID)) { out.warnings.push(id + ': is at "' + e.Status + '", not Paid - skipped.'); return out; }
  if (e.PayeeType === 'Bulk') {
    let lines = ctx.bulkLines().filter(li => li.ParentEntryID === baseId);
    if (bulkRef) lines = lines.filter(li => String(li.LineNo) === String(bulkRef.lineNo));
    if (!lines.length) out.warnings.push(id + ': no beneficiary lines found.');
    lines.forEach(li => {
      const lid = li.ParentEntryID + '-' + li.LineNo;
      if (li.RedirectedToEntryID) { out.warnings.push(lid + ': was redirected - skipped.'); return; }
      if (li.SplitToEntryID || li.LinePaymentStatus === 'Isolated' || li.LinePaymentStatus === 'Failed') { out.warnings.push(lid + ': its payment failed/was isolated - skipped.'); return; }
      out.items.push(recoveryItemFromLine_(li, e));
    });
  } else {
    if (bulkRef) { out.warnings.push(id + ': ' + baseId + ' is not a bulk bill.'); return out; }
    if (e.PaymentStatus === 'Failed') { out.warnings.push(id + ': its payment failed - skipped.'); return out; }
    out.items.push(recoveryItemFromEntry_(e));
  }
  return out;
}
// idsText: Bill IDs, bulk line IDs (E12-3) and/or Batch IDs (B7), separated by commas, spaces or new lines.
function lookupRecoverySources(idsText, actorUsername) {
  requireAdmin_(actorUsername);
  const tokens = String(idsText || '').split(/[\s,;]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!tokens.length) return { success: false, message: 'Enter at least one Bill ID or Batch ID.' };
  const ctx = buildRecoverySourceCtx_();
  const warnings = [];
  let ids = [];
  let batches = null;
  tokens.forEach(t => {
    if (/^B\d+$/.test(t)) {
      if (!batches) batches = getTable(SHEETS.BATCHES);
      const b = batches.find(x => String(x.BatchID).toUpperCase() === t);
      if (!b) { warnings.push(t + ': no such IBFT batch.'); return; }
      String(b.EntryIDs || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean).forEach(x => ids.push(x));
    } else {
      ids.push(t);
    }
  });
  ids = Array.from(new Set(ids));
  if (ids.length > 2000) return { success: false, message: 'Too many bills at once - please enter fewer.' };
  const items = [], seen = {};
  ids.forEach(id => {
    const r = resolveRecoverySource_(id, ctx);
    r.warnings.forEach(w => warnings.push(w));
    r.items.forEach(it => {
      if (seen[it.sourceId]) return;
      seen[it.sourceId] = true;
      it.alreadyRegistered = !!ctx.registered[it.sourceId];
      items.push(it);
    });
  });
  if (!items.length) return { success: false, message: warnings.join(' | ') || 'Nothing found.' };
  return { success: true, items: items, warnings: warnings };
}

// items: [{ sourceId, amount }] - who the beneficiary is is always re-read from the bill itself, never trusted from the browser.
function createDuplicateRecoveries(items, notes, actorUsername) {
  requireAdmin_(actorUsername);
  if (!Array.isArray(items) || !items.length) return { success: false, message: 'Nothing selected.' };
  return withLock_(() => {
    const ctx = buildRecoverySourceCtx_();
    let max = 0;
    getTable(SHEETS.DUPREC).forEach(r => {
      const n = parseInt(String(r.RecoveryID || '').replace('DR', ''), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    const skipped = [];
    let created = 0, totalAmount = 0;
    items.forEach(it => {
      const id = String(it.sourceId || '').trim().toUpperCase();
      const r = resolveRecoverySource_(id, ctx);
      if (r.items.length !== 1 || r.items[0].sourceId !== id) { skipped.push(id + ': ' + (r.warnings[0] || 'could not be verified as one paid payment.')); return; }
      const src = r.items[0];
      if (ctx.registered[id]) { skipped.push(id + ': a recovery is already registered for it.'); return; }
      const amount = round0_(it.amount);
      if (!(amount > 0)) { skipped.push(id + ': invalid amount.'); return; }
      if (amount > src.netPaid) { skipped.push(id + ': amount ' + amount.toLocaleString() + ' is more than the net paid (' + src.netPaid.toLocaleString() + ').'); return; }
      const ident = recoveryIdentity_(src);
      if (!ident.key && !ident.iban) { skipped.push(id + ': beneficiary cannot be identified (no ID, CNIC/NTN, name or IBAN).'); return; }
      appendRowObj(SHEETS.DUPREC, {
        RecoveryID: 'DR' + (++max), SourceEntryID: id, PayeeType: src.payeeType, BeneficiaryKey: ident.key,
        BeneficiaryName: src.name, EmployeeID: src.employeeId, CNIC_NTN: src.cnic, IBAN: normIban_(src.iban),
        SourceNetPaid: src.netPaid, AmountPaidTwice: amount, Notes: notes || '', Status: 'Open',
        CreatedBy: actorUsername, CreatedDate: new Date(), CancelledBy: '', CancelledDate: '', CancelReason: ''
      });
      ctx.registered[id] = true;
      created++; totalAmount += amount;
    });
    if (!created) return { success: false, message: skipped.join(' | ') || 'Nothing was registered.' };
    return { success: true, created: created, totalAmount: totalAmount, skipped: skipped };
  });
}

function getDuplicateRecoveries(filters, actorUsername) {
  requireAdmin_(actorUsername);
  filters = filters || {};
  const act = buildRecoveryActiveApps_('');
  const q = String(filters.query || '').trim().toLowerCase();
  let totalOutstanding = 0;
  let rows = getTable(SHEETS.DUPREC).map(r => {
    const paid = Number(r.AmountPaidTwice || 0);
    const recovered = act.sums[r.RecoveryID] || 0;
    const cancelled = String(r.Status) === 'Cancelled';
    const outstanding = cancelled ? 0 : Math.max(0, paid - recovered);
    return { recoveryId: r.RecoveryID, sourceEntryId: r.SourceEntryID, name: r.BeneficiaryName, payeeType: r.PayeeType,
      iban: r.IBAN, amountPaidTwice: paid, recovered: recovered, outstanding: outstanding,
      status: cancelled ? 'Cancelled' : (outstanding > 0 ? 'Open' : 'Recovered'),
      createdDate: r.CreatedDate, createdBy: r.CreatedBy, notes: r.Notes, cancelReason: r.CancelReason,
      applications: act.byRecovery[r.RecoveryID] || [] };
  });
  rows.forEach(r => { totalOutstanding += r.outstanding; });
  if (filters.status) rows = rows.filter(r => r.status === filters.status);
  if (q) rows = rows.filter(r => String(r.name).toLowerCase().includes(q) || String(r.sourceEntryId).toLowerCase().includes(q) ||
    String(r.iban).toLowerCase().includes(q) || String(r.recoveryId).toLowerCase().includes(q));
  rows.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  return { success: true, rows: rows, totalOutstanding: totalOutstanding };
}

// Stops any further deduction. Amounts already deducted from earlier bills stay deducted.
function cancelDuplicateRecovery(recoveryId, reason, actorUsername) {
  requireAdmin_(actorUsername);
  return withLock_(() => {
    const r = getTable(SHEETS.DUPREC).find(x => x.RecoveryID === recoveryId);
    if (!r) return { success: false, message: 'Recovery record not found.' };
    if (String(r.Status) === 'Cancelled') return { success: false, message: 'Already cancelled.' };
    updateRowByKey(SHEETS.DUPREC, 'RecoveryID', recoveryId, {
      Status: 'Cancelled', CancelledBy: actorUsername, CancelledDate: new Date(), CancelReason: reason || ''
    });
    return { success: true };
  });
}


/* =====================================================================
   SAFE BULK SAVING + SPEED HELPERS
   ===================================================================== */
// Writes many rows to a sheet in ONE operation (instead of one appendRow per row).
function appendRowsBatch_(sheetName, rowObjs) {
  if (!rowObjs || !rowObjs.length) return;
  const sh = getOrCreateSheet_(sheetName);
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const rows = rowObjs.map(o => headers.map(h => (h && o[h] !== undefined) ? o[h] : ''));
  const start = sh.getLastRow() + 1;
  const needed = start + rows.length - 1;
  if (sh.getMaxRows() < needed) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows());
  [CNIC_COLUMNS[sheetName], IBAN_COLUMNS[sheetName]].forEach(colName => {
    const idx = colName ? headers.indexOf(colName) : -1;
    if (idx !== -1) sh.getRange(start, idx + 1, rows.length, 1).setNumberFormat('@');
  });
  sh.getRange(start, 1, rows.length, headers.length).setValues(rows);
  SpreadsheetApp.flush();
  invalidateCache_(sheetName);
}

// Same upload arriving twice (double click, retry after a dropped connection)? Identified by a fingerprint of its content.
function computeBulkFingerprint_(parentMeta, lineItems) {
  const m = parentMeta || {};
  const payload = JSON.stringify({
    d: [m.diaryId || ''].concat((m.extraDiaryIds || []).slice().sort()), b: m.diaryBypassReason || '',
    c: m.campusId, h: m.headId, fy: m.fy, bn: m.billNo || '', bd: m.billDescription || '',
    pa: m.payFromAccountId || '', ro: m.receivingOfficeId || '', pi: m.pstInvoiceNo || '', vd: m.vendorInvoiceDate || '',
    lines: lineItems || []
  });
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload);
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}
// Looks for a bulk bill saved in the last 24 hours (and not cancelled) with the same fingerprint. Reads only the few columns needed.
function findBulkByFingerprint_(fp) {
  const sh = getOrCreateSheet_(SHEETS.ENTRIES);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const cFp = headers.indexOf('UploadFingerprint');
  if (cFp === -1) return null;
  const read = n => sh.getRange(2, headers.indexOf(n) + 1, last - 1, 1).getValues();
  const fps = read('UploadFingerprint');
  const hits = [];
  for (let i = 0; i < fps.length; i++) if (fps[i][0] === fp) hits.push(i);
  if (!hits.length) return null;
  const ids = read('EntryID'), ts = read('Timestamp'), st = read('Status'), amt = read('Amount'), net = read('NetAmount'), vn = read('VendorName');
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (let k = hits.length - 1; k >= 0; k--) {
    const i = hits[k];
    const t = new Date(ts[i][0]);
    if (isNaN(t) || t.getTime() < cutoff) continue;
    if (statusEquals_(st[i][0], STATUS.CANCELLED)) continue;
    return { EntryID: ids[i][0], Amount: Number(amt[i][0] || 0), NetAmount: Number(net[i][0] || 0), VendorName: vn[i][0] };
  }
  return null;
}
function duplicateBulkReply_(ex) {
  const m = String(ex.VendorName || '').match(/(\d+)/);
  return { success: true, duplicate: true, entryId: ex.EntryID, totalGross: ex.Amount, totalNet: ex.NetAmount, lineCount: m ? Number(m[1]) : 0,
    message: 'This exact upload was already saved as Bill ' + ex.EntryID + ' - nothing was saved again.' };
}
// If an earlier attempt was cut off just before the Diary link, the retry completes that link.
function repairBulkDiaryLinks_(parentMeta, entryId) {
  [parentMeta.diaryId].concat(parentMeta.extraDiaryIds || []).forEach(did => {
    did = String(did || '').trim();
    if (!did) return;
    const d = getDiaryById(did);
    if (d && d.ItemType === 'Bill' && d.Status === 'Pending' && !d.LinkedEntryID) linkDiaryToEntry_(did, entryId);
  });
}
// Reads the saved bill back: line count and totals must match what was meant to be saved.
function verifyBulkSaved_(id, expectedCount, expectedGross, expectedNet) {
  SpreadsheetApp.flush();
  const sh = getOrCreateSheet_(SHEETS.BULKITEMS);
  const values = sh.getDataRange().getValues();
  const h = values[0];
  const p = h.indexOf('ParentEntryID'), a = h.indexOf('Amount'), n = h.indexOf('NetAmount');
  let count = 0, gross = 0, net = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][p]) === id) { count++; gross += Number(values[i][a]) || 0; net += Number(values[i][n]) || 0; }
  }
  if (count !== expectedCount) return { ok: false, reason: 'expected ' + expectedCount + ' beneficiary lines but found ' + count };
  if (Math.round(gross) !== Math.round(expectedGross)) return { ok: false, reason: 'the saved lines do not add up to the bill total' };
  if (Math.round(net) !== Math.round(expectedNet)) return { ok: false, reason: 'the saved net amounts do not add up' };
  const es = getOrCreateSheet_(SHEETS.ENTRIES);
  const last = es.getLastRow();
  if (last < 2) return { ok: false, reason: 'the bill row is missing' };
  const eh = es.getRange(1, 1, 1, es.getLastColumn()).getValues()[0];
  const idCol = es.getRange(2, eh.indexOf('EntryID') + 1, last - 1, 1).getValues();
  const row = idCol.findIndex(r => String(r[0]) === id);
  if (row === -1) return { ok: false, reason: 'the bill row is missing' };
  const savedAmount = Number(es.getRange(row + 2, eh.indexOf('Amount') + 1).getValue()) || 0;
  if (Math.round(savedAmount) !== Math.round(expectedGross)) return { ok: false, reason: 'the bill total was not saved correctly' };
  return { ok: true };
}
function rollbackBulkSave_(id) {
  try { deleteRowsByKey_(SHEETS.BULKITEMS, 'ParentEntryID', id); } catch (e) {}
  try { deleteRowsByKey_(SHEETS.ENTRIES, 'EntryID', id); } catch (e) {}
  try { deleteRecoveryApplicationsForBill_(id); } catch (e) {}
}

// Updates the saved Vendor / Non-UE / Student lists for a whole upload with one read and one write per list.
function upsertSheetBatch_(sheetName, keyCol, items) {
  if (!items.length) return;
  const sh = getOrCreateSheet_(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const kIdx = headers.indexOf(keyCol);
  if (kIdx === -1) return;
  const norm = v => String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  const index = {};
  for (let i = 1; i < values.length; i++) { const k = norm(values[i][kIdx]); if (k && index[k] === undefined) index[k] = i; }
  let changed = false;
  items.forEach(it => {
    const nk = norm(it.key);
    if (!nk) return;
    let ri = index[nk];
    if (ri === undefined) {
      const row = headers.map(() => '');
      row[kIdx] = it.key;
      Object.keys(it.create || {}).forEach(c => { const ci = headers.indexOf(c); if (ci !== -1) row[ci] = it.create[c]; });
      values.push(row);
      ri = values.length - 1;
      index[nk] = ri;
    }
    Object.keys(it.fields).forEach(c => { const ci = headers.indexOf(c); if (ci !== -1) values[ri][ci] = it.fields[c]; });
    changed = true;
  });
  if (!changed) return;
  if (sh.getMaxRows() < values.length) sh.insertRowsAfter(sh.getMaxRows(), values.length - sh.getMaxRows());
  [CNIC_COLUMNS[sheetName], IBAN_COLUMNS[sheetName]].forEach(colName => {
    const idx = colName ? headers.indexOf(colName) : -1;
    if (idx !== -1) sh.getRange(2, idx + 1, values.length - 1, 1).setNumberFormat('@');
  });
  sh.getRange(1, 1, values.length, headers.length).setValues(values);
  invalidateCache_(sheetName);
}
function upsertPayeesBatch_(resolved) {
  upsertSheetBatch_(SHEETS.VENDORS, 'VendorName', resolved.filter(r => r.payeeType === 'Vendor').map(r => ({
    key: r.name, fields: { CNIC_NTN: r.cnic, IBAN: r.iban, BankName: r.bank || '' }, create: { VendorName: r.name, Phone: '' } })));
  upsertSheetBatch_(SHEETS.NONUE, 'CNIC', resolved.filter(r => r.payeeType === 'NonUEEmployee' && String(r.cnic || '').trim()).map(r => ({
    key: r.cnic, fields: { Name: r.name || '', IBAN: r.iban || '', BankName: r.bank || '' }, create: { CNIC: r.cnic } })));
  upsertSheetBatch_(SHEETS.STUDENTS, 'StudentID', resolved.filter(r => r.payeeType === 'Student' && String(r.studentId || '').trim()).map(r => ({
    key: r.studentId, fields: { Name: r.name || '', CNIC: r.cnic || '', IBAN: r.iban || '', Program: r.program || '', Session: r.session || '', Shift: r.shift || '' },
    create: { StudentID: r.studentId } })));
}
// Many bills' recovery deductions in one write.
function saveRecoveryApplicationsMany_(items, username) {
  const pending = [];
  items.forEach(it => (it.allocations || []).forEach(a => pending.push({ entryId: it.entryId, a: a })));
  if (!pending.length) return;
  let max = 0;
  getTable(SHEETS.DUPRECAPP).forEach(r => { const n = parseInt(String(r.ApplicationID || '').replace('RA', ''), 10); if (!isNaN(n) && n > max) max = n; });
  appendRowsBatch_(SHEETS.DUPRECAPP, pending.map(p => ({
    ApplicationID: 'RA' + (++max), RecoveryID: p.a.recoveryId, EntryID: p.entryId, Amount: p.a.amount, AppliedDate: new Date(), AppliedBy: username, Status: 'Active' })));
}

// The FBR section a taxed line was calculated under. A blank section on a line that carries Income Tax is shown as such, never left empty.
function effectiveIncomeTaxSection_(rec) {
  const s = String(rec.IncomeTaxSection || '').trim();
  if (s) return s;
  if ((rec.ManualTaxOverride === true || rec.ManualTaxOverride === 'TRUE') && String(rec.ManualTaxSection || '').trim()) return String(rec.ManualTaxSection).trim();
  if (Number(rec.IncomeTaxAmount || 0) <= 0) return '';
  if (rec.BillNature === 'Supply') return '153(1)(a) - Supply of Goods';
  if (rec.BillNature === 'Contract') return '153(1)(c) - Execution of Contracts';
  if (rec.BillNature === 'Service') return '153(1)(b) - Services';
  return '(Section not recorded)';
}

/* =====================================================================
   ADMIN: MOVE A BILL TO ANOTHER COST CENTRE / BUDGET HEAD
   For a bill booked to the wrong campus/head (even a Paid one) - without cancelling and re-entering it. The bill keeps its ID,
   status and payment; only its budget booking moves. The Budget Control Register shows the original booking, a reversal in the
   old cost centre, and the booking in the new one. Every transfer is logged (who, when, why).
   ===================================================================== */
function validateCostCentreTransfer_(entryId, toCampusId, toHeadId) {
  const e = getTable(SHEETS.ENTRIES).find(x => x.EntryID === String(entryId || '').trim());
  if (!e) return { error: 'Bill not found.' };
  if (statusEquals_(e.Status, STATUS.CANCELLED)) return { error: 'This bill is cancelled - it is not booked to any budget.' };
  if (e.SplitFromEntryID) return { error: 'This is an isolated beneficiary bill - it is not charged to the budget itself (its parent bulk bill ' + e.SplitFromEntryID + ' is). Move the parent bill instead.' };
  if (e.HeadCode === '(Multiple)' || getTable(SHEETS.HEADSPLITS).some(sp => sp.ParentEntryID === e.EntryID)) {
    return { error: 'This bill is split across several budget heads - moving a multi-head bill is not supported here. Cancel and re-enter it instead.' };
  }
  if (!toCampusId || !toHeadId) return { error: 'Select the target campus and budget head.' };
  const toCampus = getCampuses().find(c => c.CampusID === toCampusId);
  if (!toCampus) return { error: 'Target campus not found.' };
  const toHead = getBudgetHeads().find(h => h.HeadID === toHeadId);
  if (!toHead) return { error: 'Target budget head not found.' };
  if (e.CampusID === toCampusId && e.HeadID === toHeadId) return { error: 'The bill is already booked to that campus and budget head.' };
  const fy = e.FY;
  const hasAlloc = getHeadsForCampus(toCampusId, fy).some(h => h.HeadID === toHeadId);
  if (!hasAlloc) return { error: 'The target campus has no allocation for ' + toHead.HeadCode + ' in ' + fy + ' - add the allocation first (Admin > Add / Assign Budget Code).' };
  const amount = Number(e.Amount || 0);
  const toStatus = getBudgetStatus(toCampusId, toHeadId, fy, e.EntryID);
  if (isBudgetImpacting_(e.BillNature) && toStatus.hasAllocation && amount > toStatus.remaining) {
    return { error: 'Budget exceeded at the target: remaining balance there is only ' + toStatus.remaining.toLocaleString() + ', the bill is ' + amount.toLocaleString() + '.' };
  }
  return { e: e, toCampus: toCampus, toHead: toHead, toStatus: toStatus, fromStatusWithout: getBudgetStatus(e.CampusID, e.HeadID, fy, e.EntryID), amount: amount, fy: fy };
}
function previewBillCostCenterTransfer(entryId, toCampusId, toHeadId, actorUsername) {
  requireAdmin_(actorUsername);
  const v = validateCostCentreTransfer_(entryId, toCampusId, toHeadId);
  if (v.error) return { success: false, message: v.error };
  const e = v.e;
  return { success: true, entryId: e.EntryID, status: e.Status, fy: v.fy, amount: v.amount,
    from: { campus: e.CampusName, head: e.HeadCode + ' - ' + e.HeadName, allocated: v.fromStatusWithout.allocated, spentAfterRemoval: v.fromStatusWithout.spent, remainingAfterRemoval: v.fromStatusWithout.remaining },
    to: { campus: v.toCampus.CampusName, head: v.toHead.HeadCode + ' - ' + v.toHead.HeadName, allocated: v.toStatus.allocated, spentBefore: v.toStatus.spent,
      spentAfter: v.toStatus.spent + v.amount, remainingAfter: v.toStatus.remaining - v.amount } };
}
function applyBillCostCenterTransfer(entryId, toCampusId, toHeadId, reason, actorUsername) {
  requireAdmin_(actorUsername);
  if (!String(reason || '').trim()) return { success: false, message: 'A reason is required.' };
  return withLock_(() => {
    const v = validateCostCentreTransfer_(entryId, toCampusId, toHeadId);
    if (v.error) return { success: false, message: v.error };
    const e = v.e;
    updateRowByKey(SHEETS.ENTRIES, 'EntryID', e.EntryID, {
      CampusID: toCampusId, CampusName: v.toCampus.CampusName, HeadID: toHeadId, HeadCode: v.toHead.HeadCode, HeadName: v.toHead.HeadName,
      BudgetAllocatedAtEntry: v.toStatus.allocated, BudgetExpensesBeforeThisBill: v.toStatus.spent, BudgetAfterThisBill: v.toStatus.spent + v.amount
    });
    appendRowObj(SHEETS.CCTRANSFERS, {
      TransferID: nextId_('CT', SHEETS.CCTRANSFERS, 'TransferID'), EntryID: e.EntryID, FY: v.fy, Amount: v.amount,
      FromCampusID: e.CampusID, FromCampusName: e.CampusName, FromHeadID: e.HeadID, FromHeadCode: e.HeadCode, FromHeadName: e.HeadName,
      ToCampusID: toCampusId, ToCampusName: v.toCampus.CampusName, ToHeadID: toHeadId, ToHeadCode: v.toHead.HeadCode, ToHeadName: v.toHead.HeadName,
      BillStatusAtTransfer: e.Status, Reason: String(reason).trim(), TransferredBy: actorUsername, TransferDate: new Date()
    });
    return { success: true, entryId: e.EntryID };
  });
}
function getBillTransfers_(entryId) {
  return getTable(SHEETS.CCTRANSFERS).filter(t => t.EntryID === entryId)
    .sort((a, b) => new Date(a.TransferDate) - new Date(b.TransferDate))
    .map(t => ({ transferId: t.TransferID, date: fmtDate_(t.TransferDate), amount: Number(t.Amount || 0),
      from: t.FromCampusName + ' / ' + t.FromHeadCode + ' - ' + t.FromHeadName, to: t.ToCampusName + ' / ' + t.ToHeadCode + ' - ' + t.ToHeadName,
      by: t.TransferredBy, reason: t.Reason, statusAtTransfer: t.BillStatusAtTransfer }));
}
