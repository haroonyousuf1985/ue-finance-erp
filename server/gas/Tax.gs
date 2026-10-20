/*************************************************************
 * TAX.GS
 * Withholding tax engine for bill entry: Income Tax (Section 153),
 * Sales Tax (FBR, on goods), and Punjab Sales Tax on Services (PRA).
 *
 * IMPORTANT - PLEASE VERIFY: the Income Tax (153) and federal Sales Tax
 * rates/formulas below are exactly as specified. The Punjab Sales Tax on
 * Services rates were NOT specified, so sensible defaults (5% active /
 * 15% inactive, flat on gross) are used as placeholders - adjust them from
 * Admin > Tax Settings to match your actual PRA withholding requirement
 * before relying on this for real bills.
 *************************************************************/

// DEFAULT Income Tax rates. These are only the starting values - every rate below can be changed from Admin > Tax Settings
// (saved in the Settings sheet and used instead of these). 'final' marks a Final Tax category and is not editable.
const INCOME_TAX_RATES = {
  // Section 153(1)(a) - Supply / Sale of Goods
  Supply: {
    Company:          { filer: 0.05,  nonFiler: 0.10 },
    'Individual/AOP': { filer: 0.055, nonFiler: 0.11 }
  },
  // Section 153(1)(c) - Execution of Contracts. (A flat 16%/5% "Income Tax"
  // was mistakenly used here for a while - that pair is actually the Punjab
  // Sales Tax rate for New Projects/Repair-Renovation contracts, see the PST
  // block in computeTaxes_ below. This matrix is the real Income Tax.)
  Contract: {
    Company:          { filer: 0.075, nonFiler: 0.15 },
    'Individual/AOP': { filer: 0.08,  nonFiler: 0.16 }
  },
  // Section 153(1)(b) - Rendering of Services, by category
  Service: {
    'Specified Corporate Services':        { filer: 0.08,  nonFiler: 0.16, final: false },
    'IT & IT-Enabled Services (ITeS)':      { filer: 0.04,  nonFiler: 0.08, final: false },
    'Print & Electronic Media Advertisement': { filer: 0.015, nonFiler: 0.03, final: true },
    'General Services - Company':           { filer: 0.09,  nonFiler: 0.18, final: false },
    'General Services - Individual/AOP':    { filer: 0.14,  nonFiler: 0.28, final: false }
  }
};

// The Income Tax rates actually in force: the defaults above, overridden by whatever Admin saved in Tax Settings.
function getIncomeTaxRates_() {
  const rates = JSON.parse(JSON.stringify(INCOME_TAX_RATES));
  let saved = null;
  try { saved = JSON.parse(String(getSetting_('INCOME_TAX_RATES_JSON', '') || 'null')); } catch (e) { saved = null; }
  if (saved && typeof saved === 'object') {
    Object.keys(rates).forEach(group => {
      Object.keys(rates[group]).forEach(key => {
        const s = saved[group] && saved[group][key];
        if (!s) return;
        if (isFinite(Number(s.filer)) && s.filer !== '' && s.filer !== null) rates[group][key].filer = Number(s.filer);
        if (isFinite(Number(s.nonFiler)) && s.nonFiler !== '' && s.nonFiler !== null) rates[group][key].nonFiler = Number(s.nonFiler);
      });
    });
  }
  return rates;
}

// Sales Tax (Goods) and Section 153(1)(b) Non-UE rates are admin-configurable
// via getTaxSettings()/saveTaxSettings() now - see there for defaults.

// The system works in whole rupees only - every monetary figure is rounded
// here, once, at the point it's calculated, so it stays whole everywhere
// downstream (reports, ledgers, CSVs, the IBFT file) without needing to
// re-round in a dozen different places. Rates/percentages are NOT rounded -
// only actual currency amounts.
function round0_(n) {
  return Math.round(Number(n) || 0);
}

// These bill natures never attract Income Tax / Sales Tax / Punjab Sales Tax -
// they're reimbursements, advances, and similar movements, not a taxable
// supply/service/contract payment. Enforced here server-side (not just hidden
// in the UI) so a tampered request can't sneak tax fields through.
const NO_TAX_BILL_NATURES = ['Reimbursement of Fee', 'Medical', 'Advance', 'TADA', 'Release of Security'];

// Bill natures that only exist for Student payees. Students are never taxed
// and only ever get the single free-form Student Deduction, never the
// Security/Penalty/Other trio (see computeTaxes_ below).
const STUDENT_BILL_NATURES = ['Scholarship', 'Refund of Fee'];
// "Admission Withdrawal", "Admission to Other Campus" and "Discontinued
// Program" were added on request; "Other (Manual Entry)" lets the user type
// a category that isn't in this list at all - the UI sends the typed text
// straight through as the RefundCategory, this constant is never asked to
// validate free text server-side.
const REFUND_CATEGORIES = ['Library Security', 'Subject Repeat Fee', 'Dropped Student', 'Extra Deposited',
  'Admission Withdrawal', 'Admission to Other Campus', 'Discontinued Program'];

// UE and Non-UE Employees share the same Section 149 taxable categories.
// "Conduct of Exam" additionally takes a free-text sub-category from the
// user; "Thesis Evaluation" additionally takes Class + Student Name.
// "Honorarium" here is a general Section 149 taxable category, distinct from
// "Honoraria to Statutory Body Meeting's Member" (SECTION_156_NATURE below),
// which is Non-UE-only and taxed under Section 156's flat rate instead.
const EMPLOYEE_149_CATEGORIES = ['UE Visiting Faculty', 'Non-Teaching', 'Additional Duty',
  'Paper Setting/Marking', 'Conduct of Exam', 'Examiners', 'Thesis Evaluation', 'Honorarium', 'Contingency'];
// UE Employees only - taxable (Section 149) categories that do NOT apply to
// Non-UE Employees, on top of the shared list above.
const UE_ONLY_TAXABLE_NATURES = ['Overtime'];
// UE Employees only - Non-UE Employees have no non-taxable category at all.
// "Benevolent Fund" is a non-taxable category with a fixed list of
// sub-categories (see BENEVOLENT_FUND_SUBCATEGORIES). "POL" = Petrol/Oil/Lubricant.
// "Contingency (Non-Taxable)" is deliberately a distinct value from the
// taxable "Contingency" in EMPLOYEE_149_CATEGORIES above (not the same
// string) - some Contingency spending is genuinely non-taxable (e.g. petty
// reimbursement) while other Contingency spending is a taxable emolument;
// picking the right one at entry decides which rule applies, so they can't
// share one value or the server could never tell them apart.
const UE_NON_TAXABLE_NATURES = ['Reimbursement of Fee', 'Medical', 'Advance', 'TADA', 'Release of Security', 'GPF Advance', 'Benevolent Fund',
  'Mobile Bill', 'Refreshment', 'POL', 'Contingency (Non-Taxable)'];
const BENEVOLENT_FUND_SUBCATEGORIES = ['Marriage Grant', 'Funeral Grant', 'Education Scholarship',
  'Employees Fee Reimbursement', 'Farewell Grant', 'Monthly Grant'];
// Non-UE Employees only - a separate taxable category taxed under Section
// 156 (flat rate, admin-configurable), not the Section 149 slab system.
const SECTION_156_NATURE = "Honoraria to Statutory Body Meeting's Member";
// Non-UE Employees only - an alternative to the Section 149 slab system for
// any of the Section 149 taxable categories above (including Thesis
// Evaluation): withhold a flat rate instead, under Section 153(1)(b)
// Services - Individual/AOP, based on whether the payee is an
// Active/Registered or Inactive taxpayer (reuses the same Filer/Non-Filer
// selector already on the form). Rates are admin-configurable - see
// getTaxSettings().

// A "Release of Security" bill pays back part of a security deposit already
// withheld from an earlier, budget-impacting bill - it is not new spending
// against the budget head, so it's excluded from every "consumed"/"spent"
// budget calculation (getBudgetStatus, Yearly Matrix, Budget Consumption,
// Budget Control Register). It still needs a Campus/Budget Head on the entry
// for record-keeping, it just doesn't count against that head's allocation.
function isBudgetImpacting_(billNature) {
  return billNature !== 'Release of Security';
}

// Security / Penalty / Other Deduction / Student Deduction can each be entered
// either as a percentage of the gross bill (amount auto-calculated) or as a
// direct fixed amount (rate back-calculated purely for display/audit).
// mode: 'rate' or 'amount'.
function resolveManualDeduction_(gross, applied, mode, rateInput, amountInput) {
  if (!applied) return { rate: 0, amount: 0 };
  if (mode === 'amount') {
    const amount = round0_(amountInput);
    const rate = gross > 0 ? amount / gross : 0;
    return { rate, amount };
  }
  const rate = Number(rateInput) / 100 || 0;
  return { rate, amount: round0_(gross * rate) };
}

/* ---------- Settings (for the rates the user didn't specify) ---------- */
// Settings are read from the sheet ONCE (kept for 60 seconds, and cleared the moment settings are saved) instead of once per rate.
let SETTINGS_MEMO_ = null;
function getSettingsMap_() {
  if (SETTINGS_MEMO_) return SETTINGS_MEMO_;
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('tbl_Settings'); if (hit) { SETTINGS_MEMO_ = JSON.parse(hit); return SETTINGS_MEMO_; } } catch (e) {}
  const map = {};
  getTable(SHEETS.SETTINGS).forEach(r => { if (!Object.prototype.hasOwnProperty.call(map, r.Key)) map[r.Key] = r.Value; });
  SETTINGS_MEMO_ = map;
  try { cache.put('tbl_Settings', JSON.stringify(map), 60); } catch (e) {}
  return map;
}
function getSetting_(key, fallback) {
  const m = getSettingsMap_();
  return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : fallback;
}
function saveSetting_(key, value) {
  saveSettingsBatch_({ [key]: value });
}
// Writes several Key/Value rows in ONE read + ONE write, wrapped in
// withLock_ - the previous version called saveSetting_ once per rate
// (13 separate small reads/writes for a single "Save Tax Settings" click),
// which was the likely cause of the intermittent save error reported -
// same read-once/write-once pattern already used elsewhere in this system
// (e.g. transitionBills_) for exactly this reason.
function saveSettingsBatch_(kvMap) {
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.SETTINGS);
    const range = sh.getDataRange();
    const values = range.getValues();
    const remaining = Object.assign({}, kvMap);
    for (let i = 1; i < values.length; i++) {
      const key = values[i][0];
      if (Object.prototype.hasOwnProperty.call(remaining, key)) {
        values[i][1] = remaining[key];
        delete remaining[key];
      }
    }
    if (values.length > 1) range.setValues(values);
    Object.keys(remaining).forEach(key => {
      sh.appendRow([key, remaining[key]]);
    });
    invalidateCache_(SHEETS.SETTINGS);
    return true;
  });
}
function getTaxSettings() {
  return {
    pstActiveRate: Number(getSetting_('PST_ACTIVE_RATE', 0.05)),
    pstInactiveRate: Number(getSetting_('PST_INACTIVE_RATE', 0.15)),
    // 'exclusive' (straight % of Gross) matches this system's behavior
    // before Inclusive/Exclusive became a choice - kept as the default so
    // existing bills' figures don't shift under anyone who doesn't touch this.
    pstActiveMode: getSetting_('PST_ACTIVE_MODE', 'exclusive'),
    pstInactiveMode: getSetting_('PST_INACTIVE_MODE', 'exclusive'),
    // Not specified when this was configured - placeholder pending confirmation.
    section156Rate: Number(getSetting_('SECTION_156_RATE', 0.20)),
    // Sales Tax (Goods, Section 153 federal). Active/Filer uses a fixed
    // inclusive-with-1/5th-withholding formula (a specific FBR compliance
    // rule - only the RATE is configurable, not that formula shape, so this
    // can't be accidentally misconfigured into a different rule). Inactive/
    // Non-Filer is a straight exclusive % of Gross.
    salesTaxActiveRate: Number(getSetting_('SALES_TAX_ACTIVE_RATE', 0.18)),
    salesTaxInactiveRate: Number(getSetting_('SALES_TAX_INACTIVE_RATE', 0.22)),
    // Non-UE Employees' Section 153(1)(b) flat-rate alternative to Section 149.
    // 14% Active / 28% Inactive are the correct current rates (previously
    // 11%/15% had drifted in from an old, incorrect default).
    nonUe1531bActiveRate: Number(getSetting_('NONUE_1531B_ACTIVE_RATE', 0.14)),
    nonUe1531bInactiveRate: Number(getSetting_('NONUE_1531B_INACTIVE_RATE', 0.28)),
    // Punjab Sales Tax specifically for Execution of Contract bills, by
    // contract category (New Projects vs Repair/Renovation) - this is the
    // 5%/16% pair that was, for a while, mistakenly applied as Income Tax.
    // Defaults to Inclusive (Gross treated as already including this tax),
    // matching how it was originally specified.
    pstContractNewProjectsRate: Number(getSetting_('PST_CONTRACT_NEW_RATE', 0.05)),
    pstContractRepairRate: Number(getSetting_('PST_CONTRACT_REPAIR_RATE', 0.16)),
    pstContractNewProjectsMode: getSetting_('PST_CONTRACT_NEW_MODE', 'inclusive'),
    pstContractRepairMode: getSetting_('PST_CONTRACT_REPAIR_MODE', 'inclusive'),
    // Section 153(1)(a) Supply, 153(1)(c) Contract and 153(1)(b) Services Income Tax rates (fractions, e.g. 0.08 = 8%)
    incomeTaxRates: getIncomeTaxRates_()
  };
}
function saveTaxSettings(actorUsername, settings) {
  requireAdmin_(actorUsername);
  // Income Tax rate matrix (Supply / Contract / Services): validated, then stored as one JSON setting.
  let incomeTaxJson = null;
  if (settings.incomeTaxRates && typeof settings.incomeTaxRates === 'object') {
    const clean = {};
    const groups = Object.keys(INCOME_TAX_RATES);
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      clean[g] = {};
      const keys = Object.keys(INCOME_TAX_RATES[g]);
      for (let ki = 0; ki < keys.length; ki++) {
        const k = keys[ki];
        const s = (settings.incomeTaxRates[g] || {})[k] || {};
        const f = Number(s.filer), n = Number(s.nonFiler);
        if (!isFinite(f) || !isFinite(n) || f < 0 || n < 0 || f > 1 || n > 1) {
          return { success: false, message: 'Income Tax rate for "' + k + '" (' + g + ') must be a percentage between 0 and 100.' };
        }
        clean[g][k] = { filer: f, nonFiler: n };
      }
    }
    incomeTaxJson = JSON.stringify(clean);
  }
  saveSettingsBatch_({
    PST_ACTIVE_RATE: Number(settings.pstActiveRate),
    PST_INACTIVE_RATE: Number(settings.pstInactiveRate),
    PST_ACTIVE_MODE: settings.pstActiveMode === 'inclusive' ? 'inclusive' : 'exclusive',
    PST_INACTIVE_MODE: settings.pstInactiveMode === 'inclusive' ? 'inclusive' : 'exclusive',
    SECTION_156_RATE: Number(settings.section156Rate),
    SALES_TAX_ACTIVE_RATE: Number(settings.salesTaxActiveRate),
    SALES_TAX_INACTIVE_RATE: Number(settings.salesTaxInactiveRate),
    NONUE_1531B_ACTIVE_RATE: Number(settings.nonUe1531bActiveRate),
    NONUE_1531B_INACTIVE_RATE: Number(settings.nonUe1531bInactiveRate),
    PST_CONTRACT_NEW_RATE: Number(settings.pstContractNewProjectsRate),
    PST_CONTRACT_REPAIR_RATE: Number(settings.pstContractRepairRate),
    PST_CONTRACT_NEW_MODE: settings.pstContractNewProjectsMode === 'exclusive' ? 'exclusive' : 'inclusive',
    PST_CONTRACT_REPAIR_MODE: settings.pstContractRepairMode === 'exclusive' ? 'exclusive' : 'inclusive'
  });
  if (incomeTaxJson !== null) saveSettingsBatch_({ INCOME_TAX_RATES_JSON: incomeTaxJson });
  return { success: true };
}
// Shared Inclusive/Exclusive calculator for any straightforward rate x gross
// tax line. Exclusive: Gross x Rate. Inclusive: Gross is treated as already
// containing this tax, so the tax is backed out - Gross/(1+Rate) x Rate.
function computeRateAmount_(gross, rate, mode) {
  if (mode === 'inclusive') return round0_(gross / (1 + rate) * rate);
  return round0_(gross * rate);
}

/* ================= SECTION 149 SLAB TAX (UE / Non-UE Employees) =================
   Slabs are stored as {Threshold, FixedAmount, Rate, Label} rows, admin-
   editable (Admin > Tax Settings > Section 149 Slabs) since these get revised
   every year or two. Threshold = income where the bracket starts; FixedAmount
   = tax already accumulated by that threshold; Rate = marginal rate on the
   amount ABOVE the threshold. This mirrors the standard FBR salary-tax table
   format ("Rs. X + Y% of amount exceeding Rs. Z"), and lets Admin edit the
   fixed amount directly if a future revision isn't a clean continuation of
   the previous brackets. ================================================= */
function getTaxSlabs() {
  seedDefaultTaxSlabsIfEmpty_();
  return getTable(SHEETS.TAXSLABS)
    .map(s => ({ threshold:Number(s.Threshold), fixedAmount:Number(s.FixedAmount), rate:Number(s.Rate), label:s.Label }))
    .sort((a,b) => a.threshold - b.threshold);
}
function seedDefaultTaxSlabsIfEmpty_() {
  if (getTable(SHEETS.TAXSLABS).length) return;
  // FY 2026-27 slabs as provided - Admin can edit/replace these any time
  // from Admin > Tax Settings > Section 149 Slabs.
  const defaults = [
    [0, 0, 0, 'Up to 600,000'],
    [600000, 0, 0.01, '600,001 - 1,200,000'],
    [1200000, 6000, 0.11, '1,200,001 - 2,200,000'],
    [2200000, 116000, 0.20, '2,200,001 - 3,200,000'],
    [3200000, 316000, 0.25, '3,200,001 - 4,100,000'],
    [4100000, 541000, 0.29, '4,100,001 - 5,600,000'],
    [5600000, 976000, 0.32, '5,600,001 - 7,000,000'],
    [7000000, 1424000, 0.35, 'Above 7,000,000']
  ];
  defaults.forEach(([threshold,fixedAmount,rate,label]) =>
    appendRowObj(SHEETS.TAXSLABS, { Threshold:threshold, FixedAmount:fixedAmount, Rate:rate, Label:label }));
}
function saveTaxSlab(actorUsername, slab) {
  requireAdmin_(actorUsername);
  const threshold = Number(slab.threshold);
  if (isNaN(threshold) || slab.rate === undefined) return { success:false, message:'Threshold and rate are required.' };
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.TAXSLABS);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const tCol = headers.indexOf('Threshold');
    for (let i = 1; i < values.length; i++) {
      if (Number(values[i][tCol]) === threshold) {
        sh.getRange(i+1, 1, 1, headers.length).setValues([[threshold, Number(slab.fixedAmount)||0, Number(slab.rate), slab.label||'']]);
        invalidateCache_(SHEETS.TAXSLABS);
        return { success:true, updated:true };
      }
    }
    appendRowObj(SHEETS.TAXSLABS, { Threshold:threshold, FixedAmount:Number(slab.fixedAmount)||0, Rate:Number(slab.rate), Label:slab.label||'' });
    return { success:true, updated:false };
  });
}
function deleteTaxSlab(actorUsername, threshold) {
  requireAdmin_(actorUsername);
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.TAXSLABS);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const tCol = headers.indexOf('Threshold');
    for (let i = 1; i < values.length; i++) {
      if (Number(values[i][tCol]) === Number(threshold)) { sh.deleteRow(i+1); invalidateCache_(SHEETS.TAXSLABS); return { success:true }; }
    }
    return { success:false, message:'Slab not found.' };
  });
}

// Marginal/bracket tax on a given annual income, using the slab table above.
function computeSlabTax_(income, slabs) {
  if (!slabs.length || income <= 0) return 0;
  let applicable = slabs[0];
  for (const s of slabs) { if (income >= s.threshold) applicable = s; else break; }
  return round0_(applicable.fixedAmount + (income - applicable.threshold) * applicable.rate);
}

// Splits the income RANGE [incomeBefore, incomeAfter] a single bill's gross
// amount actually spans into one segment per Section 149 slab it touches -
// e.g. a bill that pushes someone from just under a bracket boundary to just
// over it has PART of its amount taxed at the lower bracket's rate and the
// REST at the higher one. This is what actually justifies a bill's Income
// Tax figure to an employee/auditor ("Rs. X of this payment fell in the 11%
// bracket, Rs. Y fell in the 20% bracket") - computeSlabTax_ above only ever
// evaluates a single cumulative income point, so it can tell you the total
// tax correctly but never how it's actually composed. Each segment's own
// tax, summed, always equals round0_(computeSlabTax_(after) -
// computeSlabTax_(before)) - the slab table's FixedAmount values are
// themselves the cumulative sum of exactly this kind of segment, by
// construction (see seedDefaultTaxSlabsIfEmpty_), so the two never diverge
// beyond ordinary per-segment rounding.
function computeSlabBreakdown_(incomeBefore, incomeAfter, slabs) {
  const sorted = slabs.slice().sort((a,b) => a.threshold - b.threshold);
  const breakdown = [];
  let cursor = round0_(incomeBefore);
  const end = round0_(incomeAfter);
  if (!sorted.length || end <= cursor) return breakdown;
  let safety = 0;
  while (cursor < end && safety++ < 100) {
    let bracketIdx = 0;
    for (let i = 0; i < sorted.length; i++) { if (cursor >= sorted[i].threshold) bracketIdx = i; else break; }
    const bracket = sorted[bracketIdx];
    const nextThreshold = (bracketIdx + 1 < sorted.length) ? sorted[bracketIdx + 1].threshold : Infinity;
    const segmentEnd = Math.min(end, nextThreshold);
    const portion = round0_(segmentEnd - cursor);
    if (portion > 0) {
      breakdown.push({ label: bracket.label, threshold: bracket.threshold, rate: bracket.rate,
        portionFrom: cursor, portionTo: segmentEnd, portionAmount: portion, taxOnPortion: round0_(portion * bracket.rate) });
    }
    cursor = segmentEnd;
  }
  return breakdown;
}

/* ---------- Income Profiles (Annual Taxable Income disclosure, per FY) ---------- */
/* ---------- Section 149 credit ledger (money owed back from an over-
   deducted PAID bill, drawn down automatically by later bills) ---------- */
function getSection149CreditBalance_(key, payeeType, fy) {
  const keyLower = String(key||'').trim().toLowerCase();
  if (!keyLower) return 0;
  const row = getTable(SHEETS.S149CREDITS).find(r =>
    String(r.Key).trim().toLowerCase() === keyLower && r.PayeeType === payeeType && fyMatches_(r.FY, fy));
  return row ? round0_(row.CreditAmount) : 0;
}
// delta: positive to ADD credit (an over-deduction just discovered on a Paid
// bill), negative to CONSUME it (a new bill just used some of it, or a bill
// that had used some is being refunded-then-... no - refund is also
// positive, same as adding). The stored balance never goes below zero.
// delta: positive to ADD credit (an over-deduction just discovered on a Paid
// bill), negative to CONSUME it (a new bill just used some of it, or fully
// collected an outstanding balance). The stored balance is signed: positive
// means credit owed TO this person; negative means an outstanding amount
// still owed BY them (see computeSection149Tax_'s credit-application block,
// which fully collects a negative balance on the very next relevant bill) -
// it is deliberately NOT floored at zero any more, so an outstanding balance
// can actually be represented and tracked, not just silently discarded.
function adjustSection149CreditBalance_(key, payeeType, fy, delta, note) {
  const keyTrim = String(key||'').trim();
  delta = round0_(delta);
  if (!keyTrim || !delta) return getSection149CreditBalance_(key, payeeType, fy);
  const sh = getOrCreateSheet_(SHEETS.S149CREDITS);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const kCol = headers.indexOf('Key'), tCol = headers.indexOf('PayeeType'), fCol = headers.indexOf('FY'),
        aCol = headers.indexOf('CreditAmount'), nCol = headers.indexOf('Notes'), uCol = headers.indexOf('LastUpdated');
  const keyLower = keyTrim.toLowerCase();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][kCol]).trim().toLowerCase() === keyLower && values[i][tCol] === payeeType && fyMatches_(values[i][fCol], fy)) {
      const newBalance = round0_(Number(values[i][aCol]||0) + delta);
      sh.getRange(i+1, aCol+1).setValue(newBalance);
      if (note) sh.getRange(i+1, nCol+1).setValue(String(values[i][nCol]||'').slice(-2000) + ' | ' + note);
      sh.getRange(i+1, uCol+1).setValue(new Date());
      invalidateCache_(SHEETS.S149CREDITS);
      return newBalance;
    }
  }
  const newBalance = round0_(delta);
  appendRowObj(SHEETS.S149CREDITS, { Key:keyTrim, PayeeType:payeeType, FY:fy, CreditAmount:newBalance, Notes: note||'', LastUpdated:new Date() });
  invalidateCache_(SHEETS.S149CREDITS);
  return newBalance;
}

/* ---------- Section 149 manual inclusion/exclusion override ----------
   The escape hatch for anything the automated tools can't safely judge on
   their own (chiefly a bulk Non-UE Employee line - see Admin > Section 149
   > Manual Income Inclusion Override). Returns a Set of ItemIDs (a plain
   EntryID, or "ParentEntryID-LineNo" for a bulk line) that an Admin has
   explicitly marked Excluded=TRUE for this person/FY - checked by
   computeSection149Tax_ below on top of every automatic exclusion rule
   (Cancelled, Redirected, etc.), never instead of them. */
function getSection149ManualExclusions_(key, payeeType, fy) {
  const keyLower = String(key||'').trim().toLowerCase();
  if (!keyLower) return new Set();
  const rows = getTable(SHEETS.S149EXCLUSIONS).filter(r =>
    String(r.Key).trim().toLowerCase() === keyLower && r.PayeeType === payeeType && fyMatches_(r.FY, fy) &&
    (r.Excluded === true || r.Excluded === 'TRUE' || r.Excluded === 'true'));
  return new Set(rows.map(r => String(r.ItemID).trim()));
}

/* ---------- Batch context: one read of every sheet, reused across many
   Section 149 calculations in the same run ----------
   Built once at the start of a repair tool's Preview/Apply run and passed
   through opts.ctx into every computeSection149Tax_ call for that run. This
   is the actual fix for those tools' 6-minute Google Apps Script timeout -
   without it, every single candidate bill triggered its own full re-read of
   Entries, BulkLineItems, IncomeProfiles, the credit ledger, and the
   exclusion list via the Sheets API; with a few hundred candidates that's a
   few hundred full-sheet reads. Ordinary single-bill calls (New Entry, bulk
   upload, live preview) never build or pass this - they're unaffected. */
function loadSection149BatchContext_() {
  const entries = getTable(SHEETS.ENTRIES);
  const bulkItems = getTable(SHEETS.BULKITEMS);
  const incomeProfiles = getTable(SHEETS.INCOMEPROFILES);
  const slabs = getTaxSlabs();
  const credits = getTable(SHEETS.S149CREDITS);
  const exclusions = getTable(SHEETS.S149EXCLUSIONS);

  // Indexed by "PayeeType|key" so a repeated lookup for the same employee -
  // very common across many candidate bills - filters only THEIR small
  // subset of rows instead of scanning the whole sheet every time.
  const entriesByKey = {};
  entries.forEach(e => {
    if (e.PayeeType !== 'Employee' && e.PayeeType !== 'NonUEEmployee') return;
    const k = e.PayeeType + '|' + String(e.PayeeType === 'Employee' ? e.EmployeeID : e.CNIC_NTN).trim().toLowerCase();
    (entriesByKey[k] || (entriesByKey[k] = [])).push(e);
  });
  const bulkByKey = {};
  bulkItems.forEach(li => {
    if (li.PayeeType !== 'Employee' && li.PayeeType !== 'NonUEEmployee') return;
    const k = li.PayeeType + '|' + String(li.PayeeType === 'Employee' ? li.EmployeeID : li.CNIC_NTN).trim().toLowerCase();
    (bulkByKey[k] || (bulkByKey[k] = [])).push(li);
  });
  const bulkParentFYById = {}, bulkParentStatusById = {}, bulkParentTimestampById = {}, bulkParentById = {};
  entries.filter(e => e.PayeeType === 'Bulk').forEach(e => {
    bulkParentFYById[e.EntryID] = e.FY; bulkParentStatusById[e.EntryID] = e.Status; bulkParentTimestampById[e.EntryID] = e.Timestamp;
    bulkParentById[e.EntryID] = e;
  });

  return { entries, bulkItems, incomeProfiles, slabs, credits, exclusions,
    entriesByKey, bulkByKey, bulkParentFYById, bulkParentStatusById, bulkParentTimestampById, bulkParentById };
}
function getIncomeProfileFromCtx_(ctx, key, payeeType, fy) {
  const keyLower = String(key||'').trim().toLowerCase();
  if (!keyLower) return null;
  return ctx.incomeProfiles.find(r =>
    String(r.Key).trim().toLowerCase() === keyLower && r.PayeeType === payeeType && fyMatches_(r.FY, fy)) || null;
}
function getSection149CreditBalanceFromCtx_(ctx, key, payeeType, fy) {
  const keyLower = String(key||'').trim().toLowerCase();
  if (!keyLower) return 0;
  const row = ctx.credits.find(r =>
    String(r.Key).trim().toLowerCase() === keyLower && r.PayeeType === payeeType && fyMatches_(r.FY, fy));
  return row ? round0_(row.CreditAmount) : 0;
}
function getSection149ManualExclusionsFromCtx_(ctx, key, payeeType, fy) {
  const keyLower = String(key||'').trim().toLowerCase();
  if (!keyLower) return new Set();
  const rows = ctx.exclusions.filter(r =>
    String(r.Key).trim().toLowerCase() === keyLower && r.PayeeType === payeeType && fyMatches_(r.FY, fy) &&
    (r.Excluded === true || r.Excluded === 'TRUE' || r.Excluded === 'true'));
  return new Set(rows.map(r => String(r.ItemID).trim()));
}
function setSection149ManualExclusion(key, payeeType, fy, itemId, excluded, reason, username) {
  requireAdmin_(username);
  key = String(key||'').trim(); itemId = String(itemId||'').trim();
  if (!key || !itemId) return { success:false, message:'Employee/CNIC and item ID are both required.' };
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.S149EXCLUSIONS);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const kCol = headers.indexOf('Key'), tCol = headers.indexOf('PayeeType'), fCol = headers.indexOf('FY'), iCol = headers.indexOf('ItemID'),
          eCol = headers.indexOf('Excluded'), rCol = headers.indexOf('Reason'), sCol = headers.indexOf('SetBy'), dCol = headers.indexOf('SetDate');
    const keyLower = key.toLowerCase();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][kCol]).trim().toLowerCase() === keyLower && values[i][tCol] === payeeType &&
          fyMatches_(values[i][fCol], fy) && String(values[i][iCol]).trim() === itemId) {
        sh.getRange(i+1, eCol+1).setValue(!!excluded);
        sh.getRange(i+1, rCol+1).setValue(reason||'');
        sh.getRange(i+1, sCol+1).setValue(username);
        sh.getRange(i+1, dCol+1).setValue(new Date());
        invalidateCache_(SHEETS.S149EXCLUSIONS);
        return { success:true };
      }
    }
    appendRowObj(SHEETS.S149EXCLUSIONS, { Key:key, PayeeType:payeeType, FY:fy, ItemID:itemId, Excluded: !!excluded, Reason: reason||'', SetBy: username, SetDate: new Date() });
    invalidateCache_(SHEETS.S149EXCLUSIONS);
    return { success:true };
  });
}

function getIncomeProfile(key, payeeType, fy) {
  key = String(key||'').trim();
  if (!key) return null;
  return getTable(SHEETS.INCOMEPROFILES).find(r =>
    String(r.Key).trim().toLowerCase() === key.toLowerCase() && r.PayeeType === payeeType && fyMatches_(r.FY, fy)) || null;
}
function saveIncomeProfile(actorUsername, profile) {
  requireRole_(actorUsername, ['Accounts']); // Admin always passes too
  const key = String(profile.key||'').trim();
  if (!key || !profile.fy) return { success:false, message:'Key and Financial Year are required.' };
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.INCOMEPROFILES);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const kCol = headers.indexOf('Key'), tCol = headers.indexOf('PayeeType'), fCol = headers.indexOf('FY');
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][kCol]).trim().toLowerCase() === key.toLowerCase() && values[i][tCol] === profile.payeeType && fyMatches_(values[i][fCol], profile.fy)) {
        sh.getRange(i+1, 1, 1, headers.length).setValues([[key, profile.payeeType, profile.fy, profile.name||'',
          Number(profile.annualTaxableIncome)||0, !!profile.affidavitLowIncome]]);
        invalidateCache_(SHEETS.INCOMEPROFILES);
        return { success:true, updated:true };
      }
    }
    appendRowObj(SHEETS.INCOMEPROFILES, { Key:key, PayeeType:profile.payeeType, FY:profile.fy, Name:profile.name||'',
      AnnualTaxableIncome: Number(profile.annualTaxableIncome)||0, AffidavitLowIncome: !!profile.affidavitLowIncome });
    return { success:true, updated:false };
  });
}

// The cumulative calculation itself: "his total income reported at start plus
// all bills that have already been claimed" determines the tax bracket BEFORE
// this bill; adding this bill's gross amount determines the bracket AFTER;
// only the DIFFERENCE is deducted from this bill (the rest was already
// accounted for via payroll withholding or previous bills' deductions).
// opts (all optional, used only by the Section 149 cancellation-repair tool
// below - normal live entry/bulk-upload calls never pass this):
//   asOfTimestamp  - only count entries/lines saved BEFORE this timestamp,
//                    reproducing what the calculation actually saw at the
//                    time a specific historical bill was saved, instead of
//                    the full live picture as of right now.
//   excludeEntryId - exclude this single-entry bill's own row from the sum
//                    (needed when recomputing a bill that already exists).
function computeSection149Tax_(payeeType, key, fy, grossAmount, affidavitLowIncome, extraClaimed, opts) {
  if (affidavitLowIncome) {
    return { annualIncomeAtStart:0, claimedBefore:0, incomeBefore:0, incomeAfter:0, taxBefore:0, taxAfter:0,
      rawAdditionalTax:0, creditAvailable:0, creditApplied:0, additionalTax:0 };
  }
  opts = opts || {};
  // ctx: an optional pre-loaded, pre-indexed snapshot of every sheet this
  // function needs (see loadSection149BatchContext_ below) - used by the
  // Admin > Section 149 repair tools, which call this function once per
  // candidate bill. Without it, each call independently re-reads the whole
  // Entries/BulkLineItems/IncomeProfiles/Credits/Exclusions sheets from
  // scratch via the Sheets API - fine for a single live bill calculation,
  // but with a few hundred candidates that's a few hundred full-sheet reads
  // each, which is what was pushing these tools past Google Apps Script's
  // 6-minute execution limit. When ctx is supplied, every lookup below comes
  // from data already in memory instead. Ordinary single-bill calls
  // (New Entry, bulk upload, live preview) never pass ctx and are
  // completely unaffected - same behavior as before.
  const ctx = opts.ctx || null;
  const asOf = opts.asOfTimestamp ? new Date(opts.asOfTimestamp) : null;
  const profile = ctx ? getIncomeProfileFromCtx_(ctx, key, payeeType, fy) : getIncomeProfile(key, payeeType, fy);
  const annualIncomeAtStart = profile ? round0_(profile.AnnualTaxableIncome) : 0;

  const keyLower = String(key||'').trim().toLowerCase();
  // Admin's manual override (Admin > Section 149 > Manual Income Inclusion
  // Override) - checked on top of every automatic rule below, never instead
  // of them. Fetched once here and reused by both filters.
  const manualExclusions = ctx ? getSection149ManualExclusionsFromCtx_(ctx, key, payeeType, fy) : getSection149ManualExclusions_(key, payeeType, fy);
  // A Cancelled bill is excluded from every other budget/consumption/payment
  // calculation the moment it's cancelled (see isBudgetImpacting_ callers,
  // getGeneralLedger, etc.) - this threshold-claimed total must follow the
  // same rule, or a cancelled-but-not-yet-corrected bill keeps inflating the
  // Section 149 bracket for every bill that comes after it, even though that
  // money was never actually paid out.
  // ctx.entriesByKey, when present, is already narrowed to just THIS
  // person's own rows (see loadSection149BatchContext_) - filtering that
  // small list instead of the whole sheet is what actually saves the time.
  const entriesForKey = ctx ? (ctx.entriesByKey[payeeType + '|' + keyLower] || []) : getTable(SHEETS.ENTRIES);
  const claimedFromSingleEntries = round0_(entriesForKey.filter(e =>
    fyMatches_(e.FY, fy) && e.EmployeeCategory && !statusEquals_(e.Status, STATUS.CANCELLED) &&
    (!opts.excludeEntryId || e.EntryID !== opts.excludeEntryId) &&
    (!asOf || new Date(e.Timestamp) < asOf) &&
    !manualExclusions.has(String(e.EntryID).trim()) &&
    ((payeeType === 'Employee' && String(e.EmployeeID).trim().toLowerCase() === keyLower && e.PayeeType === 'Employee') ||
     (payeeType === 'NonUEEmployee' && String(e.CNIC_NTN).trim().toLowerCase() === keyLower && e.PayeeType === 'NonUEEmployee'))
  ).reduce((s,e) => s + Number(e.Amount||0), 0));

  // A beneficiary inside a bulk bill is NOT a row in Entries (only the
  // consolidated bulk bill itself is) - their individual amount lives in
  // BulkLineItems instead, joined back to its parent bill for the FY. Without
  // this, a bulk-uploaded bill's amount would never count toward that
  // person's running annual income, and every later bill (bulk OR single
  // entry) would under-tax them against the wrong, lower threshold. If the
  // PARENT bulk bill has been Cancelled, none of its beneficiary lines count
  // here either - same rule as a cancelled single-entry bill.
  let bulkParentFYById, bulkParentStatusById, bulkParentTimestampById, bulkLinesForKey;
  if (ctx) {
    bulkParentFYById = ctx.bulkParentFYById; bulkParentStatusById = ctx.bulkParentStatusById; bulkParentTimestampById = ctx.bulkParentTimestampById;
    bulkLinesForKey = ctx.bulkByKey[payeeType + '|' + keyLower] || [];
  } else {
    bulkParentFYById = {}; bulkParentStatusById = {}; bulkParentTimestampById = {};
    getTable(SHEETS.ENTRIES).filter(e => e.PayeeType === 'Bulk').forEach(e => {
      bulkParentFYById[e.EntryID] = e.FY; bulkParentStatusById[e.EntryID] = e.Status; bulkParentTimestampById[e.EntryID] = e.Timestamp;
    });
    bulkLinesForKey = getTable(SHEETS.BULKITEMS);
  }
  const claimedFromBulkLines = round0_(bulkLinesForKey.filter(li => {
    if (EMPLOYEE_149_CATEGORIES.indexOf(li.BillNature) === -1 &&
        !(li.PayeeType === 'Employee' && UE_ONLY_TAXABLE_NATURES.indexOf(li.BillNature) !== -1)) return false;
    if (!fyMatches_(bulkParentFYById[li.ParentEntryID], fy)) return false;
    if (statusEquals_(bulkParentStatusById[li.ParentEntryID], STATUS.CANCELLED)) return false;
    // This specific beneficiary's line was individually redirected to the
    // correct person (Admin > Redirect Paid Bill, addressed by its own
    // "ParentID-LineNo" ID) - excluded here even though the rest of the
    // bulk bill is untouched and still counts for every OTHER beneficiary.
    if (li.RedirectedToEntryID) return false;
    if (manualExclusions.has(li.ParentEntryID + '-' + li.LineNo)) return false;
    if (opts.excludeBulkLine && opts.excludeBulkLine.parentEntryId === li.ParentEntryID && String(opts.excludeBulkLine.lineNo) === String(li.LineNo)) return false;
    if (asOf && !(new Date(bulkParentTimestampById[li.ParentEntryID]) < asOf)) return false;
    if (payeeType === 'Employee') return li.PayeeType === 'Employee' && String(li.EmployeeID).trim().toLowerCase() === keyLower;
    if (payeeType === 'NonUEEmployee') return li.PayeeType === 'NonUEEmployee' && String(li.CNIC_NTN).trim().toLowerCase() === keyLower;
    return false;
  }).reduce((s,li) => s + Number(li.Amount||0), 0));

  // extraClaimed: an earlier row for this SAME person, elsewhere in the same
  // bulk file currently being processed - not written to any sheet yet, so
  // the two queries above can't see it. Passed in explicitly by the caller.
  const claimedBefore = claimedFromSingleEntries + claimedFromBulkLines + round0_(extraClaimed || 0);

  const slabs = ctx ? ctx.slabs : getTaxSlabs();
  const incomeBefore = annualIncomeAtStart + claimedBefore;
  const incomeAfter = incomeBefore + round0_(grossAmount);
  const taxBefore = computeSlabTax_(incomeBefore, slabs);
  const taxAfter = computeSlabTax_(incomeAfter, slabs);
  const rawAdditionalTax = Math.max(0, taxAfter - taxBefore);

  // Section 149 credit: money already over-withheld from this same person on
  // an earlier bill (almost always a PAID bill whose tax was inflated
  // because a bill that's since been Cancelled was still counted toward
  // their annual threshold at the time - see Admin > Section 149 tools) is
  // owed back. Since a Paid bill's own record is never rewritten, the credit
  // is instead deducted from THIS bill's Income Tax, automatically, one bill
  // at a time until it's used up - so every new bill "punched" for this
  // person keeps drawing down the correction until the account is settled.
  // The balance can also be NEGATIVE - an outstanding amount this person
  // still owes (the mirror-image case) - which is instead fully collected
  // on top of this bill's own tax, settling it in one go. opts.creditOverride
  // lets a caller that's processing several bills for the same person in one
  // pass (a bulk upload, or the repair tools below) simulate the balance
  // moving across those bills without touching the ledger sheet until it's
  // ready to actually commit.
  const creditAvailable = (opts.creditOverride !== undefined) ? round0_(opts.creditOverride)
    : (ctx ? getSection149CreditBalanceFromCtx_(ctx, key, payeeType, fy) : getSection149CreditBalance_(key, payeeType, fy));
  // Positive balance: apply up to what this bill actually owes (never more).
  // Negative balance (outstanding): collect as much as this bill can
  // actually absorb WITHOUT pushing its own Net Payment below zero, and
  // carry whatever's left over forward to the next bill - collecting the
  // full outstanding amount regardless of size (the old behavior) could
  // make a bill's Income Tax exceed its own Gross, producing a negative
  // Net Payment, which is never acceptable. Employees/Non-UE Employees
  // never have Security/Penalty/Other deductions (see computeTaxes_), so
  // Net = Gross - additionalTax for this bill - the cap below is exactly
  // (Gross - rawAdditionalTax), the bill's own pre-outstanding net, which
  // is what's actually available to absorb the outstanding collection.
  let creditApplied;
  if (creditAvailable > 0) {
    creditApplied = Math.min(creditAvailable, rawAdditionalTax);
  } else if (creditAvailable < 0) {
    const maxOutstandingCollectible = Math.max(0, round0_(grossAmount) - rawAdditionalTax);
    const outstandingCollected = Math.min(-creditAvailable, maxOutstandingCollectible);
    creditApplied = -outstandingCollected; // negative => adds this much on top of rawAdditionalTax below
  } else {
    creditApplied = 0;
  }
  const additionalTax = round0_(rawAdditionalTax - creditApplied);

  return { annualIncomeAtStart, claimedBefore, incomeBefore, incomeAfter, taxBefore, taxAfter,
    rawAdditionalTax, creditAvailable, creditApplied, additionalTax };
}

/* ---------- Core calculation - single source of truth, used for both the
   live on-screen preview AND the authoritative amount saved with the bill,
   so the two can never disagree. ---------- */
function computeTaxes_(p) {
  const gross = round0_(p.grossAmount);
  const isFilerFBR = p.fbrStatus === 'Filer';
  const isActivePRA = p.praStatus === 'Active';
  const isStudent = p.payeeType === 'Student';
  const isEmployee = p.payeeType === 'Employee';
  const isNonUE = p.payeeType === 'NonUEEmployee';
  // "Release of Security" bills ARE the release payment itself - no tax, and
  // no further deductions on top (see getVendorSecurityBalance for the ledger logic).
  const isReleaseOfSecurity = p.billNature === 'Release of Security';

  // Students are never taxed. UE Employees are non-taxable only for their own
  // specific list (which includes GPF Advance, unlike Vendors). Non-UE
  // Employees have NO non-taxable category at all - every bill is taxable.
  // Vendors use the original 5-item non-taxable list.
  let noTax;
  if (isStudent) noTax = true;
  else if (isEmployee) noTax = UE_NON_TAXABLE_NATURES.indexOf(p.billNature) !== -1;
  else if (isNonUE) noTax = false;
  else noTax = NO_TAX_BILL_NATURES.indexOf(p.billNature) !== -1; // Vendor

  let incomeTaxRate = 0, incomeTaxSection = '', incomeTaxAmount = 0, section149 = null;
  if (p.applyIncomeTax && !noTax) {
    if (isNonUE && p.billNature === SECTION_156_NATURE) {
      // Section 156 - flat rate, NOT the cumulative Section 149 slab system.
      const ts = getTaxSettings();
      incomeTaxSection = '156 - Honoraria to Statutory Body Meeting\'s Member';
      incomeTaxRate = ts.section156Rate;
      incomeTaxAmount = round0_(gross * incomeTaxRate);
    } else if (isNonUE && p.nonUeTaxMethod === 'Section153_1b') {
      // Section 153(1)(b) - Services (Individual/AOP): a flat-rate alternative
      // to the Section 149 slab system, available for any of the Non-UE
      // Employee's taxable categories (including Thesis Evaluation). Rate
      // depends on whether the payee is an Active/Registered or Inactive
      // taxpayer - reuses the Filer/Non-Filer selector already on the form.
      const ts = getTaxSettings();
      const rate = isFilerFBR ? ts.nonUe1531bActiveRate : ts.nonUe1531bInactiveRate;
      incomeTaxSection = '153(1)(b) - Services (Individual/AOP)' + (p.billNature === 'Conduct of Exam' && p.examSubCategory ? ' - ' + p.examSubCategory : '');
      incomeTaxRate = rate;
      incomeTaxAmount = round0_(gross * rate);
    } else if (isEmployee || isNonUE) {
      // Section 149 - salary-style slab withholding. Only the ADDITIONAL
      // liability caused by this bill (on top of the annual income already
      // reported plus every bill already claimed this year) is deducted here.
      const key = isEmployee ? p.employeeId : p.cnic;
      section149 = computeSection149Tax_(p.payeeType, key, p.fy, gross, !!p.affidavitLowIncome, p.extraClaimed149,
        (p.section149CreditOverride !== undefined || p.section149Ctx)
          ? Object.assign({}, p.section149CreditOverride !== undefined ? { creditOverride: p.section149CreditOverride } : {}, p.section149Ctx ? { ctx: p.section149Ctx } : {})
          : undefined);
      incomeTaxSection = '149 - Salary (Slab)' + (p.billNature === 'Conduct of Exam' && p.examSubCategory ? ' - ' + p.examSubCategory : '');
      incomeTaxAmount = section149.additionalTax;
      incomeTaxRate = gross > 0 ? incomeTaxAmount / gross : 0; // effective rate for this bill, display only
    } else if (p.billNature === 'Supply') {
      incomeTaxSection = '153(1)(a) - Supply of Goods';
      const bucket = getIncomeTaxRates_().Supply[p.taxpayerType];
      if (bucket) incomeTaxRate = isFilerFBR ? bucket.filer : bucket.nonFiler;
      incomeTaxAmount = round0_(gross * incomeTaxRate);
    } else if (p.billNature === 'Contract') {
      // Standard Section 153(1)(c) Income Tax matrix - see the PST block
      // below for the separate New Projects/Repair-Renovation Punjab Sales
      // Tax that also applies to Contract bills (previously conflated with
      // this Income Tax, now corrected).
      incomeTaxSection = '153(1)(c) - Execution of Contracts';
      const bucket = getIncomeTaxRates_().Contract[p.taxpayerType];
      if (bucket) incomeTaxRate = isFilerFBR ? bucket.filer : bucket.nonFiler;
      incomeTaxAmount = round0_(gross * incomeTaxRate);
    } else if (p.billNature === 'Service') {
      const bucket = getIncomeTaxRates_().Service[p.serviceCategory];
      incomeTaxSection = '153(1)(b) - Services' + (bucket && bucket.final ? ' (Final Tax)' : '');
      if (bucket) incomeTaxRate = isFilerFBR ? bucket.filer : bucket.nonFiler;
      incomeTaxAmount = round0_(gross * incomeTaxRate);
    }
  }

  // Manual Income Tax override - available on any bill, regardless of payee
  // type or nature. Entering a Rate recalculates the Amount off Gross;
  // entering an Amount directly is used as-is (Rate becomes the effective
  // rate for display only) - resolveManualDeduction_ already implements
  // exactly this rate-vs-amount duality for Security/Penalty/Other Deduction
  // below, so it's reused here rather than re-implemented.
  if (p.manualTaxOverride) {
    const manual = resolveManualDeduction_(gross, true, p.manualTaxMode, p.manualTaxRate, p.manualTaxAmount);
    incomeTaxSection = p.manualTaxSection || incomeTaxSection || 'Manually Entered';
    incomeTaxRate = manual.rate;
    incomeTaxAmount = manual.amount;
  }

  // Sales Tax / Punjab Sales Tax: never apply to Employees or Non-UE
  // Employees - Income Tax (149) is the only deduction that ever applies to
  // a person paid this way. Each can be switched from automatic to a manual
  // Rate-or-Amount entry, same pattern as manual Income Tax above.
  let salesTaxRate = 0, salesTaxAmount = 0;
  if (p.applySalesTax && !noTax && !isEmployee && !isNonUE) {
    if (p.manualSalesTaxOverride) {
      const manual = resolveManualDeduction_(gross, true, p.salesTaxMode, p.salesTaxManualRate, p.salesTaxManualAmount);
      salesTaxRate = manual.rate; salesTaxAmount = manual.amount;
    } else {
      const ts = getTaxSettings();
      if (isFilerFBR) {
        salesTaxRate = ts.salesTaxActiveRate;
        salesTaxAmount = round0_((gross / (1 + salesTaxRate)) * salesTaxRate / 5);
      } else {
        salesTaxRate = ts.salesTaxInactiveRate;
        salesTaxAmount = round0_(gross * salesTaxRate);
      }
    }
  }

  // Punjab Sales Tax: Execution of Contract bills use their own New Projects
  // / Repair-Renovation categorization and rates (see getTaxSettings) instead
  // of the general Active/Inactive PST rates used by everything else.
  let pstRate = 0, pstAmount = 0, pstCategory = '';
  if (p.applyPST && !noTax && !isEmployee && !isNonUE) {
    if (p.manualPSTOverride) {
      const manual = resolveManualDeduction_(gross, true, p.pstMode, p.pstManualRate, p.pstManualAmount);
      pstRate = manual.rate; pstAmount = manual.amount;
    } else if (p.billNature === 'Contract') {
      const ts = getTaxSettings();
      const isRepair = p.contractCategory === 'RepairRenovation';
      pstRate = isRepair ? ts.pstContractRepairRate : ts.pstContractNewProjectsRate;
      const mode = isRepair ? ts.pstContractRepairMode : ts.pstContractNewProjectsMode;
      pstAmount = computeRateAmount_(gross, pstRate, mode);
      pstCategory = isRepair ? 'Repair/Renovation' : 'New Projects';
    } else {
      const ts = getTaxSettings();
      pstRate = isActivePRA ? ts.pstActiveRate : ts.pstInactiveRate;
      const mode = isActivePRA ? ts.pstActiveMode : ts.pstInactiveMode;
      pstAmount = computeRateAmount_(gross, pstRate, mode);
    }
  }

  // Security / Penalty / Other Deduction: Vendor-only, and only for a
  // TAXABLE nature. Employees/Non-UE Employees never get these at all
  // (Income Tax is the only deduction that ever applies to them) - Students
  // use the single Student Deduction below instead of these three.
  const showVendorDeductions = p.payeeType === 'Vendor' && !noTax && !isReleaseOfSecurity;
  const security = showVendorDeductions
    ? resolveManualDeduction_(gross, p.applySecurity, p.securityMode, p.securityRate, p.securityAmount)
    : { rate:0, amount:0 };
  const penalty = showVendorDeductions
    ? resolveManualDeduction_(gross, p.applyPenalty, p.penaltyMode, p.penaltyRate, p.penaltyAmount)
    : { rate:0, amount:0 };
  const otherDeduction = showVendorDeductions
    ? resolveManualDeduction_(gross, p.applyOtherDeduction, p.otherDeductionMode, p.otherDeductionRate, p.otherDeductionAmount)
    : { rate:0, amount:0 };

  // Students: exactly one deduction line, amount specified directly (no rate).
  let studentDeductionAmount = 0;
  if (isStudent && p.applyStudentDeduction) {
    studentDeductionAmount = round0_(p.studentDeductionAmount);
  }

  const netAmount = round0_(gross - incomeTaxAmount - salesTaxAmount - pstAmount
    - security.amount - penalty.amount - otherDeduction.amount - studentDeductionAmount);

  return {
    incomeTaxSection, incomeTaxRate, incomeTaxAmount,
    salesTaxRate, salesTaxAmount,
    pstRate, pstAmount, pstCategory,
    securityRate: security.rate, securityAmount: security.amount,
    penaltyRate: penalty.rate, penaltyAmount: penalty.amount,
    otherDeductionRate: otherDeduction.rate, otherDeductionAmount: otherDeduction.amount,
    studentDeductionAmount,
    section149, // full breakdown (income before/after, tax before/after) for audit display - null unless 149 applied
    netAmount
  };
}

// Exposed to the browser for a live preview while filling the entry form,
// before the bill is actually saved.
function previewTaxCalculation(params) {
  return computeTaxes_(params);
}
