
let CURRENT_USER = null;
let CAMPUSES = [];
const DEFAULT_FY_CLIENT = '2026-27'; // keep in sync with DEFAULT_FY in Code.gs

/* ---------- Dark / Light mode (light is the default) ---------- */
(function applyStoredTheme(){
  if (localStorage.getItem('themePreference') !== 'dark') document.body.classList.add('light');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = document.body.classList.contains('light') ? '☀️ Light' : '🌙 Dark';
})();
function toggleTheme(){
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('themePreference', isLight ? 'light' : 'dark');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = isLight ? '☀️ Light' : '🌙 Dark';
}

/* ---------- Financial Year helper ---------- */
function generateFYOptions(){
  const startYear = 2023;
  const opts = [];
  for(let i=0;i<8;i++){
    const y = startYear + i;
    opts.push(y + '-' + String(y+1).slice(-2));
  }
  return opts;
}
// includeAll=true adds an "All Years" option (value="") selected by default.
function fillFYSelect(id, includeAll){
  const sel = document.getElementById(id);
  if(!sel) return;
  const allOption = includeAll ? '<option value="" selected>All Years</option>' : '';
  const yearOptions = generateFYOptions().map(fy=>`<option value="${fy}" ${(!includeAll && fy===DEFAULT_FY_CLIENT)?'selected':''}>${fy}</option>`).join('');
  sel.innerHTML = allOption + yearOptions;
}
function fillAllFYSelects(){
  ['e_fy','a_fy','r1_fy','r4_fy','emp_fy','mio_fy','tds_fy','rtds_fy'].forEach(id => fillFYSelect(id, false));
  ['proc_fy','pass_fy','pay_fy','r2_fy','r3_fy','admin_fy','cp_fy','r5_fy','alloc_fy','me_fy','sp_fy','ai_fy','pc_fy'].forEach(id => fillFYSelect(id, true));
}

/* ---------- Toast / loading system ---------- */
function toast(message, type, sticky){
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = (type==='loading' ? '<div class="spinner"></div>' : '') + '<span>' + message + '</span>';
  wrap.appendChild(el);
  if (!sticky) setTimeout(()=>el.remove(), type==='error' ? 4500 : 2500);
  return el;
}

// Promise wrapper around google.script.run
function gs(fnName, ...args){
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(e => reject(new Error(e.message || e)))
      [fnName](...args);
  });
}

// Runs an async action with a button disabled + loading toast + success/error toast
async function runAction(button, loadingMsg, successMsg, fn){
  const loadingToast = toast(loadingMsg, 'loading', true);
  if (button) button.disabled = true;
  try {
    const result = await fn();
    loadingToast.remove();
    if (result && result.success === false){
      toast(result.message || 'Failed.', 'error');
      return result;
    }
    if (successMsg) toast(successMsg, 'success');
    return result;
  } catch(e){
    loadingToast.remove();
    toast(e.message || 'Something went wrong.', 'error');
    return { success:false, message: e.message };
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- Login / session ---------- */
function doLogin(){
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  document.getElementById('loginMsg').innerText = '';
  gs('authenticate', u, p).then(res=>{
    if(!res.success){ document.getElementById('loginMsg').innerText = res.message; return; }
    CURRENT_USER = res;
    sessionStorage.setItem('cbs_user', JSON.stringify(res));
    enterApp();
  }).catch(e=>{ document.getElementById('loginMsg').innerText = e.message; });
}
// UI-level convenience only - the real enforcement is server-side in Code.gs (requireRole_).
const ROLE_TABS = {
  Admin:          ['diary','entry','processing','passing','payment','paymentconfirm','reconciliation','reports','admin'],
  AllExceptAdmin: ['diary','entry','processing','passing','payment','paymentconfirm','reports'],
  Accounts:       ['diary','entry','reports'],
  Entry:          ['diary','entry','reports'],
  RA:             ['passing','diary','reports'],
  IBFT:           ['payment','paymentconfirm','reconciliation','diary','reports'],
  ReportsOnly:    ['reports','diary'],
  DiaryClerk:     ['diary','reports']   // Reports tab shows the Diary Report only (see restrictReportsForDiaryClerk)
};
function enterApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('appScreen').style.display='block';
  document.getElementById('whoami').innerText = CURRENT_USER.fullName + ' (' + CURRENT_USER.role + ')';

  const allowedTabs = ROLE_TABS[CURRENT_USER.role] || ['reports'];
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const tabName = btn.dataset.tab;
    btn.style.display = allowedTabs.includes(tabName) ? '' : 'none';
  });
  document.querySelectorAll('.tabpanel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  const landingTab = allowedTabs[0];
  document.getElementById('tab-'+landingTab).classList.add('active');
  const landingBtn = document.querySelector('.tab-btn[data-tab="'+landingTab+'"]');
  if (landingBtn) landingBtn.classList.add('active');

  fillAllFYSelects();
  initStickyScrollbars();
  loadCampusDropdowns();
  loadBankAccountsDropdown();
  loadReceivingOfficesDropdown();
  populateSanctionColumns();
  populateTcdColumns();
  loadGeminiKeyStatus();
  if (CURRENT_USER.role === 'DiaryClerk') restrictReportsForDiaryClerk();
  document.getElementById('e_date').valueAsDate = new Date();
  if (document.getElementById('r6_from')) document.getElementById('r6_from').value = '2026-07-01';
  if (document.getElementById('r6_to')) document.getElementById('r6_to').valueAsDate = new Date();
  if (document.getElementById('sp_dated')) document.getElementById('sp_dated').valueAsDate = new Date();
  document.getElementById('payDate').valueAsDate = new Date();
  populateBillNatureOptions();
  onBillNatureChange();
  refreshBadges();
  if (landingTab === 'reports') loadReportFilterOptions();
  if (landingTab === 'passing') loadStageTable('Processed','passingTable','pass_fy');

  // Stage 0 Diary setup.
  if (document.getElementById('dy_clerkSection')) {
    const isClerk = (CURRENT_USER.role === 'DiaryClerk' || CURRENT_USER.role === 'Admin');
    const isOrdinaryUser = (CURRENT_USER.role !== 'DiaryClerk');
    document.getElementById('dy_clerkSection').style.display = isClerk ? 'block' : 'none';
    document.getElementById('dy_userSection').style.display = isOrdinaryUser ? 'block' : 'none';
    if (isClerk) {
      loadDiaryClerkDropdowns();
      loadHeldItems();
    }
    if (isOrdinaryUser) {
      loadDiaryUserDropdowns();
      loadMyDiaryStageSummary();
      loadMyDiaryQueue();
    }
  }
  if (document.getElementById('dy_adminBypassRow')) {
    document.getElementById('dy_adminBypassRow').style.display = (CURRENT_USER.role === 'Admin') ? '' : 'none';
  }
}
function logout(){ sessionStorage.removeItem('cbs_user'); location.reload(); }
window.onload = function(){
  const saved = sessionStorage.getItem('cbs_user');
  if(saved){ CURRENT_USER = JSON.parse(saved); enterApp(); }
};

/* ---------- Tabs ---------- */
function showTab(name, evt){
  const allowedTabs = ROLE_TABS[CURRENT_USER.role] || ['reports'];
  if (!allowedTabs.includes(name)) { toast('Your role does not have access to this tab.', 'error'); return; }
  document.querySelectorAll('.tabpanel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  if(evt && evt.target) evt.target.closest('button').classList.add('active');
  if(name==='processing') loadStageTable('Received','processingTable','proc_fy');
  if(name==='passing') loadStageTable('Processed','passingTable','pass_fy');
  if(name==='payment'){ loadStageTable('Passed','paymentTable','pay_fy'); loadPaymentBatches(); }
  if(name==='paymentconfirm'){ /* deliberately no auto-load - click Load */ }
  if(name==='reconciliation'){ loadNeedsCorrectionQueue(); loadFailedBulkLines(); }
  if(name==='admin') loadAdminData();
  if(name==='reports') loadReportFilterOptions();
  if(name==='diary'){
    if (CURRENT_USER.role !== 'DiaryClerk') { loadMyDiaryStageSummary(); loadMyDiaryQueue(); }
    if (CURRENT_USER.role === 'DiaryClerk' || CURRENT_USER.role === 'Admin') { loadDiaryClerkDropdowns(); loadHeldItems(); }
  }
}
function showSubTab(name, evt){
  document.querySelectorAll('.subpanel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.sub-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('sub-'+name).classList.add('active');
  if(evt && evt.target) evt.target.classList.add('active');
}

/* ---------- Pipeline badges ---------- */
function refreshBadges(){
  gs('getPipelineCounts', '').then(counts=>{
    setBadge('processing', counts.Received);
    setBadge('passing', counts.Processed);
    setBadge('payment', counts.Passed);
  }).catch(()=>{});
  if (CURRENT_USER) {
    if (CURRENT_USER.role !== 'DiaryClerk') {
      gs('getUserDiaryQueue', CURRENT_USER.username, {}).then(list => setBadge('diary', list.length)).catch(()=>{});
    } else {
      gs('getPendingDiaryItems', { minDaysWaiting: 10 }, CURRENT_USER.username).then(list => setBadge('diary', list.length)).catch(()=>{});
    }
    gs('getPaymentsNeedingConfirmation', '').then(list => setBadge('paymentconfirm', list.length)).catch(()=>{});
    if (CURRENT_USER.role === 'Admin' || CURRENT_USER.role === 'IBFT') {
      Promise.all([
        gs('getNeedsCorrectionBills', '').catch(()=>[]),
        gs('getLineLevelConfirmationQueue', '', true).catch(()=>[])
      ]).then(([single, lines]) => setBadge('reconciliation', (single||[]).length + (lines||[]).length));
    }
  }
}
function setBadge(tab, count){
  const el = document.getElementById('badge-'+tab);
  if(!el) return;
  if(count > 0){ el.style.display='inline-block'; el.innerText = count; }
  else el.style.display='none';
}

/* ---------- Dropdowns ---------- */
function loadCampusDropdowns(){
  gs('getCampuses').then(list=>{
    CAMPUSES = list;
    fillSelect('e_campus', list, 'CampusID', 'CampusName');
    fillSelect('a_campus', list, 'CampusID', 'CampusName');
    fillSelect('r2_campus', list, 'CampusID', 'CampusName', 'All Campuses');
    fillSelect('r4_campus', list, 'CampusID', 'CampusName', 'All Campuses');
    fillSelect('r3_campus', list, 'CampusID', 'CampusName', 'All Campuses');
    fillSelect('cp_campus', list, 'CampusID', 'CampusName', 'All Campuses');
    fillSelect('sp_campus', list, 'CampusID', 'CampusName', 'All Campuses');
  });
}
let ALL_BANK_ACCOUNTS = [];
let ALL_RECEIVING_OFFICES = [];
function loadBankAccountsDropdown(){
  gs('getBankAccounts').then(list=>{
    ALL_BANK_ACCOUNTS = list || [];
    const withLabel = ALL_BANK_ACCOUNTS.map(a => Object.assign({}, a, { Label: a.AccountTitle + ' - ' + a.BankName }));
    fillSelect('e_payFromAccount', withLabel, 'AccountID', 'Label');
  }).catch(()=>{});
}
function renderBankAccountsTable(list){
  document.querySelector('#bankAccountsTable tbody').innerHTML = (list||[]).map(a =>
    `<tr><td>${a.AccountTitle}</td><td>${a.BankName}</td><td>${a.AccountNumber||''}</td>
     <td><button class="secondary" style="color:var(--danger);" onclick="deactivateBankAccountForm('${a.AccountID}')">Deactivate</button></td></tr>`
  ).join('') || emptyRow(4);
}
function loadBankAccountsAdminTable(){
  gs('getBankAccounts').then(list=> renderBankAccountsTable(list)).catch(()=>{});
}
async function addBankAccountForm(){
  const acct = { accountTitle: document.getElementById('ba_title').value, bankName: document.getElementById('ba_bank').value, accountNumber: document.getElementById('ba_number').value };
  const res = await runAction(document.getElementById('btnAddBankAccount'), 'Saving account...', 'Bank account added.',
    () => gs('addBankAccount', CURRENT_USER.username, acct));
  if (res && res.success){
    ['ba_title','ba_bank','ba_number'].forEach(id=>document.getElementById(id).value='');
    loadBankAccountsDropdown();
    loadBankAccountsAdminTable();
  }
}
async function deactivateBankAccountForm(accountId){
  if (!confirm('Deactivate this bank account? It will no longer appear as an option on New Entry.')) return;
  const res = await runAction(null, 'Deactivating...', 'Deactivated.', () => gs('deactivateBankAccount', CURRENT_USER.username, accountId));
  if (res && res.success){ loadBankAccountsDropdown(); loadBankAccountsAdminTable(); }
}
function loadReceivingOfficesDropdown(){
  gs('getReceivingOffices').then(list=>{
    ALL_RECEIVING_OFFICES = list || [];
    fillSelect('e_receivingOffice', ALL_RECEIVING_OFFICES, 'OfficeID', 'OfficeName');
  }).catch(()=>{});
}
function renderOfficesTable(list){
  document.querySelector('#officesTable tbody').innerHTML = (list||[]).map(o =>
    `<tr><td>${o.OfficeName}</td>
     <td><button class="secondary" style="color:var(--danger);" onclick="deactivateOfficeForm('${o.OfficeID}')">Deactivate</button></td></tr>`
  ).join('') || emptyRow(2);
}
function loadReceivingOfficesAdminTable(){
  gs('getReceivingOffices').then(list=> renderOfficesTable(list)).catch(()=>{});
}
async function addOfficeForm(){
  const name = document.getElementById('of_name').value;
  const res = await runAction(document.getElementById('btnAddOffice'), 'Saving office...', 'Office added.',
    () => gs('addReceivingOffice', CURRENT_USER.username, name));
  if (res && res.success){
    document.getElementById('of_name').value = '';
    loadReceivingOfficesDropdown();
    loadReceivingOfficesAdminTable();
  }
}
async function deactivateOfficeForm(officeId){
  if (!confirm('Deactivate this office? It will no longer appear as an option on New Entry.')) return;
  const res = await runAction(null, 'Deactivating...', 'Deactivated.', () => gs('deactivateReceivingOffice', CURRENT_USER.username, officeId));
  if (res && res.success){ loadReceivingOfficesDropdown(); loadReceivingOfficesAdminTable(); }
}
function onSalesTaxCheckChange(){
  document.getElementById('manualSalesTaxRow').style.display = document.getElementById('e_applyST').checked ? '' : 'none';
  if (!document.getElementById('e_applyST').checked){
    document.getElementById('e_manualSalesTaxOverride').checked = false;
    toggleDeductionRow('manualSalesTax');
  }
  updateTaxPreview();
}
function onPSTCheckChange(){
  const isVendor = document.querySelector('input[name="payeeType"]:checked').value === 'Vendor';
  const applyPST = document.getElementById('e_applyPST').checked;
  document.getElementById('pstInvoiceRow').style.display = (isVendor && applyPST) ? '' : 'none';
  document.getElementById('manualPSTRow').style.display = applyPST ? '' : 'none';
  if (!applyPST){
    document.getElementById('e_manualPSTOverride').checked = false;
    toggleDeductionRow('manualPST');
  }
  updateTaxPreview();
}
// The placeholder is always built fresh, so the list is always replaced, never appended to.
function fillSelect(id, list, valField, labelField, placeholderLabel){
  const sel = document.getElementById(id);
  const placeholder = `<option value="">${placeholderLabel || '-- select --'}</option>`;
  sel.innerHTML = placeholder + list.map(x=>`<option value="${x[valField]}">${x[labelField]}</option>`).join('');
}

let CURRENT_CAMPUS_HEADS = [];
function onCampusChange(){
  const campusId = document.getElementById('e_campus').value;
  const fy = document.getElementById('e_fy').value || DEFAULT_FY_CLIENT;
  document.getElementById('noHeadsMsg').style.display='none';
  if(!campusId) return Promise.resolve();
  return gs('getHeadsForCampus', campusId, fy).then(list=>{
    CURRENT_CAMPUS_HEADS = list;
    const sel = document.getElementById('e_headcode');
    sel.innerHTML = '<option value="">-- select --</option>' +
      list.map(h=>`<option value="${h.HeadID}" data-name="${h.HeadName}">${h.HeadCode} - ${h.HeadName}</option>`).join('');
    document.getElementById('e_headname').value = '';
    document.getElementById('balanceBox').style.display='none';
    document.getElementById('noHeadsMsg').style.display = list.length ? 'none' : 'block';
    document.querySelectorAll('.headSplitHeadSelect').forEach(populateHeadSplitSelect);
  });
}
function onHeadChange(){
  const opt = document.getElementById('e_headcode').selectedOptions[0];
  document.getElementById('e_headname').value = opt ? (opt.dataset.name || '') : '';
  checkBalance();
}
let CURRENT_BUDGET_STATUS = null;
function checkBalance(){
  const campusId = document.getElementById('e_campus').value;
  const headId = document.getElementById('e_headcode').value;
  const fy = document.getElementById('e_fy').value || DEFAULT_FY_CLIENT;
  if(!campusId || !headId){ document.getElementById('balanceBox').style.display='none'; CURRENT_BUDGET_STATUS=null; return; }
  gs('getBudgetStatus', campusId, headId, fy).then(status=>{
    CURRENT_BUDGET_STATUS = status;
    document.getElementById('balanceBox').style.display='flex';
    document.getElementById('noAllocMsg').style.display = status.hasAllocation ? 'none' : 'block';
    document.getElementById('bal_alloc').innerText = status.allocated.toLocaleString();
    document.getElementById('bal_spent').innerText = status.spent.toLocaleString();
    document.getElementById('bal_remain').innerText = status.remaining.toLocaleString();
    updateBalancePreview();
    renderBulkPreview();
  });
}
function updateBalancePreview(){
  const amt = Number(document.getElementById('e_amount').value) || 0;
  if(!CURRENT_BUDGET_STATUS){
    document.getElementById('bal_spent_after').innerText = '-';
    document.getElementById('bal_remain_after').innerText = '-';
    return;
  }
  const spentAfter = CURRENT_BUDGET_STATUS.spent + amt;
  const remainAfter = CURRENT_BUDGET_STATUS.remaining - amt;
  document.getElementById('bal_spent_after').innerText = spentAfter.toLocaleString();
  const remainEl = document.getElementById('bal_remain_after');
  remainEl.innerText = remainAfter.toLocaleString();
  remainEl.style.color = remainAfter < 0 ? 'var(--danger)' : '';
}
function onAmountInput(){
  updateBalancePreview();
  updateTaxPreview();
  updateReleaseAfterFigure();
  updateHeadSplitTotals();
}

/* ---------- Multiple Budget Heads for one bill ---------- */
function onHeadModeChange(){
  const mode = document.querySelector('input[name="headMode"]:checked').value;
  document.getElementById('singleHeadSection').style.display = (mode==='single') ? '' : 'none';
  document.getElementById('multiHeadSection').style.display = (mode==='multi') ? '' : 'none';
  if (mode==='multi' && document.querySelectorAll('#headSplitsTable tbody tr').length === 0){
    addHeadSplitRow(); addHeadSplitRow();
  }
  updateHeadSplitTotals();
}
function populateHeadSplitSelect(sel){
  const current = sel.value;
  sel.innerHTML = '<option value="">-- select --</option>' +
    CURRENT_CAMPUS_HEADS.map(h=>`<option value="${h.HeadID}" data-code="${h.HeadCode}" data-name="${h.HeadName}">${h.HeadCode} - ${h.HeadName}</option>`).join('');
  if (current) sel.value = current;
}
function addHeadSplitRow(){
  const tbody = document.querySelector('#headSplitsTable tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><select class="headSplitHeadSelect" onchange="updateHeadSplitTotals()"></select></td>
    <td><input type="number" class="headSplitAmount" oninput="updateHeadSplitTotals()"></td>
    <td><button type="button" class="secondary" onclick="this.closest('tr').remove(); updateHeadSplitTotals();">Remove</button></td>`;
  tbody.appendChild(tr);
  populateHeadSplitSelect(tr.querySelector('.headSplitHeadSelect'));
}
function collectHeadSplits(){
  return Array.from(document.querySelectorAll('#headSplitsTable tbody tr')).map(tr => {
    const sel = tr.querySelector('.headSplitHeadSelect');
    const opt = sel.selectedOptions[0];
    return { headId: sel.value, headCode: opt ? opt.dataset.code : '', headName: opt ? opt.dataset.name : '',
      amount: Number(tr.querySelector('.headSplitAmount').value) || 0 };
  }).filter(s => s.headId && s.amount > 0);
}
function updateHeadSplitTotals(){
  const billAmt = Number(document.getElementById('e_amount').value) || 0;
  const splitTotal = collectHeadSplits().reduce((s,x)=>s+x.amount, 0);
  document.getElementById('ms_billamt').innerText = num(billAmt);
  document.getElementById('ms_splittotal').innerText = num(splitTotal);
  const diffEl = document.getElementById('ms_diff');
  const diff = billAmt - splitTotal;
  diffEl.innerText = num(diff);
  diffEl.style.color = Math.abs(diff) > 0.01 ? 'var(--danger)' : '';
}

/* ---------- Vendor autofill ---------- */
let vendorTimeout;
function onVendorInput(){
  clearTimeout(vendorTimeout);
  const q = document.getElementById('e_vendor').value;
  updateSecurityHeldDisplay();
  if(q.length < 2){ document.getElementById('vendorSuggestions').style.display='none'; return; }
  vendorTimeout = setTimeout(()=>{
    gs('searchVendors', q).then(list=>{
      const box = document.getElementById('vendorSuggestions');
      if(list.length===0){ box.style.display='none'; return; }
      box.innerHTML = list.map(v=>`<div onclick='pickVendor(${JSON.stringify(v)})'>${v.VendorName} (${v.CNIC_NTN||''})</div>`).join('');
      box.style.display='block';
    });
  }, 250);
}
function pickVendor(v){
  document.getElementById('e_vendor').value = v.VendorName;
  document.getElementById('e_cnic').value = v.CNIC_NTN || '';
  document.getElementById('e_iban').value = v.IBAN || '';
  document.getElementById('e_bank').value = v.BankName || '';
  document.getElementById('vendorSuggestions').style.display='none';
  updateSecurityHeldDisplay();
}
function onCnicBlur(){
  const cnic = document.getElementById('e_cnic').value.trim();
  if(!cnic) return;
  gs('getVendorByCNIC', cnic).then(v=>{
    if(v){
      document.getElementById('e_vendor').value = v.VendorName;
      document.getElementById('e_iban').value = v.IBAN || '';
      document.getElementById('e_bank').value = v.BankName || '';
      updateSecurityHeldDisplay();
    }
  });
}

/* ---------- Entry Mode: Single vs Bulk Upload ---------- */
function onEntryModeChange(){
  const mode = document.querySelector('input[name="entryMode"]:checked').value;
  document.getElementById('singleEntrySection').style.display = (mode==='single') ? '' : 'none';
  document.getElementById('bulkEntrySection').style.display = (mode==='bulk') ? '' : 'none';
  if (mode==='bulk' && typeof loadBulkDiaryPicker === 'function') loadBulkDiaryPicker();
}

function onBulkTypeChange(){
  const hints = {
    Vendor: 'Columns: VendorName, CNIC, IBAN, BankName, Amount, IncomeTaxAmount, SalesTaxAmount, PSTAmount, SecurityAmount, PenaltyAmount, OtherDeductionAmount, Description, FBRSection. FBRSection is REQUIRED on any row that has an IncomeTaxAmount - it is the FBR withholding section applied to that row, e.g. "153(1)(a) - Supply of Goods" - it is shown per beneficiary on reports. If a CNIC already on file is used, Name/IBAN/Bank are auto-fetched - leave them blank or matching, they will be overwritten from the existing record. If any row has a PSTAmount, fill in the PST Invoice Number/Date below. Receiving Office and Pay From Account are set once, above, for the whole bill.',
    Student: 'Columns: StudentID, Name, CNIC, IBAN, Program, Session, Shift, Amount, DeductionAmount, Description, ReceivingOffice, PayFromAccount. If a Student ID already on file is used, Name/CNIC/IBAN/Program/Session/Shift are auto-fetched. ReceivingOffice/PayFromAccount are OPTIONAL per row (must match an existing office name / "Account Title - Bank Name" exactly) - leave blank to use the Received From/Pay From Account picked above for the whole bill; fill them in only for a row that was actually received from, or is to be paid from, something different.',
    Employee: 'Columns: PayeeType (Employee or NonUEEmployee), EmployeeID (UE - auto-fetches Name/CNIC/IBAN/Bank, do not type them) / CNIC (Non-UE - auto-fetches if already on file), Name/IBAN/BankName (Non-UE only, for a brand-new person), Nature (Overtime and Mobile Bill/Refreshment/POL are UE-only; Honorarium and everything else are shared with Non-UE), ExamSubCategory (Conduct of Exam only), ThesisClass/ThesisStudentName (Thesis Evaluation only), BenevolentFundSubCategory (Benevolent Fund only, UE only), VisitingProgram/VisitingSubject/VisitingCrHrs/VisitingRate/VisitingLectures (required for UE Visiting Faculty and Paper Setting/Marking, either payee type), AffidavitLowIncome (Non-UE only, Yes/No - if Yes, Section 149 tax is zero), TaxMethod (Non-UE only, leave blank or "Section149" for the slab system, or "Section153_1b" for the flat-rate alternative), TaxpayerStatus (Non-UE only, required if TaxMethod is Section153_1b - "Active" or "Inactive"), Amount, Description, ReceivingOffice, PayFromAccount. Income Tax itself is always calculated automatically - there is no Income Tax column to fill in, and each row gets its own FBR Section. ReceivingOffice/PayFromAccount are OPTIONAL per row (must match an existing office name / "Account Title - Bank Name" exactly) - leave blank to use what was picked above for the whole bill.'
  };
  const type = document.querySelector('input[name="bulkType"]:checked').value;
  document.getElementById('bulkTypeHint').innerText = hints[type];
  document.getElementById('bulkPstInvoiceRow').style.display = (type === 'Vendor') ? '' : 'none';
  BULK_LINE_ITEMS = [];
  document.getElementById('bulk_file').value = '';
  document.getElementById('bulkPreviewWrap').style.display = 'none';
}

const BULK_TEMPLATES = {
  Vendor: {
    columns: ['VendorName','CNIC','IBAN','BankName','Amount','IncomeTaxAmount','SalesTaxAmount','PSTAmount','SecurityAmount','PenaltyAmount','OtherDeductionAmount','Description','FBRSection'],
    examples: [
      { VendorName:'ABC Traders (Pvt) Ltd', CNIC:'1234567890123', IBAN:'PK00BANK0000000000000001', BankName:'Bank Alpha',
        Amount:'100000', IncomeTaxAmount:'5000', SalesTaxAmount:'8475', PSTAmount:'0', SecurityAmount:'0', PenaltyAmount:'0', OtherDeductionAmount:'0',
        Description:'Supply of goods - Filer, Company', FBRSection:'153(1)(a) - Supply of Goods' },
      { VendorName:'XYZ Services', CNIC:'9876543210123', IBAN:'PK00BANK0000000000000002', BankName:'Bank Beta',
        Amount:'50000', IncomeTaxAmount:'4500', SalesTaxAmount:'0', PSTAmount:'8000', SecurityAmount:'2500', PenaltyAmount:'0', OtherDeductionAmount:'0',
        Description:'Rendering of services, Security deducted', FBRSection:'153(1)(b) - Services' },
      { VendorName:'Build & Co Contractors', CNIC:'1122334455667', IBAN:'PK00BANK0000000000000003', BankName:'Bank Gamma',
        Amount:'200000', IncomeTaxAmount:'15000', SalesTaxAmount:'0', PSTAmount:'0', SecurityAmount:'10000', PenaltyAmount:'5000', OtherDeductionAmount:'0',
        Description:'Execution of contract', FBRSection:'153(1)(c) - Execution of Contracts' },
      { VendorName:'Known Vendor (CNIC already on file)', CNIC:'1234567890123', IBAN:'', BankName:'',
        Amount:'30000', IncomeTaxAmount:'1500', SalesTaxAmount:'0', PSTAmount:'0', SecurityAmount:'0', PenaltyAmount:'0', OtherDeductionAmount:'0',
        Description:'IBAN/Bank left blank - auto-fetched from CNIC already on file', FBRSection:'153(1)(a) - Supply of Goods' }
    ]
  },
  Student: {
    columns: ['StudentID','Name','CNIC','IBAN','Program','Session','Shift','Amount','DeductionAmount','Description','ReceivingOffice','PayFromAccount'],
    examples: [
      { StudentID:'S1001', Name:'Ahmed Raza', CNIC:'3520112345678', IBAN:'PK00BANK0000000000000010', Program:'BS Computer Science', Session:'2023-2027', Shift:'Morning',
        Amount:'25000', DeductionAmount:'0', Description:'Scholarship - full amount, no deduction', ReceivingOffice:'', PayFromAccount:'' },
      { StudentID:'S1002', Name:'Sana Malik', CNIC:'3520187654321', IBAN:'PK00BANK0000000000000011', Program:'BBA', Session:'2022-2026', Shift:'Evening',
        Amount:'15000', DeductionAmount:'0', Description:'Refund of Fee - Extra Deposited', ReceivingOffice:'', PayFromAccount:'' },
      { StudentID:'S1003', Name:'Bilal Hussain', CNIC:'3520111223344', IBAN:'PK00BANK0000000000000012', Program:'BS Mathematics', Session:'2023-2027', Shift:'Morning',
        Amount:'8000', DeductionAmount:'1000', Description:'Refund of Fee - Library Security, with a deduction retained', ReceivingOffice:'', PayFromAccount:'' },
      { StudentID:'S1001', Name:'', CNIC:'', IBAN:'', Program:'', Session:'', Shift:'',
        Amount:'5000', DeductionAmount:'0', Description:'Other fields left blank - auto-fetched because Student ID S1001 already exists (see row 1)', ReceivingOffice:'', PayFromAccount:'' },
      { StudentID:'S1004', Name:'Zara Iqbal', CNIC:'3520155667788', IBAN:'PK00BANK0000000000000013', Program:'BS Physics', Session:'2023-2027', Shift:'Morning',
        Amount:'10000', DeductionAmount:'0', Description:'Received from and paid via a DIFFERENT office/account than the rest of this bill - type the exact office name / "Account Title - Bank Name" here',
        ReceivingOffice:'Main Campus Office', PayFromAccount:'Operating Account - Bank Alpha' }
    ]
  },
  Employee: {
    columns: ['PayeeType','EmployeeID','CNIC','Name','IBAN','BankName','Nature','ExamSubCategory','ThesisClass','ThesisStudentName','BenevolentFundSubCategory','VisitingProgram','VisitingSubject','VisitingCrHrs','VisitingRate','VisitingLectures','AffidavitLowIncome','TaxMethod','TaxpayerStatus','Amount','Description','ReceivingOffice','PayFromAccount'],
    examples: [
      { PayeeType:'Employee', EmployeeID:'E101', CNIC:'', Name:'', IBAN:'', BankName:'', Nature:'UE Visiting Faculty',
        ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'',
        VisitingProgram:'BS Computer Science', VisitingSubject:'Data Structures', VisitingCrHrs:'3', VisitingRate:'2000', VisitingLectures:'20',
        AffidavitLowIncome:'', TaxMethod:'', TaxpayerStatus:'', Amount:'40000', Description:'Taxable - Section 149 slab, calculated automatically. Program/Subject/Cr. Hrs./Rate/Lectures are required for this Nature.' },
      { PayeeType:'Employee', EmployeeID:'E102', CNIC:'', Name:'', IBAN:'', BankName:'', Nature:'Conduct of Exam',
        ExamSubCategory:'Mid-Term Invigilation', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'', TaxMethod:'', TaxpayerStatus:'', Amount:'10000', Description:'Taxable - Section 149, sub-category filled in for Conduct of Exam' },
      { PayeeType:'Employee', EmployeeID:'E101', CNIC:'', Name:'', IBAN:'', BankName:'', Nature:'Medical',
        ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'', TaxMethod:'', TaxpayerStatus:'', Amount:'5000', Description:'Not Taxable - Medical, tax is always 0 regardless' },
      { PayeeType:'Employee', EmployeeID:'E103', CNIC:'', Name:'', IBAN:'', BankName:'', Nature:'TADA',
        ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'', TaxMethod:'', TaxpayerStatus:'', Amount:'3000', Description:'Not Taxable - TADA, tax is always 0 regardless' },
      { PayeeType:'Employee', EmployeeID:'E104', CNIC:'', Name:'', IBAN:'', BankName:'', Nature:'Thesis Evaluation',
        ExamSubCategory:'', ThesisClass:'BS Computer Science - 7th', ThesisStudentName:'Ahmed Raza', BenevolentFundSubCategory:'', AffidavitLowIncome:'', TaxMethod:'', TaxpayerStatus:'', Amount:'8000', Description:'Taxable - Section 149, Class and Student Name required' },
      { PayeeType:'Employee', EmployeeID:'E105', CNIC:'', Name:'', IBAN:'', BankName:'', Nature:'Benevolent Fund',
        ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'Marriage Grant', AffidavitLowIncome:'', TaxMethod:'', TaxpayerStatus:'', Amount:'50000', Description:'Not Taxable - Benevolent Fund, sub-category required, tax is always 0 regardless' },
      { PayeeType:'NonUEEmployee', EmployeeID:'', CNIC:'3520112223334', Name:'Visiting Examiner - New', IBAN:'PK00BANK0000000000000020', BankName:'Bank Delta',
        Nature:'Examiners', ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'No', TaxMethod:'Section149', TaxpayerStatus:'', Amount:'12000', Description:'Non-UE, brand new - tax calculated automatically under Section 149' },
      { PayeeType:'NonUEEmployee', EmployeeID:'', CNIC:'3520112223334', Name:'', IBAN:'', BankName:'',
        Nature:'Examiners', ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'No', TaxMethod:'Section149', TaxpayerStatus:'', Amount:'12000', Description:'Same person, later row - Name/IBAN/Bank auto-fetched; tax builds on the row above, even within the same file' },
      { PayeeType:'NonUEEmployee', EmployeeID:'', CNIC:'3520199998888', Name:'Affidavit Example', IBAN:'PK00BANK0000000000000021', BankName:'Bank Delta',
        Nature:'Examiners', ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'Yes', TaxMethod:'Section149', TaxpayerStatus:'', Amount:'12000', Description:'Affidavit of Low Income submitted - Section 149 tax is zero' },
      { PayeeType:'NonUEEmployee', EmployeeID:'', CNIC:'3520144445555', Name:'153(1)(b) Active Example', IBAN:'PK00BANK0000000000000024', BankName:'Bank Delta',
        Nature:'Examiners', ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'No', TaxMethod:'Section153_1b', TaxpayerStatus:'Active', Amount:'20000', Description:'Section 153(1)(b) - Services (Individual/AOP), Active/Registered Taxpayer rate' },
      { PayeeType:'NonUEEmployee', EmployeeID:'', CNIC:'3520133334444', Name:'153(1)(b) Inactive Example', IBAN:'PK00BANK0000000000000025', BankName:'Bank Delta',
        Nature:'Examiners', ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'No', TaxMethod:'Section153_1b', TaxpayerStatus:'Inactive', Amount:'20000', Description:'Section 153(1)(b) at the Inactive Taxpayer rate' },
      { PayeeType:'NonUEEmployee', EmployeeID:'', CNIC:'3520155556666', Name:'Board Member Example', IBAN:'PK00BANK0000000000000022', BankName:'Bank Delta',
        Nature:"Honoraria to Statutory Body Meeting's Member", ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'No', TaxMethod:'', TaxpayerStatus:'', Amount:'20000', Description:'Section 156 Honoraria - flat rate, calculated automatically' },
      { PayeeType:'NonUEEmployee', EmployeeID:'', CNIC:'3520166667777', Name:'Thesis Examiner Example', IBAN:'PK00BANK0000000000000023', BankName:'Bank Delta',
        Nature:'Thesis Evaluation', ExamSubCategory:'', ThesisClass:'BS Mathematics - 8th', ThesisStudentName:'Bilal Hussain', BenevolentFundSubCategory:'', AffidavitLowIncome:'No', TaxMethod:'Section149', TaxpayerStatus:'', Amount:'8000', Description:'Non-UE - Section 149 slab, calculated automatically' },
      { PayeeType:'Employee', EmployeeID:'E106', CNIC:'', Name:'', IBAN:'', BankName:'', Nature:'Non-Teaching',
        ExamSubCategory:'', ThesisClass:'', ThesisStudentName:'', BenevolentFundSubCategory:'', AffidavitLowIncome:'', TaxMethod:'', TaxpayerStatus:'', Amount:'15000',
        Description:'Received from and paid via a DIFFERENT office/account than the rest of this bill - type the exact office name / "Account Title - Bank Name" here',
        ReceivingOffice:'Main Campus Office', PayFromAccount:'Operating Account - Bank Alpha' }
    ]
  }
};
function downloadBulkTemplate(){
  const type = document.querySelector('input[name="bulkType"]:checked').value;
  const t = BULK_TEMPLATES[type];
  exportArrayToCSV(t.examples, t.columns.map(c=>[c,c]), type + '_Bulk_Upload_Template.csv');
}

// Simple CSV parser: handles quoted fields, embedded commas, and escaped quotes ("").
function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ','){ row.push(field); field = ''; }
      else if (c === '\n' || c === '\r'){
        if (c === '\r' && text[i+1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}
function isTruthyCsvValue(v){
  return ['yes','true','1','y'].includes(String(v||'').trim().toLowerCase());
}

// CNIC: exactly 35201-1222334-4. NTN: 12345678. IBAN: PK + 22 alphanumeric characters (24 total).
function isValidCnicFormat(v){
  const s = String(v||'').trim();
  if (!s) return false;
  return /^\d{5}-\d{7}-\d{1}$/.test(s);
}
function isValidNtnFormat(v){
  const s = String(v||'').trim();
  if (!s) return false;
  return /^\d{8}$/.test(s);
}
function isValidCnicOrNtnFormat(v){
  const s = String(v||'').trim();
  if (!s) return false;
  return isValidCnicFormat(s) || isValidNtnFormat(s);
}
function isValidIbanFormat(v){
  const s = String(v||'').trim().toUpperCase();
  if (!s) return false;
  return /^PK\d{2}[A-Z0-9]{20}$/.test(s);
}

let BULK_LINE_ITEMS = [];
let BULK_EMPLOYEE_MAP = null;
let BULK_NONUE_MAP = null;
let BULK_VENDOR_MAP = null;
let BULK_STUDENT_MAP = null;
// Resolves a row's optional ReceivingOffice/PayFromAccount CSV columns to IDs.
function resolveRowOfficeAccount(obj, rowNum, errors){
  let receivingOfficeId = '', payFromAccountId = '';
  const officeName = String(obj.ReceivingOffice||'').trim();
  if (officeName){
    const office = ALL_RECEIVING_OFFICES.find(o => o.OfficeName.toLowerCase() === officeName.toLowerCase());
    if (!office){ errors.push('Row ' + rowNum + ': ReceivingOffice "' + officeName + '" does not match any office on file (Admin > Receiving Offices).'); }
    else receivingOfficeId = office.OfficeID;
  }
  const accountName = String(obj.PayFromAccount||'').trim();
  if (accountName){
    const account = ALL_BANK_ACCOUNTS.find(a => (a.AccountTitle + ' - ' + a.BankName).toLowerCase() === accountName.toLowerCase());
    if (!account){ errors.push('Row ' + rowNum + ': PayFromAccount "' + accountName + '" does not match any account on file (must be exactly "Account Title - Bank Name").'); }
    else payFromAccountId = account.AccountID;
  }
  return { receivingOfficeId, payFromAccountId };
}
function onBulkFileSelected(evt){
  const file = evt.target.files[0];
  if (!file) return;
  const bulkType = document.querySelector('input[name="bulkType"]:checked').value;
  const errorsBox = document.getElementById('bulkErrors');
  errorsBox.style.display = 'none';
  document.getElementById('bulkPreviewWrap').style.display = 'none';

  const reader = new FileReader();
  reader.onload = async () => {
    const rows = parseCSV(reader.result);
    if (rows.length < 2){
      errorsBox.style.display = 'block'; errorsBox.innerText = 'CSV has no data rows.'; return;
    }
    const header = rows[0].map(h => h.trim());
    const dataRows = rows.slice(1);

    if (bulkType === 'Employee' && !BULK_EMPLOYEE_MAP){
      const emps = await gs('getAllEmployees');
      BULK_EMPLOYEE_MAP = {};
      emps.forEach(e => BULK_EMPLOYEE_MAP[String(e.EmployeeID).toLowerCase()] = e);
    }
    if (bulkType === 'Employee' && !BULK_NONUE_MAP){
      const nonues = await gs('getAllNonUEEmployees');
      BULK_NONUE_MAP = {};
      nonues.forEach(e => BULK_NONUE_MAP[String(e.CNIC).toLowerCase()] = e);
    }
    if (bulkType === 'Vendor' && !BULK_VENDOR_MAP){
      const vendors = await gs('getAllVendors');
      BULK_VENDOR_MAP = {};
      vendors.forEach(v => { if (v.CNIC_NTN) BULK_VENDOR_MAP[String(v.CNIC_NTN).toLowerCase()] = v; });
    }
    if (bulkType === 'Student' && !BULK_STUDENT_MAP){
      const students = await gs('getAllStudents');
      BULK_STUDENT_MAP = {};
      students.forEach(s => BULK_STUDENT_MAP[String(s.StudentID).toLowerCase()] = s);
    }

    const errors = [];
    const items = [];
    dataRows.forEach((cells, idx) => {
      const obj = {};
      header.forEach((h,i) => obj[h] = (cells[i]||'').trim());
      const rowNum = idx + 2;
      const amount = Number(obj.Amount);
      if (!amount || amount <= 0){ errors.push('Row ' + rowNum + ': invalid or missing Amount.'); return; }

      if (bulkType === 'Vendor'){
        if (!obj.VendorName && !obj.CNIC){ errors.push('Row ' + rowNum + ': Vendor name or CNIC is required.'); return; }
        const known = obj.CNIC ? BULK_VENDOR_MAP[String(obj.CNIC).toLowerCase()] : null;
        const name = obj.VendorName || (known ? known.VendorName : '');
        const iban = obj.IBAN || (known ? known.IBAN : '');
        const bankName = obj.BankName || (known ? known.BankName : '');
        const mismatch = !!known && (
          (obj.VendorName && known.VendorName && obj.VendorName !== known.VendorName) ||
          (obj.IBAN && known.IBAN && obj.IBAN !== known.IBAN) ||
          (obj.BankName && known.BankName && obj.BankName !== known.BankName));
        if (!name){ errors.push('Row ' + rowNum + ': Vendor name is required for a new vendor.'); return; }
        if (obj.CNIC && !isValidCnicOrNtnFormat(obj.CNIC)){ errors.push('Row ' + rowNum + ': CNIC/NTN must be a CNIC (35201-1222334-4) or an NTN (12345678).'); return; }
        if (iban && !isValidIbanFormat(iban)){ errors.push('Row ' + rowNum + ': IBAN must start with PK and be 24 characters in total.'); return; }
        const incomeTax = Number(obj.IncomeTaxAmount)||0, salesTax = Number(obj.SalesTaxAmount)||0, pst = Number(obj.PSTAmount)||0,
              security = Number(obj.SecurityAmount)||0, penalty = Number(obj.PenaltyAmount)||0, other = Number(obj.OtherDeductionAmount)||0;
        if (incomeTax > 0 && !String(obj.FBRSection||'').trim()){ errors.push('Row ' + rowNum + ': FBRSection is required when IncomeTaxAmount is entered - state the FBR section the tax was calculated under (e.g. 153(1)(a) - Supply of Goods).'); return; }
        const net = amount - incomeTax - salesTax - pst - security - penalty - other;
        items.push({ payeeType:'Vendor', name, cnic:obj.CNIC, iban, bankName, __existingMismatch: mismatch, fbrSection: obj.FBRSection || '',
          amount, incomeTaxAmount:incomeTax, salesTaxAmount:salesTax, pstAmount:pst, securityAmount:security,
          penaltyAmount:penalty, otherDeductionAmount:other, net, description:obj.Description });

      } else if (bulkType === 'Student'){
        if (!obj.StudentID){ errors.push('Row ' + rowNum + ': Student ID is required.'); return; }
        const known = BULK_STUDENT_MAP[String(obj.StudentID).toLowerCase()];
        const name = obj.Name || (known ? known.Name : '');
        const cnic = obj.CNIC || (known ? known.CNIC : '');
        const iban = obj.IBAN || (known ? known.IBAN : '');
        const program = obj.Program || (known ? known.Program : '');
        const session = obj.Session || (known ? known.Session : '');
        const shift = obj.Shift || (known ? known.Shift : '');
        const mismatch = !!known && (
          (obj.Name && known.Name && obj.Name !== known.Name) ||
          (obj.CNIC && known.CNIC && obj.CNIC !== known.CNIC) ||
          (obj.IBAN && known.IBAN && obj.IBAN !== known.IBAN));
        if (!name){ errors.push('Row ' + rowNum + ': Name is required for a new student.'); return; }
        if (cnic && !isValidCnicFormat(cnic)){ errors.push('Row ' + rowNum + ': CNIC must be in the format 35201-1222334-4.'); return; }
        if (iban && !isValidIbanFormat(iban)){ errors.push('Row ' + rowNum + ': IBAN must start with PK and be 24 characters in total.'); return; }
        const deduction = Number(obj.DeductionAmount)||0;
        const net = amount - deduction;
        const officeAcct = resolveRowOfficeAccount(obj, rowNum, errors);
        items.push({ payeeType:'Student', studentId:obj.StudentID, name, cnic, iban, __existingMismatch: mismatch,
          program, session, shift, amount,
          incomeTaxAmount:0, salesTaxAmount:0, pstAmount:0, securityAmount:0, penaltyAmount:0,
          otherDeductionAmount:deduction, net, description:obj.Description,
          receivingOfficeId: officeAcct.receivingOfficeId, payFromAccountId: officeAcct.payFromAccountId,
          receivingOfficeName: obj.ReceivingOffice||'', payFromAccountName: obj.PayFromAccount||'' });

      } else { // Employee (UE or Non-UE)
        const payeeType = obj.PayeeType === 'NonUEEmployee' ? 'NonUEEmployee' : 'Employee';
        const nature = obj.Nature || obj.EmployeeCategory;
        if (!nature){ errors.push('Row ' + rowNum + ': Nature is required.'); return; }
        const isTaxableCategory = EMPLOYEE_149_NATURES.includes(nature) || nature === SECTION_156_NATURE ||
          (payeeType === 'Employee' && UE_ONLY_TAXABLE_NATURES.includes(nature));
        const isNonTaxable = payeeType === 'Employee' && UE_NON_TAXABLE_NATURES_BULK.includes(nature);
        if (!isTaxableCategory && !isNonTaxable){
          errors.push('Row ' + rowNum + ': "' + nature + '" is not a valid Nature for ' + (payeeType==='Employee'?'a UE Employee':'a Non-UE Employee') + '.'); return;
        }
        if (payeeType === 'NonUEEmployee' && isNonTaxable){
          errors.push('Row ' + rowNum + ': Non-UE Employees have no non-taxable category - "' + nature + '" is not valid.'); return;
        }
        let name, cnic, iban, bankName, mismatch = false;
        if (payeeType === 'Employee'){
          const emp = BULK_EMPLOYEE_MAP[String(obj.EmployeeID).toLowerCase()];
          if (!emp){ errors.push('Row ' + rowNum + ': Employee ID "' + obj.EmployeeID + '" not found.'); return; }
          name = emp.Name; cnic = emp.CNIC; iban = emp.IBAN; bankName = emp.BankName;
        } else {
          const known = obj.CNIC ? BULK_NONUE_MAP[String(obj.CNIC).toLowerCase()] : null;
          name = obj.Name || (known ? known.Name : '');
          cnic = obj.CNIC;
          iban = obj.IBAN || (known ? known.IBAN : '');
          bankName = obj.BankName || (known ? known.BankName : '');
          mismatch = !!known && (
            (obj.Name && known.Name && obj.Name !== known.Name) ||
            (obj.IBAN && known.IBAN && obj.IBAN !== known.IBAN) ||
            (obj.BankName && known.BankName && obj.BankName !== known.BankName));
          if (!cnic || !name){ errors.push('Row ' + rowNum + ': CNIC and Name are required for a new Non-UE Employee.'); return; }
          if (!isValidCnicFormat(cnic)){ errors.push('Row ' + rowNum + ': CNIC must be in the format 35201-1222334-4.'); return; }
          if (iban && !isValidIbanFormat(iban)){ errors.push('Row ' + rowNum + ': IBAN must start with PK and be 24 characters in total.'); return; }
        }
        // Income Tax for a taxable Nature is calculated by the server at submit time.
        const incomeTax = isNonTaxable ? 0 : null;
        const net = isNonTaxable ? amount : null;
        if (nature === 'Thesis Evaluation' && (!obj.ThesisClass || !obj.ThesisStudentName)){
          errors.push('Row ' + rowNum + ': Thesis Evaluation requires both Class and Student Name.'); return;
        }
        if (nature === 'Benevolent Fund' && !obj.BenevolentFundSubCategory){
          errors.push('Row ' + rowNum + ': Benevolent Fund requires a sub-category.'); return;
        }
        if (['UE Visiting Faculty','Paper Setting/Marking'].includes(nature) &&
            (!obj.VisitingProgram || !obj.VisitingSubject || !obj.VisitingCrHrs || !obj.VisitingRate || !obj.VisitingLectures)){
          errors.push('Row ' + rowNum + ': ' + nature + ' requires Program, Subject, Cr. Hrs., Rate, and Lectures.'); return;
        }
        let nonUeTaxMethod = 'Section149', fbrStatus = 'NonFiler';
        if (payeeType === 'NonUEEmployee' && String(obj.TaxMethod||'').trim() === 'Section153_1b'){
          nonUeTaxMethod = 'Section153_1b';
          const status = String(obj.TaxpayerStatus||'').trim().toLowerCase();
          if (status !== 'active' && status !== 'inactive'){
            errors.push('Row ' + rowNum + ': TaxpayerStatus must be Active or Inactive when TaxMethod is Section153_1b.'); return;
          }
          fbrStatus = status === 'active' ? 'Filer' : 'NonFiler';
        }
        const officeAcct = resolveRowOfficeAccount(obj, rowNum, errors);
        items.push({ payeeType, employeeId:obj.EmployeeID, name, cnic, iban, bankName, amount, billNature:nature, __existingMismatch: mismatch,
          incomeTaxAmount:incomeTax, salesTaxAmount:0, pstAmount:0, securityAmount:0, penaltyAmount:0, otherDeductionAmount:0, net,
          description:obj.Description, examSubCategory:obj.ExamSubCategory,
          thesisClass:obj.ThesisClass, thesisStudentName:obj.ThesisStudentName, benevolentFundSubCategory:obj.BenevolentFundSubCategory,
          visitingProgram:obj.VisitingProgram, visitingSubject:obj.VisitingSubject, visitingCrHrs:obj.VisitingCrHrs,
          visitingRate:obj.VisitingRate, visitingLectures:obj.VisitingLectures,
          nonUeTaxMethod, fbrStatus,
          affidavitLowIncome: isTruthyCsvValue(obj.AffidavitLowIncome),
          receivingOfficeId: officeAcct.receivingOfficeId, payFromAccountId: officeAcct.payFromAccountId,
          receivingOfficeName: obj.ReceivingOffice||'', payFromAccountName: obj.PayFromAccount||'' });
      }
    });

    if (errors.length){
      errorsBox.style.display = 'block';
      errorsBox.innerHTML = errors.map(e=>'&bull; '+e).join('<br>');
    }
    BULK_LINE_ITEMS = items;
    renderBulkPreview();
  };
  reader.readAsText(file);
}

function renderBulkPreview(){
  if (typeof updateBulkDiaryTotals === 'function') updateBulkDiaryTotals();
  if (!BULK_LINE_ITEMS.length){ document.getElementById('bulkPreviewWrap').style.display = 'none'; return; }
  document.getElementById('bulkPreviewWrap').style.display = 'block';
  const grossTotal = BULK_LINE_ITEMS.reduce((s,r)=>s+r.amount,0);
  const netTotal = BULK_LINE_ITEMS.reduce((s,r)=>s+r.net,0);
  document.getElementById('bulk_count').innerText = BULK_LINE_ITEMS.length;
  document.getElementById('bulk_gross').innerText = num(grossTotal);
  document.getElementById('bulk_net').innerText = num(netTotal);

  const spentAfter = CURRENT_BUDGET_STATUS ? CURRENT_BUDGET_STATUS.spent + grossTotal : null;
  const remainAfter = CURRENT_BUDGET_STATUS ? CURRENT_BUDGET_STATUS.remaining - grossTotal : null;
  document.getElementById('bulk_spent_after').innerText = spentAfter!=null ? num(spentAfter) : '-';
  const remainEl = document.getElementById('bulk_remain_after');
  remainEl.innerText = remainAfter!=null ? num(remainAfter) : '-';
  remainEl.style.color = (remainAfter!=null && remainAfter < 0) ? 'var(--danger)' : '';

  const bulkType = document.querySelector('input[name="bulkType"]:checked').value;
  document.querySelector('#bulkPreviewTable tbody').innerHTML = BULK_LINE_ITEMS.map((r,i) => {
    const officeAcctCell = bulkType === 'Vendor' ? '<span style="color:var(--text-muted);">(bill default)</span>'
      : ((r.receivingOfficeName || r.payFromAccountName)
          ? ((r.receivingOfficeName||'-') + ' / ' + (r.payFromAccountName||'-'))
          : '<span style="color:var(--text-muted);">(bill default)</span>');
    return `<tr${r.__existingMismatch ? ' style="background:rgba(245,158,11,0.15);" title="Differs from the record already on file - will overwrite it (with confirmation) on submit"' : ''}>
     <td>${i+1}</td><td>${r.payeeType}</td><td>${r.employeeId||r.studentId||''}</td><td>${r.name}${r.__existingMismatch ? ' <span style="color:var(--amber);">⚠</span>' : ''}</td><td>${r.cnic||''}</td>
     <td>${r.iban||''}</td><td>${num(r.amount)}</td><td>${r.incomeTaxAmount===null ? '<i style="color:var(--text-muted);">at submit</i>' : num(r.incomeTaxAmount)}</td><td>${num(r.salesTaxAmount)}</td>
     <td>${num(r.pstAmount)}</td><td>${num(r.securityAmount)}</td><td>${num(r.penaltyAmount)}</td><td>${num(r.otherDeductionAmount)}</td>
     <td>${r.net===null ? '<i style="color:var(--text-muted);">at submit</i>' : num(r.net)}</td><td>${r.description||''}</td><td>${officeAcctCell}</td></tr>`;
  }).join('');
}

async function submitBulkEntryForm(){
  if (!BULK_LINE_ITEMS.length){ toast('Upload a CSV with at least one row first.', 'error'); return; }
  const parentMeta = {
    entryDate: document.getElementById('e_date').value,
    fy: document.getElementById('e_fy').value || DEFAULT_FY_CLIENT,
    billNo: document.getElementById('e_billno').value,
    campusId: document.getElementById('e_campus').value,
    campusName: document.getElementById('e_campus').selectedOptions[0]?.text || '',
    headId: document.getElementById('e_headcode').value,
    headCode: document.getElementById('e_headcode').selectedOptions[0]?.text.split(' - ')[0] || '',
    headName: document.getElementById('e_headname').value,
    billDescription: document.getElementById('bulk_billdesc').value,
    payFromAccountId: document.getElementById('e_payFromAccount').value,
    receivingOfficeId: document.getElementById('e_receivingOffice').value,
    pstInvoiceNo: document.getElementById('bulk_pstInvoiceNo').value,
    vendorInvoiceDate: document.getElementById('bulk_vendorInvoiceDate').value,
    diaryId: CURRENT_DIARY_ID || '',
    diaryBypassReason: document.getElementById('e_diaryBypass') && document.getElementById('e_diaryBypass').checked
      ? document.getElementById('e_diaryBypassReason').value.trim() : ''
  };
  // Several Diary numbers can be covered by this one bulk bill (ticked in the picker above the upload).
  const pickedDiaryIds = (typeof selectedBulkDiaryIds === 'function') ? selectedBulkDiaryIds() : [];
  if (!parentMeta.diaryBypassReason){
    if (!parentMeta.diaryId && pickedDiaryIds.length) parentMeta.diaryId = pickedDiaryIds[0];
    parentMeta.extraDiaryIds = pickedDiaryIds.filter(x => x !== parentMeta.diaryId);
  }
  if (!parentMeta.diaryId && !parentMeta.diaryBypassReason){
    toast('A Diary Number is required - go to the Diary tab and click "Enter This Bill" (Admin can bypass with a reason).', 'error');
    return;
  }
  if (!parentMeta.campusId || !parentMeta.headId){
    toast('Please select campus and budget code (in the fields above).', 'error'); return;
  }
  if (!parentMeta.billDescription || !parentMeta.billDescription.trim()){
    toast('Bill Description (whole bill) is required.', 'error'); return;
  }
  const bulkType = document.querySelector('input[name="bulkType"]:checked').value;
  if (bulkType === 'Vendor'){
    if (!parentMeta.payFromAccountId){ toast('Select the bank account this bill is to be paid from.', 'error'); return; }
    if (!parentMeta.receivingOfficeId){ toast('Select the office this bill was received from.', 'error'); return; }
  } else {
    const missingOffice = !parentMeta.receivingOfficeId && BULK_LINE_ITEMS.some(li => !li.receivingOfficeId);
    const missingAccount = !parentMeta.payFromAccountId && BULK_LINE_ITEMS.some(li => !li.payFromAccountId);
    if (missingOffice){
      toast('Select a default Receiving Office above, or fill in ReceivingOffice for every row in the CSV.', 'error'); return;
    }
    if (missingAccount){
      toast('Select a default Pay From Account above, or fill in PayFromAccount for every row in the CSV.', 'error'); return;
    }
  }
  if (BULK_LINE_ITEMS.some(li => Number(li.pstAmount) > 0) && (!parentMeta.pstInvoiceNo || !parentMeta.vendorInvoiceDate)){
    toast("Invoice Number and Vendor's Invoice Date are required - at least one row in this file has Punjab Sales Tax deducted.", 'error'); return;
  }
  const overwrites = BULK_LINE_ITEMS.filter(li => li.__existingMismatch);
  if (overwrites.length && !confirm(
    overwrites.length + ' beneficiary/ies in this file have different Name/IBAN/Bank details than what is already saved ' +
    '(' + overwrites.map(li => li.name).slice(0,5).join(', ') + (overwrites.length > 5 ? ', ...' : '') + '). ' +
    'Continuing will overwrite the saved details with what is in this file. Continue?'
  )) return;
  const res = await runAction(document.getElementById('btnSubmitBulk'), 'Uploading bulk bill...', 'Bulk bill saved as one consolidated entry, now waiting in Processing.',
    () => gs('submitBulkEntry', parentMeta, BULK_LINE_ITEMS, CURRENT_USER.username));
  if (res && res.success){
    if (res.diaryWarnings && res.diaryWarnings.length) alert('Bulk bill saved as ' + res.entryId + '.\n\nDiary check (warning only):\n- ' + res.diaryWarnings.join('\n- '));
    CURRENT_DIARY_ID = null;
    const diaryBanner = document.getElementById('dy_activeBanner'); if (diaryBanner) diaryBanner.style.display = 'none';
    if (typeof loadMyDiaryQueue === 'function') loadMyDiaryQueue();
    BULK_DIARY_PICKED.clear();
    if (typeof loadBulkDiaryPicker === 'function') loadBulkDiaryPicker();
    BULK_LINE_ITEMS = [];
    document.getElementById('bulk_file').value = '';
    document.getElementById('bulk_billdesc').value = '';
    document.getElementById('bulk_pstInvoiceNo').value = '';
    document.getElementById('bulk_vendorInvoiceDate').value = '';
    document.getElementById('bulkPreviewWrap').style.display = 'none';
    checkBalance();
    refreshBadges();
  }
}

/* ---------- Payee: Vendor / UE Employee / Non-UE Employee / Student ---------- */
function onPayeeTypeChange(){
  const type = document.querySelector('input[name="payeeType"]:checked').value;
  document.getElementById('vendorFields').style.display = (type==='Vendor') ? '' : 'none';
  document.getElementById('employeeFields').style.display = (type==='Employee') ? '' : 'none';
  document.getElementById('nonUEFields').style.display = (type==='NonUEEmployee') ? '' : 'none';
  document.getElementById('studentFields').style.display = (type==='Student') ? '' : 'none';
  document.getElementById('employeeNotFound').style.display = 'none';
  populateBillNatureOptions();
  onBillNatureChange();
  updateSecurityHeldDisplay();
}
let employeeTimeout;
function onEmployeeIdInput(){
  clearTimeout(employeeTimeout);
  const id = document.getElementById('e_employeeid').value.trim();
  document.getElementById('employeeNotFound').style.display = 'none';
  if(!id){ ['e_empname','e_empdesignation','e_empcnic','e_empiban','e_empbank'].forEach(f=>document.getElementById(f).value=''); return; }
  employeeTimeout = setTimeout(()=>{
    gs('getEmployeeById', id).then(emp=>{
      if(!emp){
        ['e_empname','e_empdesignation','e_empcnic','e_empiban','e_empbank'].forEach(f=>document.getElementById(f).value='');
        document.getElementById('employeeNotFound').style.display = 'block';
        return;
      }
      document.getElementById('e_empname').value = emp.Name || '';
      document.getElementById('e_empdesignation').value = emp.Designation || '';
      document.getElementById('e_empcnic').value = emp.CNIC || '';
      document.getElementById('e_empiban').value = emp.IBAN || '';
      document.getElementById('e_empbank').value = emp.BankName || '';
      updateSecurityHeldDisplay();
      updateIncomeProfileDisplay();
    });
  }, 250);
}

let nonUETimeout;
function onNonUECnicInput(){
  clearTimeout(nonUETimeout);
  const cnic = document.getElementById('e_nonue_cnic').value.trim();
  if(!cnic) return;
  nonUETimeout = setTimeout(()=>{
    gs('getNonUEEmployeeByCNIC', cnic).then(rec=>{
      if(rec){
        document.getElementById('e_nonue_name').value = rec.Name || '';
        document.getElementById('e_nonue_iban').value = rec.IBAN || '';
        document.getElementById('e_nonue_bank').value = rec.BankName || '';
      }
      updateSecurityHeldDisplay();
      updateIncomeProfileDisplay();
    });
  }, 300);
}

let studentIdTimeout;
function onStudentIdInput(){
  clearTimeout(studentIdTimeout);
  const id = document.getElementById('e_studentid').value.trim();
  if(!id) return;
  studentIdTimeout = setTimeout(()=>{
    gs('getStudentById', id).then(rec=>{
      if(rec){
        document.getElementById('e_beneficiaryTitle').value = rec.Name || '';
        document.getElementById('e_studentcnic').value = rec.CNIC || '';
        document.getElementById('e_beneficiaryIban').value = rec.IBAN || '';
        document.getElementById('e_program').value = rec.Program || '';
        document.getElementById('e_session').value = rec.Session || '';
        if (rec.Shift) document.getElementById('e_shift').value = rec.Shift;
      }
    });
  }, 300);
}

/* ---------- Deductions / tax preview ---------- */
const VENDOR_BILL_NATURES = [
  { group:'Taxable', options:[
    ['Supply','Supply / Sale of Goods'], ['Service','Rendering of Services'], ['Contract','Execution of Contract'] ]},
  { group:'Not Taxable', options:[
    ['Release of Security','Release of Security'] ]}
];
const EMPLOYEE_149_OPTIONS = [
  ['UE Visiting Faculty','UE Visiting Faculty'], ['Non-Teaching','Non-Teaching'], ['Additional Duty','Additional Duty'],
  ['Paper Setting/Marking','Paper Setting/Marking'], ['Conduct of Exam','Conduct of Exam'], ['Examiners','Examiners'],
  ['Thesis Evaluation','Thesis Evaluation'], ['Honorarium','Honorarium'], ['Contingency','Contingency']
];
const UE_ONLY_TAXABLE_OPTIONS = [ ['Overtime','Overtime'] ];
const UE_EMPLOYEE_BILL_NATURES = [
  { group:'Taxable (Section 149)', options: EMPLOYEE_149_OPTIONS.concat(UE_ONLY_TAXABLE_OPTIONS) },
  { group:'Not Taxable', options:[
    ['Reimbursement of Fee','Reimbursement of Fee'], ['Medical','Medical'], ['Advance','Advance'],
    ['TADA','TADA'], ['Release of Security','Release of Security'], ['GPF Advance','GPF Advance'],
    ['Benevolent Fund','Benevolent Fund'], ['Mobile Bill','Mobile Bill'], ['Refreshment','Refreshment'], ['POL','POL'],
    ['Contingency (Non-Taxable)','Contingency (Non-Taxable)'] ]}
];
const UE_NON_TAXABLE_NATURES_BULK = UE_EMPLOYEE_BILL_NATURES[1].options.map(o=>o[0]);
const SECTION_156_NATURE = "Honoraria to Statutory Body Meeting's Member";
const NONUE_EMPLOYEE_BILL_NATURES = [
  { group:'Taxable (Section 149)', options: EMPLOYEE_149_OPTIONS },
  { group:'Taxable (Section 156)', options: [ [SECTION_156_NATURE, SECTION_156_NATURE] ] }
];
const STUDENT_BILL_NATURES_CLIENT = [
  { group:null, options:[ ['Scholarship','Scholarship'], ['Refund of Fee','Refund of Fee'] ] }
];
const VENDOR_TAXABLE_NATURES = ['Supply','Service','Contract'];
const EMPLOYEE_149_NATURES = EMPLOYEE_149_OPTIONS.map(o=>o[0]);
const UE_ONLY_TAXABLE_NATURES = UE_ONLY_TAXABLE_OPTIONS.map(o=>o[0]);

const VENDOR_SERVICE_CATEGORIES = [
  ['Specified Corporate Services','Specified Corporate Services (Transport, Courier, Hotel, Security, Software Dev, etc.)'],
  ['IT & IT-Enabled Services (ITeS)','IT & IT-Enabled Services (ITeS)'],
  ['Print & Electronic Media Advertisement','Print & Electronic Media Advertisement (Final Tax)'],
  ['General Services - Company','General Services - Company'],
  ['General Services - Individual/AOP','General Services - Individual/AOP']
];

function populateBillNatureOptions(){
  const type = document.querySelector('input[name="payeeType"]:checked').value;
  const groups = type === 'Student' ? STUDENT_BILL_NATURES_CLIENT
    : type === 'Employee' ? UE_EMPLOYEE_BILL_NATURES
    : type === 'NonUEEmployee' ? NONUE_EMPLOYEE_BILL_NATURES
    : VENDOR_BILL_NATURES;
  const sel = document.getElementById('e_billnature');
  // No default nature - "-- Select --" is always the one selected on load.
  const placeholder = '<option value="" selected>-- Select --</option>';
  sel.innerHTML = placeholder + groups.map(g => {
    const opts = g.options.map(([v,label]) => `<option value="${v}">${label}</option>`).join('');
    return g.group ? `<optgroup label="${g.group}">${opts}</optgroup>` : opts;
  }).join('');
}
function populateServiceCategoryOptions(){
  document.getElementById('e_servicecategory').innerHTML = VENDOR_SERVICE_CATEGORIES.map(([v,l]) => `<option value="${v}">${l}</option>`).join('');
}

function onBillNatureChange(){
  const payeeType = document.querySelector('input[name="payeeType"]:checked').value;
  const isStudent = payeeType === 'Student';
  const isEmployee = payeeType === 'Employee';
  const isNonUE = payeeType === 'NonUEEmployee';
  const isVendor = payeeType === 'Vendor';
  const nature = document.getElementById('e_billnature').value;
  const is149 = (isEmployee || isNonUE) && EMPLOYEE_149_NATURES.includes(nature);
  const isSection156 = isNonUE && nature === SECTION_156_NATURE;
  const noTax = isStudent
    || (isVendor && !VENDOR_TAXABLE_NATURES.includes(nature))
    || ((isEmployee || isNonUE) && !is149 && !isSection156);
  const isReleaseOfSecurity = !isStudent && nature === 'Release of Security';

  const isThesis = nature === 'Thesis Evaluation';
  const isBenevolent = isEmployee && nature === 'Benevolent Fund';
  const nonUEMethodEl = document.getElementById('e_nonueTaxMethod');
  const nonue153 = isNonUE && is149 && nonUEMethodEl && nonUEMethodEl.value === 'Section153_1b';

  document.getElementById('e_refundCategoryWrap').style.display = (isStudent && nature === 'Refund of Fee') ? '' : 'none';
  if (!(isStudent && nature === 'Refund of Fee')) document.getElementById('e_refundCategoryOtherWrap').style.display = 'none';
  document.getElementById('e_taxpayerTypeWrap').style.display = (isVendor && !noTax && nature !== 'Service') ? '' : 'none';
  document.getElementById('e_serviceCategoryWrap').style.display = (isVendor && !noTax && nature === 'Service') ? '' : 'none';
  document.getElementById('e_examSubCategoryWrap').style.display = (is149 && nature === 'Conduct of Exam') ? '' : 'none';
  document.getElementById('contractRateRow').style.display = (isVendor && nature === 'Contract') ? '' : 'none';
  document.getElementById('e_thesisClassWrap').style.display = isThesis ? '' : 'none';
  document.getElementById('e_thesisStudentNameWrap').style.display = isThesis ? '' : 'none';
  document.getElementById('e_visitingFieldsWrap').style.display = (isEmployee || isNonUE) && ['UE Visiting Faculty','Paper Setting/Marking'].indexOf(nature) !== -1 ? '' : 'none';
  document.getElementById('e_benevolentSubWrap').style.display = isBenevolent ? '' : 'none';
  document.getElementById('e_nonueTaxMethodWrap').style.display = (isNonUE && is149) ? '' : 'none';
  if (isVendor && nature === 'Service' && !noTax) populateServiceCategoryOptions();

  document.getElementById('taxStatusRow').style.display = (noTax || (is149 && !nonue153) || isSection156) ? 'none' : '';
  document.getElementById('e_praStatusWrap').style.display = (noTax || isEmployee || isNonUE) ? 'none' : '';
  document.getElementById('taxCheckRow').style.display = noTax ? 'none' : '';
  document.getElementById('stCheckLabel').style.display = (isEmployee || isNonUE) ? 'none' : '';
  document.getElementById('pstCheckLabel').style.display = (isEmployee || isNonUE) ? 'none' : '';
  if (noTax) {
    document.getElementById('e_applyIT').checked = false;
    document.getElementById('e_applyST').checked = false;
    document.getElementById('e_applyPST').checked = false;
  } else if (isEmployee || isNonUE) {
    document.getElementById('e_applyIT').checked = true;
    document.getElementById('e_applyST').checked = false;
    document.getElementById('e_applyPST').checked = false;
  } else {
    document.getElementById('e_applyIT').checked = true;
    document.getElementById('e_applyST').checked = (nature === 'Supply');
    document.getElementById('e_applyPST').checked = (nature === 'Service' || nature === 'Contract');
  }
  document.getElementById('manualSalesTaxRow').style.display = document.getElementById('e_applyST').checked ? '' : 'none';
  onPSTCheckChange();

  document.getElementById('incomeProfileSection').style.display = is149 ? 'block' : 'none';
  document.getElementById('nonUEAffidavitRow').style.display = (is149 && isNonUE) ? '' : 'none';
  document.getElementById('ueAnnualIncomeRow').style.display = (is149 && isEmployee) ? '' : 'none';
  document.getElementById('annualIncomeRow').style.display = (is149 && isNonUE) ? '' : 'none';
  if (is149) updateIncomeProfileDisplay();

  const showVendorDeductions = isVendor && !noTax;
  document.getElementById('otherDeductionsSection').style.display = showVendorDeductions ? '' : 'none';
  document.getElementById('studentDeductionSection').style.display = isStudent ? '' : 'none';
  document.getElementById('releaseSecurityInfo').style.display = isReleaseOfSecurity ? 'flex' : 'none';
  if (!showVendorDeductions) {
    ['e_applySecurity','e_applyPenalty','e_applyOther'].forEach(id=>{
      document.getElementById(id).checked = false;
    });
    ['security','penalty','other'].forEach(toggleDeductionRow);
  }
  if (!isStudent) {
    document.getElementById('e_applyStudentDeduction').checked = false;
    toggleDeductionRow('studentDeduction');
  }
  if (isReleaseOfSecurity) updateSecurityHeldDisplay();
  updateTaxPreview();
}

function onRefundCategoryChange(){
  const isOther = document.getElementById('e_refundcategory').value === '__other__';
  document.getElementById('e_refundCategoryOtherWrap').style.display = isOther ? '' : 'none';
  updateTaxPreview();
}

function resolvedPayeeName(){
  const type = document.querySelector('input[name="payeeType"]:checked').value;
  if (type === 'Employee') return document.getElementById('e_empname').value;
  if (type === 'NonUEEmployee') return document.getElementById('e_nonue_name').value;
  if (type === 'Student') return document.getElementById('e_beneficiaryTitle').value;
  return document.getElementById('e_vendor').value;
}
function resolvedIncomeProfileKey(){
  const type = document.querySelector('input[name="payeeType"]:checked').value;
  if (type === 'Employee') return document.getElementById('e_employeeid').value.trim();
  if (type === 'NonUEEmployee') return document.getElementById('e_nonue_cnic').value.trim();
  return '';
}
let CURRENT_SECURITY_HELD = 0;
let securityHeldTimeout;
function updateSecurityHeldDisplay(){
  if (document.getElementById('e_billnature').value !== 'Release of Security') return;
  clearTimeout(securityHeldTimeout);
  const name = resolvedPayeeName();
  if (!name){ document.getElementById('rs_held').innerText = '-'; CURRENT_SECURITY_HELD = 0; updateReleaseAfterFigure(); return; }
  securityHeldTimeout = setTimeout(()=>{
    gs('getVendorSecurityBalance', name).then(res=>{
      CURRENT_SECURITY_HELD = res.held;
      document.getElementById('rs_held').innerText = num(res.held);
      updateReleaseAfterFigure();
    }).catch(()=>{});
  }, 250);
}
function updateReleaseAfterFigure(){
  const amt = Number(document.getElementById('e_amount').value) || 0;
  document.getElementById('rs_release').innerText = num(amt);
  const after = CURRENT_SECURITY_HELD - amt;
  const afterEl = document.getElementById('rs_after');
  afterEl.innerText = num(after);
  afterEl.style.color = after < 0 ? 'var(--danger)' : '';
}

/* ---------- Section 149 income profile ---------- */
function onAffidavitChange(){
  const affidavit = document.getElementById('e_affidavit').checked;
  document.getElementById('annualIncomeRow').style.display = affidavit ? 'none' : '';
  updateTaxPreview();
}
let incomeProfileTimeout;
function updateIncomeProfileDisplay(){
  const payeeType = document.querySelector('input[name="payeeType"]:checked').value;
  const key = resolvedIncomeProfileKey();
  const fy = document.getElementById('e_fy').value || DEFAULT_FY_CLIENT;
  const targetField = payeeType === 'Employee' ? 'e_annualIncomeUE' : 'e_annualIncome';
  if (!key){ document.getElementById(targetField).value = ''; return; }
  clearTimeout(incomeProfileTimeout);
  incomeProfileTimeout = setTimeout(()=>{
    gs('getIncomeProfile', key, payeeType, fy).then(profile=>{
      document.getElementById(targetField).value = profile ? profile.AnnualTaxableIncome : '';
      updateTaxPreview();
    }).catch(()=>{});
  }, 300);
}
async function saveIncomeProfileForm(){
  const payeeType = document.querySelector('input[name="payeeType"]:checked').value;
  const key = resolvedIncomeProfileKey();
  if (!key){ toast('Enter the Employee ID / CNIC first.', 'error'); return; }
  const profile = {
    key, payeeType, fy: document.getElementById('e_fy').value || DEFAULT_FY_CLIENT,
    name: resolvedPayeeName(), annualTaxableIncome: document.getElementById('e_annualIncome').value,
    affidavitLowIncome: document.getElementById('e_affidavit') ? document.getElementById('e_affidavit').checked : false
  };
  const res = await runAction(null, 'Saving income profile...', 'Income profile saved.',
    () => gs('saveIncomeProfile', CURRENT_USER.username, profile));
  if (res && res.success) updateTaxPreview();
}

function toggleDeductionRow(kind){
  const map = {
    security: ['e_securityBasis','e_securityModeSel','e_securityRate','e_securityAmountInput'],
    penalty: ['e_penaltyBasis','e_penaltyModeSel','e_penaltyRate','e_penaltyAmountInput'],
    other: ['e_otherCategory','e_otherBasis','e_otherModeSel','e_otherRate','e_otherAmountInput'],
    studentDeduction: ['e_studentDeductionCategory','e_studentDeductionBasis','e_studentDeductionAmount'],
    manualTax: ['e_manualTaxSection','e_manualTaxModeSel','e_manualTaxRate','e_manualTaxAmountInput'],
    manualSalesTax: ['e_salesTaxModeSel','e_salesTaxManualRate','e_salesTaxManualAmountInput'],
    manualPST: ['e_pstModeSel','e_pstManualRate','e_pstManualAmountInput']
  };
  const checkboxId = { security:'e_applySecurity', penalty:'e_applyPenalty', other:'e_applyOther', studentDeduction:'e_applyStudentDeduction',
    manualTax:'e_manualTaxOverride', manualSalesTax:'e_manualSalesTaxOverride', manualPST:'e_manualPSTOverride' }[kind];
  const checked = document.getElementById(checkboxId).checked;
  map[kind].forEach(id => document.getElementById(id).disabled = !checked);
  // Penalty and Other Deduction default to "By Amount" every time they're switched on.
  if (checked && (kind === 'penalty' || kind === 'other')) {
    document.getElementById({ penalty:'e_penaltyModeSel', other:'e_otherModeSel' }[kind]).value = 'amount';
  }
  if (kind !== 'studentDeduction') onDeductionModeChange(kind);
}

function onDeductionModeChange(kind){
  const ids = {
    security: { modeSel:'e_securityModeSel', rate:'e_securityRate', amountWrap:'e_securityAmountWrap', amountInput:'e_securityAmountInput' },
    penalty: { modeSel:'e_penaltyModeSel', rate:'e_penaltyRate', amountWrap:'e_penaltyAmountWrap', amountInput:'e_penaltyAmountInput' },
    other: { modeSel:'e_otherModeSel', rate:'e_otherRate', amountWrap:'e_otherAmountWrap', amountInput:'e_otherAmountInput' },
    manualTax: { modeSel:'e_manualTaxModeSel', rate:'e_manualTaxRate', amountWrap:'e_manualTaxAmountWrap', amountInput:'e_manualTaxAmountInput' },
    manualSalesTax: { modeSel:'e_salesTaxModeSel', rate:'e_salesTaxManualRate', amountWrap:'e_salesTaxManualAmountWrap', amountInput:'e_salesTaxManualAmountInput' },
    manualPST: { modeSel:'e_pstModeSel', rate:'e_pstManualRate', amountWrap:'e_pstManualAmountWrap', amountInput:'e_pstManualAmountInput' }
  }[kind];
  const checkboxChecked = document.getElementById({ security:'e_applySecurity', penalty:'e_applyPenalty', other:'e_applyOther',
    manualTax:'e_manualTaxOverride', manualSalesTax:'e_manualSalesTaxOverride', manualPST:'e_manualPSTOverride' }[kind]).checked;
  const mode = document.getElementById(ids.modeSel).value;
  const isAmountMode = mode === 'amount';
  document.getElementById(ids.rate).closest('.field').style.display = isAmountMode ? 'none' : '';
  document.getElementById(ids.amountWrap).style.display = isAmountMode ? '' : 'none';
  document.getElementById(ids.rate).disabled = !checkboxChecked || isAmountMode;
  document.getElementById(ids.amountInput).disabled = !checkboxChecked || !isAmountMode;
  updateTaxPreview();
}

function collectTaxParams(){
  const payeeType = document.querySelector('input[name="payeeType"]:checked').value;
  return {
    grossAmount: document.getElementById('e_amount').value || 0,
    payeeType: payeeType,
    billNature: document.getElementById('e_billnature').value,
    refundCategory: document.getElementById('e_refundcategory').value === '__other__'
      ? document.getElementById('e_refundcategory_other').value
      : document.getElementById('e_refundcategory').value,
    fbrStatus: document.getElementById('e_fbrstatus').value,
    serviceCategory: document.getElementById('e_servicecategory').value,
    taxpayerType: document.getElementById('e_taxpayertype').value,
    praStatus: document.getElementById('e_prastatus').value,
    fy: document.getElementById('e_fy').value || DEFAULT_FY_CLIENT,
    employeeId: document.getElementById('e_employeeid').value,
    cnic: payeeType === 'NonUEEmployee' ? document.getElementById('e_nonue_cnic').value : document.getElementById('e_cnic').value,
    examSubCategory: document.getElementById('e_examSubCategory').value,
    thesisClass: document.getElementById('e_thesisClass').value,
    thesisStudentName: document.getElementById('e_thesisStudentName').value,
    visitingProgram: document.getElementById('e_visitingProgram').value,
    visitingSubject: document.getElementById('e_visitingSubject').value,
    visitingCrHrs: document.getElementById('e_visitingCrHrs').value,
    visitingRate: document.getElementById('e_visitingRate').value,
    visitingLectures: document.getElementById('e_visitingLectures').value,
    benevolentFundSubCategory: document.getElementById('e_benevolentSub').value,
    nonUeTaxMethod: document.getElementById('e_nonueTaxMethod').value,
    contractCategory: document.getElementById('e_contractCategory').value,
    manualTaxOverride: document.getElementById('e_manualTaxOverride').checked,
    manualTaxSection: document.getElementById('e_manualTaxSection').value,
    manualTaxMode: document.getElementById('e_manualTaxModeSel').value,
    manualTaxRate: document.getElementById('e_manualTaxRate').value,
    manualTaxAmount: document.getElementById('e_manualTaxAmountInput').value,
    manualSalesTaxOverride: document.getElementById('e_manualSalesTaxOverride').checked,
    salesTaxMode: document.getElementById('e_salesTaxModeSel').value,
    salesTaxManualRate: document.getElementById('e_salesTaxManualRate').value,
    salesTaxManualAmount: document.getElementById('e_salesTaxManualAmountInput').value,
    manualPSTOverride: document.getElementById('e_manualPSTOverride').checked,
    pstMode: document.getElementById('e_pstModeSel').value,
    pstManualRate: document.getElementById('e_pstManualRate').value,
    pstManualAmount: document.getElementById('e_pstManualAmountInput').value,
    affidavitLowIncome: document.getElementById('e_affidavit') ? document.getElementById('e_affidavit').checked : false,
    applyIncomeTax: document.getElementById('e_applyIT').checked,
    applySalesTax: document.getElementById('e_applyST').checked,
    applyPST: document.getElementById('e_applyPST').checked,
    applySecurity: document.getElementById('e_applySecurity').checked,
    securityBasis: document.getElementById('e_securityBasis').value,
    securityMode: document.getElementById('e_securityModeSel').value,
    securityRate: document.getElementById('e_securityRate').value,
    securityAmount: document.getElementById('e_securityAmountInput').value,
    applyPenalty: document.getElementById('e_applyPenalty').checked,
    penaltyBasis: document.getElementById('e_penaltyBasis').value,
    penaltyMode: document.getElementById('e_penaltyModeSel').value,
    penaltyRate: document.getElementById('e_penaltyRate').value,
    penaltyAmount: document.getElementById('e_penaltyAmountInput').value,
    applyOtherDeduction: document.getElementById('e_applyOther').checked,
    otherDeductionCategory: document.getElementById('e_otherCategory').value,
    otherDeductionBasis: document.getElementById('e_otherBasis').value,
    otherDeductionMode: document.getElementById('e_otherModeSel').value,
    otherDeductionRate: document.getElementById('e_otherRate').value,
    otherDeductionAmount: document.getElementById('e_otherAmountInput').value,
    applyStudentDeduction: document.getElementById('e_applyStudentDeduction').checked,
    studentDeductionCategory: document.getElementById('e_studentDeductionCategory').value,
    studentDeductionBasis: document.getElementById('e_studentDeductionBasis').value,
    studentDeductionAmount: document.getElementById('e_studentDeductionAmount').value
  };
}
let taxPreviewTimeout;
function updateTaxPreview(){
  clearTimeout(taxPreviewTimeout);
  taxPreviewTimeout = setTimeout(()=>{
    gs('previewTaxCalculation', collectTaxParams()).then(tax=>{
      document.getElementById('tp_itsection').innerText = tax.incomeTaxSection || '-';
      document.getElementById('tp_itrate').innerText = tax.incomeTaxRate ? (tax.incomeTaxRate*100).toFixed(2)+'%' : '-';
      document.getElementById('tp_itamt').innerText = num(tax.incomeTaxAmount);
      document.getElementById('tp_strate').innerText = tax.salesTaxRate ? (tax.salesTaxRate*100).toFixed(2)+'%' : '-';
      document.getElementById('tp_stamt').innerText = num(tax.salesTaxAmount);
      document.getElementById('tp_pstrate').innerText = tax.pstRate ? (tax.pstRate*100).toFixed(2)+'%' : '-';
      document.getElementById('tp_pstamt').innerText = num(tax.pstAmount);
      document.getElementById('tp_pstcategory').innerText = tax.pstCategory ? (' (' + tax.pstCategory + ')') : '';
      document.getElementById('tp_secrate').innerText = tax.securityRate ? (tax.securityRate*100).toFixed(2)+'%' : '-';
      document.getElementById('tp_secamt').innerText = num(tax.securityAmount);
      document.getElementById('tp_penrate').innerText = tax.penaltyRate ? (tax.penaltyRate*100).toFixed(2)+'%' : '-';
      document.getElementById('tp_penamt').innerText = num(tax.penaltyAmount);
      document.getElementById('tp_othrate').innerText = tax.otherDeductionRate ? (tax.otherDeductionRate*100).toFixed(2)+'%' : '-';
      document.getElementById('tp_othamt').innerText = num(tax.otherDeductionAmount);
      document.getElementById('tp_studamt').innerText = num(tax.studentDeductionAmount);
      document.getElementById('tp_net').innerText = num(tax.netAmount);
      if (tax.section149) {
        document.getElementById('ip_claimed').innerText = num(tax.section149.claimedBefore);
        document.getElementById('ip_before').innerText = num(tax.section149.incomeBefore);
        document.getElementById('ip_after').innerText = num(tax.section149.incomeAfter);
      }
    }).catch(()=>{});
  }, 200);
}

let CURRENT_EDIT_ENTRY_ID = null;

async function submitEntryForm(){
  const headSel = document.getElementById('e_headcode');
  const payeeType = document.querySelector('input[name="payeeType"]:checked').value;
  const headMode = document.querySelector('input[name="headMode"]:checked').value;
  const headSplits = headMode === 'multi' ? collectHeadSplits() : [];
  const entry = {
    entryDate: document.getElementById('e_date').value,
    fy: document.getElementById('e_fy').value || DEFAULT_FY_CLIENT,
    billNo: document.getElementById('e_billno').value,
    campusId: document.getElementById('e_campus').value,
    campusName: document.getElementById('e_campus').selectedOptions[0]?.text || '',
    headId: headMode === 'multi' ? '' : headSel.value,
    headCode: headMode === 'multi' ? '' : (headSel.selectedOptions[0]?.text.split(' - ')[0] || ''),
    headName: headMode === 'multi' ? '' : document.getElementById('e_headname').value,
    headSplits: headSplits,
    payeeType: payeeType,
    employeeId: document.getElementById('e_employeeid').value,
    vendorName: payeeType === 'NonUEEmployee' ? document.getElementById('e_nonue_name').value : document.getElementById('e_vendor').value,
    cnic: payeeType === 'NonUEEmployee' ? document.getElementById('e_nonue_cnic').value : document.getElementById('e_cnic').value,
    iban: payeeType === 'NonUEEmployee' ? document.getElementById('e_nonue_iban').value : document.getElementById('e_iban').value,
    bankName: payeeType === 'NonUEEmployee' ? document.getElementById('e_nonue_bank').value : document.getElementById('e_bank').value,
    studentId: document.getElementById('e_studentid').value,
    studentCnic: document.getElementById('e_studentcnic').value,
    program: document.getElementById('e_program').value,
    session: document.getElementById('e_session').value,
    shift: document.getElementById('e_shift').value,
    beneficiaryAccountTitle: document.getElementById('e_beneficiaryTitle').value,
    beneficiaryIban: document.getElementById('e_beneficiaryIban').value,
    amount: document.getElementById('e_amount').value,
    billDescription: document.getElementById('e_billdesc').value,
    payFromAccountId: document.getElementById('e_payFromAccount').value,
    receivingOfficeId: document.getElementById('e_receivingOffice').value,
    pstInvoiceNo: document.getElementById('e_pstInvoiceNo').value,
    vendorInvoiceDate: document.getElementById('e_vendorInvoiceDate').value,
    diaryId: CURRENT_DIARY_ID || '',
    diaryBypassReason: document.getElementById('e_diaryBypass') && document.getElementById('e_diaryBypass').checked
      ? document.getElementById('e_diaryBypassReason').value.trim() : '',
    ...collectTaxParams()
  };
  if(!entry.receivingOfficeId){ toast('Select the office this bill was received from.', 'error'); return; }
  if(!entry.payFromAccountId){ toast('Select the bank account this bill is to be paid from.', 'error'); return; }
  if(!entry.diaryId && !entry.diaryBypassReason){
    toast('A Diary Number is required - go to the Diary tab and click "Enter This Bill" on an item assigned to you (Admin can bypass with a reason).', 'error');
    return;
  }
  if(payeeType === 'Vendor' && entry.applyPST && (!entry.pstInvoiceNo || !entry.vendorInvoiceDate)){
    toast('Invoice Number and Vendor\'s Invoice Date are required when Punjab Sales Tax is deducted.', 'error'); return;
  }
  if(!entry.campusId || !entry.amount){
    toast('Please fill campus and amount.', 'error');
    return;
  }
  if(!entry.billDescription || !entry.billDescription.trim()){
    toast('Bill Description is required.', 'error');
    return;
  }
  if(!entry.billNature){
    toast('Select a Nature of Bill.', 'error');
    return;
  }
  if(headMode === 'single' && !entry.headId){ toast('Please select a budget code.', 'error'); return; }
  if(headMode === 'multi'){
    if (headSplits.length < 2){ toast('Add at least two budget heads, each with an amount, for a multi-head bill.', 'error'); return; }
    const splitTotal = headSplits.reduce((s,x)=>s+x.amount, 0);
    if (Math.abs(splitTotal - Number(entry.amount)) > 0.01){
      toast('The budget head splits must add up to the bill amount.', 'error'); return;
    }
  }
  if(payeeType === 'Vendor' && !entry.vendorName){ toast('Vendor name is required.', 'error'); return; }
  if(payeeType === 'Employee' && !entry.employeeId){ toast('Employee ID is required.', 'error'); return; }
  if(payeeType === 'NonUEEmployee' && (!entry.cnic || !entry.vendorName)){
    toast('CNIC and Name are required for a Non-UE Employee.', 'error'); return;
  }
  if(payeeType === 'Student' && (!entry.studentId || !entry.beneficiaryAccountTitle)){
    toast('Student ID and Beneficiary Account Title are required.', 'error'); return;
  }
  if(payeeType === 'Student' && entry.billNature === 'Refund of Fee' && !entry.refundCategory){
    toast('Select a Refund category.', 'error'); return;
  }
  if((payeeType === 'Employee' || payeeType === 'NonUEEmployee') && entry.billNature === 'Conduct of Exam' && !entry.examSubCategory){
    toast('Enter the Conduct of Exam sub-category.', 'error'); return;
  }
  if((payeeType === 'Employee' || payeeType === 'NonUEEmployee') && entry.billNature === 'Thesis Evaluation' && (!entry.thesisClass || !entry.thesisStudentName)){
    toast('Enter the Class and Student Name for Thesis Evaluation.', 'error'); return;
  }
  if((payeeType === 'Employee' || payeeType === 'NonUEEmployee') && ['UE Visiting Faculty','Paper Setting/Marking'].includes(entry.billNature) &&
     (!entry.visitingProgram || !entry.visitingSubject || !entry.visitingCrHrs || !entry.visitingRate || !entry.visitingLectures)){
    toast('Enter Program, Subject, Cr. Hrs., Rate, and Lectures.', 'error'); return;
  }
  if(payeeType === 'Student' && entry.billNature === 'Refund of Fee' && document.getElementById('e_refundcategory').value === '__other__' && !entry.refundCategory){
    toast('Enter the Refund Category.', 'error'); return;
  }
  if(payeeType === 'Vendor' && entry.cnic && !isValidCnicOrNtnFormat(entry.cnic)){
    toast('CNIC/NTN must be a CNIC (35201-1222334-4) or an NTN (12345678).', 'error'); return;
  }
  if(payeeType === 'NonUEEmployee' && !isValidCnicFormat(entry.cnic)){
    toast('CNIC must be in the format 35201-1222334-4.', 'error'); return;
  }
  if(payeeType === 'Student' && entry.studentCnic && !isValidCnicFormat(entry.studentCnic)){
    toast("Beneficiary's CNIC must be in the format 35201-1222334-4.", 'error'); return;
  }
  const ibanToCheck = payeeType === 'Vendor' ? document.getElementById('e_iban').value
    : payeeType === 'NonUEEmployee' ? document.getElementById('e_nonue_iban').value
    : payeeType === 'Student' ? document.getElementById('e_beneficiaryIban').value : '';
  if(ibanToCheck && !isValidIbanFormat(ibanToCheck)){
    toast('IBAN must start with PK and be 24 characters in total (e.g. PK36SCBL0000001123456702).', 'error'); return;
  }
  if(payeeType === 'NonUEEmployee' && !entry.affidavitLowIncome && !document.getElementById('e_annualIncome').value){
    toast('Enter the Annual Taxable Income, or check the Affidavit of Low Income box.', 'error'); return;
  }

  const isEdit = !!CURRENT_EDIT_ENTRY_ID;
  const res = isEdit
    ? await runAction(document.getElementById('btnSubmitEntry'), 'Updating entry...', 'Bill updated.',
        () => gs('updateEntry', CURRENT_EDIT_ENTRY_ID, entry, CURRENT_USER.username))
    : await runAction(document.getElementById('btnSubmitEntry'), 'Saving entry...', 'Bill saved with status Received - it is now waiting in the Processing tab.',
        () => gs('submitEntry', entry, CURRENT_USER.username));
  if(res && res.success){
    CURRENT_EDIT_ENTRY_ID = null;
    document.getElementById('btnSubmitEntry').innerText = 'Save Entry';
    ['e_vendor','e_cnic','e_iban','e_bank','e_amount','e_billdesc','e_billno','e_employeeid','e_empname','e_empdesignation','e_empcnic','e_empiban','e_empbank',
     'e_nonue_cnic','e_nonue_name','e_nonue_iban','e_nonue_bank','e_examSubCategory',
     'e_thesisClass','e_thesisStudentName','e_visitingProgram','e_visitingSubject','e_visitingCrHrs','e_visitingRate','e_visitingLectures',
     'e_refundcategory_other','e_pstInvoiceNo','e_vendorInvoiceDate',
     'e_manualTaxSection','e_manualTaxRate','e_manualTaxAmountInput',
     'e_salesTaxManualRate','e_salesTaxManualAmountInput','e_pstManualRate','e_pstManualAmountInput',
     'e_studentid','e_studentcnic','e_program','e_session','e_beneficiaryTitle','e_beneficiaryIban']
      .forEach(id=>document.getElementById(id).value='');
    document.getElementById('e_nonueTaxMethod').value = 'Section149';
    document.getElementById('e_contractCategory').value = 'NewProjects';
    document.getElementById('e_manualTaxOverride').checked = false;
    toggleDeductionRow('manualTax');
    document.getElementById('e_manualSalesTaxOverride').checked = false;
    toggleDeductionRow('manualSalesTax');
    document.getElementById('e_manualPSTOverride').checked = false;
    toggleDeductionRow('manualPST');
    document.getElementById('manualSalesTaxRow').style.display = 'none';
    document.getElementById('manualPSTRow').style.display = 'none';
    document.getElementById('pstInvoiceRow').style.display = 'none';
    if (document.getElementById('e_affidavit')) document.getElementById('e_affidavit').checked = false;
    document.querySelector('input[name="headMode"][value="single"]').checked = true;
    document.querySelector('#headSplitsTable tbody').innerHTML = '';
    onHeadModeChange();
    checkBalance();
    updateTaxPreview();
    refreshBadges();
    CURRENT_DIARY_ID = null;
    document.getElementById('dy_activeBanner').style.display = 'none';
    if (document.getElementById('e_diaryBypass')) document.getElementById('e_diaryBypass').checked = false;
    if (document.getElementById('e_diaryBypassReasonWrap')) document.getElementById('e_diaryBypassReasonWrap').style.display = 'none';
    loadMyDiaryQueue();
    showBillConfirmation(res);
  }
}

/* ---------- Post-save confirmation popup ---------- */
let LAST_SAVED_ENTRY_ID = null;
function showBillConfirmation(res){
  LAST_SAVED_ENTRY_ID = res.entryId;
  const rows = (res.budgetSummary || []).map(b => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="font-weight:700;color:var(--accent);margin-bottom:6px;">${b.headCode || ''} ${b.headName || ''}</div>
      <div style="display:flex;justify-content:space-between;"><span>Allocation</span><b>${num(b.allocated)}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>Bill Amount</span><b>${num(b.billAmount)}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>Already Consumed</span><b>${num(b.alreadyConsumed)}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>New Total</span><b>${num(b.newTotal)}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>Remaining Balance</span><b style="color:${b.remainingBalance<0?'var(--danger)':'inherit'};">${num(b.remainingBalance)}</b></div>
    </div>`).join('');
  const warnHtml = (res.diaryWarnings && res.diaryWarnings.length)
    ? `<div style="border:1px solid var(--amber);background:rgba(245,158,11,0.12);border-radius:8px;padding:12px;margin-top:6px;font-size:14px;line-height:1.5;">
        <b style="color:var(--amber);">Diary check (warning only):</b><br>${res.diaryWarnings.map(w => '&bull; ' + w).join('<br>')}</div>`
    : '';
  document.getElementById('confirmContent').innerHTML = `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:2px solid var(--border);margin-bottom:8px;">
      <span>Bill ID</span><b>${res.entryId}</b></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:2px solid var(--border);margin-bottom:10px;">
      <span>Campus</span><b>${res.campusName || ''}</b></div>
    ${rows}${warnHtml}`;
  document.getElementById('confirmModal').style.display = 'flex';
}
function validateConfirmedEntry(){
  document.getElementById('confirmModal').style.display = 'none';
  LAST_SAVED_ENTRY_ID = null;
}
function updateConfirmedEntry(){
  document.getElementById('confirmModal').style.display = 'none';
  if (LAST_SAVED_ENTRY_ID) loadEntryForEdit(LAST_SAVED_ENTRY_ID);
}

// Pulls the full bill detail back and re-populates the New Entry form, switching it into edit mode.
async function loadEntryForEdit(entryId){
  const res = await gs('getBillDetail', entryId);
  if (!res || res.success === false){ toast('Could not load this bill for editing.', 'error'); return; }
  const e = res.bill;

  if (e.PayeeType === 'Bulk'){
    toast('Bulk bills cannot be edited here - Delete (if still Received) or Cancel it instead, then re-upload.', 'error');
    return;
  }

  // Lock in edit mode BEFORE populating any field, so Save never silently creates a duplicate.
  CURRENT_EDIT_ENTRY_ID = entryId;
  document.getElementById('btnSubmitEntry').innerText = 'Update Entry (' + entryId + ')';

  try {
  document.querySelector('input[name="entryMode"][value="single"]').checked = true;
  onEntryModeChange();

  document.getElementById('e_date').value = e.EntryDate ? new Date(e.EntryDate).toISOString().slice(0,10) : '';
  document.getElementById('e_fy').value = e.FY || DEFAULT_FY_CLIENT;
  document.getElementById('e_billno').value = e.BillNo || '';
  document.getElementById('e_billdesc').value = e.BillDescription || '';
  document.getElementById('e_amount').value = e.Amount || '';
  if (e.PayFromAccountID) document.getElementById('e_payFromAccount').value = e.PayFromAccountID;
  if (e.ReceivingOfficeID) document.getElementById('e_receivingOffice').value = e.ReceivingOfficeID;
  document.getElementById('e_pstInvoiceNo').value = e.PSTInvoiceNo || '';
  document.getElementById('e_vendorInvoiceDate').value = e.VendorInvoiceDate ? new Date(e.VendorInvoiceDate).toISOString().slice(0,10) : '';

  document.getElementById('e_campus').value = e.CampusID || '';
  await onCampusChange();

  if (res.headSplits && res.headSplits.length){
    document.querySelector('input[name="headMode"][value="multi"]').checked = true;
    onHeadModeChange();
    document.querySelector('#headSplitsTable tbody').innerHTML = '';
    res.headSplits.forEach(sp => {
      addHeadSplitRow();
      const rows = document.querySelectorAll('#headSplitsTable tbody tr');
      const tr = rows[rows.length - 1];
      tr.querySelector('.headSplitHeadSelect').value = sp.HeadID;
      tr.querySelector('.headSplitAmount').value = sp.Amount;
    });
    updateHeadSplitTotals();
  } else {
    document.querySelector('input[name="headMode"][value="single"]').checked = true;
    onHeadModeChange();
    document.getElementById('e_headcode').value = e.HeadID || '';
    onHeadChange();
  }

  const payeeType = e.PayeeType || 'Vendor';
  document.querySelector(`input[name="payeeType"][value="${payeeType}"]`).checked = true;
  onPayeeTypeChange();
  if (payeeType === 'Vendor'){
    document.getElementById('e_vendor').value = e.VendorName || '';
    document.getElementById('e_cnic').value = e.CNIC_NTN || '';
    document.getElementById('e_iban').value = e.IBAN || '';
  } else if (payeeType === 'Employee'){
    document.getElementById('e_employeeid').value = e.EmployeeID || '';
    onEmployeeIdInput();
  } else if (payeeType === 'NonUEEmployee'){
    document.getElementById('e_nonue_cnic').value = e.CNIC_NTN || '';
    document.getElementById('e_nonue_name').value = e.VendorName || '';
    document.getElementById('e_nonue_iban').value = e.IBAN || '';
  } else if (payeeType === 'Student'){
    document.getElementById('e_studentid').value = e.StudentID || '';
    document.getElementById('e_program').value = e.Program || '';
    document.getElementById('e_session').value = e.Session || '';
    if (e.Shift) document.getElementById('e_shift').value = e.Shift;
    document.getElementById('e_beneficiaryTitle').value = e.VendorName || '';
    document.getElementById('e_beneficiaryIban').value = e.IBAN || '';
    document.getElementById('e_studentcnic').value = e.CNIC_NTN || '';
  }

  document.getElementById('e_billnature').value = e.BillNature || '';
  if (e.NonUETaxMethod) document.getElementById('e_nonueTaxMethod').value = e.NonUETaxMethod;
  onBillNatureChange();
  if (e.RefundCategory){
    const refSel = document.getElementById('e_refundcategory');
    const known = Array.from(refSel.options).some(o => o.value === e.RefundCategory);
    if (known) { refSel.value = e.RefundCategory; }
    else { refSel.value = '__other__'; document.getElementById('e_refundcategory_other').value = e.RefundCategory; }
    onRefundCategoryChange();
  }
  if (e.TaxpayerType) document.getElementById('e_taxpayertype').value = e.TaxpayerType;
  if (e.ServiceCategory) document.getElementById('e_servicecategory').value = e.ServiceCategory;
  if (e.FBRStatus) document.getElementById('e_fbrstatus').value = e.FBRStatus;
  if (e.PRAStatus) document.getElementById('e_prastatus').value = e.PRAStatus;
  if (e.ExamSubCategory) document.getElementById('e_examSubCategory').value = e.ExamSubCategory;
  if (e.ThesisClass) document.getElementById('e_thesisClass').value = e.ThesisClass;
  if (e.ThesisStudentName) document.getElementById('e_thesisStudentName').value = e.ThesisStudentName;
  if (e.VisitingProgram) document.getElementById('e_visitingProgram').value = e.VisitingProgram;
  if (e.VisitingSubject) document.getElementById('e_visitingSubject').value = e.VisitingSubject;
  if (e.VisitingCrHrs) document.getElementById('e_visitingCrHrs').value = e.VisitingCrHrs;
  if (e.VisitingRate) document.getElementById('e_visitingRate').value = e.VisitingRate;
  if (e.VisitingLectures) document.getElementById('e_visitingLectures').value = e.VisitingLectures;
  if (e.BenevolentFundSubCategory) document.getElementById('e_benevolentSub').value = e.BenevolentFundSubCategory;
  if (e.ContractCategory) document.getElementById('e_contractCategory').value = e.ContractCategory;
  if (e.ManualTaxOverride){
    document.getElementById('e_manualTaxOverride').checked = true;
    toggleDeductionRow('manualTax');
    document.getElementById('e_manualTaxSection').value = e.ManualTaxSection || '';
    if (e.ManualTaxMode) document.getElementById('e_manualTaxModeSel').value = e.ManualTaxMode;
    document.getElementById('e_manualTaxRate').value = e.ManualTaxRate || '';
    document.getElementById('e_manualTaxAmountInput').value = e.ManualTaxAmount || '';
    onDeductionModeChange('manualTax');
  }
  if (e.ManualSalesTaxOverride){
    document.getElementById('manualSalesTaxRow').style.display = '';
    document.getElementById('e_manualSalesTaxOverride').checked = true;
    toggleDeductionRow('manualSalesTax');
    if (e.SalesTaxMode) document.getElementById('e_salesTaxModeSel').value = e.SalesTaxMode;
    document.getElementById('e_salesTaxManualRate').value = e.SalesTaxRate ? (e.SalesTaxRate*100).toFixed(2) : '';
    document.getElementById('e_salesTaxManualAmountInput').value = e.SalesTaxAmount || '';
    onDeductionModeChange('manualSalesTax');
  }
  if (e.ManualPSTOverride){
    document.getElementById('manualPSTRow').style.display = '';
    document.getElementById('e_manualPSTOverride').checked = true;
    toggleDeductionRow('manualPST');
    if (e.PSTMode) document.getElementById('e_pstModeSel').value = e.PSTMode;
    document.getElementById('e_pstManualRate').value = e.PSTRate ? (e.PSTRate*100).toFixed(2) : '';
    document.getElementById('e_pstManualAmountInput').value = e.PSTAmount || '';
    onDeductionModeChange('manualPST');
  }
  if (e.AffidavitLowIncome && document.getElementById('e_affidavit')){
    document.getElementById('e_affidavit').checked = true;
    onAffidavitChange();
  }

  document.getElementById('e_applyIT').checked = Number(e.IncomeTaxAmount) > 0 || !!e.IncomeTaxSection;
  document.getElementById('e_applyST').checked = !!e.SalesTaxApplied;
  document.getElementById('e_applyPST').checked = !!e.PSTApplied;
  onPSTCheckChange();

  if (e.SecurityApplied){
    document.getElementById('e_applySecurity').checked = true;
    toggleDeductionRow('security');
    document.getElementById('e_securityBasis').value = e.SecurityBasis || '';
    document.getElementById('e_securityModeSel').value = 'amount';
    document.getElementById('e_securityAmountInput').value = e.SecurityAmount || '';
    onDeductionModeChange('security');
  }
  if (e.PenaltyApplied){
    document.getElementById('e_applyPenalty').checked = true;
    toggleDeductionRow('penalty');
    document.getElementById('e_penaltyBasis').value = e.PenaltyBasis || '';
    document.getElementById('e_penaltyModeSel').value = 'amount';
    document.getElementById('e_penaltyAmountInput').value = e.PenaltyAmount || '';
    onDeductionModeChange('penalty');
  }
  if (e.OtherDeductionApplied){
    document.getElementById('e_applyOther').checked = true;
    toggleDeductionRow('other');
    document.getElementById('e_otherCategory').value = e.OtherDeductionCategory || '';
    document.getElementById('e_otherBasis').value = e.OtherDeductionBasis || '';
    document.getElementById('e_otherModeSel').value = 'amount';
    document.getElementById('e_otherAmountInput').value = e.OtherDeductionAmount || '';
    onDeductionModeChange('other');
  }
  if (e.StudentDeductionApplied){
    document.getElementById('e_applyStudentDeduction').checked = true;
    toggleDeductionRow('studentDeduction');
    document.getElementById('e_studentDeductionCategory').value = e.StudentDeductionCategory || '';
    document.getElementById('e_studentDeductionBasis').value = e.StudentDeductionBasis || '';
    document.getElementById('e_studentDeductionAmount').value = e.StudentDeductionAmount || '';
  }

  CURRENT_EDIT_ENTRY_ID = entryId;
  document.getElementById('btnSubmitEntry').innerText = 'Update Entry (' + entryId + ')';
  updateTaxPreview();
  showTab('entry');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Editing ' + entryId + ' - change what you need and click Update Entry.', 'success');
  } catch (err) {
    toast('This bill loaded only partially (' + (err.message||err) + ') - please review every field carefully before clicking Update Entry.', 'error');
    showTab('entry');
  }
}

/* ---------- Stages 2-4 ---------- */
const STAGE_TABLE_DATA = {};
// tableId -> Set of checked Bill IDs, so filtering (which re-renders the table) never loses a selection.
const STAGE_TABLE_SELECTED = {};
function toggleStageSelection(tableId, entryId, checked){
  const set = STAGE_TABLE_SELECTED[tableId] || (STAGE_TABLE_SELECTED[tableId] = new Set());
  if (checked) set.add(entryId); else set.delete(entryId);
}
function loadStageTable(status, tableId, fySelectId){
  const fy = fySelectId ? document.getElementById(fySelectId).value : '';
  const tbody = document.querySelector('#'+tableId+' tbody');
  tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;color:var(--text-muted);">Loading...</td></tr>';
  gs('getBillsByStatus', status, fy).then(list=>{
    list = list || [];
    STAGE_TABLE_DATA[tableId] = list;
    STAGE_TABLE_SELECTED[tableId] = new Set();
    renderStageTable(tableId);
    refreshBadges();
  }).catch(e=>{
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--danger);">Could not load bills: ' + (e.message||e) + '</td></tr>';
    toast('Could not load bills: ' + (e.message||e), 'error');
  });
}
function filterStageTable(tableId, idFieldPrefix){
  renderStageTable(tableId, {
    billId: (document.getElementById(idFieldPrefix+'_fid')||{}).value || '',
    name: (document.getElementById(idFieldPrefix+'_fname')||{}).value || '',
    description: (document.getElementById(idFieldPrefix+'_fdesc')||{}).value || '',
    amount: (document.getElementById(idFieldPrefix+'_famt')||{}).value || ''
  });
}
function renderStageTable(tableId, filters){
  const tbody = document.querySelector('#'+tableId+' tbody');
  let list = STAGE_TABLE_DATA[tableId] || [];
  const selected = STAGE_TABLE_SELECTED[tableId] || (STAGE_TABLE_SELECTED[tableId] = new Set());
  if (filters) {
    const fId = filters.billId.trim().toLowerCase();
    const fName = filters.name.trim().toLowerCase();
    const fDesc = filters.description.trim().toLowerCase();
    const fAmt = filters.amount.trim().toLowerCase();
    list = list.filter(e => {
      if (fId && !String(e.EntryID||'').toLowerCase().includes(fId)) return false;
      if (fName && !String(e.VendorName||'').toLowerCase().includes(fName)) return false;
      if (fDesc && !String(e.BillDescription||'').toLowerCase().includes(fDesc)) return false;
      if (fAmt && !String(e.Amount||'').toLowerCase().includes(fAmt) && !String(e.NetAmount||'').toLowerCase().includes(fAmt)) return false;
      return true;
    });
  }
  if(tableId==='processingTable'){
    tbody.innerHTML = list.map(e=>`<tr><td><input type="checkbox" class="chk-${tableId}" value="${e.EntryID}" ${selected.has(e.EntryID)?'checked':''} onchange="toggleStageSelection('${tableId}','${e.EntryID}',this.checked)"></td>
      <td>${billIdLink(e.EntryID)}</td><td>${fmtDate(e.EntryDate)}</td><td>${e.CampusName}</td><td>${e.BillDescription||''}</td>
      <td>${num(e.Amount)}</td><td>${num(e.IncomeTaxAmount)}</td><td>${num(e.SalesTaxAmount)}</td><td>${num(e.PSTAmount)}</td>
      <td>${num(e.SecurityAmount)}</td><td>${num(e.PenaltyAmount)}</td><td>${num(e.OtherDeductionAmount)}</td>
      <td>${num(netOf_(e))}</td><td>${e.VendorName}</td></tr>`).join('')
      || emptyRow(14);
  } else if(tableId==='passingTable'){
    tbody.innerHTML = list.map(e=>`<tr><td><input type="checkbox" class="chk-${tableId}" value="${e.EntryID}" ${selected.has(e.EntryID)?'checked':''} onchange="toggleStageSelection('${tableId}','${e.EntryID}',this.checked)"></td>
      <td>${billIdLink(e.EntryID)}</td><td>${fmtDate(e.EntryDate)}</td><td>${e.CampusName}</td><td>${e.BillDescription||''}</td>
      <td>${num(e.Amount)}</td><td>${num(e.IncomeTaxAmount)}</td><td>${num(e.SalesTaxAmount)}</td><td>${num(e.PSTAmount)}</td>
      <td>${num(e.SecurityAmount)}</td><td>${num(e.PenaltyAmount)}</td><td>${num(e.OtherDeductionAmount)}</td>
      <td>${num(netOf_(e))}</td><td>${e.VendorName}</td>
      <td>${e.ProcessedBy||''}</td><td>${fmtDate(e.ProcessedDate)}</td></tr>`).join('') || emptyRow(16);
  } else if(tableId==='paymentTable'){
    tbody.innerHTML = list.map(e=>`<tr><td><input type="checkbox" class="chk-${tableId}" value="${e.EntryID}" ${selected.has(e.EntryID)?'checked':''} onchange="toggleStageSelection('${tableId}','${e.EntryID}',this.checked)"></td>
      <td>${billIdLink(e.EntryID)}</td><td>${fmtDate(e.EntryDate)}</td><td>${e.CampusName}</td><td>${e.VendorName}</td>
      <td>${e.CNIC_NTN||''}</td><td>${e.IBAN||''}</td><td>${e.BillNo||''}</td><td>${num(e.Amount)}</td></tr>`).join('') || emptyRow(9);
  }
}
function billIdLink(entryId){
  return `<a href="javascript:void(0)" onclick="showBillDetail('${entryId}')" style="color:var(--accent);font-weight:600;text-decoration:underline;">${entryId}</a>`;
}
function emptyRow(cols){ return `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-muted);">No bills here right now.</td></tr>`; }


/* ---------- Bill Audit View popup ---------- */
function bavItem(label, value, valueClass){
  if (value === undefined || value === null || value === '') return '';
  return `<div class="bav-item"><div class="bav-label">${label}</div><div class="bav-value${valueClass?' '+valueClass:''}">${value}</div></div>`;
}
function bavFinRow(label, sub, amount, opts){
  opts = opts || {};
  return `<div class="bav-finrow ${opts.net?'bav-net':''} ${opts.gross?'bav-gross':''}">
    <div><div class="bav-fin-label">${label}</div>${sub ? '<div class="bav-fin-sub">'+sub+'</div>' : ''}</div>
    <div class="bav-fin-value ${opts.negative?'negative':''}">${opts.negative ? '-' : ''}${num(amount)} PKR</div>
  </div>`;
}
function bavCategoryBox(e, headSplits){
  const lines = [];
  let title = (e.BillNature || 'Bill') + ' Details';
  if (e.BillNature === 'Thesis Evaluation'){
    title = 'Thesis Evaluation Details';
    if (e.ThesisClass) lines.push('<b>Class:</b> ' + e.ThesisClass);
    if (e.ThesisStudentName) lines.push('<b>Student Name:</b> ' + e.ThesisStudentName);
  } else if (e.BillNature === 'Benevolent Fund'){
    title = 'Benevolent Fund Details';
    if (e.BenevolentFundSubCategory) lines.push('<b>Sub-category:</b> ' + e.BenevolentFundSubCategory);
  } else if (e.BillNature === 'Conduct of Exam'){
    title = 'Conduct of Exam Details';
    if (e.ExamSubCategory) lines.push('<b>Sub-category:</b> ' + e.ExamSubCategory);
  } else if (e.BillNature === 'Refund of Fee'){
    title = 'Refund of Fee Details';
    if (e.RefundCategory) lines.push('<b>Category:</b> ' + e.RefundCategory);
  } else if (e.BillNature === 'Contract' && e.ContractCategory){
    title = 'Execution of Contract Details';
    lines.push('<b>Contract Category:</b> ' + (e.ContractCategory === 'RepairRenovation' ? 'Repair / Renovation' : 'New Projects') + ' (Punjab Sales Tax rate)');
  } else if (e.BillNature === 'UE Visiting Faculty' || e.BillNature === 'Paper Setting/Marking'){
    title = e.BillNature + ' Details';
    if (e.VisitingProgram) lines.push('<b>Program:</b> ' + e.VisitingProgram);
    if (e.VisitingSubject) lines.push('<b>Subject:</b> ' + e.VisitingSubject);
    if (e.VisitingCrHrs) lines.push('<b>Cr. Hrs.:</b> ' + e.VisitingCrHrs);
    if (e.VisitingRate) lines.push('<b>Rate:</b> ' + e.VisitingRate);
    if (e.VisitingLectures) lines.push('<b>Lectures:</b> ' + e.VisitingLectures);
  }
  if (e.NonUETaxMethod === 'Section153_1b') lines.push('<b>Tax Method:</b> Section 153(1)(b) - Services (Individual/AOP)');
  if (e.AffidavitLowIncome) lines.push('<b>Affidavit of Low Income:</b> Submitted - Section 149 tax is zero');
  if (e.ManualTaxOverride) lines.push('<b>Income Tax:</b> Manually entered' + (e.ManualTaxSection ? ' (' + e.ManualTaxSection + ')' : ''));
  if (headSplits && headSplits.length){
    title = 'Multi-Head Split Details';
    lines.push(headSplits.map(sp => (sp.HeadCode||'') + ' - ' + (sp.HeadName||'') + ': ' + num(sp.Amount) + ' PKR').join('<br>'));
  }
  if (!lines.length) return '';
  return `<div class="bav-section"><div class="bav-section-title">${title}</div>${lines.map(l=>`<div class="bav-section-line">${l}</div>`).join('')}</div>`;
}
function showBillDetail(entryId){
  document.getElementById('billDetailModal').style.display = 'flex';
  document.getElementById('billDetailContent').innerHTML = 'Loading...';
  gs('getBillDetail', entryId).then(res=>{
    if (!res || res.success === false){
      document.getElementById('billDetailContent').innerHTML = '<p class="error">' + (res && res.message || 'Could not load this bill.') + '</p>';
      return;
    }
    const e = res.bill;
    window.__lastBillAuditData = res;

    let html = `<div class="bav-caption">Bill Audit View</div><div class="bav-billid">Bill ID: ${e.EntryID}</div>`;

    const headText = (res.headSplits && res.headSplits.length)
      ? 'Multiple Heads (' + res.headSplits.length + ')' : ((e.HeadCode||'') + ' - ' + (e.HeadName||''));
    html += `<div class="bav-grid">` +
      bavItem('Status', e.Status, 'status-' + e.Status) + bavItem('Entry Date', fmtDate(e.EntryDate)) +
      bavItem('Originating Office', e.ReceivingOffice) + bavItem('Paying Bank Account', e.PayFromAccountLabel) +
      bavItem('Campus', e.CampusName) + bavItem('Budget Head', headText) +
      `</div>`;

    if (res.budgetPosition && res.budgetPosition.length){
      const anyLocked = res.budgetPosition.some(bp => bp.locked);
      const anyLive = res.budgetPosition.some(bp => !bp.locked);
      html += `<div class="bav-section-title" style="margin:4px 0 8px;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;">
        Budget Position ${anyLocked ? '<span style="color:var(--accent);text-transform:none;letter-spacing:normal;">&#128274; locked as of entry</span>' : ''}
        ${anyLive ? '<span style="color:var(--amber);text-transform:none;letter-spacing:normal;">(no snapshot on file for this older bill - showing live figures instead)</span>' : ''}
      </div>`;
      html += res.budgetPosition.map(bp => {
        const heading = res.budgetPosition.length > 1 ? `<div style="font-weight:700;color:#F8FAFC;margin-bottom:6px;">${bp.headCode} - ${bp.headName}</div>` : '';
        const warn = bp.hasAllocation ? '' : '<div style="color:var(--amber);font-size:12px;margin-bottom:6px;">No allocation on file for this head/FY.</div>';
        return `<div class="bav-section" style="background:rgba(59,130,246,0.08);border-color:rgba(59,130,246,0.3);">` +
          heading + warn +
          bavFinRow('Current Bill', null, bp.currentBill) +
          bavFinRow('Expenses So Far', 'Before this bill', bp.expensesSoFar) +
          bavFinRow('After This Bill', null, bp.afterThisBill) +
          bavFinRow('Balance', 'Allocated: ' + num(bp.allocated), bp.balance, { negative: bp.balance < 0 }) +
          `</div>`;
      }).join('');
    }

    html += `<div class="bav-grid" style="margin-top:${res.budgetPosition && res.budgetPosition.length ? '18px' : '0'};">` +
      (e.PayeeType === 'Bulk'
        ? bavItem('Bill Type', 'Bulk Bill - ' + (res.bulkItems||[]).length + ' beneficiaries') + bavItem('Description', e.BillDescription)
        : bavItem('Beneficiary Type', payeeTypeLabel_(e.PayeeType)) + bavItem('FBR Section', e.IncomeTaxSection || '-') +
          bavItem('Beneficiary Name', e.VendorName) + bavItem('CNIC / NTN', e.CNIC_NTN) + bavItem('IBAN', e.IBAN) + bavItem('Description', e.BillDescription)) +
      `</div>`;

    if (e.Status === 'Cancelled'){
      html += `<div class="bav-section" style="background:rgba(239,68,68,0.10);border-color:rgba(239,68,68,0.35);">
        <div class="bav-section-title" style="color:var(--danger);">Cancelled</div>
        ${e.StatusBeforeCancellation ? `<div class="bav-section-line"><b>Was at:</b> ${e.StatusBeforeCancellation}</div>` : ''}
        ${e.CancelledBy ? `<div class="bav-section-line"><b>Cancelled By:</b> ${e.CancelledBy}${e.CancelledDate ? ' on ' + fmtDate(e.CancelledDate) : ''}</div>` : ''}
        ${e.CancellationReason ? `<div class="bav-section-line"><b>Reason:</b> ${e.CancellationReason}</div>` : ''}
        <div class="bav-section-line" style="color:var(--text-muted);">Excluded from all budget, consumption, and payment figures.</div>
      </div>`;
    }
    if (e.RedirectedToEntryID || e.RedirectedFromEntryID){
      html += `<div class="bav-section" style="background:rgba(59,130,246,0.10);border-color:rgba(59,130,246,0.35);">
        <div class="bav-section-title" style="color:#93C5FD;">Redirected Bill</div>
        ${e.RedirectedToEntryID ? `<div class="bav-section-line">This bill was paid to the wrong beneficiary and redirected - the corrected payment is <a href="javascript:void(0)" onclick="showBillDetail('${e.RedirectedToEntryID}')" style="color:#93C5FD;text-decoration:underline;">Bill ${e.RedirectedToEntryID}</a>.</div>` : ''}
        ${e.RedirectedFromEntryID ? `<div class="bav-section-line">This bill was created to correct <a href="javascript:void(0)" onclick="showBillDetail('${e.RedirectedFromEntryID}')" style="color:#93C5FD;text-decoration:underline;">Bill ${e.RedirectedFromEntryID}</a>, which had been paid to the wrong beneficiary.</div>` : ''}
      </div>`;
    }
    if (e.SplitFromEntryID){
      html += `<div class="bav-section" style="background:rgba(245,158,11,0.10);border-color:rgba(245,158,11,0.35);">
        <div class="bav-section-title" style="color:var(--amber);">Isolated Beneficiary Bill</div>
        <div class="bav-section-line">This bill was separated from bulk bill <a href="javascript:void(0)" onclick="showBillDetail('${e.SplitFromEntryID}')" style="color:var(--amber);text-decoration:underline;">${e.SplitFromEntryID}</a> (line ${e.SplitFromLineNo}) after that beneficiary's payment failed. It is NOT charged to the budget again - the amount is already charged through the parent bulk bill. Its full history, from Diary to Reconciliation, is shown below and in the original bill's trail.</div>
      </div>`;
    }

    if (e.PayeeType !== 'Bulk') html += bavCategoryBox(e, res.headSplits);

    if (e.PSTInvoiceNo || e.VendorInvoiceDate){
      html += `<div class="bav-section"><div class="bav-section-title">Punjab Sales Tax Invoice</div>` +
        (e.PSTInvoiceNo ? `<div class="bav-section-line"><b>Invoice No.:</b> ${e.PSTInvoiceNo}</div>` : '') +
        (e.VendorInvoiceDate ? `<div class="bav-section-line"><b>Vendor's Invoice Date:</b> ${fmtDate(e.VendorInvoiceDate)}</div>` : '') +
        `</div>`;
    }

    if (e.PayeeType === 'Bulk' && res.bulkItems && res.bulkItems.length){
      let totalGross = 0, totalTax = 0, totalNet = 0;
      const rows = res.bulkItems.map(li => {
        const taxTotal = Number(li.IncomeTaxAmount||0) + Number(li.SalesTaxAmount||0) + Number(li.PSTAmount||0) +
          Number(li.SecurityAmount||0) + Number(li.PenaltyAmount||0) + Number(li.OtherDeductionAmount||0);
        totalGross += Number(li.Amount||0); totalTax += taxTotal; totalNet += Number(li.NetAmount||0);
        const beneficiaryId = e.EntryID + '-' + li.LineNo;
        const redirectNote = li.RedirectedToEntryID
          ? ` <span style="color:#93C5FD;font-size:11px;" title="Paid to the wrong beneficiary - redirected to Bill ${li.RedirectedToEntryID}">&#8617; Redirected to <a href="javascript:void(0)" onclick="showBillDetail('${li.RedirectedToEntryID}')" style="color:#93C5FD;text-decoration:underline;">${li.RedirectedToEntryID}</a></span>`
          : '';
        const splitNote = li.SplitToEntryID
          ? ` <span style="color:var(--amber);font-size:11px;">&#9986; Payment failed - isolated as <a href="javascript:void(0)" onclick="showBillDetail('${li.SplitToEntryID}')" style="color:var(--amber);text-decoration:underline;">${li.SplitToEntryID}</a></span>`
          : '';
        return `<tr${(li.RedirectedToEntryID || li.SplitToEntryID) ? ' style="opacity:0.6;"' : ''}><td>${beneficiaryId}</td><td>${payeeTypeLabel_(li.PayeeType)}</td><td>${li.CNIC_NTN||''}</td><td>${li.VendorName||''}${redirectNote}${splitNote}</td><td>${li.IBAN||''}</td><td>${li.IncomeTaxSection||'-'}</td><td class="num">${num(li.Amount)}</td><td class="num">${num(taxTotal)}</td><td class="num">${num(li.NetAmount)}</td></tr>`;
      }).join('');
      html += `<div class="table-wrap bav-beneficiaries-table" style="margin-bottom:18px;"><table>
        <thead><tr><th>Line ID</th><th>Type</th><th>CNIC</th><th>Beneficiary</th><th>IBAN</th><th>FBR Section</th><th class="num">Gross</th><th class="num">Tax Deductions</th><th class="num">Net</th></tr></thead>
        <tbody>${rows}<tr><td colspan="6"><b>Total</b></td><td class="num"><b>${num(totalGross)}</b></td><td class="num"><b>${num(totalTax)}</b></td><td class="num"><b>${num(totalNet)}</b></td></tr></tbody>
        </table></div>`;
      html += `<div class="bav-fin">` + bavFinRow('NET AMOUNT PAID', null, totalNet, {net:true}) + `</div>`;
    } else {
      html += `<div class="bav-fin">`;
      html += bavFinRow('Gross Amount', null, e.Amount, {gross:true});
      if (e.IncomeTaxAmount || e.IncomeTaxSection) html += bavFinRow('Income Tax', e.IncomeTaxSection, e.IncomeTaxAmount, {negative: !!e.IncomeTaxAmount});
      if (e.SalesTaxAmount) html += bavFinRow('Sales Tax', null, e.SalesTaxAmount, {negative:true});
      if (e.PayeeType === 'Vendor') html += bavFinRow('Punjab Sales Tax (PST)', null, e.PSTAmount||0, {negative: !!e.PSTAmount});
      if (e.SecurityAmount) html += bavFinRow('Security', e.SecurityBasis, e.SecurityAmount, {negative:true});
      if (e.PenaltyAmount) html += bavFinRow('Penalty', e.PenaltyBasis, e.PenaltyAmount, {negative:true});
      if (e.OtherDeductionAmount) html += bavFinRow('Other Deduction' + (e.OtherDeductionCategory?' ('+e.OtherDeductionCategory+')':''), e.OtherDeductionBasis, e.OtherDeductionAmount, {negative:true});
      if (e.StudentDeductionAmount) html += bavFinRow('Student Deduction' + (e.StudentDeductionCategory?' ('+e.StudentDeductionCategory+')':''), e.StudentDeductionBasis, e.StudentDeductionAmount, {negative:true});
      html += bavFinRow('NET AMOUNT PAID', null, netOf_(e), {net:true});
      html += `</div>`;
    }

    html += `<div class="bav-grid" style="margin-top:18px;">` +
      bavItem('Entered By', e.EnteredBy) + bavItem('Bill / Invoice No.', e.BillNo) +
      bavItem('Processed', e.ProcessedBy ? (fmtDate(e.ProcessedDate) + ' by ' + e.ProcessedBy) : '') +
      bavItem('Passed', e.PassedBy ? (fmtDate(e.PassedDate) + ' by ' + e.PassedBy) : '') +
      bavItem('Paid', e.PaidBy ? (fmtDate(e.PaidDate) + ' by ' + e.PaidBy + (e.BatchID ? ' (Batch '+e.BatchID+')' : '')) : '') +
      `</div>`;

    document.getElementById('billDetailContent').innerHTML = html;

    // Payment / Reconciliation trail (second, non-blocking call). A bulk bill also shows its lines'
    // and isolated child bills' events; an isolated bill also shows its parent's history.
    gs('getPaymentHistory', entryId).then(events => {
      if (!events || !events.length) return;
      const rows = events.map(ev => `<tr><td>${fmtDate(ev.EventDate)}</td><td>${ev.EventType}${String(ev.EntryID)!==String(entryId) ? ' (' + ev.EntryID + ')' : ''}</td><td>${ev.LoggedBy||''}</td><td>${ev.Notes||''}</td></tr>`).join('');
      const trailHtml = `<div class="bav-section" style="margin-top:18px;">
        <div class="bav-section-title">Payment / Reconciliation Trail</div>
        <div class="table-wrap" style="margin-top:6px;"><table><thead><tr><th>Date</th><th>Event</th><th>By</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
      document.getElementById('billDetailContent').insertAdjacentHTML('beforeend', trailHtml);
    }).catch(()=>{});
  }).catch(err=>{
    document.getElementById('billDetailContent').innerHTML = '<p class="error">Could not load this bill: ' + (err.message||err) + '</p>';
  });
}
function printBillAudit(){
  document.body.classList.add('printing-audit');
  window.onafterprint = () => { document.body.classList.remove('printing-audit'); window.onafterprint = null; };
  window.print();
}
async function downloadBillAuditPDF(){
  let data = window.__lastBillAuditData;
  if (!data){ toast('Open a bill first.', 'error'); return; }
  // Re-fetch right before building the PDF so it always reflects the bill as it stands now.
  try {
    const fresh = await gs('getBillDetail', data.bill.EntryID);
    if (fresh && fresh.success !== false) { data = fresh; window.__lastBillAuditData = fresh; }
  } catch (err) { /* fall back to the cached data if the refetch fails */ }
  const e = data.bill;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 50;
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(120);
  doc.text('BILL AUDIT VIEW', 45, y);
  y += 20;
  doc.setFontSize(16); doc.setTextColor(0);
  doc.text('Bill ID: ' + e.EntryID, 45, y);
  y += 26;

  doc.setFontSize(10);
  const headText = (data.headSplits && data.headSplits.length) ? 'Multiple Heads (' + data.headSplits.length + ')' : ((e.HeadCode||'') + ' - ' + (e.HeadName||''));
  const gridPairs = [
    ['Status', e.Status], ['Entry Date', fmtDate(e.EntryDate)],
    ['Originating Office', e.ReceivingOffice||'-'], ['Paying Bank Account', e.PayFromAccountLabel||'-'],
    ['Campus', e.CampusName], ['Budget Head', headText]
  ];
  if (e.PayeeType !== 'Bulk') gridPairs.push(['Beneficiary Type', payeeTypeLabel_(e.PayeeType)], ['FBR Section', e.IncomeTaxSection||'-'], ['Beneficiary Name', e.VendorName||'-'], ['CNIC / NTN', e.CNIC_NTN||'-'], ['IBAN', e.IBAN||'-']);
  gridPairs.push(['Description', e.BillDescription||'-']);
  const colX = [45, pageWidth/2 + 10];
  for (let i = 0; i < gridPairs.length; i += 2){
    [0,1].forEach(c => {
      const pair = gridPairs[i+c];
      if (!pair) return;
      doc.setTextColor(140); doc.text(pair[0].toUpperCase(), colX[c], y);
      doc.setTextColor(0); doc.setFont('helvetica','bold'); doc.text(String(pair[1]), colX[c], y+13);
      doc.setFont('helvetica','normal');
    });
    y += 32;
  }
  y += 10;

  if (e.PayeeType === 'Bulk' && data.bulkItems && data.bulkItems.length){
    let totalGross=0, totalTax=0, totalNet=0;
    const body = data.bulkItems.map(li => {
      const taxTotal = Number(li.IncomeTaxAmount||0)+Number(li.SalesTaxAmount||0)+Number(li.PSTAmount||0)+Number(li.SecurityAmount||0)+Number(li.PenaltyAmount||0)+Number(li.OtherDeductionAmount||0);
      totalGross += Number(li.Amount||0); totalTax += taxTotal; totalNet += Number(li.NetAmount||0);
      return [payeeTypeLabel_(li.PayeeType), li.CNIC_NTN||'', li.VendorName||'', li.IBAN||'', li.IncomeTaxSection||'-', num(li.Amount), num(taxTotal), num(li.NetAmount)];
    });
    doc.autoTable({
      head: [['Type','CNIC','Beneficiary','IBAN','FBR Section','Gross','Tax Deductions','Net']], body, startY: y,
      foot: [['','','','','Total', num(totalGross), num(totalTax), num(totalNet)]],
      showFoot: 'lastPage',
      styles: { fontSize:9, cellPadding:4 }, headStyles:{ fillColor:[30,41,59] }, footStyles:{ fillColor:[240,240,240], textColor:0, fontStyle:'bold' },
      columnStyles: { 5:{halign:'right'}, 6:{halign:'right'}, 7:{halign:'right'} },
      margin: { left:45, right:45 }
    });
    y = doc.lastAutoTable.finalY + 20;
    doc.setFontSize(13); doc.setFont('helvetica','bold');
    doc.text('NET AMOUNT PAID', 45, y);
    doc.text(num(totalNet) + ' PKR', pageWidth - 45, y, { align:'right' });
  } else {
    const finRows = [['Gross Amount', num(e.Amount)]];
    if (e.IncomeTaxAmount || e.IncomeTaxSection) finRows.push(['Income Tax' + (e.IncomeTaxSection?' ('+e.IncomeTaxSection+')':''), '-' + num(e.IncomeTaxAmount||0)]);
    if (e.SalesTaxAmount) finRows.push(['Sales Tax', '-' + num(e.SalesTaxAmount)]);
    if (e.PayeeType === 'Vendor') finRows.push(['Punjab Sales Tax (PST)', '-' + num(e.PSTAmount||0)]);
    if (e.SecurityAmount) finRows.push(['Security', '-' + num(e.SecurityAmount)]);
    if (e.PenaltyAmount) finRows.push(['Penalty', '-' + num(e.PenaltyAmount)]);
    if (e.OtherDeductionAmount) finRows.push(['Other Deduction', '-' + num(e.OtherDeductionAmount)]);
    if (e.StudentDeductionAmount) finRows.push(['Student Deduction', '-' + num(e.StudentDeductionAmount)]);
    doc.setFontSize(10);
    finRows.forEach(([label,val]) => {
      doc.setTextColor(90); doc.setFont('helvetica','normal'); doc.text(label, 45, y);
      doc.setTextColor(0); doc.text(val + ' PKR', pageWidth - 45, y, { align:'right' });
      doc.setDrawColor(220); doc.line(45, y+6, pageWidth-45, y+6);
      y += 20;
    });
    y += 6;
    doc.setFontSize(13); doc.setFont('helvetica','bold');
    doc.text('NET AMOUNT PAID', 45, y);
    doc.text(num(netOf_(e)) + ' PKR', pageWidth - 45, y, { align:'right' });
  }

  if (data.budgetPosition && data.budgetPosition.length){
    y += 34;
    doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(90);
    doc.text('BUDGET POSITION', 45, y);
    y += 4;
    data.budgetPosition.forEach(bp => {
      y += 16;
      doc.setFont('helvetica','bold'); doc.setTextColor(0); doc.setFontSize(9);
      if (data.budgetPosition.length > 1) { doc.text(bp.headCode + ' - ' + bp.headName, 45, y); y += 14; }
      doc.setFont('helvetica','normal'); doc.setTextColor(90);
      [['Current Bill', bp.currentBill], ['Expenses So Far', bp.expensesSoFar], ['After This Bill', bp.afterThisBill],
       ['Balance (Allocated: ' + num(bp.allocated) + ')', bp.balance]].forEach(([label,val]) => {
        doc.text(label, 55, y);
        doc.setTextColor(0); doc.text(num(val) + ' PKR', pageWidth - 45, y, { align:'right' }); doc.setTextColor(90);
        y += 14;
      });
    });
  }

  doc.save('Bill_Audit_' + e.EntryID + '.pdf');
}

async function doStageAction(stage){
  if(stage==='processing'){
    const ids = Array.from(document.querySelectorAll('.chk-processingTable:checked')).map(c=>c.value);
    if(!ids.length){ toast('Select at least one bill.', 'error'); return; }
    const res = await runAction(document.getElementById('btnProcess'), 'Marking as Processed...', ids.length + ' bill(s) marked Processed - now waiting in the Passing tab.',
      () => gs('markProcessed', ids, CURRENT_USER.username));
    if(res && res.success) loadStageTable('Received','processingTable','proc_fy');
  } else if(stage==='passing'){
    const ids = Array.from(document.querySelectorAll('.chk-passingTable:checked')).map(c=>c.value);
    if(!ids.length){ toast('Select at least one bill.', 'error'); return; }
    const res = await runAction(document.getElementById('btnPass'), 'Marking as Passed...', ids.length + ' bill(s) marked Passed - now waiting in the Payment tab.',
      () => gs('markPassed', ids, CURRENT_USER.username));
    if(res && res.success) loadStageTable('Processed','passingTable','pass_fy');
  } else if(stage==='payment'){
    const ids = Array.from(document.querySelectorAll('.chk-paymentTable:checked')).map(c=>c.value);
    const payDate = document.getElementById('payDate').value;
    if(!ids.length){ toast('Select at least one bill.', 'error'); return; }
    if(!payDate){ toast('Select a payment date.', 'error'); return; }
    const res = await runAction(document.getElementById('btnPay'), 'Marking Paid & building IBFT report...', 'Payment batch created.',
      () => gs('markPaidAndGenerateIBFT', ids, payDate, CURRENT_USER.username));
    if(res && res.success){
      renderIbftReport(res);
      loadStageTable('Passed','paymentTable','pay_fy');
    }
  }
}

// Column set & order for the IBFT export - MUST stay in sync with mapEntryToIBFTRow_() in Code.gs.
const IBFT_COLUMNS = [
  ['bankAccountNo','Bank Account No'],
  ['taxpayerStatus','TaxPayer Status (Active/Inactive)'],
  ['cnicNtn','CNIC/NTN'],
  ['billPassedDate','Bill Passed Date'],
  ['receivingOffice','Office From Where it is received'],
  ['description','Description'],
  ['billId','Bill ID'],
  ['invoiceNo','Invoice No.'],
  ['invoiceDate','Invoice Date'],
  ['billNature','Bill Nature'],
  ['beneficiary','Beneficiary'],
  ['iban','IBAN'],
  ['bankShortName','Bank Short Name (5th, 6th, 7th and 8th Digit of IBAN)'],
  ['grossAmount','Gross Amount'],
  ['fbrSection','FBR Withholding Section'],
  ['incomeTax','Income Tax'],
  ['salesTax','Sales Tax'],
  ['punjabSalesTax','Punjab Sales Tax'],
  ['security','Security'],
  ['penalty','Penalty'],
  ['otherDeduction','Other Deduction'],
  ['netPayment','Net Payment']
];
const IBFT_NUMERIC_COLS = new Set(['grossAmount','incomeTax','salesTax','punjabSalesTax','security','penalty','otherDeduction','netPayment']);
function renderIbftTable(items){
  return `<div class="table-wrap"><table id="ibftReportTable">
      <thead><tr>${IBFT_COLUMNS.map(([,label])=>`<th>${label}</th>`).join('')}</tr></thead>
      <tbody>${items.map(it => `<tr>${IBFT_COLUMNS.map(([key])=>`<td>${IBFT_NUMERIC_COLS.has(key) ? num(it[key]) : (it[key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}
function renderIbftReport(res){
  const box = document.getElementById('ibftReport');
  box.style.display='block';
  document.getElementById('ibftReportContent').innerHTML = `
    <p><b>Batch:</b> ${res.batchId} &nbsp; <b>Date:</b> ${res.date} &nbsp; <b>Total (Gross):</b> ${num(res.total)}
      &nbsp; <button class="secondary no-print" onclick="exportArrayToCSV(window.__lastIbftItems, IBFT_COLUMNS, 'IBFT_${res.batchId}.csv')">Download CSV</button></p>
    ${renderIbftTable(res.items)}`;
  window.__lastIbftItems = res.items;
  box.scrollIntoView({behavior:'smooth'});
  // Best-effort automatic download too - the button above and Past IBFT Batches are the reliable path.
  try { exportArrayToCSV(res.items, IBFT_COLUMNS, 'IBFT_' + res.batchId + '.csv'); } catch(e){}
  loadPaymentBatches();
}

/* ---------- Past IBFT batch history ---------- */
function loadPaymentBatches(){
  gs('getPaymentBatches').then(list=>{
    document.querySelector('#batchHistoryTable tbody').innerHTML = list.map(b=>{
      const billCount = String(b.EntryIDs||'').split(',').filter(Boolean).length;
      return `<tr><td>${b.BatchID}</td><td>${fmtDate(b.Date)}</td><td>${b.GeneratedBy}</td><td>${billCount}</td><td>${num(b.TotalAmount)}</td>
        <td><button class="secondary" onclick="downloadBatchCSV('${b.BatchID}')">Download CSV</button></td></tr>`;
    }).join('') || emptyRow(6);
  }).catch(e=> toast('Could not load batch history: ' + (e.message||e), 'error'));
}
function downloadBatchCSV(batchId){
  gs('getBatchDetails', batchId).then(items=>{
    if (!items || !items.length){ toast('No bills found for this batch.', 'error'); return; }
    exportArrayToCSV(items, IBFT_COLUMNS, 'IBFT_' + batchId + '.csv');
  }).catch(e=> toast('Could not download batch: ' + (e.message||e), 'error'));
}

/* ---------- Generic CSV export from a JS array of objects ---------- */
function exportArrayToCSV(rows, columns, filename){
  if (!rows || !rows.length){ toast('Nothing to export.', 'error'); return; }
  const header = columns.map(([,label]) => '"' + label.replace(/"/g,'""') + '"').join(',');
  const body = rows.map(row => columns.map(([key]) => {
    const val = row[key] ?? '';
    return '"' + String(val).replace(/"/g,'""').replace(/\s+/g,' ').trim() + '"';
  }).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + header + '\r\n' + body], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- Generic CSV export from a rendered report table ---------- */
// A spanning cell (colspan) is expanded into that many CSV slots so every row keeps the header's column count.
function extractRowCellsForCsv(row){
  const cells = [];
  Array.from(row.querySelectorAll('th,td')).forEach(cell => {
    const span = cell.colSpan || 1;
    cells.push(cell.innerText.trim());
    for (let i = 1; i < span; i++) cells.push('');
  });
  return cells;
}
// Same idea for jsPDF-autoTable, which can represent a spanning cell natively.
function extractRowCellsForPdf(row){
  return Array.from(row.querySelectorAll('th,td')).map(cell => {
    const span = cell.colSpan || 1;
    return span > 1 ? { content: cell.innerText.trim(), colSpan: span } : cell.innerText.trim();
  });
}
function exportTableToCSV(tableId, filename){
  const table = document.getElementById(tableId);
  if (!table) { toast('Nothing to export yet - load the report first.', 'error'); return; }
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) { toast('Nothing to export yet - load the report first.', 'error'); return; }
  const csv = rows.map(row =>
    extractRowCellsForCsv(row)
      .map(text => '"' + text.replace(/"/g,'""').replace(/\s+/g,' ').trim() + '"')
      .join(',')
  ).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- PDF export of any rendered report table (orientation chosen from column count;
   `subtitle` prints the cost centre and every filter used) ---------- */
function downloadTablePDF(tableId, filename, title, subtitle){
  const table = document.getElementById(tableId);
  if (!table) { toast('Nothing to export yet - load the report first.', 'error'); return; }
  const headerRow = table.querySelector('thead tr:last-of-type');
  const headers = headerRow ? extractRowCellsForPdf(headerRow) : [];
  const bodyRows = Array.from(table.querySelectorAll('tbody tr')).map(tr => extractRowCellsForPdf(tr))
    .filter(r => r.length && r.some(c => (typeof c === 'string' ? c : c.content) !== ''));
  if (!headers.length || !bodyRows.length) { toast('Nothing to export yet - load the report first.', 'error'); return; }

  const footRow = table.querySelector('tfoot tr');
  const footer = footRow ? [extractRowCellsForPdf(footRow)] : [];

  const orientation = headers.length > 7 ? 'landscape' : 'portrait';
  const columnStyles = {};
  let pdfCol = 0;
  Array.from(headerRow.children).forEach(th => {
    const span = th.colSpan || 1;
    if (th.classList.contains('num') || AMOUNT_HEADER_KEYWORDS.test(th.innerText || '')) columnStyles[pdfCol] = { halign: 'right' };
    pdfCol += span;
  });
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation, unit:'pt', format:'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFontSize(13);
  doc.text(title || filename, 24, 26);
  doc.setFontSize(8);
  let nextY = 40;
  if (subtitle){
    doc.setTextColor(90);
    const subtitleLines = doc.splitTextToSize(subtitle, pageWidth - 48);
    doc.text(subtitleLines, 24, nextY);
    nextY += subtitleLines.length * 10;
    doc.setTextColor(0);
  }
  doc.text('Generated ' + new Date().toLocaleString(), 24, nextY);
  doc.autoTable({
    head: [headers], body: bodyRows, foot: footer, startY: nextY + 10,
    showFoot: 'lastPage',
    styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
    columnStyles: columnStyles,
    headStyles: { fillColor: [28,61,90], textColor: 255 },
    footStyles: { fillColor: [240,242,244], textColor: 0, fontStyle: 'bold' },
    margin: { left: 20, right: 20 }
  });
  doc.save(filename);
}

/* ---------- Admin ---------- */
function scrollToAdminSection(sectionId){
  if (!sectionId) return;
  const el = document.getElementById(sectionId);
  if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
  document.getElementById('adminQuickNav').value = '';
}
function loadAdminData(){
  loadCampusDropdowns();
  gs('getUsers', CURRENT_USER.username).then(list=>{
    document.querySelector('#userTable tbody').innerHTML = list.map(u=>
      `<tr><td>${u.Username}</td><td>${u.FullName}</td><td>${u.Role}</td></tr>`).join('') || emptyRow(3);
  });
  gs('getTaxSettings').then(ts=>{
    document.getElementById('ts_active').value = (ts.pstActiveRate*100).toFixed(2);
    document.getElementById('ts_activeMode').value = ts.pstActiveMode;
    document.getElementById('ts_inactive').value = (ts.pstInactiveRate*100).toFixed(2);
    document.getElementById('ts_inactiveMode').value = ts.pstInactiveMode;
    document.getElementById('ts_section156').value = (ts.section156Rate*100).toFixed(2);
    document.getElementById('ts_stActive').value = (ts.salesTaxActiveRate*100).toFixed(2);
    document.getElementById('ts_stInactive').value = (ts.salesTaxInactiveRate*100).toFixed(2);
    document.getElementById('ts_1531bActive').value = (ts.nonUe1531bActiveRate*100).toFixed(2);
    document.getElementById('ts_1531bInactive').value = (ts.nonUe1531bInactiveRate*100).toFixed(2);
    document.getElementById('ts_contractNew').value = (ts.pstContractNewProjectsRate*100).toFixed(2);
    document.getElementById('ts_contractNewMode').value = ts.pstContractNewProjectsMode;
    document.getElementById('ts_contractRepair').value = (ts.pstContractRepairRate*100).toFixed(2);
    document.getElementById('ts_contractRepairMode').value = ts.pstContractRepairMode;
  });
  loadSlabs();
  loadPipelineCounts();
  fillSelect('alloc_campus', CAMPUSES, 'CampusID', 'CampusName', 'All Campuses');
}

/* ---------- Admin: Manage Entries (edit / delete) ---------- */
async function loadManageEntries(){
  const filters = {
    billId: document.getElementById('me_billid').value,
    fy: document.getElementById('me_fy').value,
    status: document.getElementById('me_status').value,
    vendor: document.getElementById('me_vendor').value,
    description: document.getElementById('me_description').value
  };
  const list = await runAction(document.getElementById('btnLoadManageEntries'), 'Loading entries...', null,
    () => gs('searchEntriesAdmin', filters, CURRENT_USER.username));
  const tbody = document.querySelector('#manageEntriesTable tbody');
  if(!Array.isArray(list) || !list.length){ tbody.innerHTML = emptyRow(9); return; }
  tbody.innerHTML = list.map(e => {
    const editable = statusIsEquals_(e.Status, 'Received');
    const cancelled = statusIsEquals_(e.Status, 'Cancelled');
    let actions;
    if (editable) {
      actions = `<button class="secondary" onclick="editAdminEntry('${e.EntryID}')">Edit</button> <button class="secondary" style="color:var(--danger);" onclick="deleteAdminEntry('${e.EntryID}')">Delete</button> <button class="secondary" onclick="cancelAdminEntry('${e.EntryID}','${e.Status}')">Cancel</button>`;
    } else if (cancelled) {
      actions = `<span style="color:var(--text-muted);font-size:12px;">cancelled${e.StatusBeforeCancellation ? ' (was ' + e.StatusBeforeCancellation + ')' : ''}</span>`;
    } else {
      actions = `<button class="secondary" onclick="cancelAdminEntry('${e.EntryID}','${e.Status}')">Cancel</button>`;
    }
    return `<tr><td>${billIdLink(e.EntryID)}</td><td>${fmtDate(e.EntryDate)}</td><td>${e.CampusName}</td><td>${e.VendorName}</td>
      <td>${e.BillDescription||''}</td><td>${num(e.Amount)}</td><td><span class="pill ${e.Status}">${e.Status}</span></td>
      <td>${e.EnteredBy||''}</td><td>${actions}</td></tr>`;
  }).join('');
}
function statusIsEquals_(a, b){ return String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase(); }
function editAdminEntry(entryId){
  document.querySelector('.tab-btn[data-tab="entry"]').click();
  loadEntryForEdit(entryId);
}
async function deleteAdminEntry(entryId){
  if (!confirm('Delete bill ' + entryId + '? This cannot be undone and leaves no audit trail. For a bill already past Received, use Cancel instead.')) return;
  const res = await runAction(null, 'Deleting bill...', 'Bill deleted.',
    () => gs('deleteEntry', entryId, CURRENT_USER.username));
  if (res && res.success) loadManageEntries();
}
async function cancelAdminEntry(entryId, currentStatus){
  const paidWarning = statusIsEquals_(currentStatus, 'Paid')
    ? ' This bill has already been PAID - cancelling does NOT reverse the actual money transfer, it only removes it from budget/consumption figures going forward and flags the record.'
    : '';
  const reason = prompt('Cancel bill ' + entryId + '?' + paidWarning + '\n\nReason for cancelling (kept on the record):');
  if (reason === null) return;
  const res = await runAction(null, 'Cancelling bill...', 'Bill cancelled - it no longer counts anywhere.',
    () => gs('cancelEntry', entryId, reason, CURRENT_USER.username));
  if (res && res.success) loadManageEntries();
}

/* ---------- Reports: IBFT Payment ---------- */
async function loadIBFTPaymentReport(){
  const filters = { fromDate: document.getElementById('r6_from').value, toDate: document.getElementById('r6_to').value };
  const res = await runAction(document.getElementById('btnR6'), 'Loading IBFT Payment report...', null,
    () => gs('getIBFTPaymentReport', filters));
  if (!res) return;
  window.__lastIbftPaymentItemsAll = res.items;
  document.getElementById('r6_search').value = '';
  renderIBFTPaymentReport(res.items, res.totals);
  setReportCaption('r6_caption', 'r6', `Cost Centre: All Cost Centres  |  Payment Date: ${filters.fromDate || 'earliest'} to ${filters.toDate || 'latest'}`);
}
function renderIBFTPaymentReport(items, totals){
  window.__lastIbftPaymentItems = items;
  document.getElementById('r6_countLabel').textContent = items.length + ' payment(s)';
  document.getElementById('r6_totalNet').textContent = num(totals ? totals.netPayment : items.reduce((s,it)=>s+it.netPayment,0));
  document.getElementById('r6_tableWrap').innerHTML = items.length ? renderIbftTable(items) : '<p style="color:var(--text-muted);">No paid bills match.</p>';
}
// Generic "type to filter" for any already-rendered table.
function liveFilterTable(tableId, query){
  const q = String(query||'').trim().toLowerCase();
  document.querySelectorAll('#'+tableId+' tbody tr').forEach(tr => {
    if (!q){ tr.style.display=''; return; }
    tr.style.display = tr.innerText.toLowerCase().includes(q) ? '' : 'none';
  });
}
function filterIBFTPaymentReport(){
  const all = window.__lastIbftPaymentItemsAll || [];
  const q = document.getElementById('r6_search').value.trim().toLowerCase();
  if (!q){ renderIBFTPaymentReport(all); return; }
  const filtered = all.filter(it => IBFT_COLUMNS.some(([key]) => String(it[key] ?? '').toLowerCase().includes(q)));
  const totals = filtered.reduce((acc, it) => {
    acc.netPayment += it.netPayment; return acc;
  }, { netPayment: 0 });
  renderIBFTPaymentReport(filtered, totals);
}

/* ================= Sanction Proforma ================= */
const SANCTION_COLUMNS = [
  ['billId','Bill ID', true], ['date','Date', true], ['campus','Campus', true],
  ['head','Budget Head', false], ['vendor','Payee', true], ['billNo','Bill No.', false],
  ['description','Description', true], ['nature','Nature', false],
  ['gross','Gross Amount', true], ['incomeTax','Income Tax', false], ['salesTax','Sales Tax', false],
  ['pst','Punjab Sales Tax', false], ['security','Security', false], ['penalty','Penalty', false],
  ['other','Other Deduction', false], ['net','Net Amount', true], ['status','Status', false]
];
function populateSanctionColumns(){
  const wrap = document.getElementById('sp_columns');
  if (!wrap) return;
  wrap.innerHTML = SANCTION_COLUMNS.map(([key,label,dflt]) =>
    `<label><input type="checkbox" class="spcol" value="${key}" ${dflt?'checked':''}> ${label}</label>`).join('');
}

let SANCTION_SELECTED = new Set();
async function loadSanctionPicker(){
  const filters = {
    fy: document.getElementById('sp_fy').value,
    status: document.getElementById('sp_status').value,
    campusIds: document.getElementById('sp_campus').value ? [document.getElementById('sp_campus').value] : [],
    billId: document.getElementById('sp_billid').value,
    vendor: document.getElementById('sp_vendor').value,
    description: document.getElementById('sp_description').value
  };
  const list = await runAction(document.getElementById('btnSpLoad'), 'Loading bills...', null,
    () => gs('getEntriesForSanctionPicker', filters));
  const tbody = document.querySelector('#sanctionPickerTable tbody');
  if (!Array.isArray(list) || !list.length){ tbody.innerHTML = emptyRow(10); return; }
  tbody.innerHTML = list.map(e => `<tr>
    <td><input type="checkbox" class="spbill" value="${e.EntryID}" ${SANCTION_SELECTED.has(e.EntryID)?'checked':''} onchange="onSanctionBillCheck(this)"></td>
    <td>${e.EntryID}${e.PayeeType==='Bulk' ? ' <span style="color:var(--amber);font-size:11px;">(bulk)</span>' : ''}</td>
    <td>${fmtDate(e.EntryDate)}</td><td>${e.CampusName}</td><td>${e.HeadCode||''} ${e.HeadName||''}</td>
    <td>${e.VendorName}</td><td>${e.BillDescription||''}</td><td>${e.BillNature||''}</td>
    <td>${num(e.Amount)}</td><td><span class="pill ${e.Status}">${e.Status}</span></td></tr>`).join('');
  updateSanctionSelectedCount();
}
function onSanctionBillCheck(cb){
  if (cb.checked) SANCTION_SELECTED.add(cb.value); else SANCTION_SELECTED.delete(cb.value);
  updateSanctionSelectedCount();
}
function updateSanctionSelectedCount(){
  document.getElementById('sp_selectedCount').textContent = SANCTION_SELECTED.size + ' bill(s) selected so far (selections are kept even if you change the filters and load again).';
}

async function generateSanctionProforma(){
  const ids = Array.from(SANCTION_SELECTED);
  if (!ids.length){ toast('Select at least one bill first.', 'error'); return; }
  const data = await runAction(document.getElementById('btnSpGenerate'), 'Building sanction proforma...', 'Sanction proforma generated.',
    () => gs('getSanctionProformaData', ids));
  if (!data || data.error) return;
  const cols = SANCTION_COLUMNS.filter(([key]) => document.querySelector('.spcol[value="'+key+'"]').checked);
  window.__lastSanctionData = data;
  window.__lastSanctionCols = cols;
  document.getElementById('sp_previewWrap').innerHTML = renderSanctionLetterHTML(data, cols);
  document.getElementById('sp_previewCard').style.display = '';
  document.getElementById('sp_previewCard').scrollIntoView({ behavior:'smooth' });
}

// Groups the letter's rows by their source bill and inserts a Subtotal row after every bill that
// contributed more than one line, before the Grand Total at the end.
function buildSanctionTableRowsHtml(rows, cols){
  const groups = [];
  let current = null;
  rows.forEach(r => {
    const billId = String(r.billId||'');
    const parentId = isSplitBillId_client(billId) ? billId : (billId.includes('-') ? billId.split('-')[0] : billId);
    if (!current || current.parentId !== parentId){
      current = { parentId, rows: [] };
      groups.push(current);
    }
    current.rows.push(r);
  });
  return groups.map(g => {
    const rowsHtml = g.rows.map(r => `<tr>${cols.map(([key]) => `<td${sanctionAlign_(key)}>${sanctionCellValue(r, key)}</td>`).join('')}</tr>`).join('');
    if (g.rows.length <= 1) return rowsHtml;
    const subGross = g.rows.reduce((s,r)=>s+r.gross,0);
    const subNet = g.rows.reduce((s,r)=>s+r.net,0);
    const subCells = cols.map(([key],i) => {
      if (i === 0) return `<td><b>Subtotal - Bill ${g.parentId}</b></td>`;
      if (key === 'gross') return `<td${sanctionAlign_(key)}><b>${num(subGross)}</b></td>`;
      if (key === 'net') return `<td${sanctionAlign_(key)}><b>${num(subNet)}</b></td>`;
      return '<td></td>';
    }).join('');
    return rowsHtml + `<tr style="background:#EFEFEF;">${subCells}</tr>`;
  }).join('');
}
function isSplitBillId_client(id){ return /^E\d+-[A-Z]+$/.test(String(id||'').trim()); }
function renderSanctionLetterHTML(data, cols){
  const sanctionNo = document.getElementById('sp_sanctionNo').value || '________________';
  const dated = document.getElementById('sp_dated').value ? fmtDate(document.getElementById('sp_dated').value) : '________________';
  const fyLabel = data.fy || DEFAULT_FY_CLIENT;
  const tableRows = buildSanctionTableRowsHtml(data.rows, cols);
  const footCells = cols.map(([key],i) => {
    if (i === 0) return '<td><b>Grand Total</b></td>';
    if (key === 'gross') return '<td' + sanctionAlign_(key) + '><b>' + num(data.grossAmount) + '</b></td>';
    if (key === 'net') return '<td' + sanctionAlign_(key) + '><b>' + num(data.rows.reduce((s,r)=>s+r.net,0)) + '</b></td>';
    return '<td></td>';
  }).join('');
  return `
    <div class="sanction-doc" id="sanctionDocContent">
      <h2 style="text-align:center;text-decoration:underline;margin-bottom:4px;">UNIVERSITY OF EDUCATION, LAHORE</h2>
      <div style="display:flex;justify-content:space-between;margin-top:18px;">
        <div>SANCTION NO. ${sanctionNo}</div>
        <div>Dated: ${dated}</div>
      </div>
      <p style="margin-top:14px;">Subject:&nbsp;&nbsp;<b><u>Sanction of the Expenditure</u></b></p>
      <p style="text-align:justify;">
        In pursuance of Section 2.2.1 of the Delegation of Financial Powers Rules, 2003, as contained in the
        Chapter 2 of Financial Rules of the Calendar of the University of Education, Lahore, sanction is hereby
        accorded to the incurrence of expenditure of Rs. <b>${num(data.grossAmount)}</b>/- Rupees
        <b><u>${data.grossAmountWords}</u></b> in connection with <b>${data.billDescription}</b>. The expenditure
        so made shall be debited under head <b>${data.headText}</b> of University of Education, Lahore for the
        Financial Year ${fyLabel}.
      </p>
      <table style="margin-top:14px;">
        <thead><tr>${cols.map(([key,label]) => `<th${sanctionAlign_(key)}>${label}</th>`).join('')}</tr></thead>
        <tbody>${tableRows}<tr>${footCells}</tr></tbody>
      </table>
      <div style="margin-top:60px;display:flex;justify-content:space-between;text-align:center;">
        <div style="min-width:140px;">________________<br>Accounts Assistant</div>
        <div style="min-width:140px;">________________<br>Assistant Director</div>
        <div style="min-width:140px;">________________<br>Deputy Director</div>
        <div style="min-width:140px;">________________<br>Treasurer</div>
      </div>
      <div style="margin-top:50px;text-align:right;">________________<br>Vice Chancellor</div>
    </div>`;
}
function sanctionAlign_(key){
  return ['gross','incomeTax','salesTax','pst','security','penalty','other','net'].indexOf(key) !== -1 ? ' style="text-align:right;"' : '';
}
function sanctionCellValue(r, key){
  if (key === 'gross' || key === 'incomeTax' || key === 'salesTax' || key === 'pst' || key === 'security' || key === 'penalty' || key === 'other' || key === 'net') return num(r[key]);
  if (key === 'date') return fmtDate(r.date);
  if (key === 'head') return (r.headCode||'') + ' ' + (r.headName||'');
  return r[key] ?? '';
}

function buildSanctionPdfBody(rows, cols){
  const groups = [];
  let current = null;
  rows.forEach(r => {
    const billId = String(r.billId||'');
    const parentId = isSplitBillId_client(billId) ? billId : (billId.includes('-') ? billId.split('-')[0] : billId);
    if (!current || current.parentId !== parentId){
      current = { parentId, rows: [] };
      groups.push(current);
    }
    current.rows.push(r);
  });
  const body = [];
  const subtotalRowIndices = new Set();
  groups.forEach(g => {
    g.rows.forEach(r => body.push(cols.map(([key]) => sanctionCellValue(r, key))));
    if (g.rows.length > 1){
      const subGross = g.rows.reduce((s,r)=>s+r.gross,0);
      const subNet = g.rows.reduce((s,r)=>s+r.net,0);
      body.push(cols.map(([key],i) => i === 0 ? ('Subtotal - Bill ' + g.parentId) : (key === 'gross' ? num(subGross) : (key === 'net' ? num(subNet) : ''))));
      subtotalRowIndices.add(body.length - 1);
    }
  });
  return { body, subtotalRowIndices };
}
function downloadSanctionPDF(){
  const data = window.__lastSanctionData, cols = window.__lastSanctionCols;
  if (!data){ toast('Generate the proforma first.', 'error'); return; }
  const sanctionNo = document.getElementById('sp_sanctionNo').value || '________________';
  const dated = document.getElementById('sp_dated').value ? fmtDate(document.getElementById('sp_dated').value) : '________________';
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'portrait', unit:'pt', format:'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 50;
  doc.setFont('times','bold'); doc.setFontSize(15);
  doc.text('UNIVERSITY OF EDUCATION, LAHORE', pageWidth/2, y, { align:'center' });
  y += 30;
  doc.setFontSize(11); doc.setFont('times','normal');
  doc.text('SANCTION NO. ' + sanctionNo, 45, y);
  doc.text('Dated: ' + dated, pageWidth - 45, y, { align:'right' });
  y += 24;
  doc.text('Subject:', 45, y);
  doc.setFont('times','bolditalic');
  doc.text('Sanction of the Expenditure', 90, y);
  doc.setFont('times','normal');
  y += 20;
  const paragraph = 'In pursuance of Section 2.2.1 of the Delegation of Financial Powers Rules, 2003, as contained in ' +
    'the Chapter 2 of Financial Rules of the Calendar of the University of Education, Lahore, sanction is hereby ' +
    'accorded to the incurrence of expenditure of Rs. ' + num(data.grossAmount) + '/- Rupees ' + data.grossAmountWords +
    ' in connection with ' + data.billDescription + '. The expenditure so made shall be debited under head ' +
    data.headText + ' of University of Education, Lahore for the Financial Year ' + (data.fy || DEFAULT_FY_CLIENT) + '.';
  const lines = doc.splitTextToSize(paragraph, pageWidth - 90);
  doc.text(lines, 45, y, { align:'justify', maxWidth: pageWidth - 90 });
  y += lines.length * 14 + 16;

  const head = [cols.map(([,label]) => label)];
  const { body, subtotalRowIndices } = buildSanctionPdfBody(data.rows, cols);
  const totalNet = data.rows.reduce((s,r)=>s+r.net,0);
  const foot = [cols.map(([key],i) => i === 0 ? 'Grand Total' : (key === 'gross' ? num(data.grossAmount) : (key === 'net' ? num(totalNet) : '')))];
  const sanctionNumericKeys = ['gross','incomeTax','salesTax','pst','security','penalty','other','net'];
  const sanctionColumnStyles = {};
  cols.forEach(([key], i) => { if (sanctionNumericKeys.indexOf(key) !== -1) sanctionColumnStyles[i] = { halign: 'right' }; });
  doc.autoTable({
    head, body, foot, startY: y,
    showFoot: 'lastPage',
    columnStyles: sanctionColumnStyles,
    styles: { fontSize: 8, cellPadding: 3, font:'times', textColor: 0, lineColor: 0, lineWidth: 0.5 },
    headStyles: { fillColor: [239,239,239], textColor: 0, fontStyle:'bold' },
    footStyles: { fillColor: [255,255,255], textColor: 0, fontStyle:'bold', lineWidth: 0.5 },
    didParseCell: function(hookData){
      if (hookData.section === 'body' && subtotalRowIndices.has(hookData.row.index)){
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [239,239,239];
      }
    },
    margin: { left: 45, right: 45 }
  });
  y = doc.lastAutoTable.finalY + 70;
  if (y > doc.internal.pageSize.getHeight() - 100) { doc.addPage(); y = 60; }
  const colW = (pageWidth - 90) / 4;
  ['Accounts Assistant','Assistant Director','Deputy Director','Treasurer'].forEach((label,i) => {
    const cx = 45 + colW*i + colW/2;
    doc.text('________________', cx, y, { align:'center' });
    doc.text(label, cx, y + 14, { align:'center' });
  });
  y += 60;
  doc.text('________________', pageWidth - 45, y, { align:'right' });
  doc.text('Vice Chancellor', pageWidth - 45, y + 14, { align:'right' });

  doc.save('Sanction_Proforma_' + (sanctionNo || 'draft').replace(/[^\w-]/g,'_') + '.pdf');
}

// A .doc download that Word can open directly (HTML saved with the right namespaces).
function downloadSanctionDoc(){
  const content = document.getElementById('sanctionDocContent');
  if (!content){ toast('Generate the proforma first.', 'error'); return; }
  const sanctionNo = document.getElementById('sp_sanctionNo').value || 'draft';
  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset="utf-8"><title>Sanction Proforma</title>
    <style>body{font-family:'Times New Roman',serif;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #000;padding:5px 7px;} th{background:#EFEFEF;}</style>
    </head><body>${content.innerHTML}</body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'Sanction_Proforma_' + sanctionNo.replace(/[^\w-]/g,'_') + '.doc';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ================= Tax Calculation Details ================= */
// [key, label, defaultVisible, kind] - kind: 'amount', 'rate', 'bool', 'id', 'date', 'payeeType' or plain text.
const TCD_COLUMNS = [
  ['billId','Bill / Line ID',true,'id'],
  ['parentBillId','Parent Bill ID',false,'id'],
  ['date','Date',false,'date'],
  ['campus','Campus',false],
  ['payeeType','Beneficiary Type',true,'payeeType'],
  ['employeeId','Employee ID',true],
  ['cnic','CNIC / NTN',false],
  ['beneficiary','Beneficiary Name',true],
  ['iban','IBAN',false],
  ['designation','Designation',false],
  ['billNature','Nature of Bill',true],
  ['gross','Gross Amount',true,'amount'],
  ['fbrSection','FBR Section',true],
  ['incomeTaxRate','Income Tax Rate',true,'rate'],
  ['incomeTaxAmount','Income Tax Amount',true,'amount'],
  ['affidavit','Affidavit of Low Income (Non-UE)',false,'bool'],
  ['nonUeTaxMethod','Non-UE Tax Method',false],
  ['incomeBefore','Income Before This Bill',false,'amount'],
  ['incomeAfter','Income After This Bill',false,'amount'],
  ['creditApplied','Section 149 Credit Applied',false,'amount'],
  ['outstandingAdjusted','Section 149 Outstanding Adjusted',false,'amount'],
  ['salesTaxRate','Sales Tax Rate',false,'rate'],
  ['salesTaxAmount','Sales Tax Amount',false,'amount'],
  ['pstRate','Punjab Sales Tax Rate',false,'rate'],
  ['pstAmount','Punjab Sales Tax Amount',false,'amount'],
  ['pstCategory','Contract Category (PST)',false],
  ['securityRate','Security Rate',false,'rate'],
  ['securityAmount','Security Amount',false,'amount'],
  ['penaltyRate','Penalty Rate',false,'rate'],
  ['penaltyAmount','Penalty Amount',false,'amount'],
  ['otherDeductionRate','Other Deduction Rate',false,'rate'],
  ['otherDeductionAmount','Other Deduction Amount',false,'amount'],
  ['studentDeductionAmount','Student Deduction',false,'amount'],
  ['manualTaxOverride','Manual Tax Override',false,'bool'],
  ['netAmount','Net Amount',true,'amount'],
  ['pipelineStatus','Pipeline Status',true],
  ['linePaymentStatus','Payment Status',false],
  ['redirectedTo','Redirected / Isolated To',false,'id']
];
function populateTcdColumns(){
  const wrap = document.getElementById('tcd_columns');
  if (!wrap) return;
  wrap.innerHTML = TCD_COLUMNS.map(([key,label,dflt]) =>
    `<label><input type="checkbox" class="tcdcol" value="${key}" ${dflt?'checked':''} onchange="renderTcdTable()"> ${label}</label>`).join('');
}
function payeeTypeLabel_(t){
  return { Vendor:'Vendor', Employee:'UE Employee', NonUEEmployee:'Non-UE Employee', Student:'Student', Bulk:'Bulk' }[t] || (t||'-');
}
function tcdCellValue(row, key, kind){
  const v = row[key];
  if (kind === 'amount') return (v===null || v===undefined || v==='') ? '-' : num(v);
  if (kind === 'rate') return v ? (v*100).toFixed(2)+'%' : '-';
  if (kind === 'bool') return (v===null || v===undefined) ? 'Not Recorded' : (v ? 'Yes' : 'No');
  if (kind === 'date') return v ? fmtDate(v) : '-';
  if (kind === 'id') return v ? billIdLink(v) : '-';
  if (kind === 'payeeType') return payeeTypeLabel_(v);
  return (v===null || v===undefined || v==='') ? '-' : v;
}
let TCD_LAST_RESULT = null;
async function loadTaxCalculationDetails(){
  const billId = document.getElementById('tcd_billid').value.trim();
  if (!billId){ toast('Enter a Bill ID first.', 'error'); return; }
  const res = await runAction(document.getElementById('btnTcdLoad'), 'Calculating...', null,
    () => gs('getTaxCalculationDetails', billId, CURRENT_USER.username));
  if (!res || res.success === false) return;
  TCD_LAST_RESULT = res;
  renderTcdTable();
  setReportCaption('tcd_caption', 'tcd', `Bill: ${res.billId}${res.isBulk ? ' (Bulk - ' + res.rows.length + ' beneficiar' + (res.rows.length===1?'y':'ies') + ')' : ''}  |  Nature: ${res.billNature||'-'}`);
}
function renderTcdTable(){
  if (!TCD_LAST_RESULT){ return; }
  const selected = TCD_COLUMNS.filter(([key]) => document.querySelector('.tcdcol[value="'+key+'"]').checked);
  document.getElementById('tcdHeadRow').innerHTML = selected.map(([,label,,kind]) =>
    `<th${kind==='amount'||kind==='rate'?' class="num"':''}>${label}</th>`).join('');
  document.querySelector('#tcdTable tbody').innerHTML = TCD_LAST_RESULT.rows.map(row =>
    '<tr>' + selected.map(([key,,,kind]) => `<td${kind==='amount'||kind==='rate'?' class="num"':''}>${tcdCellValue(row,key,kind)}</td>`).join('') + '</tr>'
  ).join('') || `<tr><td colspan="${selected.length}" style="text-align:center;color:var(--text-muted);">No rows.</td></tr>`;
}

/* ================= AI Report (Google Gemini) ================= */
async function loadGeminiKeyStatus(){
  const statusEl = document.getElementById('ai_keyStatus');
  if (!statusEl) return;
  try {
    const res = await gs('getGeminiKeyStatus');
    if (res.hasKey){
      statusEl.innerHTML = '<span style="color:var(--accent);">&#10003; A Gemini API key is set</span> (model: ' + (res.model||'gemini-2.0-flash') + '). Questions below are ready to use.';
      document.getElementById('ai_apiKey').placeholder = 'Already set - paste a new key here to replace it';
    } else {
      statusEl.innerHTML = '<span style="color:var(--amber);">No API key set yet.</span> Paste one below and click Save before asking a question.';
    }
  } catch(e){ /* role can't see this - leave the card as-is */ }
}
async function saveGeminiKeyForm(){
  const key = document.getElementById('ai_apiKey').value.trim();
  const model = document.getElementById('ai_model').value.trim();
  if (!key){ toast('Paste an API key first.', 'error'); return; }
  const res = await runAction(document.getElementById('btnSaveGeminiKey'), 'Saving key...', 'Gemini API key saved.',
    () => gs('saveGeminiApiKey', CURRENT_USER.username, key));
  if (res && res.success){
    document.getElementById('ai_apiKey').value = '';
    if (model) await gs('saveGeminiModel', CURRENT_USER.username, model);
    loadGeminiKeyStatus();
  }
}
async function clearGeminiKeyForm(){
  if (!confirm('Remove the saved Gemini API key? AI Report will stop working until a new one is added.')) return;
  const res = await runAction(null, 'Clearing key...', 'Gemini API key removed.', () => gs('clearGeminiApiKey', CURRENT_USER.username));
  if (res && res.success) loadGeminiKeyStatus();
}
async function askAIReportForm(){
  const question = document.getElementById('ai_question').value.trim();
  if (!question){ toast('Enter a question first.', 'error'); return; }
  const fy = document.getElementById('ai_fy').value;
  document.getElementById('ai_answerCard').style.display = 'none';
  const res = await runAction(document.getElementById('btnAskAI'), 'Asking Gemini (this can take a few seconds)...', null,
    () => gs('askAIReport', question, fy, CURRENT_USER.username));
  if (!res || !res.success) return;
  document.getElementById('ai_rowInfo').textContent = 'Answered from ' + res.rowCount + ' row(s) of data' + (fy ? ' (' + fy + ')' : ' (all years)') + '.';
  document.getElementById('ai_answerWrap').innerHTML = renderMarkdownLite(res.answer);
  document.getElementById('ai_answerCard').style.display = '';
  document.getElementById('ai_answerCard').scrollIntoView({ behavior:'smooth' });
}
// Minimal markdown: tables, bold, bullet/numbered lists, headings and paragraph breaks.
function renderMarkdownLite(md){
  const escapeHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = md.replace(/\r\n/g,'\n').split('\n');
  let html = '', inTable = false, tableRows = [], inList = null, tableCount = 0;
  const closeList = () => { if (inList){ html += '</'+inList+'>'; inList = null; } };
  const closeTable = () => {
    if (!inTable) return;
    const [headerLine, sepLine, ...bodyLines] = tableRows;
    const cellsOf = l => l.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
    const tableId = 'ai_table_' + (tableCount++);
    let t = `<div class="table-wrap" style="margin:8px 0;"><table id="${tableId}"><thead><tr>` +
      cellsOf(headerLine).map(c=>`<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>';
    bodyLines.forEach(l => { t += '<tr>' + cellsOf(l).map(c=>`<td>${escapeHtml(c)}</td>`).join('') + '</tr>'; });
    t += '</tbody></table></div>' +
      `<button class="secondary no-print" style="margin:-4px 0 10px;" onclick="exportTableToCSV('${tableId}','AI_Report_Table.csv')">Download this table as CSV</button>`;
    html += t; inTable = false; tableRows = [];
  };
  const inlineFmt = s => escapeHtml(s).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\*(.+?)\*/g,'<i>$1</i>').replace(/`(.+?)`/g,'<code>$1</code>');
  lines.forEach(raw => {
    const line = raw;
    if (/^\s*\|.*\|\s*$/.test(line)){
      inTable = true; tableRows.push(line); return;
    }
    closeTable();
    if (/^#{1,4}\s+/.test(line)){
      closeList();
      const level = line.match(/^#+/)[0].length;
      html += `<h${Math.min(level+2,6)} style="margin:14px 0 6px;">${inlineFmt(line.replace(/^#{1,4}\s+/,''))}</h${Math.min(level+2,6)}>`;
      return;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)/);
    if (bullet){
      if (inList !== 'ul'){ closeList(); html += '<ul style="margin:6px 0;padding-left:22px;">'; inList = 'ul'; }
      html += `<li>${inlineFmt(bullet[1])}</li>`; return;
    }
    if (numbered){
      if (inList !== 'ol'){ closeList(); html += '<ol style="margin:6px 0;padding-left:22px;">'; inList = 'ol'; }
      html += `<li>${inlineFmt(numbered[1])}</li>`; return;
    }
    closeList();
    if (line.trim() === '') { html += '<div style="height:8px;"></div>'; return; }
    html += `<p style="margin:4px 0;">${inlineFmt(line)}</p>`;
  });
  closeTable(); closeList();
  return html;
}

/* ---------- Allocations ---------- */
async function loadAllocations(){
  const filters = {
    campusId: document.getElementById('alloc_campus').value,
    fy: document.getElementById('alloc_fy').value,
    headQuery: document.getElementById('alloc_query').value
  };
  const res = await runAction(document.getElementById('btnLoadAlloc'), 'Loading...', 'Loaded.', () => gs('searchAllocations', filters));
  if (!Array.isArray(res)) return;
  document.querySelector('#allocTable tbody').innerHTML = res.map(a =>
    `<tr><td>${a.CampusName}</td><td>${a.HeadCode}</td><td>${a.HeadName}</td><td>${a.FY}</td><td>${num(a.AllocatedAmount)}</td>
     <td><button class="secondary" onclick='editAllocationRow(${JSON.stringify(a)})'>Edit</button>
     <button class="secondary" onclick="deleteAllocationRow('${a.CampusID}','${a.HeadID}','${a.FY}')">Delete</button></td></tr>`).join('') || emptyRow(6);
}
function editAllocationRow(a){
  document.getElementById('a_campus').value = a.CampusID;
  document.getElementById('a_newcampus').value = '';
  document.getElementById('a_headcode').value = a.HeadCode;
  document.getElementById('a_headname').value = a.HeadName;
  document.getElementById('a_fy').value = a.FY;
  document.getElementById('a_amount').value = a.AllocatedAmount;
  toast('Loaded into the form above - change the amount and click Save to update.', 'success');
}
async function deleteAllocationRow(campusId, headId, fy){
  if (!confirm('Delete this allocation? This cannot be undone.')) return;
  const res = await runAction(null, 'Deleting...', 'Allocation deleted.', () => gs('deleteAllocation', CURRENT_USER.username, campusId, headId, fy));
  if (res && res.success) loadAllocations();
}

/* ---------- Budget Heads ---------- */
async function loadBudgetHeadsAdmin(){
  const query = document.getElementById('bh_query').value;
  const res = await runAction(document.getElementById('btnLoadHeads'), 'Loading...', 'Loaded.', () => gs('searchBudgetHeads', query));
  if (!Array.isArray(res)) return;
  document.querySelector('#headsTable tbody').innerHTML = res.map(h =>
    `<tr><td>${h.HeadCode}</td><td>${h.HeadName}${h.Active===false||h.Active==='FALSE'?' (inactive)':''}</td>
     <td><button class="secondary" onclick='editBudgetHeadRow("${h.HeadID}", ${JSON.stringify(h.HeadCode)}, ${JSON.stringify(h.HeadName)})'>Edit</button>
     <button class="secondary" onclick="deleteBudgetHeadRow('${h.HeadID}')">Deactivate</button></td></tr>`).join('') || emptyRow(3);
}
async function editBudgetHeadRow(headId, oldCode, oldName){
  const code = prompt('Budget Code:', oldCode);
  if (code === null) return;
  const name = prompt('Budget Head Name:', oldName);
  if (name === null) return;
  const res = await runAction(null, 'Updating...', 'Budget head updated.', () => gs('updateBudgetHead', CURRENT_USER.username, headId, code, name));
  if (res && res.success) loadBudgetHeadsAdmin();
}
async function deleteBudgetHeadRow(headId){
  if (!confirm('Deactivate this budget head? It will stop appearing in new allocations/bills, but existing records keep working.')) return;
  const res = await runAction(null, 'Deactivating...', 'Budget head deactivated.', () => gs('deleteBudgetHead', CURRENT_USER.username, headId));
  if (res && res.success) loadBudgetHeadsAdmin();
}

/* ---------- Section 149 Tax Slabs ---------- */
async function loadSlabs(){
  const slabs = await gs('getTaxSlabs');
  document.querySelector('#slabsTable tbody').innerHTML = slabs.map(s =>
    `<tr><td>${num(s.threshold)}</td><td>${num(s.fixedAmount)}</td><td>${(s.rate*100).toFixed(2)}%</td><td>${s.label||''}</td>
     <td><button class="secondary" onclick='editSlabRow(${JSON.stringify(s)})'>Edit</button>
     <button class="secondary" onclick="deleteSlabRow(${s.threshold})">Delete</button></td></tr>`).join('') || emptyRow(5);
}
function editSlabRow(s){
  document.getElementById('slab_threshold').value = s.threshold;
  document.getElementById('slab_fixed').value = s.fixedAmount;
  document.getElementById('slab_rate').value = (s.rate*100).toFixed(2);
  document.getElementById('slab_label').value = s.label || '';
}
async function saveSlabForm(){
  const slab = {
    threshold: document.getElementById('slab_threshold').value,
    fixedAmount: document.getElementById('slab_fixed').value,
    rate: (Number(document.getElementById('slab_rate').value)||0) / 100,
    label: document.getElementById('slab_label').value
  };
  const res = await runAction(document.getElementById('btnSaveSlab'), 'Saving...', 'Slab saved.', () => gs('saveTaxSlab', CURRENT_USER.username, slab));
  if (res && res.success){
    ['slab_threshold','slab_fixed','slab_rate','slab_label'].forEach(id=>document.getElementById(id).value='');
    loadSlabs();
  }
}
async function deleteSlabRow(threshold){
  if (!confirm('Delete this slab row?')) return;
  const res = await runAction(null, 'Deleting...', 'Slab deleted.', () => gs('deleteTaxSlab', CURRENT_USER.username, threshold));
  if (res && res.success) loadSlabs();
}

/* ---------- Employees / Non-UE / Vendors / Students ---------- */
async function loadEmployeesAdmin(){
  const query = document.getElementById('emp_query').value;
  const res = await runAction(document.getElementById('btnLoadEmployees'), 'Loading...', 'Loaded.', () => gs('searchEmployees', query));
  if (!Array.isArray(res)) return;
  document.querySelector('#employeeTable tbody').innerHTML = res.map(e=>
    `<tr><td>${e.EmployeeID}</td><td>${e.Name}</td><td>${e.CNIC||''}</td><td>${e.IBAN||''}</td><td>${e.BankName||''}</td><td>${e.Department||''}</td><td>${e.Designation||''}</td></tr>`).join('') || emptyRow(7);
}
async function loadNonUEAdmin(){
  const query = document.getElementById('nonue_query').value;
  const res = await gs('searchNonUEEmployees', query);
  document.querySelector('#nonueTable tbody').innerHTML = (res||[]).map(e=>
    `<tr><td>${e.CNIC}</td><td>${e.Name}</td><td>${e.IBAN||''}</td><td>${e.BankName||''}</td></tr>`).join('') || emptyRow(4);
}
async function loadVendorsAdmin(){
  const query = document.getElementById('vendor_query').value;
  const res = await gs('searchVendorsAdmin', query);
  document.querySelector('#vendorsAdminTable tbody').innerHTML = (res||[]).map(v=>
    `<tr><td>${v.VendorName}</td><td>${v.CNIC_NTN||''}</td><td>${v.IBAN||''}</td><td>${v.BankName||''}</td></tr>`).join('') || emptyRow(4);
}
async function loadStudentsAdmin(){
  const query = document.getElementById('student_query').value;
  const res = await gs('searchStudents', query);
  document.querySelector('#studentsAdminTable tbody').innerHTML = (res||[]).map(s=>
    `<tr><td>${s.StudentID}</td><td>${s.Name}</td><td>${s.CNIC||''}</td><td>${s.IBAN||''}</td><td>${s.Program||''}</td><td>${s.Session||''}</td><td>${s.Shift||''}</td></tr>`).join('') || emptyRow(7);
}

async function addEmployeeForm(){
  const emp = {
    employeeId: document.getElementById('emp_id').value.trim(),
    name: document.getElementById('emp_name').value.trim(),
    cnic: document.getElementById('emp_cnic').value.trim(),
    iban: document.getElementById('emp_iban').value.trim(),
    bankName: document.getElementById('emp_bank').value.trim(),
    department: document.getElementById('emp_dept').value.trim(),
    designation: document.getElementById('emp_designation').value.trim()
  };
  if(!emp.employeeId || !emp.name){ toast('Employee ID and Name are required.', 'error'); return; }
  if(emp.cnic && !isValidCnicFormat(emp.cnic)){
    toast('CNIC must be in the format 35201-1222334-4.', 'error'); return;
  }
  if(emp.iban && !isValidIbanFormat(emp.iban)){
    toast('IBAN must start with PK and be 24 characters in total (e.g. PK36SCBL0000001123456702).', 'error'); return;
  }
  const res = await runAction(document.getElementById('btnAddEmployee'), 'Saving...', 'Employee saved.',
    () => gs('addEmployee', CURRENT_USER.username, emp));
  if(res && res.success){
    const annualIncome = document.getElementById('emp_annualincome').value;
    if (annualIncome) {
      await gs('saveIncomeProfile', CURRENT_USER.username, {
        key: emp.employeeId, payeeType: 'Employee', fy: document.getElementById('emp_fy').value || DEFAULT_FY_CLIENT,
        name: emp.name, annualTaxableIncome: annualIncome, affidavitLowIncome: false
      });
    }
    ['emp_id','emp_name','emp_cnic','emp_iban','emp_bank','emp_dept','emp_designation','emp_annualincome'].forEach(id=>document.getElementById(id).value='');
    loadEmployeesAdmin();
  }
}
async function saveTaxSettingsForm(){
  const settings = {
    pstActiveRate: (Number(document.getElementById('ts_active').value)||0) / 100,
    pstActiveMode: document.getElementById('ts_activeMode').value,
    pstInactiveRate: (Number(document.getElementById('ts_inactive').value)||0) / 100,
    pstInactiveMode: document.getElementById('ts_inactiveMode').value,
    section156Rate: (Number(document.getElementById('ts_section156').value)||0) / 100,
    salesTaxActiveRate: (Number(document.getElementById('ts_stActive').value)||0) / 100,
    salesTaxInactiveRate: (Number(document.getElementById('ts_stInactive').value)||0) / 100,
    nonUe1531bActiveRate: (Number(document.getElementById('ts_1531bActive').value)||0) / 100,
    nonUe1531bInactiveRate: (Number(document.getElementById('ts_1531bInactive').value)||0) / 100,
    pstContractNewProjectsRate: (Number(document.getElementById('ts_contractNew').value)||0) / 100,
    pstContractNewProjectsMode: document.getElementById('ts_contractNewMode').value,
    pstContractRepairRate: (Number(document.getElementById('ts_contractRepair').value)||0) / 100,
    pstContractRepairMode: document.getElementById('ts_contractRepairMode').value
  };
  await runAction(document.getElementById('btnSaveTaxSettings'), 'Saving...', 'Tax settings saved.',
    () => gs('saveTaxSettings', CURRENT_USER.username, settings));
}
function loadPipelineCounts(){
  const fy = document.getElementById('admin_fy').value;
  gs('getPipelineCounts', fy).then(c=>{
    document.getElementById('pipelineBox').innerHTML = `
      <div class="bal-allocated"><span class="label">Received</span><span class="val">${c.Received}</span></div>
      <div class="bal-spent"><span class="label">Processed</span><span class="val">${c.Processed}</span></div>
      <div class="bal-remaining"><span class="label">Passed</span><span class="val">${c.Passed}</span></div>
      <div class="bal-remaining"><span class="label">Paid</span><span class="val">${c.Paid}</span></div>`;
  });
}
function onAdminCodeBlur(){
  const code = document.getElementById('a_headcode').value.trim();
  if(!code) return;
  gs('getHeadByCode', code).then(h=>{ if(h) document.getElementById('a_headname').value = h.HeadName; });
}
async function saveAllocationForm(){
  const params = {
    campusId: document.getElementById('a_campus').value,
    newCampusName: document.getElementById('a_newcampus').value.trim(),
    headCode: document.getElementById('a_headcode').value.trim(),
    headName: document.getElementById('a_headname').value.trim(),
    fy: document.getElementById('a_fy').value || DEFAULT_FY_CLIENT,
    amount: document.getElementById('a_amount').value
  };
  if((!params.campusId && !params.newCampusName) || !params.headCode || !params.amount){
    toast('Provide a campus, a budget code, and an amount.', 'error'); return;
  }
  const res = await runAction(document.getElementById('btnSaveAlloc'), 'Saving allocation...', 'Allocation saved.',
    () => gs('saveAllocation', CURRENT_USER.username, params));
  if(res && res.success){
    document.getElementById('a_newcampus').value = '';
    loadCampusDropdowns();
    loadAllocations();
  }
}
async function addUserForm(){
  const username = document.getElementById('u_username').value.trim();
  const password = document.getElementById('u_password').value;
  const fullname = document.getElementById('u_fullname').value.trim();
  const role = document.getElementById('u_role').value;
  if(!username || !password || !fullname){ toast('Fill all fields.', 'error'); return; }
  const res = await runAction(document.getElementById('btnAddUser'), 'Adding user...', 'User added.',
    () => gs('addUser', CURRENT_USER.username, username, password, fullname, role));
  if(res && res.success) loadAdminData();
}
async function runSystemCheck(){
  const res = await runAction(document.getElementById('btnSysCheck'), 'Checking sheets...', 'Check complete.',
    () => gs('systemCheck', CURRENT_USER.username));
  if(Array.isArray(res)){
    document.querySelector('#sysCheckTable tbody').innerHTML = res.map(r=>
      `<tr><td>${r.sheet}</td><td>${r.ok ? '✅ OK' : '⚠️ Issue'}</td><td>${r.rowCount ?? ''}</td><td>${r.message}</td></tr>`).join('');
  }
}

/* ---------- Section 149: cancelled-bill income threshold repair ---------- */
let LAST_S149_PREVIEW = null;
function renderS149FixTable(fixes){
  const changed = fixes.filter(f => f.changed);
  document.querySelector('#s149FixTable tbody').innerHTML = changed.map(f => {
    const diff = f.newTax - f.oldTax;
    const payeeLabel = (f.payeeType==='Employee'?'UE Employee':'Non-UE Employee') + (f.isBulkLine ? ', bulk line' : '');
    return `<tr><td>${billIdLink(f.entryId)}</td><td>${f.name} (${payeeLabel})</td><td>${f.fy}</td>
     <td>${num(f.gross)}</td><td>${num(f.oldTax)}</td><td style="color:var(--accent);font-weight:700;">${num(f.newTax)}</td>
     <td style="color:${diff<0?'var(--accent)':'var(--danger)'};font-weight:700;">${diff<0?'-':'+'}${num(Math.abs(diff))}</td>
     <td>${num(f.oldNet)}</td><td style="color:var(--accent);font-weight:700;">${num(f.newNet)}</td></tr>`;
  }).join('')
    || `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);">No bills need correction.</td></tr>`;
}
function renderS149BulkFlags(flags){
  const wrap = document.getElementById('s149BulkFlagWrap');
  if (!flags || !flags.length){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  document.querySelector('#s149BulkFlagTable tbody').innerHTML = flags.map(f =>
    `<tr><td>${billIdLink(f.parentEntryId + '-' + f.lineNo)}</td><td>${f.name}</td><td>Non-UE Employee, bulk line</td>
     <td>${f.fy}</td><td>${num(f.currentTax)}</td></tr>`).join('');
}
async function previewSection149Repair(){
  const res = await runAction(document.getElementById('btnPreview149'), 'Checking Section 149 impact...', null,
    () => gs('previewSection149CancellationImpact', CURRENT_USER.username));
  if (!res || res.success === false) return;
  LAST_S149_PREVIEW = res;
  renderS149FixTable(res.singleEntryFixes);
  renderS149BulkFlags(res.bulkLineFlags);
  const summary = document.getElementById('s149RepairSummary');
  const applyBtn = document.getElementById('btnApply149');
  if (res.changedCount > 0){
    const changed = res.singleEntryFixes.filter(f => f.changed);
    const totalOverDeducted = changed.reduce((s,f) => s + Math.max(0, f.oldTax - f.newTax), 0);
    const ueCount = changed.filter(f => f.payeeType === 'Employee').length;
    const nonUeCount = changed.length - ueCount;
    summary.innerHTML = `Checked ${res.singleEntryFixes.length} bill(s) - <b style="color:var(--amber);">${res.changedCount} need correction</b>` +
      ` (${ueCount} UE Employee, ${nonUeCount} Non-UE Employee).` +
      (totalOverDeducted > 0 ? ` Total Income Tax over-deducted across these bills: <b style="color:var(--accent);">${num(totalOverDeducted)}</b>.` : '') +
      (res.bulkFlagCount ? ` Plus ${res.bulkFlagCount} bulk-uploaded line(s) below for manual review.` : '');
    applyBtn.style.display = '';
  } else {
    summary.innerHTML = `Checked ${res.singleEntryFixes.length} bill(s) - all already correct.` +
      (res.bulkFlagCount ? ` ${res.bulkFlagCount} bulk-uploaded line(s) below are worth a manual glance.` : '');
    applyBtn.style.display = 'none';
  }
}
async function applySection149Repair(){
  if (!LAST_S149_PREVIEW || !LAST_S149_PREVIEW.changedCount){ toast('Run Preview first.', 'error'); return; }
  if (!confirm('Apply the correction to ' + LAST_S149_PREVIEW.changedCount + ' bill(s)? Their Income Tax and Net Amount will be updated to the corrected figures shown below.')) return;
  const res = await runAction(document.getElementById('btnApply149'), 'Applying correction...', null,
    () => gs('applySection149CancellationImpact', CURRENT_USER.username));
  if (!res || res.success === false) return;
  toast('Corrected ' + res.applied + ' bill(s).', 'success');
  document.getElementById('btnApply149').style.display = 'none';
  previewSection149Repair();
}

/* ---------- Section 149: already-Paid over-deduction -> credit ---------- */
let LAST_S149_PAID_PREVIEW = null;
function renderS149PaidEmployees(employees){
  const wrap = document.getElementById('s149PaidEmployees');
  const affected = employees.filter(g => g.netAdjustment !== 0);
  if (!affected.length){ wrap.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No employee shows a credit or outstanding right now.</p>'; return; }
  wrap.innerHTML = affected.map(g => {
    const isCredit = g.netAdjustment > 0;
    const label = isCredit ? 'Credit owed to employee' : 'Outstanding owed by employee';
    const rows = g.transactions.map(t =>
      `<tr><td>${billIdLink(t.id)}</td><td>${fmtDate(t.date)}</td><td>${t.billNature}</td><td>${num(t.gross)}</td>
       <td>${num(t.actualTax)}</td><td>${num(t.correctTax)}</td></tr>`).join('');
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><b>${g.name}</b> (${g.payeeType==='Employee'?'UE Employee':'Non-UE Employee'}) - FY ${g.fy}</div>
        <div>${label}: <b style="color:${isCredit?'var(--accent)':'var(--danger)'};font-size:15px;">${num(Math.abs(g.netAdjustment))}</b></div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:6px 0;">Total actually withheld ${num(g.totalActualTax)} vs total that should have been withheld ${num(g.totalCorrectTax)}, across ${g.transactions.length} Paid transaction(s):</div>
      <div class="table-wrap"><table><thead><tr><th>Bill ID</th><th>Date</th><th>Nature</th><th>Gross</th><th>Actually Withheld</th><th>Should Have Been</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>`;
  }).join('');
}
async function previewSection149PaidCredit(){
  const res = await runAction(document.getElementById('btnPreview149Paid'), 'Checking Paid transactions...', null,
    () => gs('previewSection149PaidOverDeduction', CURRENT_USER.username));
  if (!res || res.success === false) return;
  LAST_S149_PAID_PREVIEW = res;
  renderS149PaidEmployees(res.employees);
  const summary = document.getElementById('s149PaidSummary');
  const applyBtn = document.getElementById('btnApply149Paid');
  if (res.affectedCount > 0){
    const creditTotal = res.employees.filter(g=>g.netAdjustment>0).reduce((s,g)=>s+g.netAdjustment,0);
    const outstandingTotal = -res.employees.filter(g=>g.netAdjustment<0).reduce((s,g)=>s+g.netAdjustment,0);
    summary.innerHTML = `Checked ${res.checkedTransactionCount} Paid transaction(s) across not-yet-reconciled employees - <b style="color:var(--amber);">${res.affectedCount} employee(s) need adjustment</b>.` +
      (creditTotal > 0 ? ` Total credit to be created: <b style="color:var(--accent);">${num(creditTotal)}</b>.` : '') +
      (outstandingTotal > 0 ? ` Total outstanding to be recorded: <b style="color:var(--danger);">${num(outstandingTotal)}</b>.` : '');
    applyBtn.style.display = '';
  } else {
    summary.innerHTML = `Checked ${res.checkedTransactionCount} Paid transaction(s) - every employee already reconciles correctly.`;
    applyBtn.style.display = 'none';
  }
}
async function applySection149PaidCredit(){
  if (!LAST_S149_PAID_PREVIEW || !LAST_S149_PAID_PREVIEW.affectedCount){ toast('Run Preview first.', 'error'); return; }
  if (!confirm('Apply this reconciliation for ' + LAST_S149_PAID_PREVIEW.affectedCount + ' employee(s)? This does NOT change any Paid bill itself - it only sets up a credit/outstanding balance that adjusts those employees\' NEXT Section 149 transaction(s).')) return;
  const res = await runAction(document.getElementById('btnApply149Paid'), 'Applying...', null,
    () => gs('applySection149PaidOverDeduction', CURRENT_USER.username));
  if (!res || res.success === false) return;
  toast('Adjusted for ' + res.creditsCreated + ' employee(s), from ' + res.applied + ' Paid transaction(s).', 'success');
  document.getElementById('btnApply149Paid').style.display = 'none';
  previewSection149PaidCredit();
  if (document.getElementById('s149CreditsTable').dataset.loaded) loadSection149CreditBalances();
}
async function loadSection149CreditBalances(){
  const res = await runAction(document.getElementById('btnLoadS149Credits'), 'Loading balances...', null,
    () => gs('listSection149CreditBalances', CURRENT_USER.username));
  if (!Array.isArray(res)) return;
  document.getElementById('s149CreditsTable').dataset.loaded = '1';
  document.querySelector('#s149CreditsTable tbody').innerHTML = res.map(r => {
    const isCredit = r.creditAmount > 0;
    return `<tr><td>${r.key}</td><td>${r.payeeType==='Employee'?'UE Employee':'Non-UE Employee'}</td><td>${r.fy}</td>
     <td style="font-weight:700;color:${isCredit?'var(--accent)':'var(--danger)'};">${num(Math.abs(r.creditAmount))} ${isCredit?'(Credit)':'(Outstanding)'}</td>
     <td>${fmtDate(r.lastUpdated)}</td></tr>`;
  }).join('')
    || `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No outstanding credit or dues right now.</td></tr>`;
}

/* ---------- Section 149: manual income inclusion/exclusion override ---------- */
function onManualOverridePayeeTypeChange(){
  const isUE = document.getElementById('mio_payeeType').value === 'Employee';
  document.getElementById('mio_keyLabel').innerText = isUE ? 'Employee ID' : 'CNIC';
  document.querySelector('#mioTable tbody').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">Set Payee Type/ID/FY above and click Load.</td></tr>';
}
async function loadManualOverrideItems(){
  const payeeType = document.getElementById('mio_payeeType').value;
  const key = document.getElementById('mio_key').value.trim();
  const fy = document.getElementById('mio_fy').value || DEFAULT_FY_CLIENT;
  if (!key){ toast('Enter the ' + (payeeType==='Employee'?'Employee ID':'CNIC') + ' first.', 'error'); return; }
  const res = await gs('getSection149IncomeItems', key, payeeType, fy, CURRENT_USER.username);
  if (!Array.isArray(res)) return;
  const tbody = document.querySelector('#mioTable tbody');
  if (!res.length){ tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">No taxable Section 149 bills/lines found for this person in this FY.</td></tr>'; return; }
  tbody.innerHTML = res.map(it => {
    const included = !it.autoExcluded && !it.manuallyExcluded;
    const disabled = it.autoExcluded ? 'disabled' : '';
    const rowStyle = it.autoExcluded ? ' style="opacity:0.55;"' : '';
    const statusLabel = it.autoExcluded ? (it.status + ' - ' + it.autoExcludedReason) : it.status;
    return `<tr${rowStyle}>
      <td>${billIdLink(it.billId)}</td><td>${fmtDate(it.date)}</td><td>${it.billNature}</td>
      <td>${num(it.amount)}</td><td>${num(it.incomeTaxAmount)}</td><td>${statusLabel}</td>
      <td><label style="display:flex;align-items:center;gap:6px;font-weight:normal;">
        <input type="checkbox" ${included?'checked':''} ${disabled} style="width:auto;"
          onchange="toggleManualOverrideItem('${it.itemId}', this.checked)"> Included</label></td>
    </tr>`;
  }).join('');
}
async function toggleManualOverrideItem(itemId, willBeIncluded){
  const payeeType = document.getElementById('mio_payeeType').value;
  const key = document.getElementById('mio_key').value.trim();
  const fy = document.getElementById('mio_fy').value || DEFAULT_FY_CLIENT;
  let reason = '';
  if (!willBeIncluded){
    reason = prompt('Reason for excluding ' + itemId + ' from this person\'s Section 149 threshold (kept on record):') || '';
  }
  const res = await runAction(null, 'Saving...', willBeIncluded ? 'Item re-included.' : 'Item excluded.',
    () => gs('setSection149ManualExclusion', key, payeeType, fy, itemId, !willBeIncluded, reason, CURRENT_USER.username));
  if (res && res.success === false) loadManualOverrideItems();
}

/* ---------- Section 149: Tax Deduction Statement (shared by Admin and Reports) ---------- */
const TDS_SCOPES = {
  admin:   { payeeType:'tds_payeeType',  key:'tds_key',  fy:'tds_fy',  keyLabel:'tds_keyLabel',  result:'tdsResult',  csvBtn:'btnTdsCsv',  pdfBtn:'btnTdsPdf' },
  reports: { payeeType:'rtds_payeeType', key:'rtds_key', fy:'rtds_fy', keyLabel:'rtds_keyLabel', result:'rtdsResult', csvBtn:'btnRtdsCsv', pdfBtn:'btnRtdsPdf' }
};
const LAST_TDS_RESULT = { admin:null, reports:null };
function onTdsPayeeTypeChange(scope){
  const ids = TDS_SCOPES[scope];
  document.getElementById(ids.keyLabel).innerText = document.getElementById(ids.payeeType).value === 'Employee' ? 'Employee ID' : 'CNIC';
}
function tdsSectionLabel(t){
  if (t.section === '149') return '149 - Salary (Slab)';
  if (t.section === '156') return "156 - Honoraria to Statutory Body Meeting's Member";
  return '153(1)(b) - Services (Individual/AOP)';
}
function tdsSlabBreakdownText(t){
  if (!t.slabBreakdown || !t.slabBreakdown.length) return t.method === 'flat' ? ('Flat ' + ((t.flatRate||0)*100).toFixed(2) + '% of gross') : '-';
  return t.slabBreakdown.map(seg => seg.label + ' @ ' + (seg.rate*100).toFixed(2) + '%: ' + num(seg.portionAmount) + ' -> ' + num(seg.taxOnPortion)).join('\n');
}
async function generateTaxDeductionStatement(scope){
  const ids = TDS_SCOPES[scope];
  const payeeType = document.getElementById(ids.payeeType).value;
  const key = document.getElementById(ids.key).value.trim();
  const fy = document.getElementById(ids.fy).value || DEFAULT_FY_CLIENT;
  if (!key){ toast('Enter the ' + (payeeType==='Employee'?'Employee ID':'CNIC') + ' first.', 'error'); return; }
  const res = await runAction(null, 'Building statement...', null,
    () => gs('getSection149TaxDeductionStatement', key, payeeType, fy, CURRENT_USER.username));
  const wrap = document.getElementById(ids.result);
  if (!res || res.success === false){
    wrap.innerHTML = `<p class="error">${res && res.message || 'Could not build the statement.'}</p>`;
    document.getElementById(ids.csvBtn).style.display = 'none';
    document.getElementById(ids.pdfBtn).style.display = 'none';
    LAST_TDS_RESULT[scope] = null;
    return;
  }
  LAST_TDS_RESULT[scope] = res;
  const s = res.statement;
  const rows = s.transactions.map(t => {
    const rowStyle = !t.countsTowardThreshold && t.method === 'slab' ? ' style="opacity:0.55;"' : '';
    return `<tr${rowStyle}>
      <td>${billIdLink(t.id)}</td><td>${fmtDate(t.date)}</td><td>${t.billNature}</td><td>${tdsSectionLabel(t)}</td>
      <td>${num(t.gross)}</td>
      <td>${t.incomeBefore!==null ? num(t.incomeBefore) : '-'}</td><td>${t.incomeAfter!==null ? num(t.incomeAfter) : '-'}</td>
      <td style="white-space:pre-line;">${tdsSlabBreakdownText(t)}</td>
      <td>${num(t.correctTax)}</td><td>${num(t.actualTax)}</td><td>${num(t.creditApplied||0)}</td>
      <td>${t.status}${t.excludedReason ? ' - ' + t.excludedReason : ''}</td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px;">
      <div style="font-weight:700;color:var(--accent);margin-bottom:8px;font-size:15px;">${res.displayName}${res.designation ? ' - ' + res.designation : ''} (${payeeType==='Employee'?'UE Employee':'Non-UE Employee'}, ${key}) - FY ${fy}</div>
      <div class="row" style="gap:20px;">
        <div><span style="color:var(--text-muted);">Annual Taxable Income on file</span><br><b>${num(s.annualIncomeAtStart)}</b></div>
        <div><span style="color:var(--text-muted);">Cumulative Income after all counted transactions</span><br><b>${num(s.finalCumulativeIncome)}</b></div>
        <div><span style="color:var(--text-muted);">Total Slab Gross (counted)</span><br><b>${num(s.totalSlabGross)}</b></div>
        <div><span style="color:var(--text-muted);">Total Actually Withheld</span><br><b>${num(s.totalSlabActualTax)}</b></div>
        <div><span style="color:var(--text-muted);">Total Correct Tax Due</span><br><b>${num(s.totalSlabCorrectTax)}</b></div>
        <div><span style="color:var(--text-muted);">Total Credit Applied</span><br><b>${num(s.totalCreditApplied)}</b></div>
        <div><span style="color:var(--text-muted);">Current Ledger Balance</span><br><b style="color:${s.currentLedgerBalance>=0?'var(--accent)':'var(--danger)'};">${num(Math.abs(s.currentLedgerBalance))} ${s.currentLedgerBalance>=0?'(Credit)':'(Outstanding)'}</b></div>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Bill ID</th><th>Date</th><th>Nature</th><th>FBR Section</th><th>Gross</th><th>Income Before</th><th>Income After</th>
        <th>Slab Breakdown</th><th>Correct Tax</th><th>Actually Withheld</th><th>Credit Applied</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  document.getElementById(ids.csvBtn).style.display = '';
  document.getElementById(ids.pdfBtn).style.display = '';
}
function buildTdsCsvRows(scope){
  const s = LAST_TDS_RESULT[scope].statement;
  const rows = [];
  s.transactions.forEach(t => {
    const base = { billId:t.id, date: t.date ? fmtDate(t.date) : '', nature:t.billNature, section: tdsSectionLabel(t),
      gross:num(t.gross), incomeBefore: t.incomeBefore!==null?num(t.incomeBefore):'', incomeAfter: t.incomeAfter!==null?num(t.incomeAfter):'',
      correctTax:num(t.correctTax), actualTax:num(t.actualTax), creditApplied:num(t.creditApplied||0), status:t.status + (t.excludedReason?(' - '+t.excludedReason):'') };
    if (t.slabBreakdown && t.slabBreakdown.length){
      t.slabBreakdown.forEach(seg => rows.push(Object.assign({}, base, {
        slabLabel: seg.label, slabRate: (seg.rate*100).toFixed(2)+'%', portionAmount: num(seg.portionAmount), taxOnPortion: num(seg.taxOnPortion)
      })));
    } else {
      rows.push(Object.assign({}, base, { slabLabel: t.method==='flat' ? 'Flat Rate' : '-', slabRate: t.flatRate ? (t.flatRate*100).toFixed(2)+'%' : '-', portionAmount: num(t.gross), taxOnPortion: num(t.actualTax) }));
    }
  });
  return rows;
}
const TDS_CSV_COLUMNS = [
  ['billId','Bill ID'], ['date','Date'], ['nature','Nature of Bill'], ['section','FBR Section'],
  ['gross','Gross Amount'], ['incomeBefore','Income Before'], ['incomeAfter','Income After'],
  ['slabLabel','Slab'], ['slabRate','Rate'], ['portionAmount','Portion Amount'], ['taxOnPortion','Tax on Portion'],
  ['correctTax','Correct Total Tax (Bill)'], ['actualTax','Actually Withheld (Bill)'], ['creditApplied','Credit Applied (Bill)'], ['status','Status']
];
function downloadTdsCSV(scope){
  if (!LAST_TDS_RESULT[scope]){ toast('Generate the statement first.', 'error'); return; }
  const rows = buildTdsCsvRows(scope);
  const fname = 'Tax_Deduction_Statement_' + LAST_TDS_RESULT[scope].statement.key.replace(/[^\w-]/g,'_') + '_' + LAST_TDS_RESULT[scope].statement.fy + '.csv';
  exportArrayToCSV(rows, TDS_CSV_COLUMNS, fname);
}
function downloadTdsPDF(scope){
  if (!LAST_TDS_RESULT[scope]){ toast('Generate the statement first.', 'error'); return; }
  const result = LAST_TDS_RESULT[scope];
  const s = result.statement;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'landscape', unit:'pt', format:'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica','bold'); doc.setFontSize(14);
  doc.text('Tax Deduction Statement', 30, 30);
  doc.setFontSize(10); doc.setFont('helvetica','normal');
  doc.text(`${result.displayName}${result.designation ? ' - ' + result.designation : ''} (${s.payeeType==='Employee'?'UE Employee':'Non-UE Employee'}, ${s.key}) - FY ${s.fy}`, 30, 46);
  doc.setFontSize(9);
  const summaryLine = `Annual Income on file: ${num(s.annualIncomeAtStart)}   |   Cumulative Income after all counted transactions: ${num(s.finalCumulativeIncome)}   |   ` +
    `Total Actually Withheld: ${num(s.totalSlabActualTax)}   |   Total Correct Tax Due: ${num(s.totalSlabCorrectTax)}   |   ` +
    `Total Credit Applied: ${num(s.totalCreditApplied)}   |   Current Ledger Balance: ${num(Math.abs(s.currentLedgerBalance))} ${s.currentLedgerBalance>=0?'(Credit)':'(Outstanding)'}`;
  doc.text(doc.splitTextToSize(summaryLine, pageWidth - 60), 30, 62);

  const head = [['Bill ID','Date','Nature','FBR Section','Gross','Income Before','Income After','Slab Breakdown','Correct Tax','Actually Withheld','Credit Applied','Status']];
  const body = s.transactions.map(t => [
    t.id, t.date ? fmtDate(t.date) : '', t.billNature, tdsSectionLabel(t), num(t.gross),
    t.incomeBefore!==null?num(t.incomeBefore):'-', t.incomeAfter!==null?num(t.incomeAfter):'-',
    tdsSlabBreakdownText(t), num(t.correctTax), num(t.actualTax), num(t.creditApplied||0),
    t.status + (t.excludedReason ? (' - ' + t.excludedReason) : '')
  ]);
  doc.autoTable({
    head, body, startY: 84,
    styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [28,61,90], textColor: 255 },
    columnStyles: { 4:{halign:'right'}, 5:{halign:'right'}, 6:{halign:'right'}, 7: { cellWidth: 150 }, 8:{halign:'right'}, 9:{halign:'right'}, 10:{halign:'right'} },
    margin: { left: 20, right: 20 }
  });
  doc.save('Tax_Deduction_Statement_' + s.key.replace(/[^\w-]/g,'_') + '_' + s.fy + '.pdf');
}

/* ---------- Section 149: redirect a Paid bill to the correct beneficiary ---------- */
let RD_ORIGINAL_BILL = null;
function onRedirectPayeeTypeChange(){
  const isUE = document.querySelector('input[name="rdPayeeType"]:checked').value === 'Employee';
  document.getElementById('rd_ueFields').style.display = isUE ? '' : 'none';
  document.getElementById('rd_nonueFields').style.display = isUE ? 'none' : '';
  document.getElementById('rd_nonueTaxFields').style.display = isUE ? 'none' : 'flex';
  if (!isUE) { document.getElementById('rd_nonueTaxMethod').value = 'Section149'; onRedirectTaxMethodChange(); }
  document.getElementById('rd_previewResult').style.display = 'none';
  document.getElementById('btnApplyRedirect').style.display = 'none';
}
function onRedirectTaxMethodChange(){
  const is1531b = document.getElementById('rd_nonueTaxMethod').value === 'Section153_1b';
  document.getElementById('rd_taxpayerStatusWrap').style.display = is1531b ? '' : 'none';
  document.getElementById('rd_affidavitWrap').style.display = is1531b ? 'none' : '';
  if (is1531b) document.getElementById('rd_affidavit').checked = false;
}
let rdEmployeeTimeout;
function onRedirectEmployeeIdInput(){
  clearTimeout(rdEmployeeTimeout);
  const id = document.getElementById('rd_employeeid').value.trim();
  document.getElementById('rd_empname').value = '';
  if (!id) return;
  rdEmployeeTimeout = setTimeout(()=>{
    gs('getEmployeeById', id).then(emp => { if (emp) document.getElementById('rd_empname').value = emp.Name || ''; });
  }, 250);
}
async function loadBillForRedirect(){
  const billId = document.getElementById('rd_billid').value.trim();
  if (!billId){ toast('Enter a Bill ID first.', 'error'); return; }
  const res = await gs('getBillDetail', billId);
  if (!res || res.success === false){ toast(res && res.message || 'Bill not found.', 'error'); return; }
  const infoBox = document.getElementById('rd_originalInfo');
  const correctSection = document.getElementById('rd_correctSection');
  document.getElementById('rd_previewResult').style.display = 'none';
  document.getElementById('btnApplyRedirect').style.display = 'none';

  // A bulk-beneficiary ID like "E345-2" resolves to the PARENT bulk bill's detail; the line is then
  // picked out by its LineNo. An isolated bill ID like "E345-A" is a normal bill.
  const isBulkLineId = billId.includes('-') && !isSplitBillId_client(billId);
  let e, isBulkLine = false, lineForDisplay = null;
  if (isBulkLineId){
    const lineNo = billId.split('-').slice(1).join('-');
    const line = (res.bulkItems||[]).find(li => String(li.LineNo) === String(lineNo));
    if (!line){ toast('Beneficiary line ' + lineNo + ' was not found in bulk bill ' + billId.split('-')[0] + '.', 'error'); return; }
    e = res.bill;
    isBulkLine = true;
    lineForDisplay = line;
  } else {
    e = res.bill;
  }
  RD_ORIGINAL_BILL = { EntryID: billId, isBulkLine };

  if (e.Status !== 'Paid'){
    infoBox.style.display = 'block';
    infoBox.innerHTML = `<span style="color:var(--danger);">This ${isBulkLine?'bulk bill':'bill'} is at "${e.Status}", not Paid - this tool is only for bills already Paid. Use Edit or Cancel instead for anything still in the pipeline.</span>`;
    correctSection.style.display = 'none';
    return;
  }
  if (isBulkLine){
    if (lineForDisplay.PayeeType !== 'Employee'){
      infoBox.style.display = 'block';
      infoBox.innerHTML = `<span style="color:var(--danger);">This tool only supports UE Employee lines within a bulk bill - a bulk Non-UE Employee line doesn't retain enough information to safely redirect automatically. Correct it manually instead.</span>`;
      correctSection.style.display = 'none';
      return;
    }
    if (lineForDisplay.RedirectedToEntryID || lineForDisplay.SplitToEntryID){
      infoBox.style.display = 'block';
      infoBox.innerHTML = `<span style="color:var(--danger);">This beneficiary line has already been ${lineForDisplay.SplitToEntryID ? 'isolated into its own bill ' + lineForDisplay.SplitToEntryID : 'redirected, to Bill ' + lineForDisplay.RedirectedToEntryID}.</span>`;
      correctSection.style.display = 'none';
      return;
    }
    infoBox.style.display = 'block';
    infoBox.innerHTML = `
      <div style="font-size:11.5px;color:var(--amber);margin-bottom:6px;">Beneficiary ${billId} inside bulk bill ${billId.split('-')[0]} - only this line will be affected, every other beneficiary in the same bulk bill is untouched.</div>
      <div style="display:flex;justify-content:space-between;"><span>Currently paid to (wrong beneficiary)</span><b>${lineForDisplay.VendorName} (UE Employee)</b></div>
      <div style="display:flex;justify-content:space-between;"><span>FY</span><b>${e.FY}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>Nature of Bill</span><b>${lineForDisplay.BillNature}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>Gross Amount</span><b>${num(lineForDisplay.Amount)}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>Income Tax Withheld (under wrong beneficiary's name)</span><b>${num(lineForDisplay.IncomeTaxAmount)}</b></div>
      <div style="display:flex;justify-content:space-between;"><span>Net Amount Paid</span><b>${num(netOf_(lineForDisplay))}</b></div>`;
    correctSection.style.display = 'block';
    return;
  }
  if ((e.PayeeType !== 'Employee' && e.PayeeType !== 'NonUEEmployee') || !e.EmployeeCategory || String(e.IncomeTaxSection||'').indexOf('149') !== 0){
    infoBox.style.display = 'block';
    infoBox.innerHTML = `<span style="color:var(--danger);">This bill isn't a Section 149 UE/Non-UE Employee bill - this tool doesn't apply here. (For a bulk bill, enter the specific beneficiary's own ID, e.g. "${billId}-1".)</span>`;
    correctSection.style.display = 'none';
    return;
  }
  if (e.RedirectedToEntryID){
    infoBox.style.display = 'block';
    infoBox.innerHTML = `<span style="color:var(--danger);">This bill has already been redirected, to Bill ${e.RedirectedToEntryID}.</span>`;
    correctSection.style.display = 'none';
    return;
  }
  infoBox.style.display = 'block';
  infoBox.innerHTML = `
    <div style="display:flex;justify-content:space-between;"><span>Currently paid to (wrong beneficiary)</span><b>${e.VendorName} (${e.PayeeType==='Employee'?'UE Employee':'Non-UE Employee'})</b></div>
    <div style="display:flex;justify-content:space-between;"><span>FY</span><b>${e.FY}</b></div>
    <div style="display:flex;justify-content:space-between;"><span>Nature of Bill</span><b>${e.BillNature}</b></div>
    <div style="display:flex;justify-content:space-between;"><span>Gross Amount</span><b>${num(e.Amount)}</b></div>
    <div style="display:flex;justify-content:space-between;"><span>Income Tax Withheld (under wrong beneficiary's name)</span><b>${num(e.IncomeTaxAmount)}</b></div>
    <div style="display:flex;justify-content:space-between;"><span>Net Amount Paid</span><b>${num(netOf_(e))}</b></div>`;
  correctSection.style.display = 'block';
}
function collectRedirectBeneficiary(){
  const isUE = document.querySelector('input[name="rdPayeeType"]:checked').value === 'Employee';
  return isUE
    ? { payeeType:'Employee', employeeId: document.getElementById('rd_employeeid').value.trim() }
    : { payeeType:'NonUEEmployee', cnic: document.getElementById('rd_cnic').value.trim(),
        name: document.getElementById('rd_name').value.trim(), iban: document.getElementById('rd_iban').value.trim(),
        bankName: document.getElementById('rd_bank').value.trim(),
        nonUeTaxMethod: document.getElementById('rd_nonueTaxMethod').value,
        fbrStatus: document.getElementById('rd_taxpayerStatus').value,
        affidavitLowIncome: document.getElementById('rd_affidavit').checked };
}
async function previewRedirect(){
  if (!RD_ORIGINAL_BILL){ toast('Load a bill first.', 'error'); return; }
  const beneficiary = collectRedirectBeneficiary();
  if (beneficiary.payeeType === 'Employee' && !beneficiary.employeeId){ toast('Enter the correct beneficiary\'s Employee ID.', 'error'); return; }
  if (beneficiary.payeeType === 'NonUEEmployee' && (!beneficiary.cnic || !beneficiary.name)){ toast('Enter the correct beneficiary\'s CNIC and Name.', 'error'); return; }
  if (beneficiary.payeeType === 'NonUEEmployee' && !isValidCnicFormat(beneficiary.cnic)){ toast('CNIC must be in the format 35201-1222334-4.', 'error'); return; }
  const res = await runAction(document.getElementById('btnPreviewRedirect'), 'Calculating...', null,
    () => gs('previewBillRedirect', RD_ORIGINAL_BILL.EntryID, beneficiary, CURRENT_USER.username));
  if (!res || res.success === false) return;
  const box = document.getElementById('rd_previewResult');
  box.style.display = 'block';
  box.innerHTML = `
    <div style="font-weight:700;color:var(--accent);margin-bottom:6px;">If confirmed:</div>
    <div style="display:flex;justify-content:space-between;"><span>Bill ${res.original.entryId} (${res.original.name})</span><b>Cancelled</b></div>
    <div style="display:flex;justify-content:space-between;"><span>${res.original.name}'s own prior credit, returned to them</span><b>${num(res.creditToWrongBeneficiary)}</b></div>
    <div style="display:flex;justify-content:space-between;"><span>Income Tax withheld under ${res.original.name}'s name (NOT credited to them - tracked as an FBR Tax Adjustment for Payment/IBFT to reconcile)</span><b style="color:var(--amber);">${num(res.fbrAdjustmentAmount)}</b></div>
    <div style="border-top:1px solid var(--border);margin:8px 0;"></div>
    <div style="display:flex;justify-content:space-between;"><span>New bill for ${res.correct.name}</span><b>Gross ${num(res.original.gross)}</b></div>
    <div style="display:flex;justify-content:space-between;"><span>Income Tax (${res.newIncomeTaxSection || 'Section 149'}, at ${res.correct.name}'s own threshold)</span><b>${num(res.newIncomeTax)}</b></div>
    <div style="display:flex;justify-content:space-between;"><span>Net Amount to be paid to ${res.correct.name}</span><b style="color:var(--accent);">${num(res.newNet)}</b></div>`;
  document.getElementById('btnApplyRedirect').style.display = '';
}
async function applyRedirect(){
  if (!RD_ORIGINAL_BILL){ toast('Load a bill first.', 'error'); return; }
  const beneficiary = collectRedirectBeneficiary();
  if (!confirm('Redirect this payment? ' + (RD_ORIGINAL_BILL.isBulkLine
    ? 'Beneficiary line ' + RD_ORIGINAL_BILL.EntryID + ' will be excluded (the rest of that bulk bill is untouched)'
    : 'Bill ' + RD_ORIGINAL_BILL.EntryID + ' will be cancelled') + ', their own prior credit (if any) will be returned to them, the actual withheld tax will be tracked as an FBR Tax Adjustment (not credited to them), and a new Received bill will be created for the correct beneficiary. This cannot be undone from here.')) return;
  const res = await runAction(document.getElementById('btnApplyRedirect'), 'Redirecting payment...', null,
    () => gs('applyBillRedirect', RD_ORIGINAL_BILL.EntryID, beneficiary, CURRENT_USER.username));
  if (!res || res.success === false) return;
  toast('Redirected - new Bill ' + res.newEntryId + ' created for ' + res.correctBeneficiary + '. It now waits in Processing.', 'success');
  document.getElementById('rd_billid').value = '';
  document.getElementById('rd_originalInfo').style.display = 'none';
  document.getElementById('rd_correctSection').style.display = 'none';
  document.getElementById('rd_previewResult').style.display = 'none';
  document.getElementById('btnApplyRedirect').style.display = 'none';
  RD_ORIGINAL_BILL = null;
  refreshBadges();
}

/* ---------- Reports ---------- */
// The Diary Clerk's Reports tab shows the Diary Report only.
function restrictReportsForDiaryClerk(){
  document.querySelectorAll('nav.subtabs .sub-btn').forEach(b => {
    const ok = /rep10/.test(b.getAttribute('onclick') || '');
    b.style.display = ok ? '' : 'none';
    b.classList.toggle('active', ok);
  });
  document.querySelectorAll('.subpanel').forEach(p => p.classList.toggle('active', p.id === 'sub-rep10'));
}
let DR_USER_DEFAULT_SET = false;
function loadReportFilterOptions(){
  const isClerk = !!CURRENT_USER && CURRENT_USER.role === 'DiaryClerk';
  if (!isClerk){
    gs('getCampuses').then(list=>{
      document.getElementById('r1_campuses').innerHTML = list.map(c=>`<label><input type="checkbox" class="r1chk" value="${c.CampusID}" checked> ${c.CampusName}</label>`).join('');
    });
    fillSelect('r2_campus', CAMPUSES, 'CampusID', 'CampusName', 'All Campuses');
    gs('getBudgetHeads').then(list=> {
      fillSelect('r2_head', list, 'HeadID', 'HeadName', 'All Budget Heads');
      fillSelect('r4_head', list, 'HeadID', 'HeadName', 'All Budget Heads');
    });
  }
  if (document.getElementById('dr_user')) {
    gs('getDiaryEligibleUsers').then(list => {
      const sel = document.getElementById('dr_user');
      const current = sel.value;
      fillSelect('dr_user', list, 'Username', 'FullName', 'All Users');
      if (!DR_USER_DEFAULT_SET){
        // Regular users start on their own name (they can change it); the Diary Clerk starts on All Users.
        DR_USER_DEFAULT_SET = true;
        if (!isClerk) sel.value = CURRENT_USER.username;
      } else {
        sel.value = current;
      }
    }).catch(()=>{});
    fillOfficeFilterSelect('dr_office', 'All Offices');
  }
}
function toggleAll(containerId, checked){
  document.querySelectorAll('#'+containerId+' input[type=checkbox]').forEach(c=>c.checked = checked);
}
// Every report's "Download PDF" reads its caption from here (cost centre + every filter used).
const REPORT_CAPTIONS = {};
function setReportCaption(elementId, key, text){
  REPORT_CAPTIONS[key] = text;
  const el = document.getElementById(elementId);
  if (el) el.innerText = text;
}
function campusSelectionLabel(selectedIds, allCampuses){
  allCampuses = allCampuses || CAMPUSES;
  if (!selectedIds || !selectedIds.length || selectedIds.length === allCampuses.length) return 'All Cost Centres';
  const names = allCampuses.filter(c => selectedIds.includes(c.CampusID)).map(c => c.CampusName);
  return names.length <= 3 ? names.join(', ') : (names.slice(0,3).join(', ') + ' + ' + (names.length-3) + ' more');
}
function singleCampusLabel(campusId, allCampuses){
  allCampuses = allCampuses || CAMPUSES;
  if (!campusId) return 'All Cost Centres';
  const c = allCampuses.find(x => x.CampusID === campusId);
  return c ? c.CampusName : campusId;
}
async function loadYearlyReport(){
  const fy = document.getElementById('r1_fy').value || DEFAULT_FY_CLIENT;
  const campusIds = Array.from(document.querySelectorAll('.r1chk:checked')).map(c=>c.value);
  const rep = await runAction(document.getElementById('btnR1'), 'Building report...', 'Report loaded.',
    () => gs('getYearlyBudgetReport', fy, campusIds));
  if(!rep || rep.success===false) return;
  document.getElementById('yearlyHeadRow').innerHTML = '<th>Budget Head</th>' + rep.months.map(m=>`<th class="num">${m}</th>`).join('') + '<th class="num">Total Spent</th><th class="num">Allocated</th>';
  document.querySelector('#yearlyTable tbody').innerHTML = rep.rows.map(r=>
    `<tr><td>${r.headCode} - ${r.headName}</td>${r.months.map(v=>`<td class="num">${v?num(v):''}</td>`).join('')}<td class="num">${num(r.totalSpent)}</td><td class="num">${num(r.allocated)}</td></tr>`).join('') || emptyRow(rep.months.length+2);
  document.getElementById('yearlyFootRow').innerHTML = '<td>Monthly Total</td>' + rep.monthColumnTotals.map(v=>`<td class="num">${num(v)}</td>`).join('') +
    `<td class="num">${num(rep.grandTotalSpent)}</td><td class="num">${num(rep.grandAllocated)}</td>`;
  setReportCaption('r1_caption', 'r1', `Cost Centre: ${campusSelectionLabel(campusIds)}  |  Financial Year: ${fy}`);
}

async function loadConsumptionReport(){
  const filters = {
    fy: document.getElementById('r2_fy').value,
    campusIds: document.getElementById('r2_campus').value ? [document.getElementById('r2_campus').value] : [],
    headIds: document.getElementById('r2_head').value ? [document.getElementById('r2_head').value] : [],
    fromDate: document.getElementById('r2_from').value, toDate: document.getElementById('r2_to').value,
    vendor: document.getElementById('r2_vendor').value
  };
  const rep = await runAction(document.getElementById('btnR2'), 'Building report...', 'Report loaded.',
    () => gs('getConsumptionReport', filters));
  if(!rep || rep.success===false) return;

  const headLabel = document.getElementById('r2_head').value ? document.getElementById('r2_head').selectedOptions[0].text : 'All Budget Heads';
  const extraBits = [];
  if (filters.fromDate) extraBits.push('From ' + filters.fromDate);
  if (filters.toDate) extraBits.push('To ' + filters.toDate);
  if (filters.vendor) extraBits.push('Vendor contains "' + filters.vendor + '"');
  const captionText = `Cost Centre: ${rep.scopeLabel}  |  Financial Year: ${rep.fy}  |  Budget Head: ${headLabel}` + (extraBits.length ? '  |  ' + extraBits.join('  |  ') : '');
  document.getElementById('r2_scopeLabel').innerText = captionText;
  REPORT_CAPTIONS.r2 = captionText;
  document.getElementById('r2_alloc').innerText = num(rep.totals.allocated);
  document.getElementById('r2_spent').innerText = num(rep.totals.spent);
  document.getElementById('r2_remain').innerText = num(rep.totals.balance);

  document.querySelector('#consumptionSummaryTable tbody').innerHTML = rep.rows.map(r=>{
    const pct = Math.round(r.consumedPct);
    const barClass = r.consumedPct > 100 ? 'over' : (r.consumedPct >= 80 ? 'high' : '');
    return `<tr><td>${r.headCode}</td><td>${r.headName}</td><td>${num(r.allocated)}</td><td>${num(r.spent)}</td>
      <td>${pct}%</td><td style="width:110px;"><div class="progress-track"><div class="progress-fill ${barClass}" style="width:${Math.min(pct,100)}%"></div></div></td>
      <td>${num(r.balance)}</td></tr>`;
  }).join('') || emptyRow(7);
  document.getElementById('consumptionFootRow').innerHTML =
    `<td colspan="2">Total</td><td>${num(rep.totals.allocated)}</td><td>${num(rep.totals.spent)}</td><td>${Math.round(rep.totals.consumedPct)}%</td><td></td><td>${num(rep.totals.balance)}</td>`;

  document.querySelector('#consumptionDetailTable tbody').innerHTML = rep.entries.map(e=>
    `<tr><td>${fmtDate(e.EntryDate)}</td><td>${e.CampusName}</td><td>${e.HeadCode}</td><td>${e.HeadName}</td>
     <td>${e.VendorName}</td><td>${e.BillNo||''}</td><td>${num(e.Amount)}</td><td><span class="pill ${e.Status}">${e.Status}</span></td></tr>`).join('') || emptyRow(8);
}

async function loadStatusReport(){
  const filters = {
    fy: document.getElementById('r3_fy').value,
    status: document.getElementById('r3_status').value,
    campusIds: document.getElementById('r3_campus').value ? [document.getElementById('r3_campus').value] : [],
    fromDate: document.getElementById('r3_from').value, toDate: document.getElementById('r3_to').value,
    vendor: document.getElementById('r3_vendor').value,
    employeeId: document.getElementById('r3_employeeid').value,
    amount: document.getElementById('r3_amount').value,
    description: document.getElementById('r3_description').value,
    iban: document.getElementById('r3_iban').value
  };
  const list = await runAction(document.getElementById('btnR3'), 'Building report...', 'Report loaded.',
    () => gs('getBillStatusReport', filters));
  if(!Array.isArray(list)) return;
  document.getElementById('r3_search').value = '';
  document.querySelector('#statusTable tbody').innerHTML = list.map(e=>
    `<tr><td>${e.EntryID}</td><td>${e.BillNo||''}</td><td>${fmtDate(e.EntryDate)}</td><td>${e.FY}</td><td>${e.CampusName}</td>
     <td>${e.HeadCode}</td><td>${e.HeadName}</td>
     <td>${e.PayeeType||'Vendor'}</td><td>${e.EmployeeID||''}</td><td>${e.VendorName}</td><td>${e.CNIC_NTN||''}</td><td>${e.IBAN||''}</td>
     <td>${e.BillDescription||''}</td><td>${e.BillNature||''}</td><td>${e.IncomeTaxSection||'-'}</td><td>${num(e.Amount)}</td>
     <td>${num(e.IncomeTaxAmount)}</td><td>${num(e.SalesTaxAmount)}</td><td>${num(e.PSTAmount)}</td>
     <td>${num(e.SecurityAmount)}</td><td>${num(e.PenaltyAmount)}</td><td>${num(e.OtherDeductionAmount)}</td><td>${num(netOf_(e))}</td>
     <td>${e.EnteredBy||''}</td><td><span class="pill ${e.Status}">${e.Status}</span></td>
     <td>${fmtDate(e.EntryDate)}</td><td>${e.ProcessedBy||''}</td><td>${fmtDate(e.ProcessedDate)}</td>
     <td>${e.PassedBy||''}</td><td>${fmtDate(e.PassedDate)}</td><td>${e.PaidBy||''}</td><td>${fmtDate(e.PaidDate)}</td></tr>`).join('') || emptyRow(32);
  const bits = [`Cost Centre: ${singleCampusLabel(filters.campusIds[0])}`, `Financial Year: ${filters.fy || 'All Years'}`];
  if (filters.status) bits.push('Status: ' + filters.status);
  if (filters.fromDate) bits.push('From ' + filters.fromDate);
  if (filters.toDate) bits.push('To ' + filters.toDate);
  if (filters.vendor) bits.push('Vendor contains "' + filters.vendor + '"');
  if (filters.employeeId) bits.push('Employee ID contains "' + filters.employeeId + '"');
  if (filters.amount) bits.push('Amount contains "' + filters.amount + '"');
  if (filters.description) bits.push('Description contains "' + filters.description + '"');
  if (filters.iban) bits.push('IBAN contains "' + filters.iban + '"');
  setReportCaption('r3_caption', 'r3', bits.join('  |  '));
}

/* ---------- Budget Control Register ---------- */
async function loadBudgetControlRegister(){
  const filters = {
    fy: document.getElementById('r4_fy').value || DEFAULT_FY_CLIENT,
    campusIds: document.getElementById('r4_campus').value ? [document.getElementById('r4_campus').value] : [],
    headIds: document.getElementById('r4_head').value ? [document.getElementById('r4_head').value] : []
  };
  const rep = await runAction(document.getElementById('btnR4'), 'Building register...', 'Register loaded.',
    () => gs('getBudgetControlRegister', filters));
  if(!rep || rep.success===false) return;
  const rowsHtml = [];
  rep.groups.forEach(g=>{
    if(!g.bills.length){
      rowsHtml.push(`<tr><td>${g.campusName}</td><td>${g.headCode} - ${g.headName}</td><td colspan="7" style="color:var(--text-muted);">No bills posted yet</td>
        <td>${num(g.allocated)}</td></tr>`);
      return;
    }
    g.bills.forEach((b,i)=>{
      rowsHtml.push(`<tr>
        <td>${i===0?g.campusName:''}</td><td>${i===0?(g.headCode+' - '+g.headName):''}</td>
        <td>${billIdLink(b.entryId)}</td><td>${fmtDate(b.date)}</td><td>${b.description||''}</td>
        <td>${i===0?num(g.allocated):''}</td><td>${num(b.amount)}</td>
        <td>${num(b.consumedBefore)}</td><td>${num(b.progressiveTotal)}</td><td>${num(b.runningBalance)}</td>
      </tr>`);
    });
  });
  document.querySelector('#bcrTable tbody').innerHTML = rowsHtml.join('') || emptyRow(10);
  const headLabel = document.getElementById('r4_head').value ? document.getElementById('r4_head').selectedOptions[0].text : 'All Budget Heads';
  setReportCaption('r4_caption', 'r4', `Cost Centre: ${singleCampusLabel(filters.campusIds[0])}  |  Financial Year: ${filters.fy}  |  Budget Head: ${headLabel}`);
}

/* ---------- Confirmed Payments (Reports sub-tab) ---------- */
async function loadConfirmedPayments(){
  const filters = {
    fy: document.getElementById('cp_fy').value,
    campusId: document.getElementById('cp_campus').value,
    billId: document.getElementById('cp_billid').value,
    employeeId: document.getElementById('cp_employeeid').value,
    vendor: document.getElementById('cp_vendor').value,
    description: document.getElementById('cp_desc').value,
    minAmount: document.getElementById('cp_min').value,
    maxAmount: document.getElementById('cp_max').value
  };
  const res = await runAction(document.getElementById('btnLoadConfirmedPayments'), 'Loading confirmed payments...', 'Loaded.',
    () => gs('getConfirmedPayments', filters));
  if (!res || res.success === false) return;
  document.getElementById('cp_search').value = '';
  const list = res.rows || [];
  document.querySelector('#confirmedPaymentsTable tbody').innerHTML = list.map(e=>
    `<tr><td>${billIdLink(e.EntryID)}</td><td>${e.CampusName}</td><td>${e.EmployeeID||''}</td><td>${e.VendorName}</td><td>${e.IBAN||''}</td><td>${e.BillDescription||''}</td>
     <td>${e.IncomeTaxSection||'-'}</td>
     <td class="num">${num(e.Amount)}</td><td class="num">${num(e.IncomeTaxAmount)}</td><td class="num">${num(e.SalesTaxAmount)}</td><td class="num">${num(e.PSTAmount)}</td>
     <td class="num">${num(e.SecurityAmount)}</td><td class="num">${num(e.PenaltyAmount)}</td><td class="num">${num(e.OtherDeductionAmount)}</td>
     <td class="num">${num(netOf_(e))}</td><td>${fmtDate(e.LinePaymentConfirmedDate || e.PaymentConfirmedDate || e.PaidDate)}</td><td><span class="pill ${e.Status}">${e.Status}</span></td></tr>`).join('') || emptyRow(17);
  if (res.truncated) {
    toast('Showing the first 1000 of ' + res.totalMatched + ' matching payments - narrow your filters to see the rest.', 'error');
  }
  const bits = [`Cost Centre: ${singleCampusLabel(filters.campusId)}`, `Financial Year: ${filters.fy || 'All Years'}`];
  if (filters.billId) bits.push('Bill ID contains "' + filters.billId + '"');
  if (filters.employeeId) bits.push('Employee ID contains "' + filters.employeeId + '"');
  if (filters.vendor) bits.push('Name contains "' + filters.vendor + '"');
  if (filters.description) bits.push('Description contains "' + filters.description + '"');
  if (filters.minAmount) bits.push('Min Amount ' + filters.minAmount);
  if (filters.maxAmount) bits.push('Max Amount ' + filters.maxAmount);
  setReportCaption('cp_caption', 'cp', bits.join('  |  '));
}

/* ---------- General Ledger ---------- */
async function loadGeneralLedger(){
  const filters = {
    fy: document.getElementById('r5_fy').value,
    vendor: document.getElementById('r5_vendor').value,
    cnic: document.getElementById('r5_cnic').value,
    iban: document.getElementById('r5_iban').value,
    employeeId: document.getElementById('r5_employeeid').value
  };
  const rep = await runAction(document.getElementById('btnR5'), 'Building ledger...', 'Ledger loaded.',
    () => gs('getGeneralLedger', filters));
  if(!rep || rep.success===false) return;
  document.querySelector('#glTable tbody').innerHTML = rep.vendors.map(v=>
    `<tr><td>${v.vendorName}</td><td>${v.employeeId||''}</td><td>${v.iban||''}</td><td>${v.cnic||''}</td><td>${v.billCount}</td><td>${num(v.totals.gross)}</td>
     <td>${num(v.totals.incomeTax)}</td><td>${num(v.totals.salesTax)}</td><td>${num(v.totals.pst)}</td><td>${num(v.totals.penalty)}</td>
     <td>${num(v.totals.security)}</td><td>${num(v.totals.otherDeductions)}</td><td>${num(v.totals.net)}</td>
     <td>${num(v.securityBalance)}</td></tr>`).join('') || emptyRow(14);

  const detailRows = [];
  rep.vendors.forEach(v => v.bills.forEach(b=>{
    detailRows.push(`<tr><td>${v.vendorName}</td><td>${billIdLink(b.entryId)}</td><td>${fmtDate(b.date)}</td>
      <td>${b.campus||''}</td><td>${b.headCode ? (b.headCode+' - '+(b.headName||'')) : (b.headName||'')}</td><td><span class="pill ${b.status}">${b.status||''}</span></td>
      <td>${b.billNo||''}</td><td>${b.description||''}</td><td>${b.nature||''}</td><td>${num(b.gross)}</td><td>${num(b.incomeTax)}</td>
      <td>${num(b.salesTax)}</td><td>${num(b.pst)}</td><td>${num(b.penalty)}</td><td>${num(b.security)}</td>
      <td>${num(b.otherDeductions)}</td><td>${num(b.net)}</td></tr>`);
  }));
  document.querySelector('#glDetailTable tbody').innerHTML = detailRows.join('') || emptyRow(17);
  const bits = ['Cost Centre: All Cost Centres', `Financial Year: ${rep.fy}`];
  if (filters.vendor) bits.push('Vendor/Employee contains "' + filters.vendor + '"');
  if (filters.cnic) bits.push('CNIC/NTN contains "' + filters.cnic + '"');
  if (filters.iban) bits.push('IBAN contains "' + filters.iban + '"');
  if (filters.employeeId) bits.push('Employee ID contains "' + filters.employeeId + '"');
  setReportCaption('r5_caption', 'r5', bits.join('  |  '));
}

/* ---------- Password change ---------- */
function showPasswordChange(){ document.getElementById('pwModal').style.display='flex'; }
async function submitPasswordChange(){
  const oldP = document.getElementById('pw_old').value;
  const newP = document.getElementById('pw_new').value;
  const res = await runAction(document.getElementById('btnPwChange'), 'Updating password...', 'Password updated.',
    () => gs('changePassword', CURRENT_USER.username, oldP, newP));
  if(res && res.success) document.getElementById('pwModal').style.display='none';
}

/* ---------- Utils ---------- */
function fmtDate(d){ if(!d) return ''; const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString(); }
function num(n){ return Math.round(Number(n||0)).toLocaleString(); }
// Net amount of a bill/line: a real 0 stays 0; only a blank falls back to Gross.
function netOf_(r){ const n = r.NetAmount; return (n === '' || n === undefined || n === null) ? Number(r.Amount||0) : Number(n); }

/* ================= LAYOUT HELPERS: sticky h-scrollbar + auto right-align =================
   Both are driven by ONE debounced MutationObserver on the page body, so every table - including
   ones built dynamically after a Load click - gets both treatments automatically. */

// Auto right-align amount/numeric columns: a column is right-aligned when its header names an amount/
// rate/total, OR when most of its rendered cells look like a plain number. IDs, CNICs, IBANs, dates
// and FY labels never match, so they stay left-aligned.
const AMOUNT_HEADER_KEYWORDS = /amount|gross|net\b|tax|deduct|security|penalty|allocat|spent|balance|total|rate|credit|outstanding|withheld|remaining|consumed|fixed|threshold|allocation|income (before|after)|payment$/i;
function looksNumericCell_(text){
  const t = String(text||'').trim();
  if (!t || t === '-') return false;
  return /^-?[\d,]+(\.\d+)?%?$/.test(t);
}
function autoAlignTableColumns(){
  document.querySelectorAll('table').forEach(table => {
    const tb = table.tBodies[0];
    const firstRow = tb ? tb.firstElementChild : null;
    const lastRow = tb ? tb.lastElementChild : null;
    if (table.__alignFirst === firstRow && table.__alignLast === lastRow && table.__alignCount === table.rows.length) return;
    const headRow = table.querySelector('thead tr:last-of-type');
    if (!headRow) return;
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    const sample = bodyRows.slice(0, 8);
    Array.from(headRow.children).forEach((th, colIdx) => {
      if (th.colSpan > 1) return;
      if (!th.classList.contains('num')){
        const headerMatches = AMOUNT_HEADER_KEYWORDS.test(th.innerText || '');
        let numeric = 0, counted = 0;
        sample.forEach(row => {
          const cell = row.children[colIdx];
          if (!cell || cell.colSpan > 1) return;
          counted++;
          if (looksNumericCell_(cell.innerText)) numeric++;
        });
        const numericColumn = counted > 0 && (numeric / counted) >= 0.6;
        if (!headerMatches && !numericColumn) return;
        th.classList.add('num');
      }
      bodyRows.forEach(row => {
        const cell = row.children[colIdx];
        if (cell && cell.colSpan <= 1) cell.classList.add('num');
      });
      const foot = table.querySelector('tfoot tr');
      if (foot){
        let pos = 0, target = null;
        Array.from(foot.children).forEach(fc => { if (pos === colIdx && (fc.colSpan||1) === 1) target = fc; pos += (fc.colSpan||1); });
        if (target) target.classList.add('num');
      }
    });
    table.__alignFirst = firstRow; table.__alignLast = lastRow; table.__alignCount = table.rows.length;
  });
}

// Sticky horizontal scrollbar: a slim bar fixed to the bottom of the viewport that mirrors scrollLeft
// with whichever wide .table-wrap is currently on screen.
let STICKY_TARGET = null;
function initStickyScrollbars(){
  if (document.getElementById('stickyHScroll')) return;
  const bar = document.createElement('div');
  bar.id = 'stickyHScroll';
  bar.className = 'sticky-hscroll no-print';
  bar.innerHTML = '<div id="stickyHScrollInner"></div>';
  document.body.appendChild(bar);
  bar.addEventListener('scroll', () => { if (STICKY_TARGET && STICKY_TARGET.scrollLeft !== bar.scrollLeft) STICKY_TARGET.scrollLeft = bar.scrollLeft; });
  window.addEventListener('resize', refreshStickyScrollbars);
  window.addEventListener('scroll', refreshStickyScrollbars, { passive:true });
  let t;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { autoAlignTableColumns(); refreshStickyScrollbars(); }, 150); })
    .observe(document.body, { childList:true, subtree:true });
  autoAlignTableColumns();
  refreshStickyScrollbars();
}
function refreshStickyScrollbars(){
  const bar = document.getElementById('stickyHScroll');
  if (!bar) return;
  const vh = window.innerHeight;
  const wide = Array.from(document.querySelectorAll('.table-wrap'))
    .filter(w => w.offsetParent !== null && w.scrollWidth > w.clientWidth + 4);
  const onScreen = wide.filter(w => { const r = w.getBoundingClientRect(); return r.bottom > 80 && r.top < vh - 20; });
  if (!onScreen.length){ bar.style.display = 'none'; STICKY_TARGET = null; return; }
  onScreen.sort((a,b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top));
  const pick = onScreen[0];
  if (pick.getBoundingClientRect().bottom <= vh - 14){ bar.style.display = 'none'; STICKY_TARGET = null; return; }
  if (STICKY_TARGET !== pick){
    STICKY_TARGET = pick;
    if (!pick.__stickyBound){
      pick.__stickyBound = true;
      pick.addEventListener('scroll', () => { if (STICKY_TARGET === pick && bar.scrollLeft !== pick.scrollLeft) bar.scrollLeft = pick.scrollLeft; });
    }
  }
  // Show the bar first so its real width can be read: its scrollable range must equal the table's own, otherwise the far-right columns stay out of reach.
  bar.style.display = 'block';
  document.getElementById('stickyHScrollInner').style.width = (bar.clientWidth + pick.scrollWidth - pick.clientWidth) + 'px';
  bar.scrollLeft = pick.scrollLeft;
}



/* =================================================================
   SCRIPTSDIARY - Stage 0 Diary, Diary Report, Confirmation,
   Reconciliation (loaded after Scripts.html; shares its functions).
   The last sections deliberately re-define a few functions from Scripts.html -
   the later definition wins.
   ================================================================= */

let CURRENT_DIARY_ID = null;

/* ---------- Bulk bill covering several Diary numbers ---------- */
let BULK_DIARY_CANDIDATES = [];
const BULK_DIARY_PICKED = new Set();
async function loadBulkDiaryPicker(){
  const body = document.getElementById('bulkDiaryPickerBody');
  if (!body) return;
  const list = await gs('getUserDiaryQueue', CURRENT_USER.username, {}).catch(() => []);
  // Only open Bill items still waiting to be entered, assigned to this user.
  BULK_DIARY_CANDIDATES = (list || []).filter(r => r.itemType === 'Bill' && r.status === 'Pending' && !r.linkedEntryId && !r.isHeld);
  renderBulkDiaryPicker();
}
function renderBulkDiaryPicker(){
  const body = document.getElementById('bulkDiaryPickerBody');
  if (!body) return;
  body.innerHTML = BULK_DIARY_CANDIDATES.map(r => {
    const locked = (r.diaryId === CURRENT_DIARY_ID);
    const checked = locked || BULK_DIARY_PICKED.has(r.diaryId);
    return `<tr><td><input type="checkbox" class="chk-bulkDiary" value="${r.diaryId}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''} onchange="toggleBulkDiaryPick('${r.diaryId}', this.checked)"></td>
      <td>${diaryIdLink(r.diaryId)}</td><td>${diaryTypeLabel(r)}</td><td>${escHtml_(r.senderLabel)}</td>
      <td>${escHtml_(r.roughDescription)}</td><td class="num">${r.amount != null ? num(r.amount) : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No other pending Diary bills are assigned to you.</td></tr>';
  updateBulkDiaryTotals();
}
function toggleBulkDiaryPick(id, checked){
  if (checked) BULK_DIARY_PICKED.add(id); else BULK_DIARY_PICKED.delete(id);
  updateBulkDiaryTotals();
}
function selectedBulkDiaryIds(){
  const ids = [];
  if (CURRENT_DIARY_ID) ids.push(CURRENT_DIARY_ID);
  BULK_DIARY_CANDIDATES.forEach(r => { if (BULK_DIARY_PICKED.has(r.diaryId) && ids.indexOf(r.diaryId) === -1) ids.push(r.diaryId); });
  return ids;
}
function updateBulkDiaryTotals(){
  const el = document.getElementById('bulkDiaryTotals');
  if (!el) return;
  const ids = selectedBulkDiaryIds();
  let diaryTotal = 0, anyAmount = false;
  ids.forEach(id => { const r = BULK_DIARY_CANDIDATES.find(x => x.diaryId === id); if (r && r.amount != null){ diaryTotal += Number(r.amount); anyAmount = true; } });
  const bulkTotal = (typeof BULK_LINE_ITEMS !== 'undefined' ? BULK_LINE_ITEMS : []).reduce((s, r) => s + Number(r.amount || 0), 0);
  let text = '<b>' + ids.length + '</b> Diary number(s) selected' + (anyAmount ? ' - Diary total <b>' + num(diaryTotal) + '</b>' : '') +
    (bulkTotal ? ' - CSV gross total <b>' + num(bulkTotal) + '</b>' : '') + '.';
  if (anyAmount && bulkTotal && Math.round(diaryTotal) !== Math.round(bulkTotal)){
    text += ' <span style="color:var(--amber);">The totals differ - you can still save (warning only).</span>';
  }
  el.innerHTML = text;
}

const DIARY_STAGE_COLORS = { 0:'var(--text-muted)', 1:'#93C5FD', 2:'#FCD34D', 3:'#93C5FD', 4:'#6EE7B7', 5:'var(--danger)', 6:'var(--accent)', 7:'var(--amber)' };
function diaryStagePill(stage, label){
  return `<span style="color:${DIARY_STAGE_COLORS[stage]||'inherit'};font-weight:700;">${label}</span>`;
}
function diaryIdLink(diaryId){
  return `<a href="javascript:void(0)" onclick="openDiaryTrail('${diaryId}')" style="color:var(--accent);font-weight:600;text-decoration:underline;">${diaryId}</a>`;
}
function daysWaitingCell(days){
  return `<span style="color:${days>10?'var(--danger)':'inherit'};font-weight:${days>10?'700':'400'};">${days}</span>`;
}

/* ---------- Safe text for HTML (names with quotes/apostrophes/& must never break a button) ---------- */
function escHtml_(s){
  return String(s === null || s === undefined ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// A value safely embedded in onclick="fn(...)": JSON text, then HTML-escaped.
function attrJson_(v){ return escHtml_(JSON.stringify(v)); }

/* ---------- Shared dropdown loaders ---------- */
function fillOriginatingOfficeSelect(selectId){
  gs('getReceivingOffices').then(list=>{
    const sel = document.getElementById(selectId);
    sel.innerHTML = '<option value="">-- select --</option>' +
      list.map(o=>`<option value="${o.OfficeID}">${escHtml_(o.OfficeName)}</option>`).join('') +
      '<option value="__others__">Others (type name)</option>';
  }).catch(()=>{});
}
function fillOfficeFilterSelect(selectId, placeholder){
  gs('getReceivingOffices').then(list=>{
    fillSelect(selectId, list, 'OfficeID', 'OfficeName', placeholder || 'All Offices');
  }).catch(()=>{});
}
function loadDiaryClerkDropdowns(){
  gs('getDiaryEligibleUsers').then(list=>{
    fillSelect('dy_assignee', list, 'Username', 'FullName');
    fillSelect('dy_pendingUser', list, 'Username', 'FullName', '-- All Users --');
  }).catch(()=>{});
  fillOriginatingOfficeSelect('dy_originatingOffice');
  fillOfficeFilterSelect('dy_pendingOffice', 'All Offices');
  if (document.getElementById('dy_date')) document.getElementById('dy_date').valueAsDate = new Date();
}
function loadDiaryUserDropdowns(){
  fillOfficeFilterSelect('dy_myOffice', 'All Offices');
}

/* ---------- Log a New Bill or Letter (Diary Clerk) ---------- */
function onDyItemTypeChange(){
  const isBill = document.querySelector('input[name="dyItemType"]:checked').value === 'Bill';
  document.getElementById('dy_billFields').style.display = isBill ? '' : 'none';
  document.getElementById('dy_letterFields').style.display = isBill ? 'none' : '';
}
function diaryTypeLabel(r){ return (r.itemType === 'Bill' && r.billType) ? ('Bill (' + r.billType + ')') : r.itemType; }
// Reads a chosen PDF/JPEG file as {name, mime, base64}; resolves null when nothing was chosen.
function readAttachmentInput_(inputId){
  return new Promise((resolve, reject) => {
    const el = document.getElementById(inputId);
    const file = el && el.files && el.files[0];
    if (!file){ resolve(null); return; }
    const ext = file.name.split('.').pop().toLowerCase();
    if (['pdf','jpg','jpeg','png'].indexOf(ext) === -1){ reject(new Error('Only PDF or JPEG/JPG (or PNG) files can be attached.')); return; }
    if (file.size > 5 * 1024 * 1024){ reject(new Error('The file is too large (5 MB maximum).')); return; }
    const fr = new FileReader();
    fr.onload = () => { const str = String(fr.result); resolve({ name: file.name, mime: file.type, base64: str.substring(str.indexOf(',') + 1) }); };
    fr.onerror = () => reject(new Error('Could not read the file.'));
    fr.readAsDataURL(file);
  });
}
async function openDiaryAttachment(attachmentId, view){
  let w = null;
  if (view) w = window.open('', '_blank');   // opened first (inside the click) so the browser does not block it
  const res = await gs('getDiaryAttachmentData', attachmentId).catch(e => ({ success:false, message: e.message || e }));
  if (!res || !res.success){ if (w) w.close(); toast((res && res.message) || 'Could not open the file.', 'error'); return; }
  const bin = atob(res.base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: res.mime }));
  if (view && w){ w.location.href = url; }
  else { const a = document.createElement('a'); a.href = url; a.download = res.name; document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
function onDySenderTypeChange(){
  const type = document.getElementById('dy_senderType').value;
  document.getElementById('dy_vendorWrap').style.display = (type==='Vendor') ? '' : 'none';
  document.getElementById('dy_employeeWrap').style.display = (type==='Employee') ? '' : 'none';
  document.getElementById('dy_nonueWrap').style.display = (type==='NonUEEmployee') ? '' : 'none';
  document.getElementById('dy_nonueCnicWrap').style.display = (type==='NonUEEmployee') ? '' : 'none';
  document.getElementById('dy_officeWrap').style.display = (type==='Office') ? '' : 'none';
}
function onDyOriginatingOfficeChange(){
  document.getElementById('dy_originatingOtherWrap').style.display =
    (document.getElementById('dy_originatingOffice').value === '__others__') ? '' : 'none';
}
async function submitDiaryEntry(){
  const senderType = document.getElementById('dy_senderType').value;
  const itemType = document.querySelector('input[name="dyItemType"]:checked').value;
  const billTypeEl = document.querySelector('input[name="dyBillType"]:checked');
  const data = {
    itemType: itemType,
    dateReceived: document.getElementById('dy_date').value,
    senderReferenceDate: document.getElementById('dy_senderDate').value,
    senderType: senderType,
    vendorName: senderType==='NonUEEmployee' ? document.getElementById('dy_nonueName').value.trim() : document.getElementById('dy_vendorName').value.trim(),
    cnic: document.getElementById('dy_nonueCnic').value.trim(),
    employeeId: document.getElementById('dy_employeeId').value.trim(),
    senderOfficeName: document.getElementById('dy_senderOfficeName').value.trim(),
    senderReferenceNo: document.getElementById('dy_senderRef').value.trim(),
    originatingOfficeId: document.getElementById('dy_originatingOffice').value,
    originatingOfficeOther: document.getElementById('dy_originatingOther').value.trim(),
    roughDescription: document.getElementById('dy_desc').value.trim(),
    assignedTo: document.getElementById('dy_assignee').value,
    amount: itemType==='Bill' ? document.getElementById('dy_amount').value : '',
    billType: (itemType==='Bill' && billTypeEl) ? billTypeEl.value : ''
  };
  if (senderType==='Vendor' && !data.vendorName){ toast('Enter the Vendor Name.', 'error'); return; }
  if (senderType==='Employee' && !data.employeeId){ toast('Enter the Employee ID.', 'error'); return; }
  if (senderType==='NonUEEmployee' && (!data.vendorName || !data.cnic)){ toast('Enter both the Non-UE Employee Name and CNIC.', 'error'); return; }
  if (senderType==='Office' && !data.senderOfficeName){ toast('Enter the Sender Office Name.', 'error'); return; }
  if (!data.dateReceived){ toast('Date Received is required.', 'error'); return; }
  if (!data.senderReferenceDate){ toast("Sender's Diary / Letter Date is required.", 'error'); return; }
  if (!data.senderReferenceNo){ toast('Reference / Diary No. of the Sender is required.', 'error'); return; }
  if (!data.roughDescription){ toast('Description is required.', 'error'); return; }
  if (itemType==='Bill' && !(Number(data.amount) > 0)){ toast('Enter the Amount of the bill.', 'error'); return; }
  if (itemType==='Bill' && !data.billType){ toast('Select Single bill or Bulk bill.', 'error'); return; }
  if (!data.originatingOfficeId){ toast('Select the Originating Office (or Others).', 'error'); return; }
  if (data.originatingOfficeId==='__others__' && !data.originatingOfficeOther){ toast('Enter the Originating Office name.', 'error'); return; }
  if (!data.assignedTo){ toast('Assign this item to someone.', 'error'); return; }
  if (itemType==='Letter'){
    try { const att = await readAttachmentInput_('dy_file'); if (att) data.attachment = att; }
    catch(e){ toast(e.message, 'error'); return; }
  }

  const res = await runAction(document.getElementById('btnLogDiary'), 'Logging...', 'Item logged and assigned.',
    () => gs('createDiaryEntry', data, CURRENT_USER.username));
  if (res && res.success){
    ['dy_vendorName','dy_employeeId','dy_nonueName','dy_nonueCnic','dy_senderDate','dy_senderOfficeName','dy_senderRef','dy_desc','dy_amount','dy_file'].forEach(id=>document.getElementById(id).value='');
    document.querySelectorAll('input[name="dyBillType"]').forEach(r => r.checked = false);
    document.getElementById('dy_originatingOffice').value = '';
    document.getElementById('dy_originatingOther').value = '';
    document.getElementById('dy_originatingOtherWrap').style.display = 'none';
    document.getElementById('dy_assignee').value = '';
    document.getElementById('dy_lastId').innerText = 'Logged as ' + res.diaryId + ' - write this on the physical item.';
    if (res.attachmentWarning) toast(res.attachmentWarning, 'error');
    refreshBadges();
  }
}

/* ---------- Stage summary boxes ---------- */
function renderDiaryStageBoxes(containerId, stageCounts){
  const boxClass = { 0:'bal-spent', 1:'bal-allocated', 2:'bal-allocated', 3:'bal-allocated', 4:'bal-allocated', 5:'bal-spent', 6:'bal-remaining', 7:'bal-spent' };
  document.getElementById(containerId).innerHTML = stageCounts.map(s =>
    `<div class="${boxClass[s.stage]}"><span class="label">${s.stage} - ${s.label}</span><span class="val">${s.count}</span></div>`).join('');
}

/* ---------- Diary Clerk: Pending Diary Items ---------- */
/* ---- Pending Diary Items: filters, compact table, column picker remembered in this browser ---- */
const PD_COLUMNS = [
  ['diaryId','DN / Bill / Letter No.'], ['dateReceived','Date Received'], ['itemType','Type'], ['sender','Sender'], ['employeeId','Employee ID'],
  ['description','Description'], ['amount','Amount'], ['office','Originating Office'], ['assignedTo','Assigned To'], ['stage','Stage'],
  ['daysAtStage','Days at Stage'], ['daysWaiting','Days Since Arrival'], ['action','Action']
];
const PD_DEFAULT_VISIBLE = ['diaryId','dateReceived','itemType','sender','description','amount','office','assignedTo','stage','daysAtStage','daysWaiting','action'];
const PD_STORAGE_KEY = 'dy_pending_columns_v1';
let PD_ROWS = [];
function pdVisibleColumns_(){
  try {
    const saved = JSON.parse(localStorage.getItem(PD_STORAGE_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch(e){}
  return PD_DEFAULT_VISIBLE.slice();
}
function pdSaveVisible_(list){ try { localStorage.setItem(PD_STORAGE_KEY, JSON.stringify(list)); } catch(e){} }
function buildPendingColumnPicker_(){
  const box = document.getElementById('pd_columns');
  if (!box) return;
  const vis = pdVisibleColumns_();
  box.innerHTML = PD_COLUMNS.map(c => `<label><input type="checkbox" class="pdcol" value="${c[0]}" ${vis.indexOf(c[0]) !== -1 ? 'checked' : ''} onchange="onPendingColumnToggle()"> ${c[1]}</label>`).join('');
}
function togglePendingColumnPicker(){
  const el = document.getElementById('pd_colPicker');
  if (el.style.display === 'none'){ buildPendingColumnPicker_(); el.style.display = 'block'; } else el.style.display = 'none';
}
function onPendingColumnToggle(){
  const vis = PD_COLUMNS.map(c => c[0]).filter(k => { const el = document.querySelector('.pdcol[value="' + k + '"]'); return el && el.checked; });
  pdSaveVisible_(vis.length ? vis : PD_DEFAULT_VISIBLE.slice());
  renderPendingTable();
}
function resetPendingColumns(){
  try { localStorage.removeItem(PD_STORAGE_KEY); } catch(e){}
  buildPendingColumnPicker_(); renderPendingTable();
}
function renderPendingTable(){
  const vis = pdVisibleColumns_();
  const cols = PD_COLUMNS.filter(c => vis.indexOf(c[0]) !== -1);
  document.getElementById('pdHeadRow').innerHTML = cols.map(c => `<th>${c[1]}</th>`).join('');
  const cell = (r, key) => {
    switch (key){
      case 'diaryId': return `<td class="nowrap">${diaryIdLink(r.diaryId)}${r.linkedEntryId ? ' / ' + billIdLink(r.linkedEntryId) : ''}</td>`;
      case 'dateReceived': return `<td class="nowrap">${fmtDate(r.dateReceived)}</td>`;
      case 'itemType': return `<td>${diaryTypeLabel(r)}</td>`;
      case 'sender': return `<td>${escHtml_(r.senderLabel)}</td>`;
      case 'employeeId': return `<td>${escHtml_(r.employeeId || '')}</td>`;
      case 'description': return `<td style="min-width:150px;">${escHtml_(r.roughDescription)}</td>`;
      case 'amount': return `<td class="num">${r.amount != null ? num(r.amount) : ''}</td>`;
      case 'office': return `<td>${escHtml_(r.originatingOffice || '-')}</td>`;
      case 'assignedTo': return `<td>${escHtml_(r.assignedTo)}</td>`;
      case 'stage': return `<td>${diaryStagePill(r.stage, r.stage + ' - ' + escHtml_(r.stageLabel))}${r.isHeld ? ' <span style="color:var(--amber);font-size:10.5px;">(resume from Returned / Sent tabs)</span>' : ''}</td>`;
      case 'daysAtStage': return `<td class="num">${daysWaitingCell(r.daysAtCurrentStage)}</td>`;
      case 'daysWaiting': return `<td class="num">${daysWaitingCell(r.daysWaiting)}</td>`;
      case 'action': return `<td>${(CURRENT_USER.role === 'Admin' && !r.isHeld) ? `<button class="secondary" style="padding:1px 6px;font-size:10.5px;min-height:0;" onclick="adminReassignAnyPrompt('${r.diaryId}')">Admin Reassign</button>` : ''}</td>`;
    }
    return '<td></td>';
  };
  document.querySelector('#pendingDiaryTable tbody').innerHTML = PD_ROWS.map(r => '<tr>' + cols.map(c => cell(r, c[0])).join('') + '</tr>').join('') || emptyRow(cols.length || 1);
  const cnt = document.getElementById('pd_count');
  if (cnt) cnt.textContent = PD_ROWS.length + ' item(s) shown.';
}
async function loadPendingDiaryItems(){
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const filters = {
    assignedTo: document.getElementById('dy_pendingUser').value,
    originatingOfficeId: document.getElementById('dy_pendingOffice').value,
    query: val('dy_pendingQuery'),
    employeeId: val('dy_pendingEmpId'), description: val('dy_pendingDesc'), amount: val('dy_pendingAmount'),
    minDaysWaiting: document.getElementById('dy_only10days').checked ? 10 : 0
  };
  const tbody = document.querySelector('#pendingDiaryTable tbody');
  tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-muted);">Loading...</td></tr>';
  PD_ROWS = await gs('getPendingDiaryItems', filters, CURRENT_USER.username).catch(e=>{ toast(e.message||e, 'error'); return []; }) || [];
  renderPendingTable();

  if (filters.assignedTo){
    document.getElementById('dy_userSummaryBox').style.display = 'block';
    const summary = await gs('getUserDiaryStageSummary', filters.assignedTo).catch(()=>[]);
    renderDiaryStageBoxes('dy_stageSummaryBoxes', summary);
  } else {
    document.getElementById('dy_userSummaryBox').style.display = 'none';
  }
}
async function downloadDiaryUserSummary(format){
  const username = document.getElementById('dy_pendingUser').value;
  if (!username){ toast('Select a user first.', 'error'); return; }
  const stage = document.getElementById('dy_exportStage').value;
  const rows = await gs('getUserDiarySummaryForExport', username, stage, CURRENT_USER.username).catch(e=>{ toast(e.message||e, 'error'); return null; });
  if (!rows) return;
  if (!rows.length){ toast('Nothing to export for this selection.', 'error'); return; }
  const cols = [['diaryId','Diary Number'],['itemType','Type'],['dateReceived','Date Received'],['senderLabel','Sender'],
    ['originatingOffice','Originating Office'],['stageLabel','Stage'],['daysWaiting','Days Waiting']];
  const fname = 'Diary_Summary_' + username + (stage!=='' ? '_stage'+stage : '');
  if (format === 'csv'){
    exportArrayToCSV(rows.map(r=>({...r, dateReceived: fmtDate(r.dateReceived)})), cols, fname + '.csv');
  } else {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation:'landscape', unit:'pt', format:'a4' });
    doc.setFontSize(13); doc.text('Diary Summary - ' + username, 24, 26);
    doc.autoTable({
      head: [cols.map(c=>c[1])], body: rows.map(r => cols.map(c => c[0]==='dateReceived' ? fmtDate(r[c[0]]) : r[c[0]])),
      startY: 40, styles:{fontSize:8,cellPadding:2}, headStyles:{fillColor:[28,61,90],textColor:255},
      columnStyles: { 6: { halign:'right' } }, margin:{left:20,right:20}
    });
    doc.save(fname + '.pdf');
  }
}

/* ---------- Admin: universal reassign of a normal (not held) item ---------- */
async function adminReassignAnyPrompt(diaryId){
  const list = await gs('getDiaryEligibleUsers');
  const names = list.map(u => u.Username + ' (' + u.FullName + ')').join(', ');
  const newUser = prompt('Reassign ' + diaryId + ' to (type exact username):\n\nAvailable: ' + names);
  if (!newUser) return;
  const reason = prompt('Reason (kept on the audit trail):') || '';
  const res = await runAction(null, 'Reassigning...', 'Reassigned.', () => gs('adminReassignAny', diaryId, newUser.trim(), reason, CURRENT_USER.username));
  if (res && res.success){ refreshBadges(); if (document.getElementById('dy_pendingUser')) loadPendingDiaryItems(); }
}

/* ---------- Returned / On Hold + Sent to Other Offices (Diary Clerk / Admin only) ---------- */
async function loadHeldItems(){
  if (!document.getElementById('onHoldTable')) return;
  const res = await gs('getHeldItemsForController', CURRENT_USER.username).catch(e=>{ toast(e.message||e, 'error'); return null; });
  if (!res) return;
  const idCell = r => (r.diaryId ? diaryIdLink(r.diaryId) : '') + (r.linkedEntryId ? (r.diaryId ? ' / ' : '') + billIdLink(r.linkedEntryId) : '');
  const btn = r => `<button class="primary" onclick="openResumeModal('${r.diaryId}','${r.linkedEntryId}')">Re-assign &amp; Resume</button>`;
  document.querySelector('#onHoldTable tbody').innerHTML = (res.returned||[]).map(r => `<tr>
    <td>${idCell(r)}</td><td>${diaryTypeLabel(r)}</td><td>${escHtml_(r.stageLabel)}</td><td>${escHtml_(r.reason)}</td><td>${escHtml_(r.heldBy)}</td>
    <td>${fmtDate(r.heldDate)}</td><td>${escHtml_(r.sender)}${r.description ? ' - ' + escHtml_(r.description) : ''}${r.amount!=null ? ' (' + num(r.amount) + ')' : ''}</td>
    <td>${btn(r)}</td></tr>`).join('') || emptyRow(8);
  document.querySelector('#sentOfficeTable tbody').innerHTML = (res.sent||[]).map(r => `<tr>
    <td>${idCell(r)}</td><td>${diaryTypeLabel(r)}</td><td>${escHtml_(r.sender)}</td><td>${escHtml_(r.officeName)}</td><td>${escHtml_(r.reason)}</td>
    <td>${escHtml_(r.heldBy)}</td><td>${fmtDate(r.heldDate)}</td><td>${btn(r)}</td></tr>`).join('') || emptyRow(8);
}
let RM_DIARY_ID = '', RM_ENTRY_ID = '';
async function openResumeModal(diaryId, entryId){
  RM_DIARY_ID = diaryId || ''; RM_ENTRY_ID = entryId || '';
  document.getElementById('rm_itemId').innerText = diaryId || entryId;
  document.getElementById('rm_note').value = '';
  document.getElementById('rm_userWrap').style.display = diaryId ? '' : 'none'; // a bill with no Diary record is simply released
  const eligible = await gs('getDiaryEligibleUsers');
  fillSelect('rm_user', eligible, 'Username', 'FullName');
  document.getElementById('resumeModal').style.display = 'flex';
}
async function submitResume(){
  let res;
  if (RM_DIARY_ID){
    const user = document.getElementById('rm_user').value;
    if (!user){ toast('Select who to assign this to.', 'error'); return; }
    res = await runAction(null, 'Resuming...', 'Re-assigned and resumed.',
      () => gs('resumeHeldItem', RM_DIARY_ID, user, document.getElementById('rm_note').value.trim(), CURRENT_USER.username));
  } else {
    res = await runAction(null, 'Releasing...', 'Released - resumed at its current stage.',
      () => gs('releaseBillHold', RM_ENTRY_ID, CURRENT_USER.username));
  }
  if (res && res.success){
    document.getElementById('resumeModal').style.display = 'none';
    loadHeldItems(); refreshBadges();
    if (document.getElementById('dy_pendingUser')) loadPendingDiaryItems();
  }
}

/* ---------- Return a bill at Processing/Passing stage for correction ---------- */
let BOR_ENTRY_ID = null;
function openBillOnHoldReturn(entryId){
  BOR_ENTRY_ID = entryId;
  document.getElementById('bor_billId').innerText = entryId;
  document.getElementById('bor_objection').value = '';
  document.getElementById('billOnHoldReturnModal').style.display = 'flex';
}
async function submitBillOnHoldReturn(){
  const objection = document.getElementById('bor_objection').value.trim();
  if (!objection){ toast('Enter the objection/reason.', 'error'); return; }
  const res = await runAction(null, 'Returning...', 'Returned - the Diary Clerk/Admin will re-assign it.',
    () => gs('returnBillForCorrection', BOR_ENTRY_ID, objection, '', CURRENT_USER.username));
  if (res && res.success){
    document.getElementById('billOnHoldReturnModal').style.display = 'none';
    loadMyDiaryQueue(); loadMyDiaryStageSummary(); refreshBadges();
    if (STAGE_TABLE_DATA['processingTable']) loadStageTable('Received','processingTable','proc_fy');
    if (STAGE_TABLE_DATA['passingTable']) loadStageTable('Processed','passingTable','pass_fy');
  }
}

/* ---------- Universal reassign modal (current holder only, before Payment/IBFT) ---------- */
let RA_ITEM_ID = null;
async function openReassignModal(itemId, kind){
  RA_ITEM_ID = itemId;
  document.getElementById('ra_itemId').innerText = itemId + (kind ? ' (' + kind + ')' : '');
  document.getElementById('ra_purpose').value = '';
  document.getElementById('ra_targetOffice').value = '';
  document.querySelector('input[name="raTargetType"][value="user"]').checked = true;
  onReassignTargetChange();
  const eligible = await gs('getDiaryEligibleUsers');
  fillSelect('ra_targetUser', eligible.filter(u=>u.Username!==CURRENT_USER.username), 'Username', 'FullName');
  document.getElementById('reassignModal').style.display = 'flex';
}
function onReassignTargetChange(){
  const isOffice = document.querySelector('input[name="raTargetType"]:checked').value === 'office';
  document.getElementById('ra_userWrap').style.display = isOffice ? 'none' : '';
  document.getElementById('ra_officeWrap').style.display = isOffice ? '' : 'none';
  document.getElementById('ra_officeNote').style.display = isOffice ? '' : 'none';
}
async function submitReassign(){
  const isOffice = document.querySelector('input[name="raTargetType"]:checked').value === 'office';
  const purpose = document.getElementById('ra_purpose').value.trim();
  if (!purpose){ toast('Enter the purpose/reason.', 'error'); return; }
  const target = isOffice
    ? { type:'office', officeName: document.getElementById('ra_targetOffice').value.trim() }
    : { type:'user', username: document.getElementById('ra_targetUser').value };
  if (isOffice && !target.officeName){ toast('Enter the office name.', 'error'); return; }
  if (!isOffice && !target.username){ toast('Select who to reassign to.', 'error'); return; }
  const res = await runAction(null, 'Reassigning...', isOffice ? 'Sent - the Diary Clerk/Admin will re-assign it when it returns.' : 'Reassigned.',
    () => gs('reassignItem', RA_ITEM_ID, target, purpose, CURRENT_USER.username));
  if (res && res.success){
    document.getElementById('reassignModal').style.display = 'none';
    loadMyDiaryQueue(); loadMyDiaryStageSummary(); refreshBadges();
    if (STAGE_TABLE_DATA['processingTable']) loadStageTable('Received','processingTable','proc_fy');
    if (STAGE_TABLE_DATA['passingTable']) loadStageTable('Processed','passingTable','pass_fy');
  }
}

/* ---------- User workspace: My Diary Position + My Diary Queue ---------- */
async function loadMyDiaryStageSummary(){
  if (!document.getElementById('dy_myStageBoxes')) return;
  const summary = await gs('getUserDiaryStageSummary', CURRENT_USER.username).catch(()=>[]);
  renderDiaryStageBoxes('dy_myStageBoxes', summary);
}
async function loadMyDiaryQueue(){
  const tbody = document.querySelector('#myDiaryQueueTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);">Loading...</td></tr>';
  const filters = {
    originatingOfficeId: document.getElementById('dy_myOffice') ? document.getElementById('dy_myOffice').value : '',
    query: document.getElementById('dy_myQuery') ? document.getElementById('dy_myQuery').value.trim() : ''
  };
  const list = await gs('getUserDiaryQueue', CURRENT_USER.username, filters).catch(()=>[]);
  if (!list.length){ tbody.innerHTML = emptyRow(11); return; }
  const canEnter = ((ROLE_TABS[CURRENT_USER.role] || []).indexOf('entry') !== -1);
  tbody.innerHTML = list.map(r => {
    const billLink = r.linkedEntryId ? billIdLink(r.linkedEntryId) + ' ' : '';
    let actionBtns = '';
    if (r.isHeld){
      // Returned / On Hold / Sent to an office: view-only for the person who returned/sent it.
      actionBtns = billLink + '<span style="color:var(--amber);font-size:12px;">View only - Diary Clerk/Admin will re-assign</span>';
    } else if (r.itemType === 'Bill' && r.status === 'Pending' && !r.linkedEntryId){
      actionBtns = (canEnter ? `<button class="primary" onclick="enterDiaryBill('${r.diaryId}')">Enter This Bill</button> ` : '') + `<button class="secondary" onclick="openBillReturn('${r.diaryId}')">Return</button> <button class="secondary" onclick="openReassignModal('${r.diaryId}','Bill')">Reassign</button>`;
    } else if (r.itemType === 'Letter' && r.status === 'Pending'){
      actionBtns = `<button class="primary" onclick="openLetterAction('${r.diaryId}')">Process Letter</button> <button class="secondary" onclick="openReassignModal('${r.diaryId}','Letter')">Reassign</button>`;
    } else if (r.linkedEntryId && r.stage >= 1 && r.stage <= 2){
      actionBtns = billLink + `<button class="secondary" onclick="openBillOnHoldReturn('${r.linkedEntryId}')">Return</button> <button class="secondary" onclick="openReassignModal('${r.linkedEntryId}','Bill')">Reassign</button>`;
    } else if (r.linkedEntryId){
      actionBtns = billLink; // Payment/IBFT onward - no reassign
    }
    return `<tr><td>${diaryIdLink(r.diaryId)}</td><td>${diaryTypeLabel(r)}</td><td>${fmtDate(r.dateReceived)}</td>
      <td>${daysWaitingCell(r.daysAtCurrentStage)}</td><td>${daysWaitingCell(r.daysWaiting)}</td><td>${escHtml_(r.senderLabel)}</td>
      <td>${escHtml_(r.roughDescription)}</td><td>${r.amount!=null ? num(r.amount) : ''}</td>
      <td>${escHtml_(r.originatingOffice||'-')}</td><td>${diaryStagePill(r.stage, escHtml_(r.stageLabel))}</td><td>${actionBtns}</td></tr>`;
  }).join('');
}

/* ---------- Enter a Diary bill into New Entry ---------- */
async function enterDiaryBill(diaryId){
  const d = await gs('getDiaryById', diaryId);
  if (!d){ toast('Could not load this diary item.', 'error'); return; }
  CURRENT_DIARY_ID = diaryId;
  document.querySelector('.tab-btn[data-tab="entry"]').click();

  if (d.SenderType === 'Employee'){
    document.querySelector('input[name="payeeType"][value="Employee"]').checked = true;
    onPayeeTypeChange();
    document.getElementById('e_employeeid').value = d.EmployeeID || '';
    onEmployeeIdInput();
  } else {
    document.querySelector('input[name="payeeType"][value="Vendor"]').checked = true;
    onPayeeTypeChange();
    document.getElementById('e_vendor').value = d.SenderType === 'Office' ? (d.SenderOfficeName||'') : (d.VendorName||'');
  }
  document.getElementById('e_billdesc').value = d.RoughDescription || '';
  if (d.BillType){
    const mode = d.BillType === 'Bulk' ? 'bulk' : 'single';
    document.querySelector('input[name="entryMode"][value="' + mode + '"]').checked = true;
    onEntryModeChange();
    if (mode === 'single' && d.Amount){ document.getElementById('e_amount').value = d.Amount; onAmountInput(); }
    if (mode === 'bulk') document.getElementById('bulk_billdesc').value = (d.RoughDescription || '').slice(0, 40);
  }

  const banner = document.getElementById('dy_activeBanner');
  if (banner){ banner.style.display = 'block'; banner.innerText = 'Entering ' + diaryId + ' - logged ' + fmtDate(d.DateReceived) + ' by ' + d.LoggedBy + '. Diary says: ' + (d.BillType || 'type not stated') + (d.Amount ? ', amount ' + num(d.Amount) : '') + '. Sender/description are pre-filled and can be changed.'; }
  if (document.getElementById('e_diaryBypass')){ document.getElementById('e_diaryBypass').checked = false; onDiaryBypassChange(); }
  toast('Pre-filled from ' + diaryId + ' - review and complete the rest of the form, then Save.', 'success');
  window.scrollTo({top:0, behavior:'smooth'});
}
function onDiaryBypassChange(){
  const checked = document.getElementById('e_diaryBypass').checked;
  document.getElementById('e_diaryBypassReasonWrap').style.display = checked ? '' : 'none';
  if (checked){
    CURRENT_DIARY_ID = null;
    const banner = document.getElementById('dy_activeBanner');
    if (banner) banner.style.display = 'none';
  }
}

/* ---------- Return a Bill still at Diary stage 0 (before any Bill ID "E...") ---------- */
let BR_DIARY_ID = null;
function openBillReturn(diaryId){
  BR_DIARY_ID = diaryId;
  document.getElementById('br_diaryId').innerText = diaryId;
  ['br_objection','br_refNo','br_receiver','br_file'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('br_date').valueAsDate = new Date();
  document.getElementById('billReturnModal').style.display = 'flex';
}
async function submitBillReturn(){
  const objection = document.getElementById('br_objection').value.trim();
  const refNo = document.getElementById('br_refNo').value.trim();
  const date = document.getElementById('br_date').value;
  const receiver = document.getElementById('br_receiver').value.trim();
  if (!objection){ toast('Enter the objection/reason.', 'error'); return; }
  if (!receiver){ toast("Enter the receiver's name.", 'error'); return; }
  let attachment = null;
  try { attachment = await readAttachmentInput_('br_file'); } catch(e){ toast(e.message, 'error'); return; }
  const res = await runAction(null, 'Returning...', 'Returned - the Diary Clerk/Admin will re-assign it.',
    () => gs('returnItem', BR_DIARY_ID, objection, refNo, date, receiver, attachment, CURRENT_USER.username));
  if (res && res.success){
    if (res.attachmentWarning) toast(res.attachmentWarning, 'error');
    document.getElementById('billReturnModal').style.display='none'; loadMyDiaryQueue(); loadMyDiaryStageSummary(); refreshBadges();
  }
}

/* ---------- Letter processing modal ---------- */
let LA_DIARY_ID = null;
async function openLetterAction(diaryId){
  LA_DIARY_ID = diaryId;
  const d = await gs('getDiaryById', diaryId);
  if (!d){ toast('Could not load this letter.', 'error'); return; }
  document.getElementById('la_diaryId').innerText = diaryId;
  document.getElementById('la_summary').innerText = (d.RoughDescription||'(no description)') + ' - from ' +
    (d.SenderType==='Employee' ? ('Employee '+d.EmployeeID) : (d.SenderType==='Office' ? d.SenderOfficeName : d.VendorName)) +
    ', received ' + fmtDate(d.DateReceived) + '.';
  const eligible = await gs('getDiaryEligibleUsers');
  fillSelect('la_forwardTo', eligible.filter(u=>u.Username!==CURRENT_USER.username), 'Username', 'FullName');
  document.querySelector('input[name="laAction"][value="forward"]').checked = true;
  onLetterActionChange();
  ['la_forwardNotes','la_responseRef','la_responseDetails','la_filedDetails','la_returnObjection','la_returnRefNo','la_returnReceiver','la_responseFile','la_returnFile']
    .forEach(id=>document.getElementById(id).value='');
  document.getElementById('la_responseDate').valueAsDate = new Date();
  document.getElementById('la_returnDate').valueAsDate = new Date();
  document.getElementById('letterActionModal').style.display = 'flex';
}
function onLetterActionChange(){
  const action = document.querySelector('input[name="laAction"]:checked').value;
  document.getElementById('la_forwardFields').style.display = (action==='forward') ? '' : 'none';
  document.getElementById('la_closeResponseFields').style.display = (action==='closeResponse') ? '' : 'none';
  document.getElementById('la_closeFiledFields').style.display = (action==='closeFiled') ? '' : 'none';
  document.getElementById('la_returnFields').style.display = (action==='return') ? '' : 'none';
}
async function submitLetterAction(){
  const action = document.querySelector('input[name="laAction"]:checked').value;
  let res;
  if (action === 'forward'){
    const to = document.getElementById('la_forwardTo').value;
    if (!to){ toast('Select who to forward to.', 'error'); return; }
    res = await runAction(null, 'Forwarding...', 'Forwarded.',
      () => gs('forwardLetter', LA_DIARY_ID, to, document.getElementById('la_forwardNotes').value.trim(), CURRENT_USER.username));
  } else if (action === 'closeResponse'){
    let attachment = null;
    try { attachment = await readAttachmentInput_('la_responseFile'); } catch(e){ toast(e.message, 'error'); return; }
    res = await runAction(null, 'Closing...', 'Closed with response.',
      () => gs('closeLetterWithResponse', LA_DIARY_ID, document.getElementById('la_responseRef').value.trim(),
        document.getElementById('la_responseDate').value, document.getElementById('la_responseDetails').value.trim(), attachment, CURRENT_USER.username));
  } else if (action === 'closeFiled'){
    res = await runAction(null, 'Filing...', 'Filed for information.',
      () => gs('closeLetterFiled', LA_DIARY_ID, document.getElementById('la_filedDetails').value.trim(), CURRENT_USER.username));
  } else {
    const objection = document.getElementById('la_returnObjection').value.trim();
    const receiver = document.getElementById('la_returnReceiver').value.trim();
    if (!objection){ toast('Enter the objection/reason.', 'error'); return; }
    if (!receiver){ toast("Enter the receiver's name.", 'error'); return; }
    let attachment = null;
    try { attachment = await readAttachmentInput_('la_returnFile'); } catch(e){ toast(e.message, 'error'); return; }
    res = await runAction(null, 'Returning...', 'Returned - the Diary Clerk/Admin will re-assign it.',
      () => gs('returnItem', LA_DIARY_ID, objection, document.getElementById('la_returnRefNo').value.trim(),
        document.getElementById('la_returnDate').value, receiver, attachment, CURRENT_USER.username));
  }
  if (res && res.success){
    if (res.attachmentWarning) toast(res.attachmentWarning, 'error');
    document.getElementById('letterActionModal').style.display='none'; loadMyDiaryQueue(); loadMyDiaryStageSummary(); refreshBadges();
  }
}

/* ---------- DN Trail popup ---------- */
function movementActionLabel_(a){
  return { Assigned:'Assigned', Forwarded:'Forwarded', ClosedResponse:'Closed - Response Issued', ClosedFiled:'Closed - Filed',
    Returned:'Returned', Reassigned:'Reassigned', AdminReassigned:'Reassigned (Admin)', SentToOffice:'Sent to Another Office',
    ResumedByController:'Re-assigned & Resumed (Diary Clerk/Admin)', ReturnedForCorrection:'Returned for Correction',
    BillDeleted:'Bill Deleted - Back to Diary Pending', CombinedIntoBulkBill:'Combined into a Bulk Bill',
    OfficeConfirmedArrival:'Office Confirmed Arrival', Released:'Released - Resumed',
    AdminEdited:'Diary Details Edited (Admin)', AdminCancelled:'Diary Cancelled (Admin)', AdminRestored:'Diary Restored (Admin)',
    AdminDelinked:'De-linked from Bill (Admin)', AdminLinked:'Linked to Bill (Admin)' }[a] || a;
}
function attachmentKindLabel_(k){ return { Original:'Original letter', Response:'Response letter', Objection:'Objection letter' }[k] || k; }
function attachmentLinksHtml_(a){
  const link = 'color:var(--accent);text-decoration:underline;';
  return `<div style="margin:2px 0;"><b>${attachmentKindLabel_(a.kind)}:</b> ${escHtml_(a.fileName)} ` +
    `<a href="javascript:void(0)" onclick="openDiaryAttachment('${a.attachmentId}', true)" style="${link}">View</a> | ` +
    `<a href="javascript:void(0)" onclick="openDiaryAttachment('${a.attachmentId}', false)" style="${link}">Download</a></div>`;
}
async function openDiaryTrail(diaryId){
  document.getElementById('diaryTrailModal').style.display = 'flex';
  document.getElementById('diaryTrailContent').innerHTML = 'Loading...';
  const res = await gs('getDiaryTrail', diaryId).catch(e=>({success:false,message:e.message||e}));
  if (!res || !res.success){ document.getElementById('diaryTrailContent').innerHTML = '<p class="error">'+(res&&res.message||'Could not load.')+'</p>'; return; }
  const d = res.diary;
  const senderLabel = d.SenderType==='Employee' ? ('Employee '+d.EmployeeID) : (d.SenderType==='Office' ? d.SenderOfficeName : d.VendorName);
  const attByMove = {};
  (res.attachments || []).forEach(a => { (attByMove[a.movementId] || (attByMove[a.movementId] = [])).push(a); });
  const typeText = d.ItemType + (d.ItemType === 'Bill' && d.BillType ? ' (' + d.BillType + ')' : '');
  let html = `<div style="font-size:13px;color:var(--text-muted);margin-bottom:4px;">${typeText} &middot; Logged ${fmtDate(d.DateReceived)} by ${escHtml_(d.LoggedBy)}</div>
    <div style="font-weight:700;font-size:16px;margin-bottom:10px;">${diaryStagePill(res.currentStage, res.currentStage+' - '+escHtml_(res.currentStageLabel))} &middot; ${res.daysWaiting} day(s)</div>
    <div class="bav-grid" style="margin-bottom:14px;">
      <div class="bav-item"><div class="bav-label">Sender</div><div class="bav-value">${escHtml_(senderLabel)||'-'}</div></div>
      <div class="bav-item"><div class="bav-label">Sender's Reference No.</div><div class="bav-value">${escHtml_(d.SenderReferenceNo)||'-'}</div></div>
      <div class="bav-item"><div class="bav-label">Originating Office</div><div class="bav-value">${escHtml_(d.OriginatingOfficeName||d.OriginatingOfficeOther)||'-'}</div></div>
      <div class="bav-item"><div class="bav-label">Description</div><div class="bav-value">${escHtml_(d.RoughDescription)||'-'}</div></div>
      ${d.Amount !== '' && d.Amount !== undefined ? `<div class="bav-item"><div class="bav-label">Amount (per Diary)</div><div class="bav-value">${num(d.Amount)}</div></div>` : ''}
    </div>
    <h4 style="margin:10px 0 6px;">Movement / Disposal Trail</h4>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Action</th><th>From</th><th>To</th><th>Detail</th><th>Files</th></tr></thead><tbody>`;
  const wrapCell = 'white-space:normal;min-width:260px;max-width:420px;word-break:break-word;';
  res.movements.forEach(m => {
    let detail = m.Details || '';
    if (m.ActionType === 'ClosedResponse') detail = 'Ref: ' + (m.ResponseRefNo||'-') + ', Dated: ' + fmtDate(m.ResponseDate) + (m.Details?(' - '+m.Details):'');
    if (m.ActionType === 'Returned') detail = 'Objection: ' + m.ReturnObjection + ' | Return Ref: ' + (m.ReturnRefNo||'-') + ' | Return Date: ' + fmtDate(m.ReturnDate) + ' | Receiver: ' + m.ReturnReceiverName;
    if (m.ActionType === 'ReturnedForCorrection') detail = 'Objection: ' + (m.ReturnObjection||'') + (m.Details ? ' - ' + m.Details : '');
    const files = (attByMove[m.MovementID] || []).map(attachmentLinksHtml_).join('');
    html += `<tr><td>${fmtDate(m.ActionDate)}</td><td>${movementActionLabel_(m.ActionType)}</td><td>${escHtml_(m.FromUser)}</td><td>${escHtml_(m.ToUser)}</td><td style="${wrapCell}">${escHtml_(detail)}</td><td style="white-space:normal;">${files}</td></tr>`;
  });
  if (res.billTrail && res.billTrail.length){
    html += `<tr><td colspan="6" style="background:#0B1220;font-weight:700;">Bill Pipeline (Bill ${d.LinkedEntryID})</td></tr>`;
    res.billTrail.forEach(b => {
      html += `<tr><td>${fmtDate(b.date)}</td><td>${escHtml_(b.event)}</td><td>${escHtml_(b.by)}</td><td></td><td style="${wrapCell}">${escHtml_(b.note)}</td><td></td></tr>`;
    });
  }
  html += '</tbody></table></div>';
  document.getElementById('diaryTrailContent').innerHTML = html;
}

/* ---------- Diary Report ---------- */
// The first bar is "0-1" (so items received today are counted), then 2..6, then 7+.
function buildDiaryChartData_(rows){
  const days = (rows||[]).map(r => Number(r.daysInQueue)||0);
  const data = [{ day:'0-1', count: days.filter(d => d <= 1).length }];
  for (let d = 2; d <= 6; d++) data.push({ day: String(d), count: days.filter(x => x === d).length });
  data.push({ day:'7+', count: days.filter(d => d >= 7).length });
  return data;
}
function renderDiaryBarChart(containerId, chartData){
  const max = Math.max(1, ...chartData.map(d=>d.count));
  const bars = chartData.map(d => {
    const h = Math.round((d.count / max) * 140);
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;flex:1;min-width:36px;height:170px;">
      <div style="font-size:12px;font-weight:700;margin-bottom:4px;">${d.count}</div>
      <div style="width:60%;background:var(--accent);border-radius:4px 4px 0 0;height:${h}px;min-height:2px;"></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">${d.day}</div>
    </div>`;
  }).join('');
  document.getElementById(containerId).innerHTML = `<div style="display:flex;align-items:flex-end;gap:8px;padding:10px 4px;border-bottom:1px solid var(--border);">${bars}</div>
    <div style="text-align:center;font-size:11px;color:var(--text-muted);margin-top:4px;">Days in Queue / to Complete &rarr;</div>`;
}
async function loadDiaryReport(){
  const filters = {
    assignedTo: document.getElementById('dr_user').value,
    originatingOfficeId: document.getElementById('dr_office').value,
    query: document.getElementById('dr_query').value.trim(),
    includeCompleted: document.getElementById('dr_includeCompleted').checked
  };
  const res = await runAction(document.getElementById('btnDiaryReport'), 'Building report...', 'Report loaded.',
    () => gs('getDiaryReport', filters));
  if (!res) return;
  document.querySelector('#diaryReportTable tbody').innerHTML = res.rows.map(r => `<tr>
    <td>${diaryIdLink(r.diaryId)}</td><td>${fmtDate(r.date)}</td><td>${diaryTypeLabel(r)}</td><td>${escHtml_(r.campus)}</td>
    <td>${escHtml_(r.assignedTo)}</td><td>${escHtml_(r.currentStatus)}</td><td>${r.daysInQueue}${r.isComplete?' (total)':''}</td></tr>`).join('') || emptyRow(7);
  renderDiaryBarChart('diaryReportChart', buildDiaryChartData_(res.rows));
  const officeLabel = document.getElementById('dr_office').selectedOptions[0]?.text || 'All Offices';
  const bits = [`User: ${filters.assignedTo || 'All Users'}`, `Originating Office: ${officeLabel}`];
  if (filters.query) bits.push('Search "' + filters.query + '"');
  setReportCaption('dr_caption', 'dr', bits.join('  |  '));
}

/* ---------- Confirmation ----------
   Does NOT auto-load - click Load, then Bill ID/Batch/Beneficiary filter the loaded list live.
   Each row's ID is EITHER a plain Bill ID OR a "ParentID-LineNo" bulk beneficiary line (e.g. E123-4).
   Marking a bulk line Failed isolates it into its own new bill (E123-A ...), which moves to
   Reconciliation; the rest of the bulk bill is untouched. An isolated bill ID like E123-A ends with
   a letter, so it is never mistaken for a bulk line. */
let PC_QUEUE_ALL = [];
const PC_SELECTED = new Set();
function isBulkLineId_(id){ return /-\d+$/.test(String(id)); }
async function loadPaymentConfirmQueue(){
  const fy = document.getElementById('pc_fy').value;
  const tbody = document.querySelector('#pcQueueTable tbody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">Loading...</td></tr>';
  PC_QUEUE_ALL = await gs('getPaymentsNeedingConfirmation', fy).catch(()=>[]);
  PC_SELECTED.clear();
  document.getElementById('pc_filterRow').style.display = PC_QUEUE_ALL.length ? '' : 'none';
  document.getElementById('pc_actionRow').style.display = PC_QUEUE_ALL.length ? '' : 'none';
  ['pc_fBillId','pc_fBatch','pc_fBeneficiary'].forEach(id => document.getElementById(id).value = '');
  renderPaymentConfirmQueue(PC_QUEUE_ALL);
  refreshBadges();
}
function filterPaymentConfirmQueue(){
  const fBillId = document.getElementById('pc_fBillId').value.trim().toLowerCase();
  const fBatch = document.getElementById('pc_fBatch').value.trim().toLowerCase();
  const fBen = document.getElementById('pc_fBeneficiary').value.trim().toLowerCase();
  const filtered = PC_QUEUE_ALL.filter(e =>
    (!fBillId || String(e.EntryID||'').toLowerCase().includes(fBillId)) &&
    (!fBatch || String(e.BatchID||'').toLowerCase().includes(fBatch)) &&
    (!fBen || String(e.VendorName||'').toLowerCase().includes(fBen)));
  renderPaymentConfirmQueue(filtered);
}
function renderPaymentConfirmQueue(list){
  document.querySelector('#pcQueueTable tbody').innerHTML = (list||[]).map(e => `<tr>
    <td><input type="checkbox" class="chk-pcQueue" value="${e.EntryID}" ${PC_SELECTED.has(e.EntryID)?'checked':''} onchange="togglePcSelection('${e.EntryID}', this.checked)"></td>
    <td>${billIdLink(e.EntryID)}</td><td>${fmtDate(e.PaidDate)}</td><td>${escHtml_(e.BatchID)}</td>
    <td>${escHtml_(e.VendorName)}</td><td>${escHtml_(e.IncomeTaxSection||'-')}</td><td>${escHtml_(e.IBAN)}</td><td class="num">${num(netOf_(e))}</td>
  </tr>`).join('') || emptyRow(8);
  document.getElementById('pc_countLabel').innerText = list.length + ' item(s) shown, ' + PC_SELECTED.size + ' selected.';
}
function togglePcSelection(entryId, checked){
  if (checked) PC_SELECTED.add(entryId); else PC_SELECTED.delete(entryId);
  document.getElementById('pc_countLabel').innerText =
    document.querySelectorAll('#pcQueueTable tbody tr').length + ' item(s) shown, ' + PC_SELECTED.size + ' selected.';
}
async function markSelectedPaymentsFailed(){
  if (!PC_SELECTED.size){ toast('Tick at least one item first.', 'error'); return; }
  const reason = prompt('Reason for the ' + PC_SELECTED.size + ' selected item(s) failing (e.g. wrong IBAN, closed account, title mismatch).\n\nA failed bulk beneficiary is separated into its own new bill (E...-A) and moved to Reconciliation; the rest of the bulk bill is not affected.');
  if (reason === null) return;
  if (!reason.trim()){ toast('A reason is required.', 'error'); return; }
  const ids = Array.from(PC_SELECTED);
  const singleIds = ids.filter(id => !isBulkLineId_(id));
  const lineIds = ids.filter(isBulkLineId_);
  const res = await runAction(null, 'Marking as failed...', null, async () => {
    let count = 0, created = [], messages = [];
    if (singleIds.length){
      const r = await gs('markPaymentsFailed', singleIds, reason.trim(), CURRENT_USER.username);
      if (r.success) count += r.count; else messages.push(r.message);
    }
    if (lineIds.length){
      const r = await gs('markBulkLinesFailed', lineIds, reason.trim(), CURRENT_USER.username);
      if (r.success){ count += r.count; created = created.concat(r.created || []); }
      if (r.message) messages.push(r.message);
    }
    if (!count) return { success:false, message: messages.join(' | ') || 'Nothing was marked failed.' };
    return { success:true, count, created, messages };
  });
  if (res && res.success){
    toast(res.count + ' item(s) marked Failed - moved to Reconciliation.' +
      (res.created.length ? ' New Bill ID(s): ' + res.created.map(c => c.newEntryId).join(', ') + '.' : ''), 'success');
    if (res.messages.length) toast(res.messages.join(' | '), 'error');
    loadPaymentConfirmQueue();
  }
}
async function confirmAllRemainingPayments(){
  const rows = Array.from(document.querySelectorAll('#pcQueueTable tbody tr'));
  if (!rows.length){ toast('Nothing currently shown to confirm.', 'error'); return; }
  const visibleIds = Array.from(document.querySelectorAll('.chk-pcQueue')).map(c => c.value);
  if (!visibleIds.length){ toast('Nothing currently shown to confirm.', 'error'); return; }
  if (!confirm('Confirm payment for all ' + visibleIds.length + ' item(s) currently shown? Anything you meant to mark Failed should be ticked and handled first.')) return;
  const singleIds = visibleIds.filter(id => !isBulkLineId_(id));
  const lineIds = visibleIds.filter(isBulkLineId_);
  const res = await runAction(null, 'Confirming...', null, async () => {
    let count = 0;
    if (singleIds.length){ const r = await gs('confirmPayments', singleIds, CURRENT_USER.username); if (r.success) count += r.count; }
    if (lineIds.length){ const r = await gs('confirmBulkLines', lineIds, CURRENT_USER.username); if (r.success) count += r.count; }
    return { success:true, count };
  });
  if (res && res.success){ toast(res.count + ' item(s) confirmed.', 'success'); loadPaymentConfirmQueue(); }
}

/* ---------- Reconciliation: failed bills (including isolated beneficiary bills E123-A ...) ---------- */
async function loadNeedsCorrectionQueue(){
  const tbody = document.querySelector('#needsCorrectionTable tbody');
  if (!tbody) return;
  const list = await gs('getNeedsCorrectionBills', '').catch(()=>[]);
  tbody.innerHTML = (list||[]).map(e => `<tr>
    <td>${billIdLink(e.EntryID)}</td>
    <td>${e.SplitFromEntryID ? billIdLink(e.SplitFromEntryID) + ' (line ' + e.SplitFromLineNo + ')' : '-'}</td>
    <td>${fmtDate(e.PaymentFailureDate)}</td><td>${escHtml_(e.PaymentFailureReason)}</td>
    <td>${escHtml_(e.VendorName)}</td><td>${escHtml_(e.IncomeTaxSection||'-')}</td><td>${escHtml_(e.IBAN)}</td><td class="num">${num(netOf_(e))}</td>
    <td><button class="secondary" onclick="openEditBeneficiary(${attrJson_(e.EntryID)},${attrJson_(e.VendorName||'')},${attrJson_(e.IBAN||'')},${attrJson_(e.CNIC_NTN||'')},false)">Edit</button>
    <button class="primary" onclick="resubmitFailedPaymentAction('${e.EntryID}')">Resubmit</button></td>
  </tr>`).join('') || emptyRow(9);
}
async function resubmitFailedPaymentAction(entryId){
  if(!confirm('Send Bill ' + entryId + ' back to the Passed queue for a fresh IBFT attempt? Make sure the beneficiary\'s bank details have already been corrected.')) return;
  const res = await runAction(null, 'Resubmitting...', 'Sent back to Passed - it will appear in a new IBFT batch, with a retry marker on its Bill ID.',
    () => gs('resubmitFailedPayment', entryId, CURRENT_USER.username));
  if (res && res.success){ loadNeedsCorrectionQueue(); refreshBadges(); }
}

/* ---------- Reconciliation: older failed bulk lines (failed before isolation existed) ---------- */
async function loadFailedBulkLines(){
  const tbody = document.querySelector('#failedBulkLinesTable tbody');
  if (!tbody) return;
  const list = await gs('getLineLevelConfirmationQueue', '', true).catch(()=>[]);
  tbody.innerHTML = (list||[]).map(li => `<tr>
    <td>${billIdLink(li.EntryID)}</td><td>${billIdLink(li.ParentBillID)}</td><td>${fmtDate(li.LinePaymentFailureDate)}</td><td>${escHtml_(li.LinePaymentFailureReason)}</td>
    <td>${escHtml_(li.VendorName)}</td><td>${escHtml_(li.IncomeTaxSection||'-')}</td><td>${escHtml_(li.IBAN)}</td><td class="num">${num(netOf_(li))}</td>
    <td><button class="secondary" onclick="openEditBeneficiary(${attrJson_(li.EntryID)},${attrJson_(li.VendorName||'')},${attrJson_(li.IBAN||'')},${attrJson_(li.CNIC_NTN||'')},true)">Edit</button>
    <button class="primary" onclick="resubmitFailedBulkLineAction('${li.EntryID}')">Resubmit</button></td>
  </tr>`).join('') || emptyRow(9);
}
async function resubmitFailedBulkLineAction(lineId){
  if(!confirm('Resubmit beneficiary ' + lineId + ' for a fresh IBFT attempt? Make sure their bank details have already been corrected. Every other beneficiary in the same bulk bill is untouched.')) return;
  const res = await runAction(null, 'Resubmitting...', 'Resubmitted - will appear in a new IBFT batch for just this beneficiary.',
    () => gs('resubmitFailedBulkLine', lineId, CURRENT_USER.username));
  if (res && res.success){ loadFailedBulkLines(); refreshBadges(); }
}

/* ---------- Edit beneficiary detail before resubmitting (single/isolated bill, or older bulk line) ---------- */
let EB_ENTRY_ID = null;
let EB_IS_LINE = false;
function openEditBeneficiary(entryId, name, iban, cnic, isLine){
  EB_ENTRY_ID = entryId;
  EB_IS_LINE = !!isLine;
  document.getElementById('eb_billId').innerText = entryId;
  document.getElementById('eb_name').value = name || '';
  document.getElementById('eb_iban').value = iban || '';
  document.getElementById('eb_cnic').value = cnic || '';
  document.getElementById('editBeneficiaryModal').style.display = 'flex';
}
function collectBeneficiaryEdits(){
  return { name: document.getElementById('eb_name').value.trim(), iban: document.getElementById('eb_iban').value.trim(), cnic: document.getElementById('eb_cnic').value.trim() };
}
async function saveBeneficiaryOnly(){
  const fn = EB_IS_LINE ? 'updateFailedBulkLineBeneficiary' : 'updateFailedPaymentBeneficiary';
  const res = await runAction(null, 'Saving...', 'Beneficiary detail updated.',
    () => gs(fn, EB_ENTRY_ID, collectBeneficiaryEdits(), CURRENT_USER.username));
  if (res && res.success){ document.getElementById('editBeneficiaryModal').style.display='none'; EB_IS_LINE ? loadFailedBulkLines() : loadNeedsCorrectionQueue(); }
}
async function saveAndResubmit(){
  const editFn = EB_IS_LINE ? 'updateFailedBulkLineBeneficiary' : 'updateFailedPaymentBeneficiary';
  const resubmitFn = EB_IS_LINE ? 'resubmitFailedBulkLine' : 'resubmitFailedPayment';
  const saveRes = await runAction(null, 'Saving...', null,
    () => gs(editFn, EB_ENTRY_ID, collectBeneficiaryEdits(), CURRENT_USER.username));
  if (!saveRes || !saveRes.success) return;
  const res = await runAction(null, 'Resubmitting...', 'Updated and sent back for a fresh IBFT attempt.',
    () => gs(resubmitFn, EB_ENTRY_ID, CURRENT_USER.username));
  if (res && res.success){
    document.getElementById('editBeneficiaryModal').style.display='none';
    EB_IS_LINE ? loadFailedBulkLines() : loadNeedsCorrectionQueue();
    refreshBadges();
  }
}

/* ---------- FBR Tax Adjustments (from Redirect a Paid Bill) ---------- */
async function loadFBRTaxAdjustments(){
  const tbody = document.querySelector('#fbrAdjustTable tbody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">Loading...</td></tr>';
  const list = await gs('getFBRTaxAdjustments', {}, CURRENT_USER.username).catch(e=>{ toast(e.message||e, 'error'); return []; });
  tbody.innerHTML = (list||[]).map(a => `<tr>
    <td>${escHtml_(a.wrongBeneficiaryName)} (${a.payeeType==='Employee'?'UE':'Non-UE'})</td>
    <td>${billIdLink(a.originalEntryId)}</td><td>${billIdLink(a.redirectedToEntryId)}</td>
    <td class="num">${num(a.taxAmount)}</td><td class="num">${num(a.amountAdjusted)}</td><td class="num">${num(a.remaining)}</td>
    <td>${a.depositStatus==='Deposited' ? 'Deposited - adjust in upcoming bills' : 'Not Yet Deposited'}</td>
    <td><button class="primary" onclick="recordFBRAdjustmentPrompt('${a.adjustmentId}', ${a.remaining})">Record Adjustment</button></td>
  </tr>`).join('') || emptyRow(8);
}
async function recordFBRAdjustmentPrompt(adjustmentId, remaining){
  const amountStr = prompt('How much have you reconciled with FBR for this item? (remaining: ' + num(remaining) + ')');
  if (amountStr === null) return;
  const amount = Number(amountStr);
  if (!amount || amount <= 0){ toast('Enter a valid amount.', 'error'); return; }
  const notes = prompt('Notes (optional):') || '';
  const res = await runAction(null, 'Recording...', 'Adjustment recorded.',
    () => gs('recordFBRTaxAdjustment', adjustmentId, amount, notes, CURRENT_USER.username));
  if (res && res.success) loadFBRTaxAdjustments();
}

/* =================================================================
   FIXES THAT REPLACE EARLIER FUNCTIONS FROM Scripts.html
   (a later definition replaces the earlier one with the same name)
   ================================================================= */

/* Badge numbers: only ask the server for COUNTS, and only for the tabs this person can see. */
function refreshBadges(){
  if (!CURRENT_USER) return;
  const tabs = ROLE_TABS[CURRENT_USER.role] || [];
  if (tabs.includes('processing') || tabs.includes('passing') || tabs.includes('payment')){
    gs('getPipelineCounts', '').then(counts=>{
      setBadge('processing', counts.Received);
      setBadge('passing', counts.Processed);
      setBadge('payment', counts.Passed);
    }).catch(()=>{});
  }
  if (tabs.includes('diary')){
    if (CURRENT_USER.role === 'DiaryClerk'){
      gs('getPendingDiaryItems', { minDaysWaiting: 10 }, CURRENT_USER.username).then(list => setBadge('diary', list.length)).catch(()=>{});
    } else {
      gs('getUserDiaryQueue', CURRENT_USER.username, {}).then(list => setBadge('diary', list.length)).catch(()=>{});
    }
  }
  if (tabs.includes('paymentconfirm')){
    gs('getPaymentConfirmCount', '').then(n => setBadge('paymentconfirm', n)).catch(()=>{});
  }
  if (tabs.includes('reconciliation')){
    Promise.all([
      gs('getNeedsCorrectionBills', '').catch(()=>[]),
      gs('getLineLevelConfirmationQueue', '', true).catch(()=>[])
    ]).then(([single, lines]) => setBadge('reconciliation', (single||[]).length + (lines||[]).length));
  }
}

/* Vendor autofill: names containing an apostrophe (e.g. Ali's Traders) used to break the suggestion list. */
let VENDOR_SUGGESTIONS = [];
function onVendorInput(){
  clearTimeout(vendorTimeout);
  const q = document.getElementById('e_vendor').value;
  updateSecurityHeldDisplay();
  if(q.length < 2){ document.getElementById('vendorSuggestions').style.display='none'; return; }
  vendorTimeout = setTimeout(()=>{
    gs('searchVendors', q).then(list=>{
      VENDOR_SUGGESTIONS = list || [];
      const box = document.getElementById('vendorSuggestions');
      if(!VENDOR_SUGGESTIONS.length){ box.style.display='none'; return; }
      box.innerHTML = VENDOR_SUGGESTIONS.map((v,i)=>`<div onclick="pickVendorByIndex(${i})">${escHtml_(v.VendorName)} (${escHtml_(v.CNIC_NTN||'')})</div>`).join('');
      box.style.display='block';
    });
  }, 250);
}
function pickVendorByIndex(i){
  const v = VENDOR_SUGGESTIONS[i];
  if (v) pickVendor(v);
}

/* Admin tables: Edit buttons now work for names/labels containing apostrophes or quotes. */
async function loadAllocations(){
  const filters = {
    campusId: document.getElementById('alloc_campus').value,
    fy: document.getElementById('alloc_fy').value,
    headQuery: document.getElementById('alloc_query').value
  };
  const res = await runAction(document.getElementById('btnLoadAlloc'), 'Loading...', 'Loaded.', () => gs('searchAllocations', filters));
  if (!Array.isArray(res)) return;
  document.querySelector('#allocTable tbody').innerHTML = res.map(a =>
    `<tr><td>${escHtml_(a.CampusName)}</td><td>${escHtml_(a.HeadCode)}</td><td>${escHtml_(a.HeadName)}</td><td>${escHtml_(a.FY)}</td><td>${num(a.AllocatedAmount)}</td>
     <td><button class="secondary" onclick="editAllocationRow(${attrJson_(a)})">Edit</button>
     <button class="secondary" onclick="deleteAllocationRow(${attrJson_(a.CampusID)},${attrJson_(a.HeadID)},${attrJson_(a.FY)})">Delete</button></td></tr>`).join('') || emptyRow(6);
}
async function loadBudgetHeadsAdmin(){
  const query = document.getElementById('bh_query').value;
  const res = await runAction(document.getElementById('btnLoadHeads'), 'Loading...', 'Loaded.', () => gs('searchBudgetHeads', query));
  if (!Array.isArray(res)) return;
  document.querySelector('#headsTable tbody').innerHTML = res.map(h =>
    `<tr><td>${escHtml_(h.HeadCode)}</td><td>${escHtml_(h.HeadName)}${h.Active===false||h.Active==='FALSE'?' (inactive)':''}</td>
     <td><button class="secondary" onclick="editBudgetHeadRow(${attrJson_(h.HeadID)},${attrJson_(h.HeadCode)},${attrJson_(h.HeadName)})">Edit</button>
     <button class="secondary" onclick="deleteBudgetHeadRow(${attrJson_(h.HeadID)})">Deactivate</button></td></tr>`).join('') || emptyRow(3);
}
async function loadSlabs(){
  const slabs = await gs('getTaxSlabs');
  document.querySelector('#slabsTable tbody').innerHTML = slabs.map(s =>
    `<tr><td>${num(s.threshold)}</td><td>${num(s.fixedAmount)}</td><td>${(s.rate*100).toFixed(2)}%</td><td>${escHtml_(s.label||'')}</td>
     <td><button class="secondary" onclick="editSlabRow(${attrJson_(s)})">Edit</button>
     <button class="secondary" onclick="deleteSlabRow(${s.threshold})">Delete</button></td></tr>`).join('') || emptyRow(5);
}

/* =================================================================
   SESSION SECURITY (replaces gs / doLogin / logout / window.onload from Scripts.html)
   Every server call now carries the secret session token; the server
   decides who you are from it, never from the username the page sends.
   ================================================================= */
let SESSION_TOKEN = sessionStorage.getItem('cbs_token') || null;
let SESSION_ENDED_HANDLED_ = false;

function forceRelogin_(){
  if (SESSION_ENDED_HANDLED_) return;
  SESSION_ENDED_HANDLED_ = true;
  sessionStorage.removeItem('cbs_user');
  sessionStorage.removeItem('cbs_token');
  alert('Your session has ended or is no longer valid. Please log in again.');
  location.reload();
}

function gs(fnName, ...args){
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(e => {
        const msg = (e && e.message) ? e.message : String(e);
        if (/SESSION_EXPIRED|SESSION_REQUIRED/.test(msg)) forceRelogin_();
        reject(new Error(msg));
      })
      .apiCall(SESSION_TOKEN, fnName, args);
  });
}

function doLogin(){
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const msgEl = document.getElementById('loginMsg');
  msgEl.innerText = '';
  const btn = document.querySelector('#loginScreen button.primary');
  if (btn) btn.disabled = true;
  google.script.run
    .withSuccessHandler(res => {
      if (btn) btn.disabled = false;
      if (!res || !res.success){ msgEl.innerText = (res && res.message) || 'Login failed.'; return; }
      SESSION_TOKEN = res.token;
      SESSION_ENDED_HANDLED_ = false;
      CURRENT_USER = { success:true, username:res.username, fullName:res.fullName, role:res.role };
      sessionStorage.setItem('cbs_user', JSON.stringify(CURRENT_USER));
      sessionStorage.setItem('cbs_token', SESSION_TOKEN);
      document.getElementById('loginPass').value = '';
      enterApp();
      if (res.weakPassword){
        alert('You are still using the default password (admin123). Please change it now - the Change Password window will open.');
        showPasswordChange();
      }
    })
    .withFailureHandler(e => {
      if (btn) btn.disabled = false;
      msgEl.innerText = (e && e.message) ? e.message : String(e);
    })
    .apiLogin(u, p);
}

function logout(){
  const t = SESSION_TOKEN;
  sessionStorage.removeItem('cbs_user');
  sessionStorage.removeItem('cbs_token');
  SESSION_TOKEN = null;
  const done = () => location.reload();
  if (!t){ done(); return; }
  google.script.run.withSuccessHandler(done).withFailureHandler(done).apiLogout(t);
}

window.onload = function(){
  const saved = sessionStorage.getItem('cbs_user');
  if (saved && SESSION_TOKEN){
    CURRENT_USER = JSON.parse(saved);
    enterApp();
  } else {
    sessionStorage.removeItem('cbs_user');
  }
};
(function(){
  const passBox = document.getElementById('loginPass');
  if (passBox) passBox.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
})();

/* =================================================================
   DUPLICATE PAYMENT RECOVERY (Admin screen + New Entry hooks)
   ================================================================= */
(function installRecoveryAdminCard_(){
  const panel = document.getElementById('tab-admin');
  if (!panel || document.getElementById('adm-recovery')) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'adm-recovery';
  card.innerHTML =
    '<h3>Recover Duplicate Payments</h3>' +
    '<p style="font-size:12.5px;color:var(--text-muted);">' +
    'Use this when beneficiaries were paid <b>twice by mistake outside this system</b> (for example a bank batch run twice). ' +
    'Enter the Bill ID(s) that were paid twice, or the IBFT Batch ID (e.g. B12) to pick up every bill in it. A bulk bill\'s ID lists every beneficiary in it; ' +
    'one beneficiary can be entered as E1042-3. Each beneficiary\'s extra amount is then deducted automatically from the <b>Net Amount</b> of their next bill(s) ' +
    '(tax is still calculated as usual), bill after bill, until fully recovered. ' +
    'The original bill and the budget are never touched, and nothing is booked for the second payment.</p>' +
    '<div class="field"><label>Bill IDs / Line IDs / Batch ID (separate with commas or new lines)</label>' +
    '<textarea id="rc_ids" rows="3" style="resize:vertical;" placeholder="e.g. B12   or   E1042, E1043-2"></textarea></div>' +
    '<button class="secondary" id="btnRcFind" onclick="findRecoverySources()">Find Payments</button>' +
    '<div id="rc_warnings" style="margin-top:8px;font-size:12.5px;color:var(--amber);"></div>' +
    '<div id="rc_foundWrap" style="display:none;margin-top:10px;">' +
      '<div class="table-wrap"><table id="rcFoundTable"><thead><tr><th></th><th>Bill / Line ID</th><th>Beneficiary</th><th>Type</th><th>IBAN</th>' +
      '<th class="num">Net Paid</th><th class="num">Amount Paid Twice</th><th>Note</th></tr></thead><tbody></tbody></table></div>' +
      '<div class="row" style="margin-top:10px;align-items:flex-end;">' +
        '<div class="field"><label>Notes (optional)</label><input type="text" id="rc_notes" placeholder="e.g. Batch B12 run twice on bank portal, 11-Oct-2026"></div>' +
        '<div class="field" style="flex:0 0 auto;"><button class="primary" id="btnRcRegister" onclick="registerRecoveries()">Register Recovery</button></div>' +
      '</div>' +
    '</div>' +
    '<h3 style="margin-top:22px;font-size:13px;">Recovery Records</h3>' +
    '<div class="row">' +
      '<div class="field" style="max-width:200px;"><label>Show</label><select id="rc_status"><option value="Open">Open (still to recover)</option><option value="">All</option><option value="Recovered">Fully Recovered</option><option value="Cancelled">Cancelled</option></select></div>' +
      '<div class="field"><label>Name / Bill ID / IBAN contains</label><input type="text" id="rc_query"></div>' +
      '<div class="field" style="align-self:flex-end;"><button class="primary" id="btnRcLoad" onclick="loadRecoveries()">Load</button></div>' +
    '</div>' +
    '<div id="rc_summary" style="font-size:13px;color:var(--text-muted);margin:6px 0;"></div>' +
    '<div class="table-wrap"><table id="rcTable"><thead><tr><th>Record</th><th>Paid-Twice Bill</th><th>Beneficiary</th><th class="num">Paid Twice</th>' +
    '<th class="num">Recovered</th><th class="num">Outstanding</th><th>Status</th><th>Recovered Through</th><th></th></tr></thead>' +
    '<tbody><tr><td colspan="9" style="text-align:center;color:var(--text-muted);">Click Load.</td></tr></tbody></table></div>';
  panel.appendChild(card);
  const grp = document.querySelector('#adminQuickNav optgroup[label="Bill Management"]');
  if (grp){
    const o = document.createElement('option');
    o.value = 'adm-recovery'; o.textContent = 'Recover Duplicate Payments';
    grp.appendChild(o);
  }
})();

let RECOVERY_FOUND = [];
async function findRecoverySources(){
  const text = document.getElementById('rc_ids').value.trim();
  if (!text){ toast('Enter at least one Bill ID or Batch ID.', 'error'); return; }
  document.getElementById('rc_warnings').innerHTML = '';
  document.getElementById('rc_foundWrap').style.display = 'none';
  const res = await runAction(document.getElementById('btnRcFind'), 'Looking up payments...', null,
    () => gs('lookupRecoverySources', text, CURRENT_USER.username));
  if (!res || res.success === false) return;
  RECOVERY_FOUND = res.items || [];
  document.getElementById('rc_warnings').innerHTML = (res.warnings || []).map(w => '&bull; ' + escHtml_(w)).join('<br>');
  document.querySelector('#rcFoundTable tbody').innerHTML = RECOVERY_FOUND.map((it, i) => `<tr>
    <td><input type="checkbox" id="rc_chk_${i}" ${it.alreadyRegistered ? 'disabled' : 'checked'} style="width:auto;"></td>
    <td>${billIdLink(it.sourceId)}</td><td>${escHtml_(it.name)}</td><td>${escHtml_(payeeTypeLabel_(it.payeeType))}</td><td>${escHtml_(it.iban)}</td>
    <td class="num">${num(it.netPaid)}</td>
    <td class="num"><input type="number" id="rc_amt_${i}" value="${it.netPaid}" min="1" max="${it.netPaid}" style="width:130px;" ${it.alreadyRegistered ? 'disabled' : ''}></td>
    <td>${it.alreadyRegistered ? '<span style="color:var(--amber);">Already registered</span>' : ''}</td></tr>`).join('');
  document.getElementById('rc_foundWrap').style.display = '';
}
async function registerRecoveries(){
  const items = [];
  let total = 0;
  RECOVERY_FOUND.forEach((it, i) => {
    const cb = document.getElementById('rc_chk_' + i);
    if (!cb || !cb.checked || cb.disabled) return;
    const amount = Number(document.getElementById('rc_amt_' + i).value) || 0;
    items.push({ sourceId: it.sourceId, amount: amount });
    total += amount;
  });
  if (!items.length){ toast('Tick at least one beneficiary.', 'error'); return; }
  if (!confirm('Register ' + items.length + ' recovery record(s), total ' + num(total) + '? From now on this will be deducted automatically from these beneficiaries\' next bills. The original bills and the budget are not touched.')) return;
  const res = await runAction(document.getElementById('btnRcRegister'), 'Saving...', null,
    () => gs('createDuplicateRecoveries', items, document.getElementById('rc_notes').value.trim(), CURRENT_USER.username));
  if (!res || res.success === false) return;
  toast(res.created + ' recovery record(s) registered, total ' + num(res.totalAmount) + '.', 'success');
  if (res.skipped && res.skipped.length) toast('Skipped: ' + res.skipped.join(' | '), 'error');
  document.getElementById('rc_ids').value = '';
  document.getElementById('rc_notes').value = '';
  document.getElementById('rc_foundWrap').style.display = 'none';
  document.getElementById('rc_warnings').innerHTML = '';
  RECOVERY_FOUND = [];
  document.getElementById('rc_status').value = 'Open';
  loadRecoveries();
}
async function loadRecoveries(){
  const filters = { status: document.getElementById('rc_status').value, query: document.getElementById('rc_query').value };
  const res = await runAction(document.getElementById('btnRcLoad'), 'Loading...', null,
    () => gs('getDuplicateRecoveries', filters, CURRENT_USER.username));
  if (!res || res.success === false) return;
  document.getElementById('rc_summary').innerHTML = 'Total still to be recovered (all records): <b>' + num(res.totalOutstanding) + '</b>';
  document.querySelector('#rcTable tbody').innerHTML = (res.rows || []).map(r => {
    const through = (r.applications || []).map(a => billIdLink(a.entryId) + ' (' + num(a.amount) + ')').join(', ') || '-';
    const color = r.status === 'Open' ? 'var(--amber)' : (r.status === 'Recovered' ? 'var(--accent)' : 'var(--text-muted)');
    return `<tr><td>${escHtml_(r.recoveryId)}</td><td>${billIdLink(r.sourceEntryId)}</td>
      <td>${escHtml_(r.name)} (${escHtml_(payeeTypeLabel_(r.payeeType))})</td>
      <td class="num">${num(r.amountPaidTwice)}</td><td class="num">${num(r.recovered)}</td><td class="num">${num(r.outstanding)}</td>
      <td style="color:${color};font-weight:700;">${r.status}</td><td style="white-space:normal;min-width:180px;">${through}</td>
      <td>${r.status === 'Open' ? `<button class="secondary" style="color:var(--danger);" onclick="cancelRecovery(${attrJson_(r.recoveryId)})">Cancel</button>` : ''}</td></tr>`;
  }).join('') || emptyRow(9);
}
async function cancelRecovery(recoveryId){
  const reason = prompt('Stop recovering ' + recoveryId + '? No further deductions will be made (amounts already deducted from earlier bills stay deducted).\n\nReason (kept on record):');
  if (reason === null) return;
  const res = await runAction(null, 'Cancelling...', 'Recovery cancelled.', () => gs('cancelDuplicateRecovery', recoveryId, reason, CURRENT_USER.username));
  if (res && res.success) loadRecoveries();
}

/* ---- New Entry: live preview, save confirmation, bulk toast, audit view ---- */
(function installRecoveryHooks_(){
  // Preview asks for the recovery-aware calculation and shows an extra row when something is being recovered.
  const origGs = window.gs;
  const REFRESH_PREVIEW_AFTER = { getEmployeeById:1, getNonUEEmployeeByCNIC:1, getStudentById:1, getVendorByCNIC:1 };
  window.gs = function(fnName){
    const args = Array.prototype.slice.call(arguments, 1);
    if (fnName === 'previewTaxCalculation') fnName = 'previewTaxCalculationWithRecovery';
    const p = origGs.apply(this, [fnName].concat(args));
    if (fnName === 'previewTaxCalculationWithRecovery') p.then(updateRecoveryPreviewRow_).catch(function(){});
    if (REFRESH_PREVIEW_AFTER[fnName]) p.then(function(){ setTimeout(function(){ if (window.updateTaxPreview) window.updateTaxPreview(); }, 80); }).catch(function(){});
    if (fnName === 'submitBulkEntry') p.then(function(res){
      if (res && res.success && Number(res.recoveryDeducted) > 0) toast('Duplicate-payment recovery of ' + num(res.recoveryDeducted) + ' was deducted from beneficiaries in this bulk bill.', 'success');
    }).catch(function(){});
    return p;
  };
  const origCollect = window.collectTaxParams;
  window.collectTaxParams = function(){
    const p = origCollect();
    const t = p.payeeType;
    const val = function(id){ const el = document.getElementById(id); return el ? el.value : ''; };
    p.vendorName = resolvedPayeeName();
    p.studentId = String(val('e_studentid')).trim();
    p.iban = t === 'Employee' ? val('e_empiban') : (t === 'NonUEEmployee' ? val('e_nonue_iban') : (t === 'Student' ? val('e_beneficiaryIban') : val('e_iban')));
    p.recoveryExcludeEntryId = (typeof CURRENT_EDIT_ENTRY_ID !== 'undefined' && CURRENT_EDIT_ENTRY_ID) ? CURRENT_EDIT_ENTRY_ID : '';
    return p;
  };
  ['e_employeeid','e_vendor','e_cnic','e_iban','e_nonue_cnic','e_nonue_iban','e_studentid','e_beneficiaryIban'].forEach(function(id){
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', function(){ if (window.updateTaxPreview) window.updateTaxPreview(); });
  });
  window.updateRecoveryPreviewRow_ = function(tax){
    const tbody = document.querySelector('#taxPreviewTable tbody');
    if (!tbody) return;
    let tr = document.getElementById('tp_recoveryRow');
    if (!tr){
      tr = document.createElement('tr');
      tr.id = 'tp_recoveryRow';
      tr.innerHTML = '<td>Duplicate Payment Recovery</td><td id="tp_recnote">-</td><td>-</td><td id="tp_recamt">0</td>';
      tbody.appendChild(tr);
    }
    const amt = Number(tax && tax.recoveryDeducted) || 0;
    tr.style.display = amt > 0 ? '' : 'none';
    document.getElementById('tp_recamt').innerText = num(amt);
    document.getElementById('tp_recnote').innerText = 'Owed back before this bill: ' + num((tax && tax.recoveryBalanceBefore) || 0);
  };
  // After saving a bill, say clearly if a recovery was taken from it.
  const origConfirm = window.showBillConfirmation;
  window.showBillConfirmation = function(res){
    origConfirm(res);
    const rec = Number(res && res.tax && res.tax.recoveryDeducted) || 0;
    if (rec > 0){
      document.getElementById('confirmContent').insertAdjacentHTML('beforeend',
        '<div style="border:1px solid var(--amber);background:rgba(245,158,11,0.12);border-radius:8px;padding:12px;margin-top:6px;font-size:14px;line-height:1.5;">' +
        '<b style="color:var(--amber);">Duplicate payment recovery:</b> ' + num(rec) + ' was deducted from this bill\'s net amount to recover an amount paid twice by mistake. ' +
        'Net payable is now <b>' + num(res.tax.netAmount) + '</b>.</div>');
    }
  };
  // Bill Audit View: show the recovery line just above the Net Amount.
  const origBav = window.bavFinRow;
  window.bavFinRow = function(label, sub, amount, opts){
    let extra = '';
    if (label === 'NET AMOUNT PAID' && window.__lastBillAuditData && window.__lastBillAuditData.bill){
      const rec = Number(window.__lastBillAuditData.bill.RecoveryDeducted) || 0;
      if (rec > 0) extra = origBav('Duplicate Payment Recovery', 'Deducted to recover an amount paid twice by mistake', rec, { negative: true });
    }
    return extra + origBav(label, sub, amount, opts);
  };
})();

/* =================================================================
   REPORTS: Recovery Statement (by Employee ID) + Bank Reconciliation
   ================================================================= */
(function installRecoveryReports_(){
  const nav = document.querySelector('#tab-reports nav.subtabs');
  const panel = document.getElementById('tab-reports');
  if (!nav || !panel || document.getElementById('sub-rep13')) return;
  [['rep13','Recovery Statement',''],['rep14','Bank Reconciliation','initBankRec_()']].forEach(function(b){
    const btn = document.createElement('button');
    btn.className = 'sub-btn';
    btn.textContent = b[1];
    btn.setAttribute('onclick', "showSubTab('" + b[0] + "', event);" + b[2]);
    nav.appendChild(btn);
  });

  const rs = document.createElement('div');
  rs.id = 'sub-rep13'; rs.className = 'subpanel';
  rs.innerHTML =
    '<div class="card no-print"><h3>Duplicate-Payment Recovery Statement</h3>' +
    '<p style="font-size:12.5px;color:var(--text-muted);">For one employee: every amount paid twice by mistake, each deduction made so far from later bills, the amount recovered, and the balance still to recover.</p>' +
    '<div class="row"><div class="field"><label>Employee ID (or CNIC / Student ID)</label><input type="text" id="rs_key"></div>' +
    '<div class="field" style="align-self:flex-end;"><button class="primary" id="btnRsGo" onclick="loadRecoveryStatement()">Generate</button> ' +
    '<button class="secondary" id="btnRsCsv" onclick="downloadRecoveryStatementCSV()" style="display:none;">Download CSV</button> ' +
    '<button class="secondary" id="btnRsPdf" onclick="downloadRecoveryStatementPDF()" style="display:none;">Download PDF</button> ' +
    '<button class="secondary" onclick="window.print()">Print</button></div></div></div>' +
    '<div class="card"><div id="rs_result"></div></div>';
  panel.appendChild(rs);

  const br = document.createElement('div');
  br.id = 'sub-rep14'; br.className = 'subpanel';
  br.innerHTML =
    '<div class="card no-print"><h3>Bank Reconciliation</h3>' +
    '<p style="font-size:12.5px;color:var(--text-muted);">Every payment sent to the bank (bulk bills shown beneficiary by beneficiary). <b>Net Amount</b> is what should have left the bank for that person. ' +
    'Pick the bank account and payment dates, click Load, then search, choose columns and download.</p>' +
    '<div class="row">' +
    '<div class="field"><label>Paid From Bank Account</label><select id="br_account"><option value="">All Accounts</option></select></div>' +
    '<div class="field"><label>Payment Date From</label><input type="date" id="br_from"></div>' +
    '<div class="field"><label>Payment Date To</label><input type="date" id="br_to"></div>' +
    '<div class="field"><label>Payment Status</label><select id="br_status"><option value="">All</option><option>Submitted</option><option>Confirmed</option><option>Failed</option><option>Isolated</option></select></div></div>' +
    '<button class="primary" id="btnBrLoad" onclick="loadBankRec()">Load</button> ' +
    '<button class="secondary" onclick="document.getElementById(\'br_colPicker\').style.display = document.getElementById(\'br_colPicker\').style.display===\'none\'?\'block\':\'none\';">Column Picker</button> ' +
    '<button class="secondary" onclick="downloadBankRecCSV()">Download CSV</button> ' +
    '<button class="secondary" onclick="window.print()">Print</button>' +
    '<div id="br_colPicker" style="display:none;margin-top:10px;"><label>Columns <label style="display:inline;font-weight:normal;"><input type="checkbox" id="br_selectAll" onclick="toggleAll(\'br_columns\', this.checked); renderBankRec();" style="width:auto;"> Select All</label></label>' +
    '<div class="checklist" id="br_columns"></div></div>' +
    '<div class="row" style="margin-top:10px;"><div class="field"><label>Search (anything in the loaded rows)</label><input type="text" id="br_search" oninput="renderBankRec()" placeholder="name, CNIC, IBAN, bill ID, batch, status, amount ..."></div></div></div>' +
    '<div class="card"><div id="br_summary" style="font-size:13px;margin-bottom:8px;"></div><div class="table-wrap"><table id="brTable"><thead><tr id="brHeadRow"></tr></thead>' +
    '<tbody><tr><td style="text-align:center;color:var(--text-muted);">Set filters above and click Load.</td></tr></tbody></table></div></div>';
  panel.appendChild(br);
})();

/* ---------- Recovery Statement ---------- */
let RS_LAST = null;
function rsFlatRows_(){
  const rows = [];
  RS_LAST.records.forEach(function(r){
    const base = { recoveryId:r.recoveryId, status:r.status, sourceBill:r.sourceEntryId, sourceBatch:r.sourceBatch, sourcePaidDate:r.sourcePaidDate,
      sourceNetPaid:r.sourceNetPaid, amountPaidTwice:r.amountPaidTwice, recordRecovered:r.recovered, recordBalance:r.outstanding };
    if (!r.applications.length) rows.push(Object.assign({}, base, { appBill:'', appDate:'', appStatus:'', appGross:'', appNet:'', appAmount:'', counted:'' }));
    r.applications.forEach(function(a){
      rows.push(Object.assign({}, base, { appBill:a.entryId, appDate:a.billDate, appStatus:a.billStatus, appGross:a.billGross, appNet:a.billNetAfterRecovery,
        appAmount:a.amount, counted:a.counted ? 'Yes' : 'No (bill cancelled/deleted)' }));
    });
  });
  return rows;
}
const RS_COLUMNS = [['recoveryId','Record'],['status','Record Status'],['sourceBill','Paid-Twice Bill'],['sourceBatch','Batch'],['sourcePaidDate','Paid Date'],
  ['sourceNetPaid','Net Paid Originally'],['amountPaidTwice','Amount Paid Twice'],['appBill','Recovered From Bill'],['appDate','Bill Date'],['appStatus','Bill Status'],
  ['appGross','Bill Gross'],['appNet','Bill Net After Recovery'],['appAmount','Amount Recovered'],['counted','Counted'],['recordRecovered','Record Recovered So Far'],['recordBalance','Record Balance']];
async function loadRecoveryStatement(){
  const key = document.getElementById('rs_key').value.trim();
  if (!key){ toast('Enter an Employee ID.', 'error'); return; }
  const res = await runAction(document.getElementById('btnRsGo'), 'Building statement...', null, () => gs('getRecoveryStatement', key, CURRENT_USER.username));
  const wrap = document.getElementById('rs_result');
  if (!res || res.success === false){
    wrap.innerHTML = '<p class="error">' + escHtml_((res && res.message) || 'Could not build the statement.') + '</p>';
    document.getElementById('btnRsCsv').style.display = 'none'; document.getElementById('btnRsPdf').style.display = 'none';
    RS_LAST = null; return;
  }
  RS_LAST = res;
  const t = res.totals;
  let html = '<div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px;">' +
    '<div style="font-weight:700;color:var(--accent);margin-bottom:8px;font-size:15px;">' + escHtml_(res.name) + (res.designation ? ' - ' + escHtml_(res.designation) : '') + ' (' + escHtml_(res.key) + ')</div>' +
    '<div class="row" style="gap:24px;">' +
    '<div><span style="color:var(--text-muted);">Total Paid Twice</span><br><b>' + num(t.paidTwice) + '</b></div>' +
    '<div><span style="color:var(--text-muted);">Recovered So Far</span><br><b style="color:var(--accent);">' + num(t.recovered) + '</b></div>' +
    '<div><span style="color:var(--text-muted);">Balance Still To Recover</span><br><b style="color:' + (t.outstanding > 0 ? 'var(--danger)' : 'var(--accent)') + ';">' + num(t.outstanding) + '</b></div></div></div>';
  res.records.forEach(function(r){
    const rows = r.applications.map(function(a){
      return '<tr' + (a.counted ? '' : ' style="opacity:0.55;"') + '><td>' + billIdLink(a.entryId) + '</td><td>' + escHtml_(a.billDate) + '</td><td>' + escHtml_(a.nature) + '</td>' +
        '<td class="num">' + num(a.billGross) + '</td><td class="num">' + num(a.billNetAfterRecovery) + '</td><td class="num">' + num(a.amount) + '</td>' +
        '<td>' + escHtml_(a.billStatus) + (a.counted ? '' : ' - not counted') + '</td></tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">Nothing recovered yet.</td></tr>';
    html += '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;">' +
      '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;"><div><b>' + escHtml_(r.recoveryId) + '</b> - paid twice on bill ' + billIdLink(r.sourceEntryId) +
      (r.sourceBatch ? ' (batch ' + escHtml_(r.sourceBatch) + ')' : '') + (r.sourcePaidDate ? ', paid ' + escHtml_(r.sourcePaidDate) : '') + '</div>' +
      '<div><b>' + escHtml_(r.status) + '</b></div></div>' +
      '<div style="font-size:12.5px;color:var(--text-muted);margin:4px 0;">Net originally paid: ' + num(r.sourceNetPaid) + ' &nbsp;|&nbsp; Paid twice: <b>' + num(r.amountPaidTwice) + '</b> &nbsp;|&nbsp; Recovered: <b>' + num(r.recovered) +
      '</b> &nbsp;|&nbsp; Balance: <b>' + num(r.outstanding) + '</b>' + (r.notes ? ' &nbsp;|&nbsp; Notes: ' + escHtml_(r.notes) : '') +
      (r.cancelReason ? ' &nbsp;|&nbsp; Cancelled: ' + escHtml_(r.cancelReason) : '') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Recovered From Bill</th><th>Bill Date</th><th>Nature</th><th class="num">Bill Gross</th><th class="num">Bill Net After Recovery</th><th class="num">Amount Recovered</th><th>Bill Status</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  });
  wrap.innerHTML = html;
  document.getElementById('btnRsCsv').style.display = ''; document.getElementById('btnRsPdf').style.display = '';
}
function downloadRecoveryStatementCSV(){
  if (!RS_LAST){ toast('Generate the statement first.', 'error'); return; }
  exportArrayToCSV(rsFlatRows_(), RS_COLUMNS, 'Recovery_Statement_' + RS_LAST.key.replace(/[^\w-]/g, '_') + '.csv');
}
function downloadRecoveryStatementPDF(){
  if (!RS_LAST){ toast('Generate the statement first.', 'error'); return; }
  const res = RS_LAST, t = res.totals;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'landscape', unit:'pt', format:'a4' });
  doc.setFont('helvetica','bold'); doc.setFontSize(14);
  doc.text('Duplicate-Payment Recovery Statement', 30, 30);
  doc.setFont('helvetica','normal'); doc.setFontSize(10);
  doc.text(res.name + (res.designation ? ' - ' + res.designation : '') + ' (' + res.key + ')', 30, 46);
  doc.text('Total Paid Twice: ' + num(t.paidTwice) + '   |   Recovered So Far: ' + num(t.recovered) + '   |   Balance Still To Recover: ' + num(t.outstanding), 30, 62);
  const money = { sourceNetPaid:1, amountPaidTwice:1, appGross:1, appNet:1, appAmount:1, recordRecovered:1, recordBalance:1 };
  const body = rsFlatRows_().map(r => RS_COLUMNS.map(c => (money[c[0]] && r[c[0]] !== '') ? num(r[c[0]]) : r[c[0]]));
  const cs = {};
  RS_COLUMNS.forEach((c, i) => { if (money[c[0]]) cs[i] = { halign:'right' }; });
  doc.autoTable({ head:[RS_COLUMNS.map(c => c[1])], body: body, startY: 76, styles:{ fontSize:7, cellPadding:2, overflow:'linebreak' },
    headStyles:{ fillColor:[28,61,90], textColor:255 }, columnStyles: cs, margin:{ left:20, right:20 } });
  doc.save('Recovery_Statement_' + res.key.replace(/[^\w-]/g, '_') + '.pdf');
}

/* ---------- Bank Reconciliation ---------- */
// [key, label, visibleByDefault, isAmount]
const BR_COLUMNS = [
  ['paymentDate','Payment Date',true,false],['batchId','Batch',true,false],['billId','Bill / Line ID',true,false],
  ['payFromAccount','Paid From Account',true,false],['accountNo','Account No.',false,false],
  ['beneficiary','Beneficiary',true,false],['employeeId','Employee ID',false,false],['cnicNtn','CNIC / NTN',false,false],['iban','IBAN',true,false],['bankShortName','Bank Code',false,false],
  ['billNature','Bill Nature',false,false],['description','Description',false,false],['fy','FY',false,false],['campus','Campus',false,false],
  ['gross','Gross Amount',false,true],['incomeTax','Income Tax',false,true],['salesTax','Sales Tax',false,true],['pst','Punjab Sales Tax',false,true],
  ['security','Security',false,true],['penalty','Penalty',false,true],['otherDeduction','Other Deduction',false,true],['recovery','Duplicate-Payment Recovery',false,true],
  ['net','Net Amount',true,true],['paymentStatus','Payment Status',true,false],['confirmedDate','Confirmed Date',false,false],['failureReason','Failure Reason',false,false],
  ['inBankFile','In Bank File',false,false],['billStatus','Bill Status',false,false],['notes','Notes',false,false]
];
let BR_ROWS = [];
let BR_INIT_DONE = false;
function initBankRec_(){
  if (!BR_INIT_DONE){
    BR_INIT_DONE = true;
    document.getElementById('br_columns').innerHTML = BR_COLUMNS.map(function(c){
      return '<label><input type="checkbox" class="brcol" value="' + c[0] + '" ' + (c[2] ? 'checked' : '') + ' onchange="renderBankRec()"> ' + c[1] + '</label>';
    }).join('');
  }
  gs('getBankAccounts').then(function(list){
    const sel = document.getElementById('br_account');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All Accounts</option>' + (list || []).map(function(a){
      return '<option value="' + escHtml_(a.AccountID) + '">' + escHtml_(a.AccountTitle + ' - ' + a.BankName + (a.AccountNumber ? ' (' + a.AccountNumber + ')' : '')) + '</option>';
    }).join('');
    sel.value = cur;
  }).catch(function(){});
}
async function loadBankRec(){
  const filters = { accountId: document.getElementById('br_account').value, fromDate: document.getElementById('br_from').value,
    toDate: document.getElementById('br_to').value, paymentStatus: document.getElementById('br_status').value };
  const res = await runAction(document.getElementById('btnBrLoad'), 'Loading payments...', null, () => gs('getBankReconciliationReport', filters, CURRENT_USER.username));
  if (!res || res.success === false) return;
  BR_ROWS = res.rows || [];
  document.getElementById('br_search').value = '';
  if (res.truncated) toast('Showing the first 20,000 of ' + res.totalMatched + ' payments - narrow the dates.', 'error');
  renderBankRec();
}
function brVisibleRows_(){
  const q = document.getElementById('br_search').value.trim().toLowerCase();
  if (!q) return BR_ROWS;
  return BR_ROWS.filter(function(r){
    return Object.keys(r).some(function(k){ return String(r[k] === null || r[k] === undefined ? '' : r[k]).toLowerCase().indexOf(q) !== -1; });
  });
}
function brSelectedCols_(){
  return BR_COLUMNS.filter(function(c){ const el = document.querySelector('.brcol[value="' + c[0] + '"]'); return el && el.checked; });
}
function renderBankRec(){
  if (!document.getElementById('br_columns').innerHTML) initBankRec_();
  const cols = brSelectedCols_();
  const rows = brVisibleRows_();
  document.getElementById('brHeadRow').innerHTML = cols.map(function(c){ return '<th' + (c[3] ? ' class="num"' : '') + '>' + c[1] + '</th>'; }).join('');
  document.querySelector('#brTable tbody').innerHTML = rows.map(function(r){
    return '<tr>' + cols.map(function(c){
      const v = r[c[0]];
      if (c[3]) return '<td class="num">' + num(v) + '</td>';
      if (c[0] === 'billId') return '<td>' + billIdLink(String(v)) + '</td>';
      return '<td>' + escHtml_(v) + '</td>';
    }).join('') + '</tr>';
  }).join('') || '<tr><td colspan="' + Math.max(cols.length, 1) + '" style="text-align:center;color:var(--text-muted);">No payments match.</td></tr>';
  const sum = function(pred){ return rows.filter(pred).reduce(function(s, r){ return s + Number(r.net || 0); }, 0); };
  document.getElementById('br_summary').innerHTML = '<b>' + rows.length + '</b> payment(s) shown' + (rows.length !== BR_ROWS.length ? ' of ' + BR_ROWS.length + ' loaded' : '') +
    ' &nbsp;|&nbsp; Total Net Amount: <b>' + num(sum(function(){ return true; })) + '</b>' +
    ' &nbsp;|&nbsp; Confirmed: <b>' + num(sum(function(r){ return r.paymentStatus === 'Confirmed'; })) + '</b>' +
    ' &nbsp;|&nbsp; Submitted (not yet confirmed): <b>' + num(sum(function(r){ return r.paymentStatus === 'Submitted'; })) + '</b>' +
    ' &nbsp;|&nbsp; Failed / Isolated: <b>' + num(sum(function(r){ return r.paymentStatus === 'Failed' || r.paymentStatus === 'Isolated'; })) + '</b>';
}
function downloadBankRecCSV(){
  const rows = brVisibleRows_();
  if (!rows.length){ toast('Load the report first.', 'error'); return; }
  const cols = brSelectedCols_();
  if (!cols.length){ toast('Choose at least one column.', 'error'); return; }
  exportArrayToCSV(rows, cols.map(function(c){ return [c[0], c[1]]; }), 'Bank_Reconciliation.csv');
}

/* ---- IBFT: tell the user when zero-net beneficiaries were left out of the bank file ---- */
(function installZeroNetNotice_(){
  const prev = window.gs;
  window.gs = function(fnName){
    const p = prev.apply(this, arguments);
    if (fnName === 'markPaidAndGenerateIBFT') p.then(function(res){
      if (res && res.success && res.zeroNetSkipped > 0) toast(res.zeroNetSkipped + ' beneficiary line(s) had a net of 0 (fully recovered) and were left out of the bank file.', 'success');
    }).catch(function(){});
    return p;
  };
})();

/* =================================================================
   DIARY TAB: sub-pages, layout, required-field marks
   ================================================================= */
(function installDiaryStyles_(){
  const st = document.createElement('style');
  st.textContent =
    '.dysub{display:none}.dysub.active{display:block}' +
    '#tab-diary{max-width:100%}' +
    '#pendingDiaryTable{font-size:11.5px;width:100%}' +
    '#pendingDiaryTable th,#pendingDiaryTable td{padding:2px 6px;white-space:normal;line-height:1.25;vertical-align:top}' +
    '#pendingDiaryTable td.nowrap{white-space:nowrap}' +
    '#pendingDiaryTable th{font-size:10px}';
  document.head.appendChild(st);
  // All Diary log fields are mandatory (letter attachment excepted) - mark them.
  ['dy_date','dy_senderDate','dy_senderType','dy_vendorName','dy_employeeId','dy_nonueName','dy_nonueCnic','dy_senderOfficeName',
   'dy_senderRef','dy_originatingOffice','dy_originatingOther','dy_desc','dy_assignee'].forEach(function(id){
    const el = document.getElementById(id);
    const lab = el && el.closest('.field') && el.closest('.field').querySelector('label');
    if (lab && lab.textContent.indexOf('*') === -1) lab.textContent = lab.textContent + ' *';
  });
  const t = document.getElementById('dy_senderDate');
  if (t) t.removeAttribute('title');
})();

function showDiarySub(name){
  document.querySelectorAll('#tab-diary .dysub').forEach(function(p){ p.classList.toggle('active', p.id === 'dysub-' + name); });
  document.querySelectorAll('#dy_subnav .sub-btn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-sub') === name); });
  if (name === 'held' || name === 'sent') { if (typeof loadHeldItems === 'function') loadHeldItems(); }
  if (name === 'myqueue') loadMyDiaryQueue();
  if (name === 'mypos') loadMyDiaryStageSummary();
  if (name === 'pending') { buildPendingColumnPicker_(); renderPendingTable(); }
  setTimeout(function(){ if (typeof refreshStickyScrollbars === 'function') refreshStickyScrollbars(); }, 200);
}
function initDiarySubtabs_(){
  const nav = document.getElementById('dy_subnav');
  if (!nav || !CURRENT_USER) return;
  const role = CURRENT_USER.role;
  const isClerk = (role === 'DiaryClerk' || role === 'Admin');
  const isUser = (role !== 'DiaryClerk');
  const items = [];
  if (isClerk) items.push(['log','Log New Bill / Letter'], ['pending','Pending Diary Items'], ['held','Returned / On Hold'], ['sent','Sent to Other Offices']);
  if (isUser) items.push(['mypos','My Diary Position'], ['myqueue','My Diary Queue']);
  nav.innerHTML = items.map(function(i){ return '<button class="sub-btn" data-sub="' + i[0] + '" onclick="showDiarySub(\'' + i[0] + '\')">' + i[1] + '</button>'; }).join('');
  if (items.length) showDiarySub(items[0][0]);
}
(function installDiaryHooks_(){
  const prevEnter = window.enterApp;
  window.enterApp = function(){ prevEnter.apply(this, arguments); initDiarySubtabs_(); };
  const prevShow = window.showTab;
  window.showTab = function(name){
    prevShow.apply(this, arguments);
    if (name === 'diary'){
      const nav = document.getElementById('dy_subnav');
      if (nav && !nav.children.length) initDiarySubtabs_();
      setTimeout(function(){ if (typeof refreshStickyScrollbars === 'function') refreshStickyScrollbars(); }, 200);
    }
  };
})();

/* =================================================================
   ADMIN: Diary numbers - edit / cancel / restore / de-link / link
   ================================================================= */
(function installDiaryAdminCard_(){
  const panel = document.getElementById('tab-admin');
  if (!panel || document.getElementById('adm-diarytools')) return;
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'adm-diarytools';
  card.innerHTML =
    '<h3>Diary Numbers: Edit / Cancel / De-link / Link</h3>' +
    '<p style="font-size:12.5px;color:var(--text-muted);">Complete or correct a bill\'s cycle. <b>Edit</b> corrects a Diary entry\'s details. <b>Cancel</b> withdraws a Diary number that was logged by mistake (Restore reverses it). ' +
    '<b>De-link</b> detaches a Diary number from the bill it was attached to (the Diary item goes back to Pending). <b>Link</b> attaches a Pending Bill-type Diary number to an existing bill ' +
    '(a single bill carries one Diary number; a bulk bill can carry several). Every action needs a reason and is kept in the Diary trail.</p>' +
    '<div class="row">' +
    '<div class="field" style="max-width:170px;"><label>Diary No. contains</label><input type="text" id="ad_id"></div>' +
    '<div class="field" style="max-width:170px;"><label>Linked Bill ID contains</label><input type="text" id="ad_bill"></div>' +
    '<div class="field"><label>Sender / Description / Employee ID / Ref. contains</label><input type="text" id="ad_q"></div>' +
    '<div class="field" style="max-width:170px;"><label>Status</label><select id="ad_status"><option value="">All</option><option>Pending</option><option>Entered</option><option>Returned</option><option>Closed</option><option>Cancelled</option></select></div>' +
    '<div class="field" style="align-self:flex-end;"><button class="primary" id="btnAdLoad" onclick="loadAdminDiary()">Load</button></div></div>' +
    '<div id="ad_count" style="font-size:12px;color:var(--text-muted);"></div>' +
    '<div class="table-wrap" style="margin-top:8px;"><table id="adminDiaryTable"><thead><tr><th>Diary No.</th><th>Type</th><th>Date Received</th><th>Sender</th><th>Description</th><th class="num">Amount</th><th>Assigned To</th><th>Status</th><th>Linked Bill</th><th></th></tr></thead>' +
    '<tbody><tr><td colspan="10" style="text-align:center;color:var(--text-muted);">Set filters above and click Load.</td></tr></tbody></table></div>';
  panel.appendChild(card);
  const grp = document.querySelector('#adminQuickNav optgroup[label="Bill Management"]');
  if (grp){ const o = document.createElement('option'); o.value = 'adm-diarytools'; o.textContent = 'Diary Numbers: Edit / Cancel / De-link / Link'; grp.appendChild(o); }

  const modal = document.createElement('div');
  modal.id = 'adEditModal';
  modal.style.cssText = 'display:none; position:fixed; inset:0; background:#0007; align-items:center; justify-content:center; z-index:107; padding:16px;';
  modal.innerHTML =
    '<div class="card" style="background:var(--navy-light); max-width:760px; width:100%; margin:0; max-height:92vh; overflow-y:auto;">' +
    '<h3 style="margin-top:0;">Edit Diary Entry <span id="ae_id" style="color:var(--accent);"></span></h3>' +
    '<div class="row"><div class="field"><label>Date Received *</label><input type="date" id="ae_date"></div>' +
    '<div class="field"><label>Sender\'s Diary / Letter Date</label><input type="date" id="ae_senderDate"></div>' +
    '<div class="field"><label>Reference / Diary No. of the Sender</label><input type="text" id="ae_ref"></div></div>' +
    '<div class="row"><div class="field"><label>Sender Is</label><select id="ae_senderType" onchange="onAdEditSenderType()"><option value="Vendor">Vendor</option><option value="Employee">UE Employee</option><option value="NonUEEmployee">Non-UE Employee</option><option value="Office">Another Office</option></select></div>' +
    '<div class="field" id="ae_vendorWrap"><label>Vendor / Name *</label><input type="text" id="ae_vendor"></div>' +
    '<div class="field" id="ae_empWrap"><label>Employee ID *</label><input type="text" id="ae_emp"></div>' +
    '<div class="field" id="ae_cnicWrap"><label>CNIC *</label><input type="text" id="ae_cnic"></div>' +
    '<div class="field" id="ae_officeNameWrap"><label>Sender Office Name *</label><input type="text" id="ae_senderOffice"></div></div>' +
    '<div class="row"><div class="field"><label>Originating Office *</label><select id="ae_office" onchange="onAdEditOffice()"></select></div>' +
    '<div class="field" id="ae_officeOtherWrap" style="display:none;"><label>Originating Office Name *</label><input type="text" id="ae_officeOther"></div></div>' +
    '<div class="row"><div class="field"><label>Description</label><input type="text" id="ae_desc"></div>' +
    '<div class="field" id="ae_amountWrap"><label>Amount (Gross) *</label><input type="number" id="ae_amount" min="1"></div>' +
    '<div class="field" id="ae_billTypeWrap"><label>Bill Type *</label><select id="ae_billType"><option value="Single">Single bill</option><option value="Bulk">Bulk bill</option></select></div></div>' +
    '<div style="display:flex; gap:10px; margin-top:10px;"><button class="primary" style="flex:1;" onclick="saveAdminDiaryEdit()">Save Changes</button>' +
    '<button class="secondary" style="flex:1;" onclick="document.getElementById(\'adEditModal\').style.display=\'none\'">Cancel</button></div></div>';
  document.body.appendChild(modal);
})();

let AD_ROWS = [];
let AD_EDIT_ID = '';
async function loadAdminDiary(){
  const filters = { diaryId: document.getElementById('ad_id').value.trim(), billId: document.getElementById('ad_bill').value.trim(),
    query: document.getElementById('ad_q').value.trim(), status: document.getElementById('ad_status').value };
  const res = await runAction(document.getElementById('btnAdLoad'), 'Loading...', null, () => gs('adminSearchDiary', filters, CURRENT_USER.username));
  if (!res || res.success === false) return;
  AD_ROWS = res.rows || [];
  document.getElementById('ad_count').textContent = AD_ROWS.length + ' shown' + (res.total > AD_ROWS.length ? ' of ' + res.total + ' (narrow the filters to see the rest)' : '') + '.';
  document.querySelector('#adminDiaryTable tbody').innerHTML = AD_ROWS.map(function(r, i){
    const btns = [];
    btns.push('<button class="secondary" style="padding:1px 7px;font-size:11px;min-height:0;" onclick="openAdminDiaryEdit(' + i + ')">Edit</button>');
    if (r.status === 'Cancelled') btns.push('<button class="secondary" style="padding:1px 7px;font-size:11px;min-height:0;" onclick="adminDiaryRestore(' + i + ')">Restore</button>');
    else if (!r.linkedEntryId && r.status !== 'Closed') btns.push('<button class="secondary" style="padding:1px 7px;font-size:11px;min-height:0;color:var(--danger);" onclick="adminDiaryCancel(' + i + ')">Cancel</button>');
    if (r.linkedEntryId) btns.push('<button class="secondary" style="padding:1px 7px;font-size:11px;min-height:0;" onclick="adminDiaryDelink(' + i + ')">De-link</button>');
    else if (r.itemType === 'Bill' && r.status === 'Pending') btns.push('<button class="secondary" style="padding:1px 7px;font-size:11px;min-height:0;" onclick="adminDiaryLink(' + i + ')">Link to Bill</button>');
    return '<tr><td>' + diaryIdLink(r.diaryId) + '</td><td>' + diaryTypeLabel({ itemType: r.itemType, billType: r.billType }) + '</td><td>' + fmtDate(r.dateReceived) + '</td><td>' + escHtml_(r.senderLabel) +
      '</td><td style="white-space:normal;min-width:160px;">' + escHtml_(r.description) + '</td><td class="num">' + (r.amount != null ? num(r.amount) : '') + '</td><td>' + escHtml_(r.assignedTo) +
      '</td><td>' + escHtml_(r.status) + '</td><td>' + (r.linkedEntryId ? billIdLink(r.linkedEntryId) : '-') + '</td><td style="white-space:nowrap;">' + btns.join(' ') + '</td></tr>';
  }).join('') || emptyRow(10);
}
function onAdEditSenderType(){
  const t = document.getElementById('ae_senderType').value;
  document.getElementById('ae_vendorWrap').style.display = (t === 'Vendor' || t === 'NonUEEmployee') ? '' : 'none';
  document.getElementById('ae_empWrap').style.display = t === 'Employee' ? '' : 'none';
  document.getElementById('ae_cnicWrap').style.display = t === 'NonUEEmployee' ? '' : 'none';
  document.getElementById('ae_officeNameWrap').style.display = t === 'Office' ? '' : 'none';
}
function onAdEditOffice(){ document.getElementById('ae_officeOtherWrap').style.display = document.getElementById('ae_office').value === '__others__' ? '' : 'none'; }
async function openAdminDiaryEdit(i){
  const r = AD_ROWS[i];
  AD_EDIT_ID = r.diaryId;
  document.getElementById('ae_id').textContent = r.diaryId;
  const offices = await gs('getReceivingOffices').catch(function(){ return []; });
  document.getElementById('ae_office').innerHTML = '<option value="">-- select --</option>' + offices.map(function(o){ return '<option value="' + escHtml_(o.OfficeID) + '">' + escHtml_(o.OfficeName) + '</option>'; }).join('') + '<option value="__others__">Others (type name)</option>';
  document.getElementById('ae_office').value = r.originatingOfficeId || (r.originatingOfficeOther ? '__others__' : '');
  document.getElementById('ae_officeOther').value = r.originatingOfficeOther || '';
  onAdEditOffice();
  document.getElementById('ae_date').value = r.dateReceived || '';
  document.getElementById('ae_senderDate').value = r.senderReferenceDate || '';
  document.getElementById('ae_ref').value = r.senderReferenceNo || '';
  document.getElementById('ae_senderType').value = r.senderType || 'Vendor';
  document.getElementById('ae_vendor').value = r.vendorName || '';
  document.getElementById('ae_emp').value = r.employeeId || '';
  document.getElementById('ae_cnic').value = r.cnic || '';
  document.getElementById('ae_senderOffice').value = r.senderOfficeName || '';
  document.getElementById('ae_desc').value = r.description || '';
  document.getElementById('ae_amount').value = r.amount != null ? r.amount : '';
  document.getElementById('ae_billType').value = r.billType || 'Single';
  const isBill = r.itemType === 'Bill';
  document.getElementById('ae_amountWrap').style.display = isBill ? '' : 'none';
  document.getElementById('ae_billTypeWrap').style.display = isBill ? '' : 'none';
  onAdEditSenderType();
  document.getElementById('adEditModal').style.display = 'flex';
}
async function saveAdminDiaryEdit(){
  const g = function(id){ return document.getElementById(id).value; };
  const upd = { dateReceived: g('ae_date'), senderReferenceDate: g('ae_senderDate'), senderReferenceNo: g('ae_ref'), senderType: g('ae_senderType'),
    vendorName: g('ae_vendor'), employeeId: g('ae_emp'), cnic: g('ae_cnic'), senderOfficeName: g('ae_senderOffice'),
    originatingOfficeId: g('ae_office'), originatingOfficeOther: g('ae_officeOther'), roughDescription: g('ae_desc'), amount: g('ae_amount'), billType: g('ae_billType') };
  const res = await runAction(null, 'Saving...', 'Diary entry updated.', () => gs('adminUpdateDiary', AD_EDIT_ID, upd, CURRENT_USER.username));
  if (res && res.success){ document.getElementById('adEditModal').style.display = 'none'; loadAdminDiary(); }
}
async function adminDiaryCancel(i){
  const r = AD_ROWS[i];
  const reason = prompt('Cancel Diary number ' + r.diaryId + '? It will no longer appear in any queue or be enterable as a bill.\n\nReason (kept on the trail):');
  if (reason === null) return;
  const res = await runAction(null, 'Cancelling...', 'Diary number cancelled.', () => gs('adminCancelDiary', r.diaryId, reason, CURRENT_USER.username));
  if (res && res.success){ loadAdminDiary(); refreshBadges(); }
}
async function adminDiaryRestore(i){
  const r = AD_ROWS[i];
  const reason = prompt('Restore Diary number ' + r.diaryId + ' to Pending?\n\nReason (optional):');
  if (reason === null) return;
  const res = await runAction(null, 'Restoring...', 'Diary number restored to Pending.', () => gs('adminRestoreDiary', r.diaryId, reason, CURRENT_USER.username));
  if (res && res.success){ loadAdminDiary(); refreshBadges(); }
}
async function adminDiaryDelink(i){
  const r = AD_ROWS[i];
  const reason = prompt('De-link ' + r.diaryId + ' from Bill ' + r.linkedEntryId + '? The Diary item returns to Pending (the bill itself is not changed).\n\nReason (kept on the trail):');
  if (reason === null) return;
  const res = await runAction(null, 'De-linking...', 'De-linked - the Diary number is Pending again.', () => gs('adminDelinkDiary', r.diaryId, reason, CURRENT_USER.username));
  if (res && res.success){ loadAdminDiary(); refreshBadges(); }
}
async function adminDiaryLink(i){
  const r = AD_ROWS[i];
  const billId = prompt('Link ' + r.diaryId + ' to which Bill ID? (e.g. E1042)');
  if (billId === null || !billId.trim()) return;
  const reason = prompt('Reason for linking ' + r.diaryId + ' to ' + billId.trim() + ' (kept on the trail):');
  if (reason === null) return;
  const res = await runAction(null, 'Linking...', null, () => gs('adminLinkDiaryToBill', r.diaryId, billId.trim(), reason, CURRENT_USER.username));
  if (res && res.success){
    toast('Linked to Bill ' + billId.trim().toUpperCase() + '.', 'success');
    if (res.warnings && res.warnings.length) alert('Linked, with a warning (not a block):\n- ' + res.warnings.join('\n- '));
    loadAdminDiary(); refreshBadges();
  }
}

/* =================================================================
   REPORTS: Bill Cycle Report
   ================================================================= */
(function installBillCycleReport_(){
  const nav = document.querySelector('#tab-reports nav.subtabs');
  const panel = document.getElementById('tab-reports');
  if (!nav || !panel || document.getElementById('sub-rep15')) return;
  const btn = document.createElement('button');
  btn.className = 'sub-btn'; btn.textContent = 'Bill Cycle Report';
  btn.setAttribute('onclick', "showSubTab('rep15', event)");
  nav.appendChild(btn);
  const p = document.createElement('div');
  p.id = 'sub-rep15'; p.className = 'subpanel';
  p.innerHTML =
    '<div class="card no-print"><h3>Bill Cycle Report</h3>' +
    '<p style="font-size:12.5px;color:var(--text-muted);">From the day a bill was received to its final disposal: every stage with dates in/out and days spent, and the action log showing who did what. ' +
    'Enter a Bill ID (e.g. E1042) or a Diary Number (e.g. DN-2026-00017).</p>' +
    '<div class="row"><div class="field"><label>Bill ID / Diary Number</label><input type="text" id="bc_id"></div>' +
    '<div class="field" style="align-self:flex-end;"><button class="primary" id="btnBcGo" onclick="loadBillCycle()">Generate</button> ' +
    '<button class="secondary" id="btnBcCsv" onclick="downloadBillCycleCSV()" style="display:none;">Download CSV</button> ' +
    '<button class="secondary" id="btnBcPdf" onclick="downloadBillCyclePDF()" style="display:none;">Download PDF</button> ' +
    '<button class="secondary" onclick="window.print()">Print</button></div></div></div>' +
    '<div class="card"><div id="bc_result"></div></div>';
  panel.appendChild(p);
})();

let BC_LAST = null;
async function loadBillCycle(){
  const id = document.getElementById('bc_id').value.trim();
  if (!id){ toast('Enter a Bill ID or Diary Number.', 'error'); return; }
  const res = await runAction(document.getElementById('btnBcGo'), 'Building report...', null, () => gs('getBillCycleReport', id, CURRENT_USER.username));
  const wrap = document.getElementById('bc_result');
  if (!res || res.success === false){
    wrap.innerHTML = '<p class="error">' + escHtml_((res && res.message) || 'Could not build the report.') + '</p>';
    document.getElementById('btnBcCsv').style.display = 'none'; document.getElementById('btnBcPdf').style.display = 'none';
    BC_LAST = null; return;
  }
  BC_LAST = res;
  const h = res.header, s = res.summary;
  const kv = function(l, v){ return (v === '' || v === null || v === undefined) ? '' : '<div style="min-width:180px;"><span style="color:var(--text-muted);font-size:11.5px;">' + l + '</span><br><b>' + escHtml_(v) + '</b></div>'; };
  let html = '<div style="text-align:center;font-weight:800;font-size:15px;">UNIVERSITY OF EDUCATION, LAHORE</div>' +
    '<div style="text-align:center;margin-bottom:12px;">Bill Cycle Report - ' + escHtml_(h.billId) + '</div>' +
    '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;"><div class="row" style="gap:18px;">' +
    kv('Payee / Beneficiary', h.payee) + kv('Description', h.description) + kv('Nature', h.nature) + kv('Campus', h.campus) + kv('Budget Head', h.head) + kv('Financial Year', h.fy) +
    kv('Bill / Invoice No.', h.billNo) + kv('Gross Amount', h.gross ? num(h.gross) : '') + kv('Net Amount', h.net ? num(h.net) : '') + kv('IBFT Batch', h.batchId) + kv('Current Status', h.status) + '</div>' +
    (h.note ? '<div style="margin-top:6px;color:var(--amber);font-size:12.5px;">' + escHtml_(h.note) + '</div>' : '') + '</div>' +
    '<div style="border:1px solid var(--accent);border-radius:8px;padding:12px;margin-bottom:12px;"><div class="row" style="gap:18px;">' +
    kv('Date Received', s.receivedDate) + kv('Final Disposal', s.finalStatus) + kv('Final Date', s.finalDate) + kv('Total Days', s.totalDays !== null ? String(s.totalDays) : '') +
    kv('Days Returned / On Hold', String(s.holdDays) + (s.holdOpen ? ' (still on hold)' : '')) + kv('Current Stage', s.currentStage) + '</div></div>';
  if (h.diaryNumbers && h.diaryNumbers.length){
    html += '<h4 style="margin:10px 0 6px;">Diary Number(s)</h4><div class="table-wrap"><table><thead><tr><th>Diary No.</th><th>Date Received</th><th>Sender</th><th>Sender\'s Ref.</th><th>Originating Office</th><th>Assigned To</th></tr></thead><tbody>' +
      h.diaryNumbers.map(function(d){ return '<tr><td>' + diaryIdLink(d.diaryId) + '</td><td>' + escHtml_(d.dateReceived) + '</td><td>' + escHtml_(d.sender) + '</td><td>' + escHtml_(d.senderRef) + '</td><td>' + escHtml_(d.office) + '</td><td>' + escHtml_(d.assignedTo) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  html += '<h4 style="margin:14px 0 6px;">Stages</h4><div class="table-wrap"><table id="bcStagesTable"><thead><tr><th>#</th><th>Stage</th><th>Action Taken By</th><th>Date In</th><th>Date Out</th><th class="num">Days at Stage</th><th>Status</th><th>Detail</th></tr></thead><tbody>' +
    res.stages.map(function(g){ return '<tr><td>' + g.no + '</td><td>' + escHtml_(g.stage) + '</td><td style="white-space:normal;">' + escHtml_(g.actionBy) + '</td><td>' + escHtml_(g.dateIn) + '</td><td>' + escHtml_(g.dateOut) +
      '</td><td class="num">' + (g.days !== null && g.days !== undefined ? g.days : '') + '</td><td>' + escHtml_(g.status) + '</td><td style="white-space:normal;">' + escHtml_(g.detail) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
    '<h4 style="margin:14px 0 6px;">Action Log</h4><div class="table-wrap"><table id="bcActionsTable"><thead><tr><th>#</th><th>Date &amp; Time</th><th>Action</th><th>Done By</th><th>Detail</th></tr></thead><tbody>' +
    (res.actions.map(function(a){ return '<tr><td>' + a.no + '</td><td style="white-space:nowrap;">' + escHtml_(a.when) + '</td><td style="white-space:normal;">' + escHtml_(a.action) + '</td><td>' + escHtml_(a.by) + '</td><td style="white-space:normal;">' + escHtml_(a.detail) + '</td></tr>'; }).join('') || emptyRow(5)) + '</tbody></table></div>' +
    '<div style="font-size:11.5px;color:var(--text-muted);margin-top:8px;">Days are calendar days between the dates shown (0 = same day). Generated ' + escHtml_(s.generatedAt) + ' by ' + escHtml_(CURRENT_USER.username) + '.</div>';
  wrap.innerHTML = html;
  document.getElementById('btnBcCsv').style.display = ''; document.getElementById('btnBcPdf').style.display = '';
}
function downloadBillCycleCSV(){
  if (!BC_LAST){ toast('Generate the report first.', 'error'); return; }
  const r = BC_LAST, h = r.header, s = r.summary;
  const q = function(v){ return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""').replace(/\s+/g, ' ').trim() + '"'; };
  const line = function(arr){ return arr.map(q).join(','); };
  const L = [];
  L.push(line(['UNIVERSITY OF EDUCATION, LAHORE'])); L.push(line(['BILL CYCLE REPORT', h.billId])); L.push('');
  [['Payee / Beneficiary', h.payee], ['Description', h.description], ['Nature', h.nature], ['Campus', h.campus], ['Budget Head', h.head], ['Financial Year', h.fy],
   ['Gross Amount', h.gross], ['Net Amount', h.net], ['IBFT Batch', h.batchId], ['Current Status', h.status], ['Date Received', s.receivedDate],
   ['Final Disposal', s.finalStatus], ['Final Date', s.finalDate], ['Total Days', s.totalDays], ['Days Returned / On Hold', s.holdDays], ['Current Stage', s.currentStage],
   ['Generated', s.generatedAt + ' by ' + CURRENT_USER.username]].forEach(function(p){ L.push(line(p)); });
  L.push(''); L.push(line(['DIARY NUMBERS']));
  L.push(line(['Diary No.', 'Date Received', 'Sender', "Sender's Ref.", 'Originating Office', 'Assigned To']));
  (h.diaryNumbers || []).forEach(function(d){ L.push(line([d.diaryId, d.dateReceived, d.sender, d.senderRef, d.office, d.assignedTo])); });
  L.push(''); L.push(line(['STAGES']));
  L.push(line(['#', 'Stage', 'Action Taken By', 'Date In', 'Date Out', 'Days at Stage', 'Status', 'Detail']));
  r.stages.forEach(function(g){ L.push(line([g.no, g.stage, g.actionBy, g.dateIn, g.dateOut, g.days, g.status, g.detail])); });
  L.push(''); L.push(line(['ACTION LOG']));
  L.push(line(['#', 'Date & Time', 'Action', 'Done By', 'Detail']));
  r.actions.forEach(function(a){ L.push(line([a.no, a.when, a.action, a.by, a.detail])); });
  const blob = new Blob(['\ufeff' + L.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'Bill_Cycle_' + String(h.billId).replace(/[^\w-]/g, '_') + '.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function downloadBillCyclePDF(){
  if (!BC_LAST){ toast('Generate the report first.', 'error'); return; }
  const r = BC_LAST, h = r.header, s = r.summary;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pw = doc.internal.pageSize.getWidth();
  doc.setFont('times', 'bold'); doc.setFontSize(15);
  doc.text('UNIVERSITY OF EDUCATION, LAHORE', pw / 2, 34, { align: 'center' });
  doc.setFontSize(12); doc.text('BILL CYCLE REPORT', pw / 2, 52, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(h.billId, pw / 2, 66, { align: 'center' });
  const pairs = [['Payee / Beneficiary', h.payee], ['Description', h.description], ['Nature', h.nature], ['Campus', h.campus], ['Budget Head', h.head], ['Financial Year', h.fy],
    ['Gross Amount', h.gross ? num(h.gross) : ''], ['Net Amount', h.net ? num(h.net) : ''], ['IBFT Batch', h.batchId], ['Current Status', h.status],
    ['Date Received', s.receivedDate], ['Final Disposal', s.finalStatus], ['Final Date', s.finalDate], ['Total Days', s.totalDays !== null ? String(s.totalDays) : ''],
    ['Days Returned / On Hold', String(s.holdDays) + (s.holdOpen ? ' (still on hold)' : '')], ['Current Stage', s.currentStage]].filter(function(p){ return p[1] !== '' && p[1] !== null && p[1] !== undefined; });
  const body = [];
  for (let i = 0; i < pairs.length; i += 2) body.push([pairs[i][0], pairs[i][1], pairs[i + 1] ? pairs[i + 1][0] : '', pairs[i + 1] ? pairs[i + 1][1] : '']);
  doc.autoTable({ body: body, startY: 76, theme: 'grid', styles: { fontSize: 8.5, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', fillColor: [239, 241, 244], cellWidth: 110 }, 2: { fontStyle: 'bold', fillColor: [239, 241, 244], cellWidth: 110 } }, margin: { left: 30, right: 30 } });
  let y = doc.lastAutoTable.finalY + 12;
  if (h.diaryNumbers && h.diaryNumbers.length){
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Diary Number(s)', 30, y + 8);
    doc.autoTable({ head: [['Diary No.', 'Date Received', 'Sender', "Sender's Ref.", 'Originating Office', 'Assigned To']],
      body: h.diaryNumbers.map(function(d){ return [d.diaryId, d.dateReceived, d.sender, d.senderRef, d.office, d.assignedTo]; }),
      startY: y + 14, styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: [28, 61, 90], textColor: 255 }, margin: { left: 30, right: 30 } });
    y = doc.lastAutoTable.finalY + 12;
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Stages', 30, y + 8);
  doc.autoTable({ head: [['#', 'Stage', 'Action Taken By', 'Date In', 'Date Out', 'Days', 'Status', 'Detail']],
    body: r.stages.map(function(g){ return [g.no, g.stage, g.actionBy, g.dateIn, g.dateOut, g.days === null || g.days === undefined ? '' : g.days, g.status, g.detail]; }),
    startY: y + 14, styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' }, headStyles: { fillColor: [28, 61, 90], textColor: 255 },
    columnStyles: { 0: { cellWidth: 22 }, 5: { halign: 'right', cellWidth: 34 } }, margin: { left: 30, right: 30 } });
  y = doc.lastAutoTable.finalY + 14;
  if (y > doc.internal.pageSize.getHeight() - 90){ doc.addPage(); y = 40; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Action Log', 30, y + 8);
  doc.autoTable({ head: [['#', 'Date & Time', 'Action', 'Done By', 'Detail']],
    body: r.actions.map(function(a){ return [a.no, a.when, a.action, a.by, a.detail]; }),
    startY: y + 14, styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' }, headStyles: { fillColor: [28, 61, 90], textColor: 255 },
    columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 80 } }, margin: { left: 30, right: 30 } });
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++){
    doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
    const ph = doc.internal.pageSize.getHeight();
    doc.text('Generated ' + s.generatedAt + ' by ' + CURRENT_USER.username + '. Days are calendar days between the dates shown (0 = same day).', 30, ph - 16);
    doc.text('Page ' + i + ' of ' + pages, pw - 30, ph - 16, { align: 'right' });
  }
  doc.save('Bill_Cycle_' + String(h.billId).replace(/[^\w-]/g, '_') + '.pdf');
}


/* =================================================================
   ADMIN > TAX SETTINGS: every Income Tax rate (Supply / Contract / Services) editable
   ================================================================= */
(function installIncomeTaxRatesEditor_(){
  const btn = document.getElementById('btnSaveTaxSettings');
  if (!btn || document.getElementById('itr_container')) return;
  const box = document.createElement('div');
  box.id = 'itr_box';
  box.innerHTML =
    '<h4 style="margin:14px 0 6px;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Income Tax - Section 153 Rates (Supply, Contract, Services)</h4>' +
    '<p style="font-size:11.5px;color:var(--text-muted);margin-top:-2px;">Rate of Gross Amount (%) withheld as Income Tax, for Active/Filer and Inactive/Non-Filer. Changes apply to bills saved from now on; bills already saved keep the figures they were saved with.</p>' +
    '<div id="itr_container"><div style="color:var(--text-muted);font-size:12.5px;">Loading...</div></div>';
  btn.parentNode.insertBefore(box, btn);
})();
const ITR_GROUP_LABELS = { Supply: 'Section 153(1)(a) - Supply / Sale of Goods', Contract: 'Section 153(1)(c) - Execution of Contracts', Service: 'Section 153(1)(b) - Rendering of Services' };
function renderIncomeTaxRatesEditor_(rates){
  const c = document.getElementById('itr_container');
  if (!c || !rates) return;
  const pct = v => (Number(v) * 100).toFixed(2);
  let html = '';
  Object.keys(rates).forEach(function(g){
    html += '<div style="font-weight:700;margin:10px 0 4px;">' + escHtml_(ITR_GROUP_LABELS[g] || g) + '</div><div class="table-wrap"><table><thead><tr><th>Category / Taxpayer</th><th class="num">Active / Filer (%)</th><th class="num">Inactive / Non-Filer (%)</th></tr></thead><tbody>';
    Object.keys(rates[g]).forEach(function(k){
      const r = rates[g][k];
      html += '<tr><td>' + escHtml_(k) + (r.final ? ' <span style="color:var(--amber);font-size:11px;">(Final Tax)</span>' : '') + '</td>' +
        '<td class="num"><input type="number" step="0.01" min="0" max="100" class="itr-in" data-g="' + escHtml_(g) + '" data-k="' + escHtml_(k) + '" data-f="filer" value="' + pct(r.filer) + '" style="width:110px;text-align:right;"></td>' +
        '<td class="num"><input type="number" step="0.01" min="0" max="100" class="itr-in" data-g="' + escHtml_(g) + '" data-k="' + escHtml_(k) + '" data-f="nonFiler" value="' + pct(r.nonFiler) + '" style="width:110px;text-align:right;"></td></tr>';
    });
    html += '</tbody></table></div>';
  });
  c.innerHTML = html;
}
function collectIncomeTaxRates_(){
  const out = {};
  document.querySelectorAll('#itr_container .itr-in').forEach(function(el){
    const g = el.getAttribute('data-g'), k = el.getAttribute('data-k'), f = el.getAttribute('data-f');
    (out[g] || (out[g] = {}))[k] = out[g][k] || {};
    out[g][k][f] = (Number(el.value) || 0) / 100;
  });
  return out;
}
(function installIncomeTaxRatesHook_(){
  const prev = window.gs;
  window.gs = function(fnName){
    const args = Array.prototype.slice.call(arguments, 1);
    if (fnName === 'saveTaxSettings' && args[1] && typeof args[1] === 'object' && document.querySelector('#itr_container .itr-in')) {
      args[1].incomeTaxRates = collectIncomeTaxRates_();
    }
    const p = prev.apply(this, [fnName].concat(args));
    if (fnName === 'getTaxSettings') p.then(function(ts){ if (ts && ts.incomeTaxRates) renderIncomeTaxRatesEditor_(ts.incomeTaxRates); }).catch(function(){});
    if (fnName === 'saveTaxSettings') p.then(function(res){ if (res && res.success) gs('getTaxSettings').catch(function(){}); }).catch(function(){});
    return p;
  };
})();

/* =================================================================
   ADMIN: Move a bill to another cost centre / budget head
   ================================================================= */
(function installTransferCard_(){
  const panel = document.getElementById('tab-admin');
  if (!panel || document.getElementById('adm-transfer')) return;
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'adm-transfer';
  card.innerHTML =
    '<h3>Move a Bill to Another Cost Centre / Budget Head</h3>' +
    '<p style="font-size:12.5px;color:var(--text-muted);">For a bill booked to the wrong campus or budget head - even one already Paid - without cancelling and re-entering it. ' +
    'The bill keeps its ID, status and payment; only its budget booking moves (the target must have an allocation for that head and enough balance). ' +
    'The Budget Control Register keeps the trail: the original booking and a <b>reversal</b> row in the old cost centre, and the booking in the new one. ' +
    'Works for single-head and bulk bills (a bulk bill moves as a whole); a bill split across several heads cannot be moved here.</p>' +
    '<div class="row"><div class="field"><label>Bill ID</label><input type="text" id="tr_billid" placeholder="e.g. E1042"></div>' +
    '<div class="field" style="align-self:flex-end;"><button class="secondary" onclick="loadBillForTransfer()">Load Bill</button></div></div>' +
    '<div id="tr_info" style="display:none;margin:10px 0;padding:12px;border:1px solid var(--border);border-radius:8px;font-size:13px;"></div>' +
    '<div id="tr_form" style="display:none;">' +
      '<div class="row"><div class="field"><label>Move To - Campus</label><select id="tr_campus" onchange="onTransferCampusChange()"></select></div>' +
      '<div class="field"><label>Move To - Budget Head</label><select id="tr_head"><option value="">-- select campus first --</option></select></div></div>' +
      '<div class="field"><label>Reason (kept on the record and shown in the Budget Control Register)</label><input type="text" id="tr_reason" placeholder="e.g. Booked to Main Campus by mistake - belongs to Lahore Campus"></div>' +
      '<button class="secondary" id="btnTrPreview" onclick="previewTransfer()">Preview</button>' +
      '<div id="tr_preview" style="display:none;margin-top:10px;padding:12px;border:1px solid var(--accent);border-radius:8px;font-size:13px;"></div>' +
      '<button class="primary" id="btnTrApply" onclick="applyTransfer()" style="display:none;margin-top:10px;">Confirm - Move This Bill</button>' +
    '</div>';
  panel.appendChild(card);
  const grp = document.querySelector('#adminQuickNav optgroup[label="Bill Management"]');
  if (grp){ const o = document.createElement('option'); o.value = 'adm-transfer'; o.textContent = 'Move a Bill to Another Cost Centre'; grp.appendChild(o); }
})();

let TR_BILL = null;
async function loadBillForTransfer(){
  const id = document.getElementById('tr_billid').value.trim();
  if (!id){ toast('Enter a Bill ID.', 'error'); return; }
  const res = await gs('getBillDetail', id).catch(function(e){ return { success:false, message:e.message }; });
  const info = document.getElementById('tr_info');
  document.getElementById('tr_preview').style.display = 'none';
  document.getElementById('btnTrApply').style.display = 'none';
  if (!res || res.success === false){ toast((res && res.message) || 'Bill not found.', 'error'); return; }
  const b = res.bill;
  info.style.display = 'block';
  const multi = (res.headSplits && res.headSplits.length) || b.HeadCode === '(Multiple)';
  const blocked = b.Status === 'Cancelled' ? 'This bill is cancelled - it is not booked to any budget.'
    : (b.SplitFromEntryID ? 'This is an isolated beneficiary bill - move its parent bulk bill ' + b.SplitFromEntryID + ' instead.'
    : (multi ? 'This bill is split across several budget heads and cannot be moved here.' : ''));
  info.innerHTML = '<div style="display:flex;justify-content:space-between;"><span>Bill</span><b>' + escHtml_(b.EntryID) + ' - ' + escHtml_(b.PayeeType === 'Bulk' ? 'Bulk bill' : b.VendorName) + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Status / FY</span><b>' + escHtml_(b.Status) + ' / ' + escHtml_(b.FY) + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Gross Amount</span><b>' + num(b.Amount) + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Currently booked to</span><b>' + escHtml_(b.CampusName) + ' / ' + escHtml_(b.HeadCode + ' - ' + b.HeadName) + '</b></div>' +
    (blocked ? '<div style="color:var(--danger);margin-top:6px;">' + escHtml_(blocked) + '</div>' : '');
  if (blocked){ document.getElementById('tr_form').style.display = 'none'; TR_BILL = null; return; }
  TR_BILL = { id: b.EntryID, fy: b.FY };
  fillSelect('tr_campus', CAMPUSES, 'CampusID', 'CampusName');
  document.getElementById('tr_head').innerHTML = '<option value="">-- select campus first --</option>';
  document.getElementById('tr_form').style.display = 'block';
}
async function onTransferCampusChange(){
  const cid = document.getElementById('tr_campus').value;
  if (!cid || !TR_BILL) return;
  const list = await gs('getHeadsForCampus', cid, TR_BILL.fy).catch(function(){ return []; });
  fillSelect('tr_head', (list || []).map(function(h){ return { HeadID: h.HeadID, L: h.HeadCode + ' - ' + h.HeadName }; }), 'HeadID', 'L');
  document.getElementById('tr_preview').style.display = 'none';
  document.getElementById('btnTrApply').style.display = 'none';
}
async function previewTransfer(){
  if (!TR_BILL){ toast('Load a bill first.', 'error'); return; }
  const cid = document.getElementById('tr_campus').value, hid = document.getElementById('tr_head').value;
  if (!cid || !hid){ toast('Select the target campus and budget head.', 'error'); return; }
  const res = await runAction(document.getElementById('btnTrPreview'), 'Checking...', null, () => gs('previewBillCostCenterTransfer', TR_BILL.id, cid, hid, CURRENT_USER.username));
  if (!res || res.success === false) return;
  const box = document.getElementById('tr_preview');
  box.style.display = 'block';
  box.innerHTML = '<div style="font-weight:700;color:var(--accent);margin-bottom:6px;">If confirmed (' + escHtml_(res.fy) + ', bill amount ' + num(res.amount) + '):</div>' +
    '<div style="font-weight:700;">Leaves: ' + escHtml_(res.from.campus) + ' / ' + escHtml_(res.from.head) + '</div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Allocated</span><b>' + num(res.from.allocated) + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Spent after this bill is removed</span><b>' + num(res.from.spentAfterRemoval) + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Balance after removal</span><b>' + num(res.from.remainingAfterRemoval) + '</b></div>' +
    '<div style="border-top:1px solid var(--border);margin:8px 0;"></div>' +
    '<div style="font-weight:700;">Goes to: ' + escHtml_(res.to.campus) + ' / ' + escHtml_(res.to.head) + '</div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Allocated</span><b>' + num(res.to.allocated) + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Spent before / after</span><b>' + num(res.to.spentBefore) + ' / ' + num(res.to.spentAfter) + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;"><span>Balance after</span><b style="color:' + (res.to.remainingAfter < 0 ? 'var(--danger)' : 'inherit') + ';">' + num(res.to.remainingAfter) + '</b></div>';
  document.getElementById('btnTrApply').style.display = '';
}
async function applyTransfer(){
  if (!TR_BILL) return;
  const cid = document.getElementById('tr_campus').value, hid = document.getElementById('tr_head').value;
  const reason = document.getElementById('tr_reason').value.trim();
  if (!reason){ toast('Enter the reason for the move.', 'error'); return; }
  if (!confirm('Move Bill ' + TR_BILL.id + ' to the selected cost centre / budget head? The Budget Control Register will show the reversal and the new booking. The bill itself and its payment are not changed.')) return;
  const res = await runAction(document.getElementById('btnTrApply'), 'Moving...', null, () => gs('applyBillCostCenterTransfer', TR_BILL.id, cid, hid, reason, CURRENT_USER.username));
  if (!res || res.success === false) return;
  toast('Bill ' + res.entryId + ' moved.', 'success');
  document.getElementById('tr_billid').value = ''; document.getElementById('tr_reason').value = '';
  document.getElementById('tr_info').style.display = 'none'; document.getElementById('tr_form').style.display = 'none';
  TR_BILL = null;
}

/* ---- Bill Audit View: show transfer history; Bulk upload: dropped-connection guidance + duplicate notice ---- */
(function installTransferAndBulkHooks_(){
  const prev = window.gs;
  window.gs = function(fnName){
    const p = prev.apply(this, arguments);
    if (fnName === 'getBillDetail') p.then(function(res){
      if (!res || res.success === false || !res.transfers || !res.transfers.length) return;
      setTimeout(function(){
        const modal = document.getElementById('billDetailModal'), box = document.getElementById('billDetailContent');
        if (!modal || modal.style.display !== 'flex' || !box || document.getElementById('bav_transfers')) return;
        if (!window.__lastBillAuditData || window.__lastBillAuditData.bill.EntryID !== res.bill.EntryID) return;
        box.insertAdjacentHTML('beforeend', '<div class="bav-section" id="bav_transfers" style="margin-top:18px;background:rgba(245,158,11,0.10);border-color:rgba(245,158,11,0.35);">' +
          '<div class="bav-section-title" style="color:var(--amber);">Cost Centre Transfers</div>' +
          '<div class="table-wrap" style="margin-top:6px;"><table><thead><tr><th>Date</th><th>From</th><th>To</th><th>By</th><th>Reason</th></tr></thead><tbody>' +
          res.transfers.map(function(t){ return '<tr><td>' + escHtml_(t.date) + '</td><td style="white-space:normal;">' + escHtml_(t.from) + '</td><td style="white-space:normal;">' + escHtml_(t.to) + '</td><td>' + escHtml_(t.by) + '</td><td style="white-space:normal;">' + escHtml_(t.reason) + '</td></tr>'; }).join('') +
          '</tbody></table></div></div>');
      }, 120);
    }).catch(function(){});
    if (fnName === 'submitBulkEntry') {
      p.then(function(res){
        if (res && res.duplicate) alert(res.message + '\n\nThis is the bill from your earlier attempt (it was saved before the connection dropped or the button was pressed twice). Nothing was duplicated.');
        else if (res && res.payeeWarning) alert(res.payeeWarning);
      }).catch(function(){
        alert('The connection or the server stopped before confirming your bulk upload.\n\nDo NOT worry about duplicates or partial data: a bulk bill is saved completely or not at all.\nJust click Submit Bulk Bill again with the same file. If the first attempt did save, you will be told its Bill ID and nothing is saved twice; if it did not, it saves now.');
      });
    }
    return p;
  };
})();
