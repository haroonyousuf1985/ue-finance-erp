/*************************************************************
 * REPORTS.GS  (complete file)
 * All reporting/read-only logic lives here, separate from the bill
 * lifecycle and admin code in Code.gs.
 *************************************************************/

function monthIndexFromDate_(d) {
  if (isNaN(d)) return null;
  const m = d.getMonth();
  return m >= 6 ? m - 6 : m + 6; // 0 = Jul ... 11 = Jun
}

/* ---------- Report 1: Yearly Budget Matrix ---------- */
function getYearlyBudgetReport(fy, campusIds) {
  fy = String(fy || DEFAULT_FY).trim();
  const months = ['Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];
  const heads = getBudgetHeads();

  // Release-of-Security bills and Cancelled bills never count as budget consumption.
  // Multi-head split bills are added back per head from EntryHeadSplits.
  let entries = getTable(SHEETS.ENTRIES).filter(e => fyMatches_(e.FY, fy) && isBudgetImpacting_(e.BillNature) && !statusEquals_(e.Status, STATUS.CANCELLED) && !e.SplitFromEntryID);
  if (campusIds && campusIds.length) entries = entries.filter(e => campusIds.includes(e.CampusID));

  let splits = getTable(SHEETS.HEADSPLITS).filter(sp => fyMatches_(sp.FY, fy));
  if (campusIds && campusIds.length) splits = splits.filter(sp => campusIds.includes(sp.CampusID));
  const cancelledParentIds = new Set(getTable(SHEETS.ENTRIES).filter(e => statusEquals_(e.Status, STATUS.CANCELLED)).map(e => e.EntryID));
  splits = splits.filter(sp => !cancelledParentIds.has(sp.ParentEntryID));

  let allocs = getTableCached(SHEETS.ALLOC).filter(a => fyMatches_(a.FY, fy));
  if (campusIds && campusIds.length) allocs = allocs.filter(a => campusIds.includes(a.CampusID));

  const rows = heads.map(h => {
    const monthTotals = months.map(() => 0);
    entries.filter(e => e.HeadID === h.HeadID).forEach(e => {
      const idx = monthIndexFromDate_(new Date(e.EntryDate));
      if (idx !== null) monthTotals[idx] += Number(e.Amount || 0);
    });
    splits.filter(sp => sp.HeadID === h.HeadID).forEach(sp => {
      const idx = monthIndexFromDate_(new Date(sp.EntryDate));
      if (idx !== null) monthTotals[idx] += Number(sp.Amount || 0);
    });
    const allocated = allocs.filter(a => a.HeadID === h.HeadID).reduce((s,a) => s+Number(a.AllocatedAmount||0), 0);
    return { headCode:h.HeadCode, headName:h.HeadName, months:monthTotals, totalSpent: monthTotals.reduce((s,v)=>s+v,0), allocated };
  }).filter(r => r.allocated > 0 || r.totalSpent > 0);

  const monthColumnTotals = months.map((_, i) => rows.reduce((s,r) => s + r.months[i], 0));
  return {
    fy, months, rows, monthColumnTotals,
    grandTotalSpent: monthColumnTotals.reduce((s,v)=>s+v,0),
    grandAllocated: rows.reduce((s,r)=>s+r.allocated,0)
  };
}

/* ---------- Report 2: Budget Consumption ---------------------------------------------------
   One row per Budget Head. Specific campus + All Heads -> a row per head; specific campus +
   one Head -> one row; All Campuses -> figures consolidated across every campus per head. */
function getConsumptionReport(filters) {
  filters = filters || {};
  // filters.fy === '' means "All Years" - must NOT be replaced with DEFAULT_FY.
  const fy = (filters.fy !== undefined && filters.fy !== null) ? String(filters.fy).trim() : DEFAULT_FY;
  const allCampuses = getCampuses();
  const allHeads = getBudgetHeads();

  const isAllCampuses = !(filters.campusIds && filters.campusIds.length);
  const campusIds = isAllCampuses ? allCampuses.map(c => c.CampusID) : filters.campusIds;

  const isAllHeads = !(filters.headIds && filters.headIds.length);
  const headIds = isAllHeads ? allHeads.map(h => h.HeadID) : filters.headIds;

  let entries = getTable(SHEETS.ENTRIES).filter(e =>
    fyMatches_(e.FY, fy) && campusIds.includes(e.CampusID) && headIds.includes(e.HeadID) && isBudgetImpacting_(e.BillNature) && !statusEquals_(e.Status, STATUS.CANCELLED) && !e.SplitFromEntryID);
  if (filters.fromDate) entries = entries.filter(e => e.EntryDate && new Date(e.EntryDate) >= new Date(filters.fromDate));
  if (filters.toDate) entries = entries.filter(e => e.EntryDate && new Date(e.EntryDate) <= new Date(filters.toDate));
  if (filters.vendor) entries = entries.filter(e => String(e.VendorName).toLowerCase().includes(filters.vendor.toLowerCase()));

  let splits = getTable(SHEETS.HEADSPLITS).filter(sp =>
    fyMatches_(sp.FY, fy) && campusIds.includes(sp.CampusID) && headIds.includes(sp.HeadID));
  if (filters.fromDate) splits = splits.filter(sp => sp.EntryDate && new Date(sp.EntryDate) >= new Date(filters.fromDate));
  if (filters.toDate) splits = splits.filter(sp => sp.EntryDate && new Date(sp.EntryDate) <= new Date(filters.toDate));
  const splitParents = {};
  if (splits.length) {
    const parentIds = new Set(splits.map(sp => sp.ParentEntryID));
    getTable(SHEETS.ENTRIES).filter(e => parentIds.has(e.EntryID)).forEach(e => splitParents[e.EntryID] = e);
    splits = splits.filter(sp => !statusEquals_((splitParents[sp.ParentEntryID]||{}).Status, STATUS.CANCELLED));
    if (filters.vendor) splits = splits.filter(sp => String((splitParents[sp.ParentEntryID]||{}).VendorName).toLowerCase().includes(filters.vendor.toLowerCase()));
  }
  const splitDetailRows = splits.map(sp => {
    const parent = splitParents[sp.ParentEntryID] || {};
    return { EntryID:sp.ParentEntryID, EntryDate:sp.EntryDate, CampusName:parent.CampusName,
      HeadCode:sp.HeadCode, HeadName:sp.HeadName, VendorName:parent.VendorName, BillNo:parent.BillNo,
      Amount:sp.Amount, Status:parent.Status, HeadID:sp.HeadID };
  });

  const allocs = getTableCached(SHEETS.ALLOC).filter(a =>
    fyMatches_(a.FY, fy) && campusIds.includes(a.CampusID) && headIds.includes(a.HeadID));

  const rows = allHeads.filter(h => headIds.includes(h.HeadID)).map(h => {
    const spentNormal = entries.filter(e => e.HeadID === h.HeadID).reduce((s,e) => s + Number(e.Amount||0), 0);
    const spentSplits = splits.filter(sp => sp.HeadID === h.HeadID).reduce((s,sp) => s + Number(sp.Amount||0), 0);
    const spent = spentNormal + spentSplits;
    const allocated = allocs.filter(a => a.HeadID === h.HeadID).reduce((s,a) => s + Number(a.AllocatedAmount||0), 0);
    const balance = allocated - spent;
    const consumedPct = allocated > 0 ? (spent / allocated * 100) : (spent > 0 ? 100 : 0);
    return { headId:h.HeadID, headCode:h.HeadCode, headName:h.HeadName, allocated, spent, balance, consumedPct };
  }).filter(r => r.allocated > 0 || r.spent > 0)
    .sort((a,b) => b.spent - a.spent);

  const totals = rows.reduce((acc,r) => {
    acc.allocated += r.allocated; acc.spent += r.spent; acc.balance += r.balance; return acc;
  }, { allocated:0, spent:0, balance:0 });
  totals.consumedPct = totals.allocated > 0 ? (totals.spent / totals.allocated * 100) : 0;

  entries = entries.concat(splitDetailRows);

  const scopeLabel = isAllCampuses
    ? 'All Campuses (Consolidated)'
    : (allCampuses.filter(c => campusIds.includes(c.CampusID)).map(c => c.CampusName).join(', ') || 'Selected Campus');

  return {
    fy: fy || 'All Years', scopeLabel, isAllCampuses, rows, totals,
    entries: entries.sort((a,b) => new Date(b.EntryDate) - new Date(a.EntryDate))
  };
}

/* ---------- Confirmed Payments (money ACTUALLY confirmed received) ----------
   A bulk bill's beneficiaries are shown individually, each only once their OWN line is
   Confirmed. A beneficiary isolated into its own bill (E123-A) appears as that bill once
   it is confirmed. */
function getConfirmedPayments(filters) {
  filters = filters || {};
  const isLineConfirmed_ = li => li.LinePaymentStatus === 'Confirmed' || (!li.LinePaymentStatus && !li.RedirectedToEntryID);
  let normal = getTable(SHEETS.ENTRIES).filter(e =>
    e.PayeeType !== 'Bulk' && statusEquals_(e.Status, STATUS.PAID) && (e.PaymentStatus === 'Confirmed' || !e.PaymentStatus));
  let bulkParents = getTable(SHEETS.ENTRIES).filter(e => e.PayeeType === 'Bulk' && statusEquals_(e.Status, STATUS.PAID));
  let bulkLines = expandBulkItems_(bulkParents).filter(isLineConfirmed_);
  let rows = normal.concat(bulkLines);

  if (filters.fy) rows = rows.filter(e => fyMatches_(e.FY, filters.fy));
  if (filters.campusId) rows = rows.filter(e => e.CampusID === filters.campusId);
  if (filters.billId) rows = rows.filter(e => String(e.EntryID).toLowerCase().includes(String(filters.billId).toLowerCase()));
  if (filters.employeeId) rows = rows.filter(e => String(e.EmployeeID||'').toLowerCase().includes(String(filters.employeeId).toLowerCase()));
  if (filters.vendor) rows = rows.filter(e => String(e.VendorName).toLowerCase().includes(filters.vendor.toLowerCase()));
  if (filters.description) rows = rows.filter(e => String(e.BillDescription).toLowerCase().includes(filters.description.toLowerCase()));
  if (filters.minAmount) rows = rows.filter(e => Number(e.Amount) >= Number(filters.minAmount));
  if (filters.maxAmount) rows = rows.filter(e => Number(e.Amount) <= Number(filters.maxAmount));
  rows = rows.sort((a,b) => new Date(b.PaidDate) - new Date(a.PaidDate));
  const truncated = rows.length > 1000;
  return { rows: rows.slice(0, 1000), truncated, totalMatched: rows.length };
}

/* ---------- Budget Control Register ---------- */
function getBudgetControlRegister(filters) {
  filters = filters || {};
  const fy = filters.fy !== undefined && filters.fy !== null ? String(filters.fy).trim() : DEFAULT_FY;
  const campuses = getCampuses();
  const heads = getBudgetHeads();
  const campusIds = (filters.campusIds && filters.campusIds.length) ? filters.campusIds : campuses.map(c => c.CampusID);
  const headIds = (filters.headIds && filters.headIds.length) ? filters.headIds : heads.map(h => h.HeadID);

  const entries = getTable(SHEETS.ENTRIES).filter(e =>
    fyMatches_(e.FY, fy) && campusIds.includes(e.CampusID) && headIds.includes(e.HeadID) && isBudgetImpacting_(e.BillNature) && !statusEquals_(e.Status, STATUS.CANCELLED) && !e.SplitFromEntryID);
  const allocs = getTableCached(SHEETS.ALLOC).filter(a =>
    fyMatches_(a.FY, fy) && campusIds.includes(a.CampusID) && headIds.includes(a.HeadID));

  let splits = getTable(SHEETS.HEADSPLITS).filter(sp =>
    fyMatches_(sp.FY, fy) && campusIds.includes(sp.CampusID) && headIds.includes(sp.HeadID));
  const splitParents = {};
  if (splits.length) {
    const parentIds = new Set(splits.map(sp => sp.ParentEntryID));
    getTable(SHEETS.ENTRIES).filter(e => parentIds.has(e.EntryID)).forEach(e => splitParents[e.EntryID] = e);
    splits = splits.filter(sp => !statusEquals_((splitParents[sp.ParentEntryID]||{}).Status, STATUS.CANCELLED));
  }
  const splitPseudoEntries = splits.map(sp => {
    const parent = splitParents[sp.ParentEntryID] || {};
    return { EntryID:sp.ParentEntryID, CampusID:sp.CampusID, HeadID:sp.HeadID, EntryDate:sp.EntryDate, BillDescription:parent.BillDescription,
      VendorName:parent.VendorName, BillNo:parent.BillNo, Amount:sp.Amount, Status:parent.Status };
  });
  let allEntries = entries.concat(splitPseudoEntries);

  // Bills moved between cost centres: the cost centre a bill LEFT keeps its original booking plus a visible REVERSAL row,
  // and the bill's current row says where it came from.
  const transfers = getTable(SHEETS.CCTRANSFERS).filter(t => fyMatches_(t.FY, fy));
  if (transfers.length) {
    const byBill = {};
    transfers.forEach(t => { (byBill[t.EntryID] || (byBill[t.EntryID] = [])).push(t); });
    Object.keys(byBill).forEach(k => byBill[k].sort((a, b) => new Date(a.TransferDate) - new Date(b.TransferDate)));
    const billInfo = {};
    getTable(SHEETS.ENTRIES).filter(e => byBill[e.EntryID]).forEach(e => { billInfo[e.EntryID] = e; });
    const extra = [];
    Object.keys(byBill).forEach(id => {
      const bill = billInfo[id] || {};
      byBill[id].forEach((t, i) => {
        const amt = Number(t.Amount || 0);
        const toLabel = t.ToCampusName + ' / ' + t.ToHeadCode;
        const fromLabel = t.FromCampusName + ' / ' + t.FromHeadCode;
        const base = { EntryID: id, CampusID: t.FromCampusID, HeadID: t.FromHeadID, VendorName: bill.VendorName, BillNo: bill.BillNo, Status: bill.Status };
        // what the cost centre it is leaving had booked: the original booking (or the earlier transfer-in)
        extra.push(Object.assign({}, base, i === 0
          ? { EntryDate: bill.EntryDate, Amount: amt, BillDescription: '[ORIGINAL BOOKING - later transferred] ' + (bill.BillDescription || '') }
          : { EntryDate: byBill[id][i - 1].TransferDate, Amount: amt, BillDescription: '[TRANSFERRED IN from ' + byBill[id][i - 1].FromCampusName + ' / ' + byBill[id][i - 1].FromHeadCode + ']' }));
        extra.push(Object.assign({}, base, { EntryDate: t.TransferDate, Amount: -amt,
          BillDescription: '[REVERSAL - transferred out to ' + toLabel + ' by ' + t.TransferredBy + ': ' + (t.Reason || '') + ']' }));
      });
    });
    allEntries = allEntries.map(e => {
      const list = byBill[e.EntryID];
      if (!list) return e;
      const last = list[list.length - 1];
      return Object.assign({}, e, { BillDescription: '[Transferred in from ' + last.FromCampusName + ' / ' + last.FromHeadCode + ' on ' + fmtDate_(last.TransferDate) + '] ' + (e.BillDescription || '') });
    }).concat(extra);
  }

  const groups = [];
  campuses.filter(c => campusIds.includes(c.CampusID)).forEach(c => {
    heads.filter(h => headIds.includes(h.HeadID)).forEach(h => {
      const groupEntries = allEntries.filter(e => e.CampusID === c.CampusID && e.HeadID === h.HeadID)
        .sort((a,b) => new Date(a.EntryDate) - new Date(b.EntryDate));
      const allocated = allocs.filter(a => a.CampusID === c.CampusID && a.HeadID === h.HeadID)
        .reduce((s,a) => s + Number(a.AllocatedAmount||0), 0);
      if (!groupEntries.length && !allocated) return;
      let running = allocated;
      let progressiveTotal = 0;
      const bills = groupEntries.map(e => {
        const amt = Number(e.Amount||0);
        const consumedBefore = progressiveTotal;
        progressiveTotal += amt;
        running -= amt;
        return { entryId:e.EntryID, date:e.EntryDate, description:e.BillDescription, vendor:e.VendorName, billNo:e.BillNo,
          amount:amt, status:e.Status, consumedBefore, progressiveTotal, runningBalance:running };
      });
      const consumed = groupEntries.reduce((s,e) => s + Number(e.Amount||0), 0);
      groups.push({
        campusName:c.CampusName, headCode:h.HeadCode, headName:h.HeadName,
        allocated, consumed, balance: allocated - consumed, bills
      });
    });
  });
  return { fy, groups };
}

/* ---------- Report 3: Bill Status ----------
   Full entry-level rows. A bulk bill is replaced by its individual beneficiary rows (each shows
   its own FBR Section). A beneficiary that was isolated into its own bill (E123-A) is left out
   of the bulk bill's rows because it now appears as its own bill. */
function getBillStatusReport(filters) {
  filters = filters || {};
  const fy = (filters.fy !== undefined && filters.fy !== null) ? String(filters.fy).trim() : DEFAULT_FY;
  const allEntries = getTable(SHEETS.ENTRIES).filter(e => fyMatches_(e.FY, fy));
  const bulkParents = allEntries.filter(e => e.PayeeType === 'Bulk');
  const normalEntries = allEntries.filter(e => e.PayeeType !== 'Bulk');
  let entries = normalEntries.concat(expandBulkItems_(bulkParents));
  entries = entries.filter(e => !e.SplitToEntryID);

  if (filters.status) entries = entries.filter(e => statusEquals_(e.Status, filters.status));
  if (filters.campusIds && filters.campusIds.length) entries = entries.filter(e => filters.campusIds.includes(e.CampusID));
  if (filters.fromDate) entries = entries.filter(e => e.EntryDate && new Date(e.EntryDate) >= new Date(filters.fromDate));
  if (filters.toDate) entries = entries.filter(e => e.EntryDate && new Date(e.EntryDate) <= new Date(filters.toDate));
  if (filters.billId) entries = entries.filter(e => String(e.EntryID).toLowerCase().includes(filters.billId.toLowerCase()));
  if (filters.vendor) entries = entries.filter(e => String(e.VendorName).toLowerCase().includes(filters.vendor.toLowerCase()));
  if (filters.employeeId) entries = entries.filter(e => String(e.EmployeeID).toLowerCase().includes(filters.employeeId.toLowerCase()));
  if (filters.amount) entries = entries.filter(e => String(e.Amount).includes(filters.amount));
  if (filters.description) entries = entries.filter(e => String(e.BillDescription).toLowerCase().includes(filters.description.toLowerCase()));
  if (filters.iban) entries = entries.filter(e => String(e.IBAN).toLowerCase().includes(filters.iban.toLowerCase()));
  return entries.sort((a,b) => new Date(b.EntryDate) - new Date(a.EntryDate));
}

/* ---------- General Ledger: one account per vendor/employee ----------
   Only PAID and payment-CONFIRMED bills count. A bulk beneficiary appears under its own
   account; a line redirected or isolated away (SplitToEntryID) is not counted under the bulk
   bill (an isolated beneficiary counts as its own bill E123-A once that is confirmed). */
function getGeneralLedger(filters) {
  filters = filters || {};
  const fy = (filters.fy !== undefined && filters.fy !== null) ? String(filters.fy).trim() : '';
  const vendorFilter = (filters.vendor || '').toLowerCase();
  const cnicFilter = (filters.cnic || '').toLowerCase();
  const ibanFilter = (filters.iban || '').toLowerCase();
  const employeeIdFilter = (filters.employeeId || '').toLowerCase();

  const isPaymentConfirmed_ = e => !e.PaymentStatus || e.PaymentStatus === 'Confirmed';
  const paidNormal = getTable(SHEETS.ENTRIES).filter(e =>
    statusEquals_(e.Status, STATUS.PAID) && e.PayeeType !== 'Student' && e.PayeeType !== 'Bulk' && isPaymentConfirmed_(e));
  const paidBulkParents = getTable(SHEETS.ENTRIES).filter(e =>
    statusEquals_(e.Status, STATUS.PAID) && e.PayeeType === 'Bulk' && isPaymentConfirmed_(e));
  const paidBulkBeneficiaries = expandBulkItems_(paidBulkParents).filter(e =>
    e.PayeeType !== 'Student' && !e.RedirectedToEntryID && !e.SplitToEntryID);
  const allPaid = paidNormal.concat(paidBulkBeneficiaries);
  const byVendor = {};
  allPaid.forEach(e => {
    const key = e.VendorName || '(Unknown)';
    if (!byVendor[key]) byVendor[key] = { vendorName:key, iban:e.IBAN, cnic:e.CNIC_NTN, employeeId:e.EmployeeID, allBills:[] };
    byVendor[key].allBills.push(e);
    byVendor[key].iban = e.IBAN || byVendor[key].iban;
    byVendor[key].cnic = e.CNIC_NTN || byVendor[key].cnic;
    byVendor[key].employeeId = e.EmployeeID || byVendor[key].employeeId;
  });

  const vendors = Object.keys(byVendor).map(k => byVendor[k]).filter(v =>
    (!vendorFilter || v.vendorName.toLowerCase().includes(vendorFilter)) &&
    (!cnicFilter || String(v.cnic).toLowerCase().includes(cnicFilter)) &&
    (!ibanFilter || String(v.iban).toLowerCase().includes(ibanFilter)) &&
    (!employeeIdFilter || String(v.employeeId).toLowerCase().includes(employeeIdFilter))
  );

  const result = vendors.map(v => {
    // Lifetime security balance (all years) - a security deposit held in one year is still owed later.
    let securityBalance = 0;
    v.allBills.forEach(e => {
      if (e.BillNature === 'Release of Security') securityBalance -= Number(e.Amount||0);
      else securityBalance += Number(e.SecurityAmount||0);
    });

    const scoped = v.allBills.filter(e => fyMatches_(e.FY, fy));
    const totals = scoped.reduce((acc,e) => {
      acc.gross += Number(e.Amount||0);
      acc.incomeTax += Number(e.IncomeTaxAmount||0);
      acc.salesTax += Number(e.SalesTaxAmount||0);
      acc.pst += Number(e.PSTAmount||0);
      acc.penalty += Number(e.PenaltyAmount||0);
      acc.security += Number(e.SecurityAmount||0);
      acc.otherDeductions += Number(e.OtherDeductionAmount||0);
      acc.net += Number(netOf_(e));
      return acc;
    }, { gross:0, incomeTax:0, salesTax:0, pst:0, penalty:0, security:0, otherDeductions:0, net:0 });

    return {
      vendorName: v.vendorName, iban: v.iban, cnic: v.cnic, employeeId: v.employeeId,
      billCount: scoped.length, totals, securityBalance,
      bills: scoped.sort((a,b) => new Date(b.EntryDate) - new Date(a.EntryDate)).map(e => ({
        entryId:e.EntryID, date:e.EntryDate, billNo:e.BillNo, description:e.BillDescription, nature:e.BillNature,
        campus:e.CampusName, headCode:e.HeadCode, headName:e.HeadName, status:e.Status,
        gross:Number(e.Amount||0), incomeTax:Number(e.IncomeTaxAmount||0), salesTax:Number(e.SalesTaxAmount||0),
        pst:Number(e.PSTAmount||0), penalty:Number(e.PenaltyAmount||0), security:Number(e.SecurityAmount||0),
        otherDeductions:Number(e.OtherDeductionAmount||0), net:Number(netOf_(e))
      }))
    };
  }).filter(v => v.billCount > 0)
    .sort((a,b) => b.totals.net - a.totals.net);

  return { fy: fy || 'All Years', vendors: result };
}

/* ================= REPORT 6: IBFT Payment =================
   Every bill actually paid out (IBFT batch SUBMITTED), in the same column layout as the Stage 4
   export. Filtered by Payment (Paid) Date. This mirrors what was sent to the bank, so a
   beneficiary that later bounced still appears in its original batch; the retry appears as a
   separate row (Bill ID with a retry marker, e.g. E123-A-1). */
function getIBFTPaymentReport(filters) {
  filters = filters || {};
  const fromDate = filters.fromDate ? new Date(filters.fromDate) : null;
  const toDate = filters.toDate ? new Date(filters.toDate) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  let paidBills = getTable(SHEETS.ENTRIES).filter(e => {
    if (!statusEquals_(e.Status, STATUS.PAID) || !e.PaidDate) return false;
    const paidDate = new Date(e.PaidDate);
    if (fromDate && paidDate < fromDate) return false;
    if (toDate && paidDate > toDate) return false;
    return true;
  });

  const items = expandBulkItems_(paidBills)
    .sort((a,b) => new Date(b.PaidDate) - new Date(a.PaidDate))
    .map(mapEntryToIBFTRow_)
    .filter(it => it.netPayment > 0);

  const totals = items.reduce((acc, it) => {
    acc.grossAmount += it.grossAmount; acc.incomeTax += it.incomeTax; acc.salesTax += it.salesTax;
    acc.punjabSalesTax += it.punjabSalesTax; acc.security += it.security; acc.penalty += it.penalty;
    acc.otherDeduction += it.otherDeduction; acc.netPayment += it.netPayment;
    return acc;
  }, { grossAmount:0, incomeTax:0, salesTax:0, punjabSalesTax:0, security:0, penalty:0, otherDeduction:0, netPayment:0 });

  return { items, totals, count: items.length };
}

/* ================= REPORT 7: Sanction Proforma ================= */
// Bill picker - a bulk bill is one selectable row; it is expanded into beneficiaries only
// inside getSanctionProformaData. NOTE: an isolated beneficiary bill (E123-A) is its own bill -
// select it too if it should appear on the letter.
function getEntriesForSanctionPicker(filters) {
  filters = filters || {};
  const fy = (filters.fy !== undefined && filters.fy !== null) ? String(filters.fy).trim() : DEFAULT_FY;
  let entries = getTable(SHEETS.ENTRIES).filter(e => fyMatches_(e.FY, fy));
  if (filters.status) entries = entries.filter(e => statusEquals_(e.Status, filters.status));
  if (filters.campusIds && filters.campusIds.length) entries = entries.filter(e => filters.campusIds.includes(e.CampusID));
  if (filters.vendor) entries = entries.filter(e => String(e.VendorName).toLowerCase().includes(filters.vendor.toLowerCase()));
  if (filters.description) entries = entries.filter(e => String(e.BillDescription).toLowerCase().includes(filters.description.toLowerCase()));
  if (filters.billId) entries = entries.filter(e => String(e.EntryID).toLowerCase().includes(filters.billId.toLowerCase()));
  if (filters.fromDate) entries = entries.filter(e => e.EntryDate && new Date(e.EntryDate) >= new Date(filters.fromDate));
  if (filters.toDate) entries = entries.filter(e => e.EntryDate && new Date(e.EntryDate) <= new Date(filters.toDate));
  return entries.sort((a,b) => new Date(b.EntryDate) - new Date(a.EntryDate));
}

function getSanctionProformaData(entryIds) {
  if (!entryIds || !entryIds.length) return { error: 'Select at least one bill.' };
  const allEntries = getTable(SHEETS.ENTRIES);
  const byId = {};
  allEntries.forEach(e => byId[e.EntryID] = e);
  const selected = entryIds.map(id => byId[id]).filter(Boolean);
  if (!selected.length) return { error: 'Selected bills were not found - they may have been deleted.' };

  const bulkParents = selected.filter(e => e.PayeeType === 'Bulk');
  const normalRows = selected.filter(e => e.PayeeType !== 'Bulk');
  const tableRows = normalRows.concat(expandBulkItems_(bulkParents));

  const grossTotal = selected.reduce((s,e) => s + Number(e.Amount||0), 0);

  const anySingleBillIsMultiHead = selected.some(e => e.HeadCode === '(Multiple)');
  const headKeys = uniq_(selected.map(e => (e.HeadCode||'') + '||' + (e.HeadName||'')));
  const headText = (anySingleBillIsMultiHead || headKeys.length > 1)
    ? 'Multi Heads'
    : ((selected[0].HeadCode || '') + ' - ' + (selected[0].HeadName || ''));

  const natureKeys = uniq_(selected.map(e => e.BillNature || ''));
  let descriptionText;
  if (natureKeys.length === 1) {
    const descKeys = uniq_(selected.map(e => e.BillDescription || ''));
    descriptionText = (descKeys.length === 1 && descKeys[0]) ? descKeys[0] : (selected[0].BillNature || selected[0].BillDescription || 'Expenditure');
  } else {
    descriptionText = 'Multi Misc. Nature Bills';
  }

  const fyKeys = uniq_(selected.map(e => e.FY || ''));
  const fy = fyKeys.length === 1 ? fyKeys[0] : selected.map(e=>e.FY).sort().pop();

  return {
    grossAmount: round0_(grossTotal),
    grossAmountWords: numberToWordsPKR_(round0_(grossTotal)),
    billDescription: descriptionText,
    headText: headText,
    fy: fy,
    billCount: selected.length,
    rows: tableRows.map(r => ({
      billId: r.EntryID, date: r.EntryDate, campus: r.CampusName, headCode: r.HeadCode, headName: r.HeadName,
      payeeType: r.PayeeType, vendor: r.VendorName, billNo: r.BillNo, description: r.BillDescription, nature: r.BillNature,
      gross: Number(r.Amount||0), incomeTax: Number(r.IncomeTaxAmount||0), salesTax: Number(r.SalesTaxAmount||0),
      pst: Number(r.PSTAmount||0), security: Number(r.SecurityAmount||0), penalty: Number(r.PenaltyAmount||0),
      other: Number(r.OtherDeductionAmount||0), net: Number(netOf_(r)), status: r.Status
    }))
  };
}
function uniq_(arr) { return Array.from(new Set(arr)); }

// South Asian (Lakh/Crore) number-to-words for the sanction letter.
function numberToWordsPKR_(amount) {
  amount = Math.round(Number(amount) || 0);
  if (amount === 0) return 'Rupees Zero Only';
  const negative = amount < 0;
  amount = Math.abs(amount);
  const onesWords = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tensWords = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function twoDigits(n) {
    if (n < 20) return onesWords[n];
    return tensWords[Math.floor(n/10)] + (n%10 ? ' ' + onesWords[n%10] : '');
  }
  function threeDigits(n) {
    if (n < 100) return twoDigits(n);
    return onesWords[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' ' + twoDigits(n%100) : '');
  }
  let n = amount;
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = n;
  const parts = [];
  if (crore) parts.push(threeDigits(crore) + ' Crore');
  if (lakh) parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (hundred) parts.push(threeDigits(hundred));
  return (negative ? 'Minus ' : '') + 'Rupees ' + parts.join(' ') + ' Only';
}

/* ================= REPORT: Tax Calculation Details =================
   Loads ONE bill (or ONE beneficiary line of a bulk bill, by "ParentID-LineNo") and returns
   every figure behind its tax calculation. Passing a bulk parent's ID returns every
   beneficiary line, one row each (each with its own FBR Section). */
function getTaxCalculationDetails(billId, actorUsername) {
  requireReportsAccess_(actorUsername);
  billId = String(billId || '').trim();
  if (!billId) return { success: false, message: 'Enter a Bill ID.' };
  const bulkRef = parseBulkLineId_(billId);
  const baseId = bulkRef ? bulkRef.parentId : billId;
  const bill = getTable(SHEETS.ENTRIES).find(e => e.EntryID === baseId);
  if (!bill) return { success: false, message: 'Bill not found.' };

  const rows = [];
  if (bill.PayeeType === 'Bulk') {
    let lines = getTable(SHEETS.BULKITEMS).filter(li => li.ParentEntryID === baseId);
    if (bulkRef) lines = lines.filter(li => String(li.LineNo) === String(bulkRef.lineNo));
    if (!lines.length) return { success: false, message: 'Beneficiary line not found in this bulk bill.' };
    lines.sort((a,b) => Number(a.LineNo) - Number(b.LineNo)).forEach(li => rows.push(buildTaxCalcRow_(bill, li)));
  } else {
    rows.push(buildTaxCalcRow_(bill, null));
  }
  return { success: true, billId: baseId, isBulk: bill.PayeeType === 'Bulk', billNature: bill.BillNature, rows };
}
function buildTaxCalcRow_(bill, line) {
  const isLine = !!line;
  const src = isLine ? line : bill;
  const gross = Number(src.Amount || 0);
  const incomeTax = Number(src.IncomeTaxAmount || 0);
  const salesTax = Number(src.SalesTaxAmount || 0);
  const pst = Number(src.PSTAmount || 0);
  const security = Number(src.SecurityAmount || 0);
  const penalty = Number(src.PenaltyAmount || 0);
  const other = Number(src.OtherDeductionAmount || 0);
  const studentDed = isLine ? 0 : Number(bill.StudentDeductionAmount || 0);
  const net = src.NetAmount !== undefined && src.NetAmount !== '' ? Number(src.NetAmount) : round0_(gross - incomeTax - salesTax - pst - security - penalty - other - studentDed);
  const rawCredit = Number((isLine ? line.Section149CreditApplied : bill.Section149CreditApplied) || 0);
  const eff = amt => gross > 0 ? amt / gross : 0;
  return {
    billId: isLine ? (line.ParentEntryID + '-' + line.LineNo) : bill.EntryID,
    parentBillId: isLine ? line.ParentEntryID : '',
    date: bill.EntryDate,
    campus: bill.CampusName,
    payeeType: isLine ? line.PayeeType : bill.PayeeType,
    employeeId: isLine ? line.EmployeeID : bill.EmployeeID,
    cnic: isLine ? line.CNIC_NTN : bill.CNIC_NTN,
    beneficiary: isLine ? line.VendorName : bill.VendorName,
    iban: isLine ? line.IBAN : bill.IBAN,
    designation: isLine ? '' : (bill.Designation || ''),
    billNature: isLine ? (line.BillNature || bill.BillNature) : bill.BillNature,
    gross,
    fbrSection: isLine ? (line.IncomeTaxSection || '') : (bill.IncomeTaxSection || ''),
    incomeTaxRate: isLine ? eff(incomeTax) : Number(bill.IncomeTaxRate || 0),
    incomeTaxAmount: incomeTax,
    affidavit: isLine ? null : !!bill.AffidavitLowIncome,
    nonUeTaxMethod: isLine ? '' : (bill.NonUETaxMethod || ''),
    incomeBefore: isLine ? null : (bill.IncomeBeforeThisBill === '' || bill.IncomeBeforeThisBill === undefined ? null : Number(bill.IncomeBeforeThisBill)),
    incomeAfter: isLine ? null : (bill.IncomeAfterThisBill === '' || bill.IncomeAfterThisBill === undefined ? null : Number(bill.IncomeAfterThisBill)),
    creditApplied: rawCredit > 0 ? rawCredit : 0,
    outstandingAdjusted: rawCredit < 0 ? Math.abs(rawCredit) : 0,
    salesTaxRate: isLine ? eff(salesTax) : Number(bill.SalesTaxRate || 0),
    salesTaxAmount: salesTax,
    pstRate: isLine ? eff(pst) : Number(bill.PSTRate || 0),
    pstAmount: pst,
    pstCategory: isLine ? '' : (bill.ContractCategory || ''),
    securityRate: isLine ? eff(security) : Number(bill.SecurityRate || 0),
    securityAmount: security,
    penaltyRate: isLine ? eff(penalty) : Number(bill.PenaltyRate || 0),
    penaltyAmount: penalty,
    otherDeductionRate: isLine ? eff(other) : Number(bill.OtherDeductionRate || 0),
    otherDeductionAmount: other,
    studentDeductionAmount: studentDed,
    manualTaxOverride: isLine ? false : !!bill.ManualTaxOverride,
    netAmount: net,
    pipelineStatus: bill.Status,
    linePaymentStatus: isLine ? (line.LinePaymentStatus || '') : (bill.PaymentStatus || ''),
    redirectedTo: isLine ? (line.RedirectedToEntryID || line.SplitToEntryID) : bill.RedirectedToEntryID
  };
}

/* ================= REPORT 8: Diary Report =================
   One row per Diary item (Bill or Letter), at whatever stage, plus a completed one's total
   turnaround. Uses the same engine as the Diary tab, so it never disagrees with it. */
// true  = every user may look at anyone's Diary items (regular users just START on their own name).
// false = a regular user is always limited to their own items (Admin and Diary Clerk still see everyone).
const DIARY_REPORT_USERS_SEE_ALL = true;
function getDiaryReport(filters, username) {
  filters = Object.assign({ includeCompleted: true, minDaysWaiting: 0 }, filters || {});
  if (!DIARY_REPORT_USERS_SEE_ALL) {
    const role = getUserRole_(username);
    if (role !== 'Admin' && role !== 'DiaryClerk') filters.assignedTo = username;
  }
  const rows = buildDiaryTrackingRows_(filters);

  const buckets = [1, 2, 3, 4, 5, 6];
  const chartData = buckets.map(d => ({ day: String(d), count: rows.filter(r => r.daysWaiting === d).length }));
  chartData.push({ day: '7+', count: rows.filter(r => r.daysWaiting >= 7).length });

  return {
    rows: rows.map(r => ({
      diaryId: r.diaryId, date: r.dateReceived, itemType: r.itemType, billType: r.billType, amount: r.amount,
      campus: r.originatingOffice || '-', assignedTo: r.assignedTo, currentStatus: r.stageLabel,
      daysInQueue: r.daysWaiting, isComplete: r.isComplete
    })),
    chartData
  };
}

/* ================= REPORT: Duplicate-Payment Recovery Statement (by Employee ID) =================
   Everything about amounts paid twice by mistake to one person: the duplicated payment, each deduction
   made so far from later bills, and the balance still to recover. Also accepts a CNIC / Student ID. */
function getRecoveryStatement(key, actorUsername) {
  requireReportsAccess_(actorUsername);
  key = String(key || '').trim();
  if (!key) return { success: false, message: 'Enter an Employee ID.' };
  const kl = key.toLowerCase();
  const recs = getTable(SHEETS.DUPREC).filter(r =>
    String(r.EmployeeID).trim().toLowerCase() === kl || String(r.CNIC_NTN).trim().toLowerCase() === kl ||
    ['emp|', 'stu|', 'cnic|'].some(p => String(r.BeneficiaryKey).toLowerCase() === p + kl));
  if (!recs.length) return { success: false, message: 'No duplicate-payment recovery is on record for "' + key + '".' };

  const entriesById = {};
  getTable(SHEETS.ENTRIES).forEach(e => { entriesById[e.EntryID] = e; });
  const lineById = {};
  getTable(SHEETS.BULKITEMS).forEach(li => { lineById[li.ParentEntryID + '-' + li.LineNo] = li; });
  const info = id => {
    const li = lineById[id];
    if (li) {
      const p = entriesById[li.ParentEntryID] || {};
      return { entryDate: p.EntryDate, paidDate: p.PaidDate, batchId: p.BatchID, status: p.Status,
        gross: Number(li.Amount || 0), net: netOf_(li), nature: li.BillNature || p.BillNature, description: li.BillDescription || p.BillDescription };
    }
    const e = entriesById[id];
    if (!e) return null;
    return { entryDate: e.EntryDate, paidDate: e.PaidDate, batchId: e.BatchID, status: e.Status,
      gross: Number(e.Amount || 0), net: netOf_(e), nature: e.BillNature, description: e.BillDescription };
  };
  const recIds = new Set(recs.map(r => r.RecoveryID));
  const appsAll = getTable(SHEETS.DUPRECAPP).filter(a => recIds.has(a.RecoveryID));

  const records = recs.map(r => {
    const src = info(String(r.SourceEntryID)) || {};
    const cancelled = String(r.Status) === 'Cancelled';
    const apps = appsAll.filter(a => a.RecoveryID === r.RecoveryID)
      .sort((a, b) => new Date(a.AppliedDate) - new Date(b.AppliedDate))
      .map(a => {
        const bi = info(String(a.EntryID)) || {};
        return { entryId: a.EntryID, billDate: bi.entryDate ? fmtDate_(bi.entryDate) : '', billStatus: bi.status || '(deleted)',
          billGross: bi.gross, billNetAfterRecovery: bi.net, nature: bi.nature || '', amount: Number(a.Amount || 0),
          counted: recoveryAppIsActive_(a, entriesById) };
      });
    const recovered = apps.filter(a => a.counted).reduce((s, a) => s + a.amount, 0);
    const paid = Number(r.AmountPaidTwice || 0);
    const outstanding = cancelled ? 0 : Math.max(0, paid - recovered);
    return {
      recoveryId: r.RecoveryID, sourceEntryId: r.SourceEntryID, sourceBatch: src.batchId || '',
      sourcePaidDate: src.paidDate ? fmtDate_(src.paidDate) : '', sourceNature: src.nature || '', sourceDescription: src.description || '',
      sourceNetPaid: Number(r.SourceNetPaid || 0), amountPaidTwice: paid, recovered: recovered, outstanding: outstanding,
      status: cancelled ? 'Cancelled' : (outstanding > 0 ? 'Open' : 'Fully Recovered'),
      registeredBy: r.CreatedBy, registeredDate: r.CreatedDate ? fmtDate_(r.CreatedDate) : '', notes: r.Notes || '', cancelReason: r.CancelReason || '',
      applications: apps
    };
  }).sort((a, b) => String(a.recoveryId).localeCompare(String(b.recoveryId), undefined, { numeric: true }));

  let name = recs[0].BeneficiaryName;
  let designation = '';
  const emp = getEmployeeById(key);
  if (emp) { name = emp.Name; designation = emp.Designation || ''; }
  const live = records.filter(r => r.status !== 'Cancelled');
  return {
    success: true, key: key, name: name, designation: designation, records: records,
    totals: {
      paidTwice: live.reduce((s, r) => s + r.amountPaidTwice, 0),
      recovered: live.reduce((s, r) => s + r.recovered, 0),
      outstanding: live.reduce((s, r) => s + r.outstanding, 0)
    }
  };
}

/* ================= REPORT: Bank Reconciliation =================
   Every payment that went out in an IBFT batch (bulk bills expanded into their beneficiaries), by the
   bank account it was paid from and the payment date. Net Amount is what actually left the bank for that
   beneficiary (after taxes, deductions and any duplicate-payment recovery). */
function getBankReconciliationReport(filters, actorUsername) {
  requireReportsAccess_(actorUsername);
  filters = filters || {};
  const from = filters.fromDate ? new Date(filters.fromDate) : null;
  const to = filters.toDate ? new Date(filters.toDate) : null;
  if (to) to.setHours(23, 59, 59, 999);
  const parents = getTable(SHEETS.ENTRIES).filter(e => {
    if (!e.PaidDate) return false;
    // A bill cancelled AFTER being paid still moved money, so it stays visible here.
    if (!statusEquals_(e.Status, STATUS.PAID) && !statusEquals_(e.Status, STATUS.CANCELLED)) return false;
    const d = new Date(e.PaidDate);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  let rows = expandBulkItems_(parents);
  if (filters.accountId) rows = rows.filter(e => e.PayFromAccountID === filters.accountId);
  const out = rows.map(e => {
    const isLine = !!parseBulkLineId_(e.EntryID);
    let payStatus = isLine
      ? (e.LinePaymentStatus || (e.PaymentStatus === 'Confirmed' ? 'Confirmed' : 'Submitted'))
      : (e.PaymentStatus || 'Submitted');
    const retry = Number(e.PaymentRetryCount || 0);
    const confirmed = isLine ? e.LinePaymentConfirmedDate : e.PaymentConfirmedDate;
    const reason = isLine ? e.LinePaymentFailureReason : e.PaymentFailureReason;
    const notes = [];
    if (statusEquals_(e.Status, STATUS.CANCELLED)) notes.push('Bill cancelled after payment');
    if (e.RedirectedToEntryID) notes.push('Redirected to ' + e.RedirectedToEntryID);
    if (e.SplitToEntryID) notes.push('Isolated as ' + e.SplitToEntryID);
    if (e.SplitFromEntryID) notes.push('Isolated from ' + e.SplitFromEntryID);
    const net = netOf_(e);
    const iban = normIban_(e.IBAN);
    return {
      paymentDate: fmtDate_(e.PaidDate), batchId: e.BatchID || '', billId: retry > 0 ? e.EntryID + '-' + retry : e.EntryID,
      payFromAccount: e.PayFromAccountLabel || '', accountNo: e.PayFromAccountNumber || '',
      beneficiary: e.VendorName || '', employeeId: e.EmployeeID || '', cnicNtn: e.CNIC_NTN || '', iban: e.IBAN || '',
      bankShortName: iban.length >= 8 ? iban.substring(4, 8) : '',
      billNature: e.BillNature || '', description: e.BillDescription || '', fy: e.FY || '', campus: e.CampusName || '',
      gross: Number(e.Amount || 0), incomeTax: Number(e.IncomeTaxAmount || 0), salesTax: Number(e.SalesTaxAmount || 0),
      pst: Number(e.PSTAmount || 0), security: Number(e.SecurityAmount || 0), penalty: Number(e.PenaltyAmount || 0),
      otherDeduction: Number(e.OtherDeductionAmount || 0), recovery: Number(e.RecoveryDeducted || 0), net: net,
      paymentStatus: payStatus, confirmedDate: confirmed ? fmtDate_(confirmed) : '', failureReason: reason || '',
      inBankFile: net > 0 ? 'Yes' : 'No (zero net)', billStatus: e.Status || '', notes: notes.join('; ')
    };
  });
  let result = out;
  if (filters.paymentStatus) result = result.filter(r => r.paymentStatus === filters.paymentStatus);
  result.sort((a, b) => String(b.paymentDate).localeCompare(String(a.paymentDate)) || String(a.billId).localeCompare(String(b.billId), undefined, { numeric: true }));
  const truncated = result.length > 20000;
  return { success: true, rows: result.slice(0, 20000), truncated: truncated, totalMatched: result.length };
}


/* ================= REPORT: Bill Cycle Report =================
   One bill (or Diary number) from the day it was received to its final disposal: every stage with the date in/out
   and days spent, and a chronological action log showing who did what. For reporting to authority. */
function fmtDateTime_(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  return isNaN(dt) ? '' : Utilities.formatDate(dt, Session.getScriptTimeZone() || 'Asia/Karachi', 'yyyy-MM-dd HH:mm');
}
function calDaysBetween_(from, to) {
  const a = new Date(from), b = to ? new Date(to) : new Date();
  if (!from || isNaN(a) || isNaN(b)) return null;
  const sa = new Date(a.getFullYear(), a.getMonth(), a.getDate()), sb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((sb - sa) / 86400000));
}
function cycleMovementLabel_(a) {
  return { Assigned: 'Logged / Assigned', Forwarded: 'Forwarded', ClosedResponse: 'Closed - Response Issued', ClosedFiled: 'Closed - Filed',
    Returned: 'Returned', Reassigned: 'Reassigned', AdminReassigned: 'Reassigned (Admin)', SentToOffice: 'Sent to Another Office',
    ResumedByController: 'Re-assigned & Resumed', ReturnedForCorrection: 'Returned for Correction', BillDeleted: 'Bill Deleted - Back to Diary Pending',
    CombinedIntoBulkBill: 'Combined into a Bulk Bill', AdminEdited: 'Diary Details Edited (Admin)', AdminCancelled: 'Diary Cancelled (Admin)',
    AdminRestored: 'Diary Restored (Admin)', AdminDelinked: 'De-linked from Bill (Admin)', AdminLinked: 'Linked to Bill (Admin)' }[a] || a;
}
function cycleMovementActions_(movements) {
  return movements.map(m => {
    let detail = m.Details || '';
    if (m.ActionType === 'ClosedResponse') detail = 'Ref: ' + (m.ResponseRefNo || '-') + ', Dated: ' + (m.ResponseDate ? fmtDate_(m.ResponseDate) : '-') + (m.Details ? ' - ' + m.Details : '');
    if (m.ActionType === 'Returned') detail = 'Objection: ' + m.ReturnObjection + ' | Return Ref: ' + (m.ReturnRefNo || '-') + ' | Receiver: ' + (m.ReturnReceiverName || '-');
    if (m.ActionType === 'ReturnedForCorrection') detail = 'Objection: ' + (m.ReturnObjection || '') + (m.Details ? ' - ' + m.Details : '');
    return { sort: new Date(m.ActionDate).getTime() || 0, when: fmtDateTime_(m.ActionDate),
      action: cycleMovementLabel_(m.ActionType) + (m.ToUser ? ' -> ' + m.ToUser : '') + ' [' + m.DiaryID + ']',
      by: m.FromUser || '', detail: detail, source: 'Diary' };
  });
}
function cycleHoldDays_(movements, stillOpen) {
  let start = null, total = 0, openNow = false;
  movements.forEach(m => {
    if (['Returned', 'ReturnedForCorrection', 'SentToOffice'].indexOf(m.ActionType) !== -1) { if (!start) start = m.ActionDate; }
    else if (m.ActionType === 'ResumedByController' && start) { total += calDaysBetween_(start, m.ActionDate) || 0; start = null; }
  });
  if (start && stillOpen) { total += calDaysBetween_(start, null) || 0; openNow = true; }
  return { days: total, openNow: openNow };
}

function getBillCycleReport(idText, actorUsername) {
  requireReportsAccess_(actorUsername);
  const id = String(idText || '').trim().toUpperCase();
  if (!id) return { success: false, message: 'Enter a Bill ID or a Diary Number.' };
  const allDiary = getTable(SHEETS.DIARY);
  let entryId = '';
  if (/^DN-/.test(id)) {
    const d = allDiary.find(x => String(x.DiaryID).toUpperCase() === id);
    if (!d) return { success: false, message: 'Diary number not found.' };
    if (!d.LinkedEntryID) return buildDiaryOnlyCycle_(d);
    entryId = d.LinkedEntryID;
  } else {
    const ref = parseBulkLineId_(id);
    entryId = ref ? ref.parentId : id;
  }
  const entriesAll = getTable(SHEETS.ENTRIES);
  const entry = entriesAll.find(e => e.EntryID === entryId);
  if (!entry) return { success: false, message: 'Bill ' + entryId + ' was not found.' };
  const entriesById = {}; entriesAll.forEach(e => { entriesById[e.EntryID] = e; });

  const diaryRows = allDiary.filter(d => d.LinkedEntryID === entryId)
    .sort((a, b) => new Date(a.DateReceived) - new Date(b.DateReceived));
  const diaryIds = new Set(diaryRows.map(d => d.DiaryID));
  const movements = getTable(SHEETS.LETTERMOVEMENTS).filter(m => diaryIds.has(m.DiaryID))
    .sort((a, b) => new Date(a.ActionDate) - new Date(b.ActionDate));
  const payEvents = getTable(SHEETS.PAYMENTCONFIRM).filter(ev => String(ev.EntryID) === entryId || String(ev.EntryID).indexOf(entryId + '-') === 0)
    .sort((a, b) => new Date(a.EventDate) - new Date(b.EventDate));
  const isBulk = entry.PayeeType === 'Bulk';
  const lineCount = isBulk ? getTable(SHEETS.BULKITEMS).filter(li => li.ParentEntryID === entryId).length : 0;

  const cancelled = statusEquals_(entry.Status, STATUS.CANCELLED);
  const received = diaryRows.length ? diaryRows[0].DateReceived : entry.Timestamp;
  const finalDate = cancelled ? entry.CancelledDate : (entry.PaymentStatus === 'Confirmed' ? entry.PaymentConfirmedDate : null);
  const stageInfo = computeItemStage_(diaryRows[0] || { ItemType: 'Bill', LinkedEntryID: entryId, Status: 'Entered' }, entriesById);

  // ---- Stages ----
  const stages = [];
  const mk = (no, name, dIn, dOut, by, detail, current) => stages.push({
    no: no, stage: name, dateIn: dIn ? fmtDateTime_(dIn) : '', dateOut: dOut ? fmtDateTime_(dOut) : '',
    days: dIn ? calDaysBetween_(dIn, dOut || null) : null, actionBy: by || '', detail: detail || '',
    status: !dIn ? 'Not reached' : (dOut ? 'Completed' : (cancelled ? 'Stopped (cancelled)' : 'Current - waiting'))
  });
  if (diaryRows.length) {
    stages.push({ no: 1, stage: 'Diary (received & assigned)', dateIn: fmtDate_(diaryRows[0].DateReceived), dateOut: fmtDateTime_(entry.Timestamp),
      days: calDaysBetween_(diaryRows[0].DateReceived, entry.Timestamp), actionBy: 'Logged by ' + Array.from(new Set(diaryRows.map(d => d.LoggedBy))).join(', ') + '; entered as bill by ' + (entry.EnteredBy || '-'),
      detail: diaryRows.map(d => d.DiaryID + ' (assigned to ' + (d.AssignedToUsername || '-') + ')').join('; '), status: 'Completed' });
  } else {
    stages.push({ no: 1, stage: 'Diary (received & assigned)', dateIn: '', dateOut: '', days: null, actionBy: '',
      detail: 'No Diary record' + (entry.DiaryBypassReason ? ' - ' + entry.DiaryBypassReason : ''), status: 'Not applicable' });
  }
  mk(2, 'Processing', entry.Timestamp, entry.ProcessedDate, entry.ProcessedBy ? 'Processed by ' + entry.ProcessedBy : 'Entered by ' + (entry.EnteredBy || '-'), 'Bill entered, awaiting processing');
  mk(3, 'Passing', entry.ProcessedDate, entry.PassedDate, entry.PassedBy ? 'Passed by ' + entry.PassedBy : '', '');
  mk(4, 'Payment / IBFT', entry.PassedDate, entry.PaidDate, entry.PaidBy ? 'IBFT generated by ' + entry.PaidBy : '', entry.BatchID ? 'Batch ' + entry.BatchID : '');
  const confNote = entry.PaymentStatus === 'Failed' ? 'Payment FAILED: ' + (entry.PaymentFailureReason || '') : (isBulk ? lineCount + ' beneficiaries' : '');
  mk(5, 'Bank Confirmation', entry.PaidDate, entry.PaymentStatus === 'Confirmed' ? entry.PaymentConfirmedDate : null,
    entry.PaymentConfirmedBy ? 'Confirmed by ' + entry.PaymentConfirmedBy : '', confNote);
  if (cancelled) stages.push({ no: 6, stage: 'Cancelled', dateIn: fmtDateTime_(entry.CancelledDate), dateOut: '', days: null,
    actionBy: 'Cancelled by ' + (entry.CancelledBy || '-'), detail: (entry.CancellationReason || '') + (entry.StatusBeforeCancellation ? ' (was at ' + entry.StatusBeforeCancellation + ')' : ''), status: 'Final' });

  // ---- Action log ----
  const actions = cycleMovementActions_(movements);
  const add = (when, action, by, detail, source) => { if (when) actions.push({ sort: new Date(when).getTime() || 0, when: fmtDateTime_(when), action: action, by: by || '', detail: detail || '', source: source }); };
  add(entry.Timestamp, 'Bill Entered (' + entryId + ')', entry.EnteredBy, 'Gross ' + Number(entry.Amount || 0).toLocaleString() + ' - ' + (entry.BillDescription || ''), 'Bill');
  add(entry.ProcessedDate, 'Processed', entry.ProcessedBy, '', 'Bill');
  add(entry.PassedDate, 'Passed', entry.PassedBy, '', 'Bill');
  add(entry.PaidDate, 'IBFT Batch Generated', entry.PaidBy, entry.BatchID ? 'Batch ' + entry.BatchID : '', 'Bill');
  if (entry.PaymentStatus === 'Confirmed') add(entry.PaymentConfirmedDate, 'Payment Confirmed', entry.PaymentConfirmedBy, '', 'Bill');
  if (entry.PaymentStatus === 'Failed') add(entry.PaymentFailureDate, 'Payment Failed', entry.PaymentFailureLoggedBy, entry.PaymentFailureReason, 'Bill');
  if (cancelled) add(entry.CancelledDate, 'Bill Cancelled', entry.CancelledBy, entry.CancellationReason, 'Bill');
  if (!diaryRows.length && entry.HoldBy) {
    add(entry.HoldDate, 'Returned / Put On Hold', entry.HoldBy, entry.HoldReason, 'Bill');
    if (entry.ReleasedBy) add(entry.ReleasedDate, 'Released From Hold', entry.ReleasedBy, '', 'Bill');
  }
  let confirmedLines = 0, lastConfirmedLine = null;
  payEvents.forEach(ev => {
    const isOwn = String(ev.EntryID) === entryId;
    if (ev.EventType === 'Confirmed') {
      if (isOwn) return; // already shown from the bill itself
      confirmedLines++; if (!lastConfirmedLine || new Date(ev.EventDate) > new Date(lastConfirmedLine)) lastConfirmedLine = ev.EventDate;
      return;
    }
    add(ev.EventDate, 'Payment ' + ev.EventType + (isOwn ? '' : ' (' + ev.EntryID + ')'), ev.LoggedBy, ev.Notes, 'Payment');
  });
  if (confirmedLines) add(lastConfirmedLine, confirmedLines + ' beneficiary payment(s) confirmed', '', 'Date shown is the last confirmation', 'Payment');
  actions.sort((a, b) => a.sort - b.sort);
  actions.forEach((a, i) => { a.no = i + 1; delete a.sort; });

  const hold = cycleHoldDays_(movements, !cancelled && entry.PaymentStatus !== 'Confirmed');
  const payeeName = isBulk ? ('Bulk bill - ' + lineCount + ' beneficiaries') : entry.VendorName;
  return {
    success: true, diaryOnly: false,
    header: {
      billId: entryId, status: entry.Status, paymentStatus: entry.PaymentStatus || '', payee: payeeName, payeeType: entry.PayeeType,
      description: entry.BillDescription || '', nature: entry.BillNature || '', campus: entry.CampusName || '', fy: entry.FY || '',
      head: entry.HeadCode ? entry.HeadCode + ' - ' + (entry.HeadName || '') : '', billNo: entry.BillNo || '',
      gross: Number(entry.Amount || 0), net: netOf_(entry), batchId: entry.BatchID || '',
      diaryNumbers: diaryRows.map(d => ({ diaryId: d.DiaryID, dateReceived: fmtDate_(d.DateReceived), sender: diarySenderLabel_(d),
        senderRef: d.SenderReferenceNo || '', office: diaryOriginatingOfficeLabel_(d), assignedTo: d.AssignedToUsername || '' })),
      note: entry.SplitFromEntryID ? 'Isolated from bulk bill ' + entry.SplitFromEntryID + ' (line ' + entry.SplitFromLineNo + ') after a failed payment.' : ''
    },
    summary: {
      receivedDate: received ? fmtDate_(received) : '', finalDate: finalDate ? fmtDateTime_(finalDate) : '',
      finalStatus: cancelled ? 'Cancelled' : (entry.PaymentStatus === 'Confirmed' ? 'Paid & Confirmed' : 'In progress'),
      totalDays: calDaysBetween_(received, finalDate || null), holdDays: hold.days, holdOpen: hold.openNow,
      currentStage: stageInfo.stage + ' - ' + stageInfo.label, generatedAt: fmtDateTime_(new Date()), generatedBy: actorUsername
    },
    stages: stages, actions: actions
  };
}
function buildDiaryOnlyCycle_(d) {
  const movements = getTable(SHEETS.LETTERMOVEMENTS).filter(m => m.DiaryID === d.DiaryID).sort((a, b) => new Date(a.ActionDate) - new Date(b.ActionDate));
  const actions = cycleMovementActions_(movements).sort((a, b) => a.sort - b.sort);
  actions.forEach((a, i) => { a.no = i + 1; delete a.sort; });
  const info = computeItemStage_(d, {});
  const ended = (d.Status === 'Closed' || d.Status === 'Cancelled') ? d.ClosedDate : null;
  const hold = cycleHoldDays_(movements, !ended);
  return {
    success: true, diaryOnly: true,
    header: { billId: '(not yet entered as a bill)', status: d.Status, paymentStatus: '', payee: diarySenderLabel_(d), payeeType: d.SenderType,
      description: d.RoughDescription || '', nature: d.ItemType + (d.BillType ? ' (' + d.BillType + ')' : ''), campus: '', fy: '', head: '', billNo: '',
      gross: (d.Amount !== '' && d.Amount !== undefined && d.Amount !== null) ? Number(d.Amount) : 0, net: 0, batchId: '',
      diaryNumbers: [{ diaryId: d.DiaryID, dateReceived: fmtDate_(d.DateReceived), sender: diarySenderLabel_(d), senderRef: d.SenderReferenceNo || '',
        office: diaryOriginatingOfficeLabel_(d), assignedTo: d.AssignedToUsername || '' }], note: '' },
    summary: { receivedDate: fmtDate_(d.DateReceived), finalDate: ended ? fmtDateTime_(ended) : '', finalStatus: ended ? d.Status : 'In progress',
      totalDays: calDaysBetween_(d.DateReceived, ended), holdDays: hold.days, holdOpen: hold.openNow,
      currentStage: info.stage + ' - ' + info.label, generatedAt: fmtDateTime_(new Date()), generatedBy: '' },
    stages: [{ no: 1, stage: 'Diary', dateIn: fmtDate_(d.DateReceived), dateOut: ended ? fmtDateTime_(ended) : '', days: calDaysBetween_(d.DateReceived, ended),
      actionBy: 'Logged by ' + (d.LoggedBy || '-'), detail: info.label, status: ended ? 'Completed' : 'Current - waiting' }],
    actions: actions
  };
}
