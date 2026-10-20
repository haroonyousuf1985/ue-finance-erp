/*************************************************************
 * DIARYSTAGE.GS  (complete file)
 *  - Stage 0 Diary: bills/letters, return, send to office, resume by Diary Clerk/Admin
 *  - Payment Confirmation / Reconciliation, including isolating a failed bulk
 *    beneficiary into its own bill (E123-A, E123-B ...), all done in fast batches
 *************************************************************/

const DIARY_STAGE_LABELS = {
  0: 'Diary - Pending', 1: 'Processing', 2: 'Passing', 3: 'Payment/IBFT',
  4: 'Confirmation', 5: 'Reconciliation', 6: 'Paid', 7: 'Returned'
};

/* ---------- small shared helpers ---------- */
function truthy_(v) { return v === true || v === 'TRUE' || v === 'true'; }
// An isolated bulk-line bill looks like E123-A (a real bill), unlike a bulk line E123-4.
function isSplitBillId_(id) { return /^E\d+-[A-Z]+$/.test(String(id || '').trim()); }

function nextDiaryId_() {
  const year = new Date().getFullYear();
  const prefix = 'DN-' + year + '-';
  const data = getTable(SHEETS.DIARY);
  let max = 0;
  data.forEach(r => {
    const s = String(r.DiaryID || '');
    if (s.indexOf(prefix) === 0) {
      const n = parseInt(s.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(5, '0');
}
function nextMovementId_() { return nextId_('MV', SHEETS.LETTERMOVEMENTS, 'MovementID'); }

function getDiaryEligibleUsers() {
  // Every active user can hold, be assigned or be reassigned a Diary item - whether or not they can enter bills.
  return getTable(SHEETS.USERS)
    .filter(u => u.Active !== false && u.Active !== 'FALSE')
    .map(u => ({ Username: u.Username, FullName: u.FullName, Role: u.Role }));
}

/* ---------- Stage 0: log a bill or letter's physical arrival, assign it by name ---------- */
function createDiaryEntry(data, username) {
  requireRole_(username, ['DiaryClerk']);
  data = data || {};
  // Every field of the log form is mandatory (the letter attachment alone is optional).
  if (!String(data.dateReceived || '').trim()) return { success: false, message: 'Date Received is required.' };
  if (!String(data.senderReferenceDate || '').trim()) return { success: false, message: "Sender's Diary / Letter Date is required." };
  if (!String(data.senderReferenceNo || '').trim()) return { success: false, message: "Reference / Diary No. of the Sender is required." };
  if (!String(data.roughDescription || '').trim()) return { success: false, message: 'Description is required.' };

  const itemType = data.itemType === 'Letter' ? 'Letter' : 'Bill';
  const senderType = ['Vendor', 'Employee', 'NonUEEmployee', 'Office'].indexOf(data.senderType) !== -1 ? data.senderType : 'Vendor';
  if (senderType === 'Vendor' && !String(data.vendorName || '').trim()) return { success: false, message: 'Vendor Name is required.' };
  if (senderType === 'Employee' && !String(data.employeeId || '').trim()) return { success: false, message: 'Employee ID is required.' };
  if (senderType === 'NonUEEmployee' && (!String(data.cnic || '').trim() || !String(data.vendorName || '').trim())) {
    return { success: false, message: 'Non-UE Employee CNIC and Name are both required.' };
  }
  if (senderType === 'Office' && !String(data.senderOfficeName || '').trim()) return { success: false, message: 'Sender Office Name is required.' };
  if (!String(data.assignedTo || '').trim()) return { success: false, message: 'Assign this item to someone.' };
  const assignee = getTable(SHEETS.USERS).find(u => u.Username === data.assignedTo && u.Active !== false && u.Active !== 'FALSE');
  if (!assignee) return { success: false, message: 'Selected user was not found or is inactive.' };

  // A Bill must state its Amount and whether it is a Single bill or a Bulk bill (several beneficiaries).
  let billAmount = '', billType = '';
  if (itemType === 'Bill') {
    billAmount = Math.round(Number(data.amount) || 0);
    if (!billAmount || billAmount <= 0) return { success: false, message: 'Enter the Amount of the bill.' };
    billType = data.billType === 'Bulk' ? 'Bulk' : (data.billType === 'Single' ? 'Single' : '');
    if (!billType) return { success: false, message: 'Select whether this is a Single bill or a Bulk bill (multiple beneficiaries).' };
  }

  let attachment = null;
  if (data.attachment) {
    const chk = validateAttachmentInput_(data.attachment);
    if (chk.error) return { success: false, message: chk.error };
    attachment = data.attachment;
  }

  let originatingOfficeId = '', originatingOfficeName = '', originatingOfficeOther = '';
  if (data.originatingOfficeId === '__others__') {
    if (!String(data.originatingOfficeOther || '').trim()) return { success: false, message: 'Enter the Originating Office name.' };
    originatingOfficeOther = data.originatingOfficeOther.trim();
  } else {
    if (!data.originatingOfficeId) return { success: false, message: 'Select the Originating Office (or choose Others).' };
    const office = getReceivingOffices().find(o => o.OfficeID === data.originatingOfficeId);
    if (!office) return { success: false, message: 'Selected Originating Office was not found.' };
    originatingOfficeId = office.OfficeID;
    originatingOfficeName = office.OfficeName;
  }

  return withLock_(() => {
    const id = nextDiaryId_();
    const mvId = nextMovementId_();
    appendRowObj(SHEETS.DIARY, {
      DiaryID: id, DateReceived: data.dateReceived || fmtDate_(new Date()),
      SenderReferenceDate: data.senderReferenceDate || '', LoggedBy: username,
      ItemType: itemType, SenderType: senderType,
      VendorName: (senderType === 'Vendor' || senderType === 'NonUEEmployee') ? (data.vendorName || '').trim() : '',
      EmployeeID: senderType === 'Employee' ? data.employeeId.trim() : '',
      CNIC_NTN: senderType === 'NonUEEmployee' ? (data.cnic || '').trim() : '',
      SenderOfficeName: senderType === 'Office' ? data.senderOfficeName.trim() : '',
      SenderReferenceNo: data.senderReferenceNo || '',
      OriginatingOfficeID: originatingOfficeId, OriginatingOfficeName: originatingOfficeName, OriginatingOfficeOther: originatingOfficeOther,
      RoughDescription: data.roughDescription || '',
      AssignedToUsername: data.assignedTo, AssignedDate: new Date(), AssignedBy: username,
      PendingOfficeConfirmation: false, OfficeName: '',
      Status: 'Pending', LinkedEntryID: '', ClosedDate: '', ClosedBy: '',
      HeldByUsername: '', HeldDate: '', HeldReason: '',
      Amount: billAmount, BillType: billType
    });
    appendRowObj(SHEETS.LETTERMOVEMENTS, {
      MovementID: mvId, DiaryID: id, ActionType: 'Assigned',
      FromUser: username, ToUser: data.assignedTo, ActionDate: new Date(),
      ResponseRefNo: '', ResponseDate: '', Details: 'Logged and assigned by Diary Clerk.',
      ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
    });
    let attachmentWarning = '';
    if (attachment) {
      try { saveDiaryAttachment_(id, mvId, 'Original', attachment, username); }
      catch (err) { attachmentWarning = 'Item logged as ' + id + ', but the file could not be saved: ' + err.message; }
    }
    return { success: true, diaryId: id, attachmentWarning: attachmentWarning };
  });
}

// Several Diary numbers can share ONE bulk bill, so a bill can have more than one Diary row.
function getDiaryRowsForEntry_(entryId) {
  entryId = String(entryId || '').trim();
  if (!entryId) return [];
  return getTable(SHEETS.DIARY).filter(d => d.LinkedEntryID === entryId);
}

function getDiaryById(diaryId) {
  diaryId = String(diaryId || '').trim();
  if (!diaryId) return null;
  return getTable(SHEETS.DIARY).find(d => d.DiaryID === diaryId) || null;
}

function diarySenderLabel_(d) {
  if (d.SenderType === 'Employee') return 'Employee ' + d.EmployeeID;
  if (d.SenderType === 'NonUEEmployee') return (d.VendorName || 'Non-UE Employee') + (d.CNIC_NTN ? ' (' + d.CNIC_NTN + ')' : '');
  if (d.SenderType === 'Office') return d.SenderOfficeName;
  return d.VendorName;
}
function diaryOriginatingOfficeLabel_(d) {
  return d.OriginatingOfficeName || d.OriginatingOfficeOther || '-';
}

/* ---------- Stage computation - single source of truth ---------- */
function computeItemStage_(d, entriesById, bulkLinesByParent) {
  if (d.Status === 'Cancelled' && !d.LinkedEntryID) return { stage: 6, label: 'Cancelled (Diary)' };
  if (d.ItemType !== 'Letter' && d.LinkedEntryID) {
    const entry = entriesById ? entriesById[d.LinkedEntryID] : getTable(SHEETS.ENTRIES).find(e => e.EntryID === d.LinkedEntryID);
    if (!entry) return { stage: 1, label: 'Entered (record not found)' };
    if (isOnHold_(entry)) return { stage: 7, label: 'Returned - ' + (entry.HoldReason || 'Needs Correction') };
    if (statusEquals_(entry.Status, STATUS.CANCELLED)) return { stage: 6, label: 'Cancelled' };
    if (statusEquals_(entry.Status, STATUS.RECEIVED)) return { stage: 1, label: DIARY_STAGE_LABELS[1] };
    if (statusEquals_(entry.Status, STATUS.PROCESSED)) return { stage: 2, label: DIARY_STAGE_LABELS[2] };
    if (statusEquals_(entry.Status, STATUS.PASSED)) return { stage: 3, label: DIARY_STAGE_LABELS[3] };
    if (statusEquals_(entry.Status, STATUS.PAID)) {
      if (entry.PayeeType === 'Bulk') {
        const lines = bulkLinesByParent ? (bulkLinesByParent[entry.EntryID] || []) : getTable(SHEETS.BULKITEMS).filter(li => li.ParentEntryID === entry.EntryID);
        // A beneficiary isolated into its own bill (E123-A ...) keeps this bulk bill in Reconciliation
        // until that bill is confirmed too.
        const childIds = lines.filter(li => li.SplitToEntryID).map(li => li.SplitToEntryID);
        if (childIds.length) {
          const allEntries = entriesById ? null : getTable(SHEETS.ENTRIES);
          const open = childIds.filter(cid => {
            const c = entriesById ? entriesById[cid] : allEntries.find(e => e.EntryID === cid);
            return c && !statusEquals_(c.Status, STATUS.CANCELLED) &&
              !(statusEquals_(c.Status, STATUS.PAID) && c.PaymentStatus === 'Confirmed');
          });
          if (open.length) return { stage: 5, label: DIARY_STAGE_LABELS[5] + ' - isolated beneficiary bill(s): ' + open.join(', ') };
        }
        if (lines.some(li => li.LinePaymentStatus === 'Failed')) return { stage: 5, label: DIARY_STAGE_LABELS[5] + ' (some beneficiaries)' };
      }
      if (entry.PaymentStatus === 'Confirmed') return { stage: 6, label: DIARY_STAGE_LABELS[6] };
      if (entry.PaymentStatus === 'Failed') return { stage: 5, label: DIARY_STAGE_LABELS[5] };
      return { stage: 4, label: DIARY_STAGE_LABELS[4] };
    }
    return { stage: 1, label: entry.Status };
  }

  if (d.Status === 'Returned') return { stage: 7, label: DIARY_STAGE_LABELS[7] + ' - With Diary Clerk/Admin' };
  if (truthy_(d.PendingOfficeConfirmation)) return { stage: 0, label: 'Sent to ' + (d.OfficeName || 'Office') };
  if (d.Status === 'Pending') return { stage: 0, label: DIARY_STAGE_LABELS[0] };

  if (d.ItemType === 'Letter') {
    if (d.Status === 'Closed') return { stage: 6, label: 'Closed' };
    return { stage: 1, label: 'With ' + d.AssignedToUsername };
  }
  return { stage: 1, label: 'Entered (record not found)' };
}

function daysBetween_(from, to) {
  const a = new Date(from), b = to ? new Date(to) : new Date();
  if (isNaN(a)) return 0;
  return Math.max(0, Math.floor((b - a) / (1000 * 60 * 60 * 24)));
}

function stageEnteredDate_(d, linkedEntry, stageInfo) {
  if (linkedEntry) {
    if (stageInfo.stage === 7) return linkedEntry.HoldDate || d.DateReceived;
    if (stageInfo.stage === 6) return linkedEntry.PaymentConfirmedDate || linkedEntry.CancelledDate || linkedEntry.PaidDate;
    if (stageInfo.stage === 5) return linkedEntry.PaymentFailureDate || linkedEntry.PaidDate;
    if (stageInfo.stage === 4) return linkedEntry.PaidDate;
    if (stageInfo.stage === 3) return linkedEntry.PassedDate;
    if (stageInfo.stage === 2) return linkedEntry.ProcessedDate;
    if (stageInfo.stage === 1) return linkedEntry.EntryDate;
  }
  if (stageInfo.stage === 7) return d.HeldDate || d.DateReceived;
  return d.AssignedDate || d.DateReceived;
}

function buildDiaryTrackingRows_(filters) {
  filters = filters || {};
  const allEntries = getTable(SHEETS.ENTRIES);
  const entriesById = {};
  allEntries.forEach(e => { entriesById[e.EntryID] = e; });
  const bulkParentIds = new Set(allEntries.filter(e => e.PayeeType === 'Bulk').map(e => e.EntryID));
  const bulkLinesByParent = {};
  if (bulkParentIds.size) {
    getTable(SHEETS.BULKITEMS).forEach(li => {
      if (!bulkParentIds.has(li.ParentEntryID)) return;
      (bulkLinesByParent[li.ParentEntryID] || (bulkLinesByParent[li.ParentEntryID] = [])).push(li);
    });
  }

  const diaryRows = getTable(SHEETS.DIARY);

  // Self-heal: a Diary bill whose linked bill was deleted (Admin > Manage Entries > Delete) goes back
  // to Diary Pending so it can be entered again, instead of being stuck "Entered (record not found)".
  const orphans = diaryRows.filter(d => d.ItemType !== 'Letter' && d.LinkedEntryID && !entriesById[d.LinkedEntryID]);
  if (orphans.length) {
    withLock_(() => {
      orphans.forEach(d => {
        updateRowByKey(SHEETS.DIARY, 'DiaryID', d.DiaryID, { Status: 'Pending', LinkedEntryID: '' });
        appendRowObj(SHEETS.LETTERMOVEMENTS, {
          MovementID: nextMovementId_(), DiaryID: d.DiaryID, ActionType: 'BillDeleted',
          FromUser: '', ToUser: d.AssignedToUsername || '', ActionDate: new Date(),
          ResponseRefNo: '', ResponseDate: '',
          Details: 'Bill ' + d.LinkedEntryID + ' was deleted - returned to Diary Pending so it can be entered again.',
          ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
        });
        d.Status = 'Pending'; d.LinkedEntryID = '';
      });
    });
  }

  let rows = diaryRows.map(d => {
    const stageInfo = computeItemStage_(d, entriesById, bulkLinesByParent);
    const linkedEntry = d.LinkedEntryID ? entriesById[d.LinkedEntryID] : null;
    const completedDate = stageInfo.stage === 6
      ? (linkedEntry ? (linkedEntry.PaymentConfirmedDate || linkedEntry.CancelledDate) : d.ClosedDate)
      : null;
    const stageEnteredAt = stageEnteredDate_(d, linkedEntry, stageInfo);
    return {
      diaryId: d.DiaryID, dateReceived: d.DateReceived, senderReferenceDate: d.SenderReferenceDate, itemType: d.ItemType,
      senderType: d.SenderType, senderLabel: diarySenderLabel_(d),
      vendorName: d.VendorName, employeeId: d.EmployeeID,
      originatingOffice: diaryOriginatingOfficeLabel_(d), originatingOfficeId: d.OriginatingOfficeID,
      senderReferenceNo: d.SenderReferenceNo,
      roughDescription: linkedEntry ? (linkedEntry.BillDescription || d.RoughDescription) : d.RoughDescription,
      amount: linkedEntry ? Number(linkedEntry.Amount || 0) : ((d.Amount !== '' && d.Amount !== undefined && d.Amount !== null) ? Number(d.Amount) : null),
      billType: d.BillType || '',
      assignedTo: d.AssignedToUsername, status: d.Status, linkedEntryId: d.LinkedEntryID,
      pendingOfficeConfirmation: truthy_(d.PendingOfficeConfirmation), officeName: d.OfficeName,
      stage: stageInfo.stage, stageLabel: stageInfo.label,
      daysWaiting: completedDate ? daysBetween_(d.DateReceived, completedDate) : daysBetween_(d.DateReceived),
      daysAtCurrentStage: daysBetween_(stageEnteredAt),
      isComplete: stageInfo.stage === 6, completedDate: completedDate,
      isHeld: stageInfo.stage === 7 || truthy_(d.PendingOfficeConfirmation),
      heldBy: d.HeldByUsername || ''
    };
  });

  if (filters.assignedTo) rows = rows.filter(r => r.assignedTo === filters.assignedTo);
  if (filters.originatingOfficeId) rows = rows.filter(r => r.originatingOfficeId === filters.originatingOfficeId);
  if (filters.query) {
    const q = String(filters.query).toLowerCase();
    rows = rows.filter(r =>
      String(r.vendorName || '').toLowerCase().includes(q) ||
      String(r.employeeId || '').toLowerCase().includes(q) ||
      String(r.senderLabel || '').toLowerCase().includes(q) ||
      String(r.diaryId || '').toLowerCase().includes(q));
  }
  if (filters.employeeId) {
    const q = String(filters.employeeId).trim().toLowerCase();
    rows = rows.filter(r => String(r.employeeId || '').toLowerCase().includes(q));
  }
  if (filters.description) {
    const q = String(filters.description).trim().toLowerCase();
    rows = rows.filter(r => String(r.roughDescription || '').toLowerCase().includes(q));
  }
  if (filters.amount) {
    const q = String(filters.amount).replace(/,/g, '').trim();
    rows = rows.filter(r => r.amount !== null && r.amount !== undefined && String(r.amount).includes(q));
  }
  if (!filters.includeCompleted) rows = rows.filter(r => !r.isComplete);
  if (filters.minDaysWaiting !== undefined && filters.minDaysWaiting !== null && filters.minDaysWaiting !== '') {
    rows = rows.filter(r => r.daysWaiting >= Number(filters.minDaysWaiting));
  }
  return rows.sort((a, b) => b.daysWaiting - a.daysWaiting);
}

function getPendingDiaryItems(filters, actorUsername) {
  requireRole_(actorUsername, ['DiaryClerk']);
  filters = Object.assign({ minDaysWaiting: 10 }, filters || {});
  return buildDiaryTrackingRows_(filters);
}

function getUserDiaryQueue(username, filters) {
  filters = Object.assign({}, filters || {}, { assignedTo: username });
  return buildDiaryTrackingRows_(filters);
}

function getUserDiaryStageSummary(username) {
  const rows = buildDiaryTrackingRows_({ assignedTo: username, includeCompleted: true, minDaysWaiting: 0 });
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  rows.forEach(r => { counts[r.stage] = (counts[r.stage] || 0) + 1; });
  return Object.keys(DIARY_STAGE_LABELS).map(s => ({ stage: Number(s), label: DIARY_STAGE_LABELS[s], count: counts[s] || 0 }));
}

function getUserDiarySummaryForExport(username, stageFilter, actorUsername) {
  requireRole_(actorUsername, ['DiaryClerk']);
  const filters = { assignedTo: username, includeCompleted: true, minDaysWaiting: 0 };
  let rows = buildDiaryTrackingRows_(filters);
  if (stageFilter !== undefined && stageFilter !== null && stageFilter !== '') {
    rows = rows.filter(r => r.stage === Number(stageFilter));
  }
  return rows;
}

/* ================= HOLD / RETURN / SEND-TO-OFFICE MODEL =================
   An item is "frozen" when it is (a) Returned before entry, (b) an entered bill
   On Hold, or (c) sent to another office. Only the Diary Clerk or Admin can resume
   a frozen item (resumeHeldItem), by assigning it to a named person. The person who
   froze it keeps a view-only record. ================================================ */
function isDiaryController_(username) {
  const role = getUserRole_(username);
  return role === 'Admin' || role === 'DiaryClerk';
}
function requireDiaryController_(username) {
  if (!isDiaryController_(username)) throw new Error('Only the Diary Clerk or Admin can do this.');
}
function isItemFrozen_(diaryRow, entry) {
  return diaryRow.Status === 'Returned' || truthy_(diaryRow.PendingOfficeConfirmation) || !!(entry && isOnHold_(entry));
}

// Diary Clerk / Admin: everything Returned, On Hold, or Sent to an Office.
function getHeldItemsForController(actorUsername) {
  requireDiaryController_(actorUsername);
  const entries = getTable(SHEETS.ENTRIES);
  const entriesById = {}; entries.forEach(e => { entriesById[e.EntryID] = e; });
  const diary = getTable(SHEETS.DIARY);
  const diaryByEntry = {}; diary.forEach(d => { if (d.LinkedEntryID) diaryByEntry[d.LinkedEntryID] = d; });
  const lastMove = {};
  getTable(SHEETS.LETTERMOVEMENTS)
    .sort((a, b) => new Date(a.ActionDate) - new Date(b.ActionDate))
    .forEach(m => { lastMove[m.DiaryID] = m; });

  const returned = [], sent = [], seenEntry = {};
  diary.forEach(d => {
    const entry = d.LinkedEntryID ? entriesById[d.LinkedEntryID] : null;
    const isSent = truthy_(d.PendingOfficeConfirmation);
    const isReturnedPre = d.Status === 'Returned' && !entry;
    const isHeldBill = !!(entry && isOnHold_(entry));
    if (!isSent && !isReturnedPre && !isHeldBill) return;
    if (d.LinkedEntryID) { if (seenEntry[d.LinkedEntryID]) return; seenEntry[d.LinkedEntryID] = true; }
    const stageInfo = computeItemStage_(d, entriesById);
    const lm = lastMove[d.DiaryID] || {};
    const row = {
      diaryId: d.DiaryID, itemType: d.ItemType, linkedEntryId: d.LinkedEntryID || '',
      sender: diarySenderLabel_(d), stageLabel: stageInfo.label,
      description: entry ? (entry.BillDescription || d.RoughDescription) : d.RoughDescription,
      amount: entry ? Number(entry.Amount || 0) : ((d.Amount !== '' && d.Amount !== undefined && d.Amount !== null) ? Number(d.Amount) : null),
      billType: d.BillType || '',
      heldBy: d.HeldByUsername || (entry && entry.HoldBy) || lm.FromUser || '',
      heldDate: d.HeldDate || (entry && entry.HoldDate) || lm.ActionDate || d.DateReceived,
      reason: d.HeldReason || (entry && entry.HoldReason) || lm.ReturnObjection || lm.Details || '',
      officeName: d.OfficeName || ''
    };
    (isSent ? sent : returned).push(row);
  });
  entries.filter(e => isOnHold_(e) && !diaryByEntry[e.EntryID]).forEach(e => {
    returned.push({
      diaryId: '', itemType: 'Bill', linkedEntryId: e.EntryID, sender: e.VendorName, stageLabel: 'On Hold - ' + e.Status,
      description: e.BillDescription, amount: Number(e.Amount || 0), heldBy: e.HoldBy || '', heldDate: e.HoldDate,
      reason: e.HoldReason || '', officeName: ''
    });
  });
  const byDate = (a, b) => new Date(b.heldDate) - new Date(a.heldDate);
  return { returned: returned.sort(byDate), sent: sent.sort(byDate) };
}

// Diary Clerk / Admin: assign a frozen item to a named person and resume it where it left off.
function resumeHeldItem(diaryId, newUsername, note, actorUsername) {
  requireDiaryController_(actorUsername);
  const row = getDiaryById(diaryId);
  if (!row) return { success: false, message: 'Diary item not found.' };
  const entry = row.LinkedEntryID ? getTable(SHEETS.ENTRIES).find(e => e.EntryID === row.LinkedEntryID) : null;
  if (!isItemFrozen_(row, entry)) return { success: false, message: 'This item is not currently Returned, On Hold or Sent to an office.' };
  const newUser = getTable(SHEETS.USERS).find(u => u.Username === newUsername && u.Active !== false && u.Active !== 'FALSE');
  if (!newUser) return { success: false, message: 'Select an active user to assign this to.' };
  const stageBefore = computeItemStage_(row, entry ? { [entry.EntryID]: entry } : {}).label;
  // A bulk bill can cover several Diary numbers - they are all resumed together.
  const siblings = row.LinkedEntryID ? getDiaryRowsForEntry_(row.LinkedEntryID) : [row];
  return withLock_(() => {
    siblings.forEach(d => {
      const diaryUpdates = {
        AssignedToUsername: newUsername, AssignedDate: new Date(), AssignedBy: actorUsername,
        PendingOfficeConfirmation: false, OfficeName: '', HeldByUsername: '', HeldDate: '', HeldReason: ''
      };
      if (d.Status === 'Returned') diaryUpdates.Status = 'Pending';
      updateRowByKey(SHEETS.DIARY, 'DiaryID', d.DiaryID, diaryUpdates);
      appendRowObj(SHEETS.LETTERMOVEMENTS, {
        MovementID: nextMovementId_(), DiaryID: d.DiaryID, ActionType: 'ResumedByController',
        FromUser: d.HeldByUsername || d.AssignedToUsername || '', ToUser: newUsername, ActionDate: new Date(),
        ResponseRefNo: '', ResponseDate: '',
        Details: 'Re-assigned and resumed by ' + actorUsername + ' (was: ' + stageBefore + ')' + (note ? ' - ' + note : ''),
        ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
      });
    });
    if (entry && isOnHold_(entry)) {
      updateRowByKey(SHEETS.ENTRIES, 'EntryID', entry.EntryID, { OnHold: false, ReleasedBy: actorUsername, ReleasedDate: new Date() });
    }
    return { success: true };
  });
}
function reassignReturnedItem(diaryId, newUsername, actorUsername) {
  return resumeHeldItem(diaryId, newUsername, 'Re-routed after being returned', actorUsername);
}
function releaseBillHold(entryId, username) {
  requireDiaryController_(username);
  const entry = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
  if (!entry) return { success: false, message: 'Bill not found.' };
  if (!isOnHold_(entry)) return { success: false, message: 'This bill is not currently on hold.' };
  const diaryRow = getTable(SHEETS.DIARY).find(d => d.LinkedEntryID === entryId);
  if (diaryRow) return resumeHeldItem(diaryRow.DiaryID, diaryRow.AssignedToUsername, 'Released', username);
  return withLock_(() => {
    updateRowByKey(SHEETS.ENTRIES, 'EntryID', entryId, { OnHold: false, ReleasedBy: username, ReleasedDate: new Date() });
    return { success: true };
  });
}

// Admin: universal reassign. A frozen item is resumed; a normal item is just re-pointed.
function adminReassignAny(diaryId, newUsername, reason, actorUsername) {
  requireAdmin_(actorUsername);
  const row = getTable(SHEETS.DIARY).find(d => d.DiaryID === diaryId);
  if (!row) return { success: false, message: 'Diary item not found.' };
  const entry = row.LinkedEntryID ? getTable(SHEETS.ENTRIES).find(e => e.EntryID === row.LinkedEntryID) : null;
  if (isItemFrozen_(row, entry)) return { success: false, message: 'This item is Returned / On Hold / Sent to an office - resume it from the "Returned / On Hold Bills" or "Items Sent to Other Offices" section.' };
  const newUser = getTable(SHEETS.USERS).find(u => u.Username === newUsername && u.Active !== false && u.Active !== 'FALSE');
  if (!newUser) return { success: false, message: 'Selected user was not found or is inactive.' };
  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { AssignedToUsername: newUsername, AssignedDate: new Date(), AssignedBy: actorUsername });
    appendRowObj(SHEETS.LETTERMOVEMENTS, {
      MovementID: nextMovementId_(), DiaryID: diaryId, ActionType: 'AdminReassigned',
      FromUser: row.AssignedToUsername || '(unassigned)', ToUser: newUsername, ActionDate: new Date(),
      ResponseRefNo: '', ResponseDate: '', Details: 'Reassigned by Admin' + (reason ? ': ' + reason : ''),
      ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
    });
    return { success: true };
  });
}

// Reassign (current holder or Admin only; never once Paid; never while frozen).
// To a user: handed over directly. To another office: the item is frozen (a bill is put
// On Hold) until the Diary Clerk/Admin re-assigns it; the sender keeps a view-only record.
function reassignItem(entryOrDiaryId, target, purpose, username) {
  target = target || {};
  if (!String(purpose || '').trim()) return { success: false, message: 'Enter the purpose/reason for this reassignment.' };
  const idStr = String(entryOrDiaryId || '').trim();
  // A Diary number looks like DN-2026-00001 - it must never be mistaken for a bulk-line ID such as E12-3.
  const isDiaryId = /^DN-/i.test(idStr);
  const bulkRef = isDiaryId ? null : parseBulkLineId_(idStr);
  const isBillById = !isDiaryId && (/^E\d+/.test(idStr) || !!bulkRef);
  let row, rows;   // rows = every Diary number sharing this item (a bulk bill can cover several)
  if (isBillById) {
    const baseId = bulkRef ? bulkRef.parentId : idStr;
    rows = getDiaryRowsForEntry_(baseId);
    if (!rows.length) return { success: false, message: 'No Diary record links to this bill - it may have been entered via Admin bypass.' };
    row = rows[0];
  } else {
    row = getDiaryById(idStr);
    if (!row) return { success: false, message: 'Diary item not found.' };
    rows = row.LinkedEntryID ? getDiaryRowsForEntry_(row.LinkedEntryID) : [row];
  }
  const entry = row.LinkedEntryID ? getTable(SHEETS.ENTRIES).find(e => e.EntryID === row.LinkedEntryID) : null;
  if (row.ItemType === 'Letter' && row.Status === 'Closed') return { success: false, message: 'This letter is already closed.' };
  if (entry && statusEquals_(entry.Status, STATUS.CANCELLED)) return { success: false, message: 'This bill is cancelled.' };
  if (entry && !statusEquals_(entry.Status, STATUS.RECEIVED) && !statusEquals_(entry.Status, STATUS.PROCESSED)) {
    return { success: false, message: 'A bill can only be reassigned while it is at Diary (Pending), Processing or Passing stage - it can no longer be reassigned once it has passed Passing.' };
  }
  if (isItemFrozen_(row, entry)) return { success: false, message: 'This item is Returned / On Hold / Sent to an office - only the Diary Clerk or Admin can re-assign and resume it.' };
  const permError = requireHolderOrAdmin_(row, username);
  if (permError) return { success: false, message: permError };

  const isOffice = target.type === 'office';
  if (isOffice) {
    if (!String(target.officeName || '').trim()) return { success: false, message: 'Enter the receiving office\'s name.' };
  } else {
    if (!String(target.username || '').trim()) return { success: false, message: 'Select who to reassign this to.' };
    const newUser = getTable(SHEETS.USERS).find(u => u.Username === target.username && u.Active !== false && u.Active !== 'FALSE');
    if (!newUser) return { success: false, message: 'Selected user was not found or is inactive.' };
  }

  return withLock_(() => {
    rows.forEach(d => {
      if (isOffice) {
        const officeName = target.officeName.trim();
        updateRowByKey(SHEETS.DIARY, 'DiaryID', d.DiaryID, {
          PendingOfficeConfirmation: true, OfficeName: officeName,
          HeldByUsername: username, HeldDate: new Date(), HeldReason: 'Sent to ' + officeName + ' - ' + purpose.trim()
        });
      } else {
        updateRowByKey(SHEETS.DIARY, 'DiaryID', d.DiaryID, { AssignedToUsername: target.username, AssignedDate: new Date(), AssignedBy: username });
      }
      appendRowObj(SHEETS.LETTERMOVEMENTS, {
        MovementID: nextMovementId_(), DiaryID: d.DiaryID, ActionType: isOffice ? 'SentToOffice' : 'Reassigned',
        FromUser: username, ToUser: isOffice ? ('Office: ' + target.officeName.trim()) : target.username, ActionDate: new Date(),
        ResponseRefNo: '', ResponseDate: '', Details: purpose.trim(),
        ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
      });
    });
    if (isOffice && entry) {
      updateRowByKey(SHEETS.ENTRIES, 'EntryID', entry.EntryID, {
        OnHold: true, HoldReason: 'Sent to office: ' + target.officeName.trim() + ' - ' + purpose.trim(),
        HoldBy: username, HoldDate: new Date(), ReleasedBy: '', ReleasedDate: ''
      });
    }
    return { success: true };
  });
}

// Return a bill at Processing/Passing stage (Received/Processed) by its holder or Admin.
// The bill is put On Hold; the returner keeps view-only access; only the Diary Clerk/Admin
// can resume it. (The 3rd parameter is no longer used.)
function returnBillForCorrection(entryId, objection, ignoredReassignTo, username) {
  if (!String(objection || '').trim()) return { success: false, message: 'Enter the reason/objection for returning this bill.' };
  const entry = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
  if (!entry) return { success: false, message: 'Bill not found.' };
  if (isOnHold_(entry)) return { success: false, message: 'This bill is already on hold, awaiting the Diary Clerk/Admin.' };
  if (!statusEquals_(entry.Status, STATUS.RECEIVED) && !statusEquals_(entry.Status, STATUS.PROCESSED)) {
    return { success: false, message: 'A bill can only be returned while at Processing or Passing stage - once Payment/IBFT is generated, use Reconciliation instead.' };
  }
  const diaryRows = getDiaryRowsForEntry_(entryId);   // a bulk bill can cover several Diary numbers
  if (diaryRows.length) {
    const permError = requireHolderOrAdmin_(diaryRows[0], username);
    if (permError) return { success: false, message: permError };
  }
  return withLock_(() => {
    updateRowByKey(SHEETS.ENTRIES, 'EntryID', entryId, {
      OnHold: true, HoldReason: objection.trim(), HoldBy: username, HoldDate: new Date(), ReleasedBy: '', ReleasedDate: ''
    });
    diaryRows.forEach(d => {
      updateRowByKey(SHEETS.DIARY, 'DiaryID', d.DiaryID, { HeldByUsername: username, HeldDate: new Date(), HeldReason: objection.trim() });
      appendRowObj(SHEETS.LETTERMOVEMENTS, {
        MovementID: nextMovementId_(), DiaryID: d.DiaryID, ActionType: 'ReturnedForCorrection',
        FromUser: username, ToUser: '', ActionDate: new Date(),
        ResponseRefNo: '', ResponseDate: '', Details: 'Returned at ' + entry.Status + ' stage for correction.',
        ReturnObjection: objection.trim(), ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
      });
    });
    return { success: true };
  });
}

/* ---------- Validates a Diary Number before a bill is entered (called from Code.gs) ---------- */
function resolveDiaryForEntry_(diaryId, bypassReason, username) {
  diaryId = String(diaryId || '').trim();
  const role = getUserRole_(username);
  const isAdmin = role === 'Admin';

  if (!diaryId) {
    if (!isAdmin) return { error: 'A Diary Number is required - log this bill in the Diary tab first (or ask an Admin to bypass it).' };
    if (!String(bypassReason || '').trim()) return { error: 'Bypassing Diary requires a reason (Admin only).' };
    return { diaryId: '', bypassReason: bypassReason.trim() };
  }

  const diaryRow = getDiaryById(diaryId);
  if (!diaryRow) return { error: 'Diary Number "' + diaryId + '" was not found.' };
  if (diaryRow.ItemType !== 'Bill') return { error: 'Diary Number "' + diaryId + '" was logged as a Letter, not a Bill.' };
  if (diaryRow.Status === 'Entered') return { error: 'Diary Number "' + diaryId + '" has already been entered as Bill ' + diaryRow.LinkedEntryID + '.' };
  if (diaryRow.Status !== 'Pending') return { error: 'Diary Number "' + diaryId + '" is currently "' + diaryRow.Status + '" and cannot be entered right now.' };
  if (truthy_(diaryRow.PendingOfficeConfirmation)) return { error: 'Diary Number "' + diaryId + '" was sent to another office and must be resumed by the Diary Clerk/Admin first.' };
  if (!isAdmin && diaryRow.AssignedToUsername !== username) {
    return { error: 'Diary Number "' + diaryId + '" is assigned to ' + diaryRow.AssignedToUsername + ', not you.' };
  }
  return { diaryId: diaryId, bypassReason: '', diaryRow: diaryRow };
}
// Compares what the Diary said (Amount, Single/Bulk) with the bill actually entered. A mismatch is a WARNING only - never a block.
function diaryMismatchWarnings_(diaryRow, enteredAmount, enteredIsBulk) {
  if (!diaryRow) return [];
  const warnings = [];
  const dAmt = Number(diaryRow.Amount);
  if (diaryRow.Amount !== '' && diaryRow.Amount !== undefined && diaryRow.Amount !== null && !isNaN(dAmt) &&
      Math.round(dAmt) !== Math.round(Number(enteredAmount) || 0)) {
    warnings.push('Amount differs: the Diary says ' + num_(dAmt) + ' but the bill entered is ' + num_(enteredAmount) + '.');
  }
  const dType = String(diaryRow.BillType || '').trim();
  const eType = enteredIsBulk ? 'Bulk' : 'Single';
  if (dType && dType !== eType) {
    warnings.push('Bill type differs: the Diary says ' + dType + ' but this was entered as ' + eType + '.');
  }
  return warnings;
}
// Bulk bill covering several Diary numbers: the Diary amounts are added up and compared with the bulk total (warning only).
function diaryMismatchWarningsMulti_(rows, total) {
  rows = (rows || []).filter(Boolean);
  if (rows.length <= 1) return diaryMismatchWarnings_(rows[0], total, true);
  let sum = 0, any = false;
  rows.forEach(r => {
    if (r.Amount !== '' && r.Amount !== undefined && r.Amount !== null && !isNaN(Number(r.Amount))) { sum += Number(r.Amount); any = true; }
  });
  const warnings = [];
  if (any && Math.round(sum) !== Math.round(Number(total) || 0)) {
    warnings.push('Amount differs: the ' + rows.length + ' Diary numbers add up to ' + num_(sum) + ' but the bulk bill total is ' + num_(total) + '.');
  }
  return warnings;
}
function linkDiaryToEntry_(diaryId, entryId) {
  if (!diaryId) return;
  updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { Status: 'Entered', LinkedEntryID: entryId });
}

/* =================================================================
   LETTER WORKFLOW - forward / close / return
   ================================================================= */
function requireHolderOrAdmin_(diaryRow, username) {
  const role = getUserRole_(username);
  if (truthy_(diaryRow.PendingOfficeConfirmation)) return 'This item was sent to another office - only the Diary Clerk or Admin can resume it.';
  if (diaryRow.Status === 'Returned') return 'This item was returned - only the Diary Clerk or Admin can re-assign it.';
  if (role === 'Admin') return null;
  if (diaryRow.AssignedToUsername !== username) return 'This item is not currently assigned to you.';
  return null;
}

function forwardLetter(diaryId, toUsername, notes, username) {
  const row = getDiaryById(diaryId);
  if (!row) return { success: false, message: 'Item not found.' };
  if (row.ItemType !== 'Letter') return { success: false, message: 'Only Letters can be forwarded - a Bill moves through the normal bill pipeline instead.' };
  if (row.Status !== 'Pending') return { success: false, message: 'This letter is not currently open (' + row.Status + ').' };
  const permError = requireHolderOrAdmin_(row, username);
  if (permError) return { success: false, message: permError };
  const newUser = getTable(SHEETS.USERS).find(u => u.Username === toUsername && u.Active !== false && u.Active !== 'FALSE');
  if (!newUser) return { success: false, message: 'Selected user was not found or is inactive.' };

  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { AssignedToUsername: toUsername, AssignedDate: new Date(), AssignedBy: username });
    appendRowObj(SHEETS.LETTERMOVEMENTS, {
      MovementID: nextMovementId_(), DiaryID: diaryId, ActionType: 'Forwarded',
      FromUser: username, ToUser: toUsername, ActionDate: new Date(),
      ResponseRefNo: '', ResponseDate: '', Details: notes || '',
      ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
    });
    return { success: true };
  });
}

function closeLetterWithResponse(diaryId, responseRefNo, responseDate, details, attachment, username) {
  const row = getDiaryById(diaryId);
  if (!row) return { success: false, message: 'Item not found.' };
  if (row.ItemType !== 'Letter') return { success: false, message: 'Only Letters can be closed this way.' };
  if (row.Status !== 'Pending') return { success: false, message: 'This letter is not currently open (' + row.Status + ').' };
  const permError = requireHolderOrAdmin_(row, username);
  if (permError) return { success: false, message: permError };
  if (!String(responseRefNo || '').trim() && !String(details || '').trim() && !attachment) {
    return { success: false, message: 'Enter the response letter reference/date, some closing detail, or attach the response letter.' };
  }
  let att = null;
  if (attachment) {
    const chk = validateAttachmentInput_(attachment);
    if (chk.error) return { success: false, message: chk.error };
    att = attachment;
  }

  return withLock_(() => {
    const mvId = nextMovementId_();
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { Status: 'Closed', ClosedDate: new Date(), ClosedBy: username });
    appendRowObj(SHEETS.LETTERMOVEMENTS, {
      MovementID: mvId, DiaryID: diaryId, ActionType: 'ClosedResponse',
      FromUser: username, ToUser: '', ActionDate: new Date(),
      ResponseRefNo: responseRefNo || '', ResponseDate: responseDate || '', Details: details || '',
      ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
    });
    let attachmentWarning = '';
    if (att) {
      try { saveDiaryAttachment_(diaryId, mvId, 'Response', att, username); }
      catch (err) { attachmentWarning = 'Letter closed, but the response file could not be saved: ' + err.message; }
    }
    return { success: true, attachmentWarning: attachmentWarning };
  });
}

function closeLetterFiled(diaryId, details, username) {
  const row = getDiaryById(diaryId);
  if (!row) return { success: false, message: 'Item not found.' };
  if (row.ItemType !== 'Letter') return { success: false, message: 'Only Letters can be closed this way.' };
  if (row.Status !== 'Pending') return { success: false, message: 'This letter is not currently open (' + row.Status + ').' };
  const permError = requireHolderOrAdmin_(row, username);
  if (permError) return { success: false, message: permError };

  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { Status: 'Closed', ClosedDate: new Date(), ClosedBy: username });
    appendRowObj(SHEETS.LETTERMOVEMENTS, {
      MovementID: nextMovementId_(), DiaryID: diaryId, ActionType: 'ClosedFiled',
      FromUser: username, ToUser: '', ActionDate: new Date(),
      ResponseRefNo: '', ResponseDate: '', Details: details || 'Filed for information/record.',
      ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
    });
    return { success: true };
  });
}

// Return a Letter, or a Bill still at Diary stage 0 (before any Bill ID "E..."), by its holder.
function returnItem(diaryId, objection, returnRefNo, returnDate, receiverName, attachment, username) {
  const row = getDiaryById(diaryId);
  if (!row) return { success: false, message: 'Item not found.' };
  if (row.LinkedEntryID) return { success: false, message: 'This bill already has a Bill ID - return it from its Processing/Passing stage instead.' };
  if (row.Status !== 'Pending') return { success: false, message: 'This item is not currently open (' + row.Status + ').' };
  const permError = requireHolderOrAdmin_(row, username);
  if (permError) return { success: false, message: permError };
  if (!String(objection || '').trim()) return { success: false, message: 'Enter the reason/objection for returning this item.' };
  if (!String(receiverName || '').trim()) return { success: false, message: "Enter the receiver's name." };
  let att = null;
  if (attachment) {
    const chk = validateAttachmentInput_(attachment);
    if (chk.error) return { success: false, message: chk.error };
    att = attachment;
  }

  return withLock_(() => {
    const mvId = nextMovementId_();
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, {
      Status: 'Returned', HeldByUsername: username, HeldDate: new Date(), HeldReason: objection.trim()
    });
    appendRowObj(SHEETS.LETTERMOVEMENTS, {
      MovementID: mvId, DiaryID: diaryId, ActionType: 'Returned',
      FromUser: username, ToUser: '', ActionDate: new Date(),
      ResponseRefNo: '', ResponseDate: '', Details: '',
      ReturnObjection: objection.trim(), ReturnRefNo: returnRefNo || '', ReturnDate: returnDate || '', ReturnReceiverName: receiverName.trim()
    });
    let attachmentWarning = '';
    if (att) {
      try { saveDiaryAttachment_(diaryId, mvId, 'Objection', att, username); }
      catch (err) { attachmentWarning = 'Returned, but the objection file could not be saved: ' + err.message; }
    }
    return { success: true, attachmentWarning: attachmentWarning };
  });
}

/* ---------- Full trail for the "click the DN number" popup ---------- */
function getDiaryTrail(diaryId) {
  const d = getDiaryById(diaryId);
  if (!d) return { success: false, message: 'Diary item not found.' };
  const movements = getTable(SHEETS.LETTERMOVEMENTS).filter(m => m.DiaryID === diaryId)
    .sort((a, b) => new Date(a.ActionDate) - new Date(b.ActionDate));

  let billTrail = [];
  let entry = null;
  const entriesById = {};
  if (d.ItemType === 'Bill' && d.LinkedEntryID) {
    const allEntries = getTable(SHEETS.ENTRIES);
    allEntries.forEach(e => { entriesById[e.EntryID] = e; });
    entry = entriesById[d.LinkedEntryID] || null;
    if (entry) {
      billTrail.push({ event: 'Entered', by: entry.EnteredBy, date: entry.EntryDate });
      if (entry.ProcessedBy) billTrail.push({ event: 'Processed', by: entry.ProcessedBy, date: entry.ProcessedDate });
      if (entry.PassedBy) billTrail.push({ event: 'Passed', by: entry.PassedBy, date: entry.PassedDate });
      if (entry.PaidBy) billTrail.push({ event: 'IBFT Submitted', by: entry.PaidBy, date: entry.PaidDate });
      if (entry.PaymentConfirmedBy) billTrail.push({ event: 'Payment Confirmed', by: entry.PaymentConfirmedBy, date: entry.PaymentConfirmedDate });
      if (entry.PaymentFailureLoggedBy) billTrail.push({ event: 'Payment Failed', by: entry.PaymentFailureLoggedBy, date: entry.PaymentFailureDate, note: entry.PaymentFailureReason });
      if (entry.CancelledBy) billTrail.push({ event: 'Cancelled', by: entry.CancelledBy, date: entry.CancelledDate, note: entry.CancellationReason });
      // Per-beneficiary events and isolated child bills (E123-A ...) stay tied to this bill's trail.
      getTable(SHEETS.PAYMENTCONFIRM)
        .filter(ev => String(ev.EntryID).indexOf(entry.EntryID + '-') === 0)
        .sort((a, b) => new Date(a.EventDate) - new Date(b.EventDate))
        .forEach(ev => billTrail.push({ event: ev.EventType + ' (' + ev.EntryID + ')', by: ev.LoggedBy, date: ev.EventDate, note: ev.Notes }));
    }
  }
  const stageInfo = computeItemStage_(d, entry ? entriesById : {});
  return {
    success: true, diary: d, movements, billTrail, entry, attachments: getDiaryAttachments_(diaryId),
    currentStage: stageInfo.stage, currentStageLabel: stageInfo.label,
    daysWaiting: daysBetween_(d.DateReceived, (d.Status === 'Closed' || d.Status === 'Cancelled') ? d.ClosedDate : (entry && entry.PaymentConfirmedDate ? entry.PaymentConfirmedDate : null))
  };
}

/* =================================================================
   PAYMENT CONFIRMATION / RECONCILIATION
   ================================================================= */

// Single bills still waiting (Submitted), plus bulk beneficiary LINES not yet Confirmed,
// Failed or Isolated.
function getPaymentsNeedingConfirmation(fy) {
  let rows = getTable(SHEETS.ENTRIES).filter(e => statusEquals_(e.Status, STATUS.PAID));
  if (fy) rows = rows.filter(e => fyMatches_(e.FY, fy));
  const normal = rows.filter(e => e.PayeeType !== 'Bulk' && (e.PaymentStatus === 'Submitted' || !e.PaymentStatus));
  const bulkParents = rows.filter(e => e.PayeeType === 'Bulk' && e.PaymentStatus !== 'Confirmed');
  const bulkLines = expandBulkItems_(bulkParents).filter(li =>
    li.LinePaymentStatus !== 'Confirmed' && li.LinePaymentStatus !== 'Failed' && li.LinePaymentStatus !== 'Isolated');
  return normal.concat(bulkLines).sort((a, b) => new Date(a.PaidDate) - new Date(b.PaidDate));
}

// Just the NUMBER of items waiting for confirmation (used for the tab badge, so the browser
// does not have to download every beneficiary just to show a count).
function getPaymentConfirmCount(fy) {
  const rows = getTable(SHEETS.ENTRIES).filter(e => statusEquals_(e.Status, STATUS.PAID) && fyMatches_(e.FY, fy));
  let count = rows.filter(e => e.PayeeType !== 'Bulk' && (e.PaymentStatus === 'Submitted' || !e.PaymentStatus)).length;
  const bulkIds = new Set(rows.filter(e => e.PayeeType === 'Bulk' && e.PaymentStatus !== 'Confirmed').map(e => e.EntryID));
  if (bulkIds.size) {
    getTable(SHEETS.BULKITEMS).forEach(li => {
      if (bulkIds.has(li.ParentEntryID) && li.LinePaymentStatus !== 'Confirmed' &&
          li.LinePaymentStatus !== 'Failed' && li.LinePaymentStatus !== 'Isolated') count++;
    });
  }
  return count;
}

// Bills whose payment bounced (includes isolated beneficiary bills E123-A ...).
function getNeedsCorrectionBills(fy) {
  let rows = getTable(SHEETS.ENTRIES).filter(e => statusEquals_(e.Status, STATUS.PAID) && e.PaymentStatus === 'Failed');
  if (fy) rows = rows.filter(e => fyMatches_(e.FY, fy));
  return expandBulkItems_(rows).sort((a, b) => new Date(b.PaymentFailureDate) - new Date(a.PaymentFailureDate));
}

function nextConfirmationId_() {
  return nextId_('PC', SHEETS.PAYMENTCONFIRM, 'ConfirmationID');
}
// Adds many payment-history rows in ONE read and ONE write (caller holds the lock).
// Each event: { EntryID, BatchID, EventType, EventDate, LoggedBy, Notes }
function appendPaymentEvents_(events) {
  if (!events || !events.length) return;
  const sh = getOrCreateSheet_(SHEETS.PAYMENTCONFIRM);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('ConfirmationID');
  let maxN = 0;
  for (let i = 1; i < values.length; i++) {
    const n = parseInt(String(values[i][idCol] || '').replace('PC', ''), 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  const rows = events.map(ev => {
    const obj = Object.assign({ ConfirmationID: 'PC' + (++maxN) }, ev);
    return headers.map(h => (h && obj[h] !== undefined) ? obj[h] : '');
  });
  const startRow = sh.getLastRow() + 1;
  const needed = startRow + rows.length - 1;
  if (sh.getMaxRows() < needed) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows());
  sh.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
  invalidateCache_(SHEETS.PAYMENTCONFIRM);
}
// "E658-25" (bulk line) -> parent "E658". An isolated bill "E658-A" is a real bill - kept as is.
function baseEntryId_(entryId) {
  const s = String(entryId);
  if (isSplitBillId_(s)) return s;
  return s.includes('-') ? s.split('-')[0] : entryId;
}

function confirmPayments(entryIds, username) {
  requireRole_(username, ['IBFT']);
  if (!entryIds || !entryIds.length) return { success: false, message: 'Nothing selected to confirm.' };
  const baseIds = Array.from(new Set(entryIds.map(baseEntryId_)));
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.ENTRIES);
    const range = sh.getDataRange();
    const values = range.getValues();
    const headers = values[0];
    const idCol = headers.indexOf('EntryID'), statusCol = headers.indexOf('Status'),
          psCol = headers.indexOf('PaymentStatus'), pcdCol = headers.indexOf('PaymentConfirmedDate'), pcbCol = headers.indexOf('PaymentConfirmedBy'),
          batchCol = headers.indexOf('BatchID');
    const idSet = new Set(baseIds);
    const now = new Date();
    let count = 0;
    const events = [];
    for (let i = 1; i < values.length; i++) {
      if (!idSet.has(values[i][idCol])) continue;
      if (!statusEquals_(values[i][statusCol], STATUS.PAID)) continue;
      if (values[i][psCol] === 'Confirmed') continue;
      values[i][psCol] = 'Confirmed'; values[i][pcdCol] = now; values[i][pcbCol] = username;
      events.push({ EntryID: values[i][idCol], BatchID: values[i][batchCol] || '', EventType: 'Confirmed', EventDate: now, LoggedBy: username, Notes: '' });
      count++;
    }
    range.setValues(values);
    appendPaymentEvents_(events);
    invalidateCache_(SHEETS.ENTRIES);
    return { success: true, count };
  });
}
function confirmPayment(entryId, username) {
  const res = confirmPayments([entryId], username);
  if (!res.success) return res;
  if (!res.count) return { success: false, message: 'This bill is not at Paid yet, or is already confirmed.' };
  return { success: true };
}

function markPaymentsFailed(entryIds, reason, username) {
  requireRole_(username, ['IBFT']);
  if (!entryIds || !entryIds.length) return { success: false, message: 'Nothing selected to mark failed.' };
  if (!String(reason || '').trim()) return { success: false, message: 'A reason is required (e.g. wrong IBAN, closed account, title mismatch).' };
  const baseIds = Array.from(new Set(entryIds.map(baseEntryId_)));
  return withLock_(() => {
    const sh = getOrCreateSheet_(SHEETS.ENTRIES);
    const range = sh.getDataRange();
    const values = range.getValues();
    const headers = values[0];
    const idCol = headers.indexOf('EntryID'), statusCol = headers.indexOf('Status'),
          psCol = headers.indexOf('PaymentStatus'), prCol = headers.indexOf('PaymentFailureReason'),
          plCol = headers.indexOf('PaymentFailureLoggedBy'), pfdCol = headers.indexOf('PaymentFailureDate'),
          batchCol = headers.indexOf('BatchID');
    const idSet = new Set(baseIds);
    const now = new Date();
    let count = 0;
    const events = [];
    for (let i = 1; i < values.length; i++) {
      if (!idSet.has(values[i][idCol])) continue;
      if (!statusEquals_(values[i][statusCol], STATUS.PAID)) continue;
      values[i][psCol] = 'Failed'; values[i][prCol] = reason.trim(); values[i][plCol] = username; values[i][pfdCol] = now;
      events.push({ EntryID: values[i][idCol], BatchID: values[i][batchCol] || '', EventType: 'Failed', EventDate: now, LoggedBy: username, Notes: reason.trim() });
      count++;
    }
    range.setValues(values);
    appendPaymentEvents_(events);
    invalidateCache_(SHEETS.ENTRIES);
    return { success: true, count };
  });
}
function markPaymentFailed(entryId, reason, username) {
  const res = markPaymentsFailed([entryId], reason, username);
  if (!res.success) return res;
  if (!res.count) return { success: false, message: 'This bill is not at Paid yet.' };
  return { success: true };
}

// Fix a failed single bill's beneficiary detail before resubmitting.
function updateFailedPaymentBeneficiary(entryId, updates, username) {
  requireRole_(username, ['IBFT']);
  const bulkRef = parseBulkLineId_(entryId);
  const fields = {
    VendorName: updates.name !== undefined ? String(updates.name).trim() : undefined,
    IBAN: updates.iban !== undefined ? String(updates.iban).replace(/\s+/g, '').toUpperCase() : undefined,
    CNIC_NTN: updates.cnic !== undefined ? String(updates.cnic).trim() : undefined
  };
  Object.keys(fields).forEach(k => { if (fields[k] === undefined) delete fields[k]; });
  if (!Object.keys(fields).length) return { success: false, message: 'Nothing to update.' };
  if (fields.CNIC_NTN && !isValidCnicOrNtnFormat_(fields.CNIC_NTN)) {
    return { success: false, message: 'CNIC/NTN must be a CNIC (35201-1222334-4) or an NTN (12345678).' };
  }
  if (fields.IBAN && !/^PK\d{2}[A-Z0-9]{20}$/.test(fields.IBAN)) {
    return { success: false, message: 'IBAN must start with PK and be 24 characters in total.' };
  }

  return withLock_(() => {
    if (bulkRef) {
      const ok = updateBulkLineItemByParentAndLineNo_(bulkRef.parentId, bulkRef.lineNo, fields);
      if (!ok) return { success: false, message: 'Beneficiary line not found.' };
    } else {
      const existing = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
      if (!existing) return { success: false, message: 'Bill not found.' };
      if (existing.PaymentStatus !== 'Failed') return { success: false, message: 'This bill is not currently marked Failed.' };
      updateRowByKey(SHEETS.ENTRIES, 'EntryID', entryId, fields);
    }
    return { success: true };
  });
}

// Send a corrected failed bill (including an isolated E123-A) back to Passed for a fresh IBFT attempt.
function resubmitFailedPayment(entryId, username) {
  requireRole_(username, ['IBFT']);
  const baseId = baseEntryId_(entryId);
  const existing = getTable(SHEETS.ENTRIES).find(e => e.EntryID === baseId);
  if (!existing) return { success: false, message: 'Bill not found.' };
  if (existing.PaymentStatus !== 'Failed') return { success: false, message: 'This bill is not currently marked Failed.' };

  return withLock_(() => {
    updateRowByKey(SHEETS.ENTRIES, 'EntryID', baseId, {
      Status: STATUS.PASSED, PaymentStatus: '', PaidBy: '', PaidDate: '', BatchID: '',
      PaymentRetryOfEntryID: existing.PaymentRetryOfEntryID || baseId,
      PaymentRetryCount: Number(existing.PaymentRetryCount || 0) + 1
    });
    appendPaymentEvents_([{
      EntryID: baseId, BatchID: '', EventType: 'Retried', EventDate: new Date(), LoggedBy: username,
      Notes: 'Returned to the Passed queue for a fresh IBFT attempt (retry #' + (Number(existing.PaymentRetryCount || 0) + 1) + ').'
    }]);
    return { success: true };
  });
}

// Full payment history for one bill. A parent bulk bill also shows its lines' and isolated
// children's events; an isolated bill also shows its parent's and original line's history.
function getPaymentHistory(entryId) {
  const id = String(entryId);
  const baseId = baseEntryId_(id);
  const relevant = new Set([id, baseId]);
  if (isSplitBillId_(id)) {
    const e = getTable(SHEETS.ENTRIES).find(x => x.EntryID === id);
    if (e && e.SplitFromEntryID) { relevant.add(String(e.SplitFromEntryID)); relevant.add(e.SplitFromEntryID + '-' + e.SplitFromLineNo); }
  }
  const plainBill = id.indexOf('-') === -1;
  return getTable(SHEETS.PAYMENTCONFIRM).filter(r => {
    const rid = String(r.EntryID);
    return relevant.has(rid) || (plainBill && rid.indexOf(id + '-') === 0);
  }).sort((a, b) => new Date(a.EventDate) - new Date(b.EventDate));
}

/* =================================================================
   PER-BENEFICIARY CONFIRMATION / RECONCILIATION (bulk bills)
   Everything below reads each sheet once and writes in bulk, so thousands of
   beneficiaries finish in seconds instead of timing out.
   ================================================================= */

// Recomputes several bulk parents' own PaymentStatus at once: Confirmed only when every ACTIVE
// line (not isolated) is Confirmed; Failed if any is Failed; otherwise Submitted.
function recomputeParentPaymentStatuses_(parentIds) {
  const ids = new Set(Array.from(parentIds || []).map(String));
  if (!ids.size) return;
  const bVals = getOrCreateSheet_(SHEETS.BULKITEMS).getDataRange().getValues();
  const bh = bVals[0];
  const bp = bh.indexOf('ParentEntryID'), bs = bh.indexOf('LinePaymentStatus'), bsp = bh.indexOf('SplitToEntryID');
  const agg = {};
  for (let i = 1; i < bVals.length; i++) {
    const pid = String(bVals[i][bp]);
    if (!ids.has(pid)) continue;
    const a = agg[pid] || (agg[pid] = { active: 0, confirmed: 0, failed: 0 });
    const st = bVals[i][bs];
    if (st === 'Isolated' || (bsp !== -1 && bVals[i][bsp])) continue;
    a.active++;
    if (st === 'Confirmed') a.confirmed++;
    if (st === 'Failed') a.failed++;
  }
  const sh = getOrCreateSheet_(SHEETS.ENTRIES);
  const eVals = sh.getDataRange().getValues();
  const eh = eVals[0];
  const ei = eh.indexOf('EntryID'), ep = eh.indexOf('PaymentStatus'), ec = eh.indexOf('PaymentConfirmedDate');
  const now = new Date();
  for (let i = 1; i < eVals.length; i++) {
    const a = agg[String(eVals[i][ei])];
    if (!a) continue;
    const allConfirmed = a.confirmed === a.active;
    const newStatus = allConfirmed ? 'Confirmed' : (a.failed > 0 ? 'Failed' : 'Submitted');
    if (eVals[i][ep] === newStatus) continue;
    sh.getRange(i + 1, ep + 1).setValue(newStatus);
    if (allConfirmed && ec !== -1) sh.getRange(i + 1, ec + 1).setValue(now);
  }
  invalidateCache_(SHEETS.ENTRIES);
}
function recomputeParentPaymentStatus_(parentEntryId) {
  recomputeParentPaymentStatuses_([parentEntryId]);
}

// entryIds here are beneficiary line IDs, "ParentID-LineNo" (e.g. E658-12).
function confirmBulkLines(lineIds, username) {
  requireRole_(username, ['IBFT']);
  if (!lineIds || !lineIds.length) return { success: false, message: 'Nothing selected to confirm.' };
  return withLock_(() => {
    const now = new Date();
    const wanted = {};
    lineIds.forEach(id => {
      const ref = parseBulkLineId_(id);
      if (ref) wanted[ref.parentId + '|' + ref.lineNo] = true;
    });
    const sh = getOrCreateSheet_(SHEETS.BULKITEMS);
    const values = sh.getDataRange().getValues();
    const h = values[0];
    const pCol = h.indexOf('ParentEntryID'), lCol = h.indexOf('LineNo'), sCol = h.indexOf('LinePaymentStatus'),
          dCol = h.indexOf('LinePaymentConfirmedDate'), bCol = h.indexOf('LinePaymentConfirmedBy'), spCol = h.indexOf('SplitToEntryID');
    if ([pCol, lCol, sCol, dCol, bCol].indexOf(-1) !== -1) {
      return { success: false, message: 'Sheet columns are missing - run initializeSystem once from the Apps Script editor.' };
    }
    const touchedParents = new Set();
    const events = [];
    let count = 0;
    for (let i = 1; i < values.length; i++) {
      if (!wanted[values[i][pCol] + '|' + values[i][lCol]]) continue;
      if (values[i][sCol] === 'Confirmed' || values[i][sCol] === 'Isolated' || (spCol !== -1 && values[i][spCol])) continue;
      values[i][sCol] = 'Confirmed'; values[i][dCol] = now; values[i][bCol] = username;
      touchedParents.add(String(values[i][pCol]));
      events.push({ EntryID: values[i][pCol] + '-' + values[i][lCol], BatchID: '', EventType: 'Confirmed', EventDate: now, LoggedBy: username, Notes: '' });
      count++;
    }
    if (count) {
      [sCol, dCol, bCol].forEach(c => {
        sh.getRange(2, c + 1, values.length - 1, 1).setValues(values.slice(1).map(r => [r[c]]));
      });
      appendPaymentEvents_(events);
      recomputeParentPaymentStatuses_(touchedParents);
    }
    invalidateCache_(SHEETS.ENTRIES);
    invalidateCache_(SHEETS.BULKITEMS);
    return { success: true, count };
  });
}

function splitSuffix_(i) { // 0->A ... 25->Z, 26->AA ...
  let n = i + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Marking bulk lines Failed ISOLATES each one into its own new bill (E123-A ...), which lands in
// Reconciliation. The rest of the bulk bill is untouched. Done in one pass: each sheet is read
// once and written in bulk.
function markBulkLinesFailed(lineIds, reason, username) {
  requireRole_(username, ['IBFT']);
  if (!lineIds || !lineIds.length) return { success: false, message: 'Nothing selected to mark failed.' };
  if (!String(reason || '').trim()) return { success: false, message: 'A reason is required.' };
  reason = reason.trim();
  return withLock_(() => {
    const now = new Date();
    const eSh = getOrCreateSheet_(SHEETS.ENTRIES);
    const eVals = eSh.getDataRange().getValues();
    const eh = eVals[0];
    const E = {}; eh.forEach((h, i) => { if (h) E[h] = i; });
    const bSh = getOrCreateSheet_(SHEETS.BULKITEMS);
    const bVals = bSh.getDataRange().getValues();
    const bh = bVals[0];
    const B = {}; bh.forEach((h, i) => { if (h) B[h] = i; });

    const needE = ['EntryID','PayeeType','Status','Amount','NetAmount','IncomeTaxAmount','SalesTaxAmount','PSTAmount',
      'SecurityAmount','PenaltyAmount','OtherDeductionAmount','SplitFromEntryID','SplitFromLineNo'];
    const needB = ['ParentEntryID','LineNo','LinePaymentStatus','LinePaymentFailureReason','LinePaymentFailureLoggedBy',
      'LinePaymentFailureDate','SplitToEntryID','RedirectedToEntryID'];
    const missing = needE.filter(c => E[c] === undefined).concat(needB.filter(c => B[c] === undefined));
    if (missing.length) {
      return { success: false, message: 'Sheet columns are missing (' + missing.join(', ') + ') - run initializeSystem once from the Apps Script editor.' };
    }

    const parentIdx = {}, usedIds = new Set();
    for (let i = 1; i < eVals.length; i++) { const id = String(eVals[i][E.EntryID]); usedIds.add(id); parentIdx[id] = i; }
    const lineIdx = {};
    for (let i = 1; i < bVals.length; i++) lineIdx[bVals[i][B.ParentEntryID] + '|' + bVals[i][B.LineNo]] = i;

    const n = v => Number(v || 0);
    const created = [], skipped = [], touchedParents = new Set(), childRows = [], events = [];

    lineIds.forEach(id => {
      const ref = parseBulkLineId_(id);
      if (!ref) return;
      const pi = parentIdx[ref.parentId];
      const li = lineIdx[ref.parentId + '|' + ref.lineNo];
      if (pi === undefined || eVals[pi][E.PayeeType] !== 'Bulk') { skipped.push(id + ': parent bulk bill not found.'); return; }
      if (!statusEquals_(eVals[pi][E.Status], STATUS.PAID)) { skipped.push(id + ': the bulk bill is not at Paid stage.'); return; }
      if (li === undefined) { skipped.push(id + ': beneficiary line not found.'); return; }
      const lrow = bVals[li];
      if (lrow[B.SplitToEntryID]) { skipped.push(id + ': already isolated as ' + lrow[B.SplitToEntryID] + '.'); return; }
      if (lrow[B.RedirectedToEntryID]) { skipped.push(id + ': this line was redirected.'); return; }
      if (lrow[B.LinePaymentStatus] === 'Confirmed') { skipped.push(id + ': already confirmed.'); return; }

      const parent = {}; eh.forEach((h, k) => { if (h) parent[h] = eVals[pi][k]; });
      const line = {}; bh.forEach((h, k) => { if (h) line[h] = lrow[k]; });

      let k = 0;
      while (usedIds.has(ref.parentId + '-' + splitSuffix_(k))) k++;
      const newId = ref.parentId + '-' + splitSuffix_(k);
      usedIds.add(newId);

      const amount = n(line.Amount), it = n(line.IncomeTaxAmount), st = n(line.SalesTaxAmount), pst = n(line.PSTAmount),
            sec = n(line.SecurityAmount), pen = n(line.PenaltyAmount), oth = n(line.OtherDeductionAmount);
      const net = (line.NetAmount !== '' && line.NetAmount !== undefined) ? n(line.NetAmount) : (amount - it - st - pst - sec - pen - oth);
      const nature = line.BillNature || (parent.BillNature === 'Bulk' ? '' : parent.BillNature);

      const child = Object.assign({}, parent, {
        EntryID: newId, Timestamp: now,
        PayeeType: line.PayeeType, EmployeeID: line.EmployeeID || '', StudentID: line.StudentID || '',
        Program: line.Program || '', Session: line.Session || '', Shift: line.Shift || '',
        VendorName: line.VendorName, CNIC_NTN: line.CNIC_NTN || '', IBAN: line.IBAN || '',
        Amount: amount, BillDescription: '[Isolated from ' + ref.parentId + ' line ' + line.LineNo + '] ' + (line.BillDescription || parent.BillDescription || ''),
        BillNature: nature, RefundCategory: '', FBRStatus: '', ServiceCategory: '', TaxpayerType: '', PRAStatus: '',
        IncomeTaxSection: line.IncomeTaxSection || '', IncomeTaxRate: '', IncomeTaxAmount: it,
        SalesTaxApplied: st > 0, SalesTaxRate: '', SalesTaxAmount: st,
        PSTApplied: pst > 0, PSTRate: '', PSTAmount: pst,
        SecurityApplied: sec > 0, SecurityMode: '', SecurityBasis: '', SecurityRate: '', SecurityAmount: sec,
        PenaltyApplied: pen > 0, PenaltyMode: '', PenaltyBasis: '', PenaltyRate: '', PenaltyAmount: pen,
        OtherDeductionApplied: oth > 0, OtherDeductionMode: '', OtherDeductionCategory: '', OtherDeductionBasis: '', OtherDeductionRate: '', OtherDeductionAmount: oth,
        StudentDeductionApplied: false, StudentDeductionCategory: '', StudentDeductionBasis: '', StudentDeductionAmount: 0,
        // EmployeeCategory stays blank on purpose: the original bulk line still counts once toward the
        // person's Section 149 annual income; a second counted copy here would double-count it.
        EmployeeCategory: '', ExamSubCategory: '', AffidavitLowIncome: false, IncomeBeforeThisBill: '', IncomeAfterThisBill: '',
        Section149CreditApplied: 0, NonUETaxMethod: '',
        ThesisClass: line.ThesisClass || '', ThesisStudentName: line.ThesisStudentName || '', BenevolentFundSubCategory: line.BenevolentFundSubCategory || '',
        VisitingProgram: line.VisitingProgram || '', VisitingSubject: line.VisitingSubject || '', VisitingCrHrs: line.VisitingCrHrs || '',
        VisitingRate: line.VisitingRate || '', VisitingLectures: line.VisitingLectures || '',
        PayFromAccountID: line.PayFromAccountID || parent.PayFromAccountID || '', PayFromAccountLabel: line.PayFromAccountLabel || parent.PayFromAccountLabel || '',
        PayFromAccountNumber: line.PayFromAccountNumber || parent.PayFromAccountNumber || '',
        ReceivingOfficeID: line.ReceivingOfficeID || parent.ReceivingOfficeID || '', ReceivingOffice: line.ReceivingOffice || parent.ReceivingOffice || '',
        ContractCategory: '', ManualTaxOverride: false, ManualTaxSection: '', ManualTaxMode: '', ManualTaxRate: '', ManualTaxAmount: '',
        ManualSalesTaxOverride: false, SalesTaxMode: '', ManualPSTOverride: false, PSTMode: '',
        BudgetAllocatedAtEntry: '', BudgetExpensesBeforeThisBill: '', BudgetAfterThisBill: '',
        RedirectedFromEntryID: '', RedirectedToEntryID: '', Section149PaidCreditRecorded: false,
        OnHold: false, HoldReason: '', HoldBy: '', HoldDate: '', ReleasedBy: '', ReleasedDate: '',
        PaymentStatus: 'Failed', PaymentConfirmedDate: '', PaymentConfirmedBy: '',
        PaymentFailureReason: reason, PaymentFailureLoggedBy: username, PaymentFailureDate: now,
        PaymentRetryOfEntryID: '', PaymentRetryCount: 0,
        SplitFromEntryID: ref.parentId, SplitFromLineNo: line.LineNo,
        RecoveryDeducted: n(line.RecoveryDeducted),
        NetAmount: net
      });
      childRows.push(eh.map(h => (h && child[h] !== undefined) ? child[h] : ''));

      // The parent bulk bill is deliberately left untouched: it keeps its FULL amount in the budget. The isolated bill
      // (E123-A ...) carries SplitFromEntryID, which excludes it from every budget figure, so it is never charged twice.

      lrow[B.LinePaymentStatus] = 'Isolated'; lrow[B.LinePaymentFailureReason] = reason;
      lrow[B.LinePaymentFailureLoggedBy] = username; lrow[B.LinePaymentFailureDate] = now; lrow[B.SplitToEntryID] = newId;

      events.push({ EntryID: ref.parentId + '-' + line.LineNo, BatchID: parent.BatchID || '', EventType: 'Failed', EventDate: now, LoggedBy: username,
        Notes: reason + ' - isolated as new bill ' + newId });
      events.push({ EntryID: newId, BatchID: parent.BatchID || '', EventType: 'Failed', EventDate: now, LoggedBy: username,
        Notes: 'Isolated from bulk bill ' + ref.parentId + ' (line ' + line.LineNo + '): ' + reason });
      created.push({ lineId: id, newEntryId: newId });
      touchedParents.add(ref.parentId);
    });

    if (!created.length) return { success: false, count: 0, created, skipped, message: skipped.join(' | ') || 'Nothing was marked failed.' };

    const writeCol = (sh, vals, c) => sh.getRange(2, c + 1, vals.length - 1, 1).setValues(vals.slice(1).map(r => [r[c]]));
    ['LinePaymentStatus', 'LinePaymentFailureReason', 'LinePaymentFailureLoggedBy', 'LinePaymentFailureDate', 'SplitToEntryID']
      .forEach(c => writeCol(bSh, bVals, B[c]));

    const startRow = eSh.getLastRow() + 1;
    const needed = startRow + childRows.length - 1;
    if (eSh.getMaxRows() < needed) eSh.insertRowsAfter(eSh.getMaxRows(), needed - eSh.getMaxRows());
    eSh.getRange(startRow, 1, childRows.length, eh.length).setValues(childRows);

    appendPaymentEvents_(events);
    recomputeParentPaymentStatuses_(touchedParents);
    invalidateCache_(SHEETS.ENTRIES); invalidateCache_(SHEETS.BULKITEMS);
    return { success: true, count: created.length, created, skipped, message: skipped.join(' | ') };
  });
}

// Older failures (before isolation existed) can still be resubmitted per line.
function resubmitFailedBulkLine(lineId, username) {
  requireRole_(username, ['IBFT']);
  const ref = parseBulkLineId_(lineId);
  if (!ref) return { success: false, message: 'Not a valid beneficiary line ID.' };
  const line = getTable(SHEETS.BULKITEMS).find(li => li.ParentEntryID === ref.parentId && String(li.LineNo) === String(ref.lineNo));
  if (!line) return { success: false, message: 'Beneficiary line not found.' };
  if (line.LinePaymentStatus !== 'Failed') return { success: false, message: 'This beneficiary is not currently marked Failed.' };
  return withLock_(() => {
    const newRetry = Number(line.LinePaymentRetryCount || 0) + 1;
    updateBulkLineItemByParentAndLineNo_(ref.parentId, ref.lineNo, {
      LinePaymentStatus: 'Submitted', LinePaymentRetryCount: newRetry
    });
    recomputeParentPaymentStatuses_([ref.parentId]);
    appendPaymentEvents_([{
      EntryID: lineId, BatchID: '', EventType: 'Retried', EventDate: new Date(), LoggedBy: username,
      Notes: 'Beneficiary detail corrected, resubmitted for confirmation (retry #' + newRetry + ').'
    }]);
    invalidateCache_(SHEETS.ENTRIES);
    return { success: true };
  });
}

function updateFailedBulkLineBeneficiary(lineId, updates, username) {
  requireRole_(username, ['IBFT']);
  const ref = parseBulkLineId_(lineId);
  if (!ref) return { success: false, message: 'Not a valid beneficiary line ID.' };
  const fields = {
    VendorName: updates.name !== undefined ? String(updates.name).trim() : undefined,
    IBAN: updates.iban !== undefined ? String(updates.iban).replace(/\s+/g, '').toUpperCase() : undefined,
    CNIC_NTN: updates.cnic !== undefined ? String(updates.cnic).trim() : undefined
  };
  Object.keys(fields).forEach(k => { if (fields[k] === undefined) delete fields[k]; });
  if (!Object.keys(fields).length) return { success: false, message: 'Nothing to update.' };
  if (fields.CNIC_NTN && !isValidCnicOrNtnFormat_(fields.CNIC_NTN)) {
    return { success: false, message: 'CNIC/NTN must be a CNIC (35201-1222334-4) or an NTN (12345678).' };
  }
  if (fields.IBAN && !/^PK\d{2}[A-Z0-9]{20}$/.test(fields.IBAN)) {
    return { success: false, message: 'IBAN must start with PK and be 24 characters in total.' };
  }
  return withLock_(() => {
    const ok = updateBulkLineItemByParentAndLineNo_(ref.parentId, ref.lineNo, fields);
    if (!ok) return { success: false, message: 'Beneficiary line not found.' };
    return { success: true };
  });
}

// Per-line queue for older Failed lines (Reconciliation) or lines awaiting confirmation.
function getLineLevelConfirmationQueue(fy, wantFailed) {
  const parents = getTable(SHEETS.ENTRIES).filter(e =>
    e.PayeeType === 'Bulk' && statusEquals_(e.Status, STATUS.PAID) && fyMatches_(e.FY, fy));
  if (!parents.length) return [];
  const parentIds = new Set(parents.map(e => e.EntryID));
  const parentById = {}; parents.forEach(e => parentById[e.EntryID] = e);
  return getTable(SHEETS.BULKITEMS).filter(li => parentIds.has(li.ParentEntryID) &&
    (wantFailed ? li.LinePaymentStatus === 'Failed'
                : (li.LinePaymentStatus !== 'Confirmed' && li.LinePaymentStatus !== 'Isolated'))
  ).map(li => Object.assign({}, li, {
    EntryID: li.ParentEntryID + '-' + li.LineNo, ParentBillID: li.ParentEntryID,
    BatchID: parentById[li.ParentEntryID].BatchID, PaidDate: parentById[li.ParentEntryID].PaidDate
  }));
}

/* =================================================================
   LETTER / DIARY ATTACHMENTS (stored in Google Drive; served back through the app, never by public link)
   ================================================================= */
const ATTACHMENT_MAX_BYTES_ = 5 * 1024 * 1024;
const ATTACHMENT_ALLOWED_EXT_ = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

function validateAttachmentInput_(att) {
  if (!att || !att.base64 || !att.name) return { error: 'The attached file is empty or unreadable.' };
  const ext = String(att.name).split('.').pop().toLowerCase();
  if (!ATTACHMENT_ALLOWED_EXT_[ext]) return { error: 'Only PDF or JPEG/JPG (or PNG) files can be attached.' };
  const approxBytes = Math.floor(String(att.base64).length * 3 / 4);
  if (approxBytes > ATTACHMENT_MAX_BYTES_) return { error: 'The file is too large (5 MB maximum).' };
  return { ext: ext };
}
function getDiaryAttachmentFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DIARY_ATTACHMENT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* folder was removed - make a new one below */ } }
  const folder = DriveApp.createFolder('UE Finance - Diary Attachments');
  props.setProperty('DIARY_ATTACHMENT_FOLDER_ID', folder.getId());
  return folder;
}
function saveDiaryAttachment_(diaryId, movementId, kind, att, username) {
  const chk = validateAttachmentInput_(att);
  if (chk.error) throw new Error(chk.error);
  const mime = ATTACHMENT_ALLOWED_EXT_[chk.ext];
  const safeName = String(att.name).replace(/[\\\/:*?"<>|]/g, '_');
  const attId = nextId_('AT', SHEETS.LETTERATTACH, 'AttachmentID');
  const bytes = Utilities.base64Decode(att.base64);
  const blob = Utilities.newBlob(bytes, mime, diaryId + '_' + attId + '_' + safeName);
  const file = getDiaryAttachmentFolder_().createFile(blob);
  appendRowObj(SHEETS.LETTERATTACH, {
    AttachmentID: attId, DiaryID: diaryId, MovementID: movementId, Kind: kind, FileName: att.name, MimeType: mime,
    FileSize: bytes.length, DriveFileId: file.getId(), UploadedBy: username, UploadedDate: new Date()
  });
  return attId;
}
function getDiaryAttachments_(diaryId) {
  return getTable(SHEETS.LETTERATTACH).filter(r => r.DiaryID === diaryId)
    .sort((a, b) => new Date(a.UploadedDate) - new Date(b.UploadedDate))
    .map(r => ({ attachmentId: r.AttachmentID, movementId: r.MovementID, kind: r.Kind, fileName: r.FileName,
      mimeType: r.MimeType, fileSize: Number(r.FileSize || 0), uploadedBy: r.UploadedBy, uploadedDate: r.UploadedDate }));
}
// Any signed-in user who can see a Diary trail can open its files (the same rule as the trail itself).
function getDiaryAttachmentData(attachmentId) {
  const row = getTable(SHEETS.LETTERATTACH).find(r => r.AttachmentID === String(attachmentId));
  if (!row) return { success: false, message: 'Attachment not found.' };
  try {
    const blob = DriveApp.getFileById(row.DriveFileId).getBlob();
    return { success: true, name: row.FileName, mime: row.MimeType, base64: Utilities.base64Encode(blob.getBytes()) };
  } catch (err) {
    return { success: false, message: 'Could not open the file: ' + err.message };
  }
}

/* =================================================================
   ONE-TIME REPAIR (run from the Apps Script editor, safe to re-run)
   Before this version, isolating a failed beneficiary REDUCED the parent bulk bill's Amount/tax/Net by that
   beneficiary's figures. The parent must keep its full amount, so each affected parent's totals are rebuilt
   from its beneficiary lines (lines redirected to another bill are still excluded, as before).
   ================================================================= */
function repairBulkParentTotalsAfterIsolation() {
  return withLock_(() => {
    const lines = getTable(SHEETS.BULKITEMS);
    const parentsWithIsolation = new Set(lines.filter(li => li.SplitToEntryID).map(li => String(li.ParentEntryID)));
    if (!parentsWithIsolation.size) return 'No isolated beneficiary lines found - nothing to repair.';
    const n = v => Number(v || 0);
    const totals = {};
    lines.forEach(li => {
      const pid = String(li.ParentEntryID);
      if (!parentsWithIsolation.has(pid) || li.RedirectedToEntryID) return;
      const t = totals[pid] || (totals[pid] = { amt: 0, it: 0, st: 0, pst: 0, sec: 0, pen: 0, oth: 0, net: 0 });
      t.amt += n(li.Amount); t.it += n(li.IncomeTaxAmount); t.st += n(li.SalesTaxAmount); t.pst += n(li.PSTAmount);
      t.sec += n(li.SecurityAmount); t.pen += n(li.PenaltyAmount); t.oth += n(li.OtherDeductionAmount);
      t.net += (li.NetAmount !== '' && li.NetAmount !== undefined) ? n(li.NetAmount)
        : (n(li.Amount) - n(li.IncomeTaxAmount) - n(li.SalesTaxAmount) - n(li.PSTAmount) - n(li.SecurityAmount) - n(li.PenaltyAmount) - n(li.OtherDeductionAmount));
    });
    const sh = getOrCreateSheet_(SHEETS.ENTRIES);
    const range = sh.getDataRange();
    const values = range.getValues();
    const h = values[0];
    const col = {}; ['EntryID','Amount','IncomeTaxAmount','SalesTaxAmount','PSTAmount','SecurityAmount','PenaltyAmount','OtherDeductionAmount','NetAmount']
      .forEach(c => col[c] = h.indexOf(c));
    let fixed = 0;
    for (let i = 1; i < values.length; i++) {
      const t = totals[String(values[i][col.EntryID])];
      if (!t) continue;
      values[i][col.Amount] = round0_(t.amt); values[i][col.IncomeTaxAmount] = round0_(t.it); values[i][col.SalesTaxAmount] = round0_(t.st);
      values[i][col.PSTAmount] = round0_(t.pst); values[i][col.SecurityAmount] = round0_(t.sec); values[i][col.PenaltyAmount] = round0_(t.pen);
      values[i][col.OtherDeductionAmount] = round0_(t.oth); values[i][col.NetAmount] = round0_(t.net);
      fixed++;
    }
    range.setValues(values);
    invalidateCache_(SHEETS.ENTRIES);
    return 'Rebuilt the full totals of ' + fixed + ' bulk bill(s) that had an isolated beneficiary.';
  });
}


/* =================================================================
   ADMIN: EDIT / CANCEL / RESTORE / DE-LINK / LINK a Diary number
   (to complete or correct a bill's cycle). Every action is written to
   the item's movement trail with who did it and why.
   ================================================================= */
function adminDiaryLog_(diaryId, actionType, actor, details) {
  appendRowObj(SHEETS.LETTERMOVEMENTS, {
    MovementID: nextMovementId_(), DiaryID: diaryId, ActionType: actionType,
    FromUser: actor, ToUser: '', ActionDate: new Date(), ResponseRefNo: '', ResponseDate: '',
    Details: details || '', ReturnObjection: '', ReturnRefNo: '', ReturnDate: '', ReturnReceiverName: ''
  });
}

function adminSearchDiary(filters, actorUsername) {
  requireAdmin_(actorUsername);
  filters = filters || {};
  const low = v => String(v || '').trim().toLowerCase();
  const fId = low(filters.diaryId), fBill = low(filters.billId), fQ = low(filters.query);
  let rows = getTable(SHEETS.DIARY);
  if (filters.status) rows = rows.filter(d => d.Status === filters.status);
  if (fId) rows = rows.filter(d => low(d.DiaryID).includes(fId));
  if (fBill) rows = rows.filter(d => low(d.LinkedEntryID).includes(fBill));
  if (fQ) rows = rows.filter(d => low(diarySenderLabel_(d)).includes(fQ) || low(d.RoughDescription).includes(fQ) ||
    low(d.EmployeeID).includes(fQ) || low(d.SenderReferenceNo).includes(fQ));
  rows.sort((a, b) => String(b.DiaryID).localeCompare(String(a.DiaryID)));
  const total = rows.length;
  return {
    success: true, total: total,
    rows: rows.slice(0, 300).map(d => ({
      diaryId: d.DiaryID, itemType: d.ItemType, billType: d.BillType || '',
      dateReceived: d.DateReceived ? fmtDate_(d.DateReceived) : '', senderReferenceDate: d.SenderReferenceDate ? fmtDate_(d.SenderReferenceDate) : '',
      senderReferenceNo: d.SenderReferenceNo || '', senderType: d.SenderType, senderLabel: diarySenderLabel_(d),
      vendorName: d.VendorName || '', employeeId: d.EmployeeID || '', cnic: d.CNIC_NTN || '', senderOfficeName: d.SenderOfficeName || '',
      originatingOfficeId: d.OriginatingOfficeID || '', originatingOffice: diaryOriginatingOfficeLabel_(d), originatingOfficeOther: d.OriginatingOfficeOther || '',
      description: d.RoughDescription || '', amount: (d.Amount !== '' && d.Amount !== undefined && d.Amount !== null) ? Number(d.Amount) : null,
      assignedTo: d.AssignedToUsername || '', status: d.Status, linkedEntryId: d.LinkedEntryID || '', loggedBy: d.LoggedBy || ''
    }))
  };
}

function adminUpdateDiary(diaryId, upd, actorUsername) {
  requireAdmin_(actorUsername);
  upd = upd || {};
  const d = getDiaryById(diaryId);
  if (!d) return { success: false, message: 'Diary item not found.' };
  const senderType = ['Vendor', 'Employee', 'NonUEEmployee', 'Office'].indexOf(upd.senderType) !== -1 ? upd.senderType : d.SenderType;
  const t = v => String(v === undefined || v === null ? '' : v).trim();
  if (senderType === 'Vendor' && !t(upd.vendorName)) return { success: false, message: 'Vendor Name is required.' };
  if (senderType === 'Employee' && !t(upd.employeeId)) return { success: false, message: 'Employee ID is required.' };
  if (senderType === 'NonUEEmployee' && (!t(upd.cnic) || !t(upd.vendorName))) return { success: false, message: 'Non-UE Employee CNIC and Name are both required.' };
  if (senderType === 'Office' && !t(upd.senderOfficeName)) return { success: false, message: 'Sender Office Name is required.' };
  if (!t(upd.dateReceived)) return { success: false, message: 'Date Received is required.' };

  let officeId = '', officeName = '', officeOther = '';
  if (upd.originatingOfficeId === '__others__') {
    if (!t(upd.originatingOfficeOther)) return { success: false, message: 'Enter the Originating Office name.' };
    officeOther = t(upd.originatingOfficeOther);
  } else {
    const office = getReceivingOffices().find(o => o.OfficeID === upd.originatingOfficeId);
    if (!office) return { success: false, message: 'Select the Originating Office (or Others).' };
    officeId = office.OfficeID; officeName = office.OfficeName;
  }
  let amount = d.Amount, billType = d.BillType;
  if (d.ItemType === 'Bill') {
    amount = Math.round(Number(upd.amount) || 0);
    if (!amount || amount <= 0) return { success: false, message: 'Enter the Amount of the bill.' };
    billType = upd.billType === 'Bulk' ? 'Bulk' : (upd.billType === 'Single' ? 'Single' : '');
    if (!billType) return { success: false, message: 'Select Single bill or Bulk bill.' };
  }
  const updates = {
    DateReceived: t(upd.dateReceived), SenderReferenceDate: t(upd.senderReferenceDate), SenderReferenceNo: t(upd.senderReferenceNo),
    SenderType: senderType,
    VendorName: (senderType === 'Vendor' || senderType === 'NonUEEmployee') ? t(upd.vendorName) : '',
    EmployeeID: senderType === 'Employee' ? t(upd.employeeId) : '',
    CNIC_NTN: senderType === 'NonUEEmployee' ? t(upd.cnic) : '',
    SenderOfficeName: senderType === 'Office' ? t(upd.senderOfficeName) : '',
    OriginatingOfficeID: officeId, OriginatingOfficeName: officeName, OriginatingOfficeOther: officeOther,
    RoughDescription: t(upd.roughDescription), Amount: amount, BillType: billType
  };
  const labels = { DateReceived: 'Date Received', SenderReferenceDate: "Sender's Date", SenderReferenceNo: 'Reference No.', SenderType: 'Sender Type',
    VendorName: 'Vendor/Name', EmployeeID: 'Employee ID', CNIC_NTN: 'CNIC', SenderOfficeName: 'Sender Office', OriginatingOfficeName: 'Originating Office',
    OriginatingOfficeOther: 'Originating Office (other)', RoughDescription: 'Description', Amount: 'Amount', BillType: 'Bill Type' };
  const norm = (k, v) => (k === 'DateReceived' || k === 'SenderReferenceDate') ? (v ? fmtDate_(v) : '') : String(v === undefined || v === null ? '' : v).trim();
  const changes = [];
  Object.keys(updates).forEach(k => {
    const before = norm(k, d[k]), after = norm(k, updates[k]);
    if (before !== after && labels[k]) changes.push(labels[k] + ': "' + before + '" -> "' + after + '"');
  });
  if (!changes.length) return { success: false, message: 'Nothing was changed.' };
  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, updates);
    adminDiaryLog_(diaryId, 'AdminEdited', actorUsername, 'Edited by Admin - ' + changes.join('; '));
    return { success: true };
  });
}

function adminCancelDiary(diaryId, reason, actorUsername) {
  requireAdmin_(actorUsername);
  if (!String(reason || '').trim()) return { success: false, message: 'A reason is required.' };
  const d = getDiaryById(diaryId);
  if (!d) return { success: false, message: 'Diary item not found.' };
  if (d.Status === 'Cancelled') return { success: false, message: 'Already cancelled.' };
  if (d.LinkedEntryID) return { success: false, message: 'This Diary number is linked to Bill ' + d.LinkedEntryID + ' - De-link it first.' };
  if (d.Status === 'Closed') return { success: false, message: 'A closed letter cannot be cancelled.' };
  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, {
      Status: 'Cancelled', ClosedDate: new Date(), ClosedBy: actorUsername,
      PendingOfficeConfirmation: false, OfficeName: '', HeldByUsername: '', HeldDate: '', HeldReason: ''
    });
    adminDiaryLog_(diaryId, 'AdminCancelled', actorUsername, 'Cancelled by Admin: ' + reason.trim());
    return { success: true };
  });
}

function adminRestoreDiary(diaryId, reason, actorUsername) {
  requireAdmin_(actorUsername);
  const d = getDiaryById(diaryId);
  if (!d) return { success: false, message: 'Diary item not found.' };
  if (d.Status !== 'Cancelled') return { success: false, message: 'This item is not cancelled.' };
  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { Status: 'Pending', ClosedDate: '', ClosedBy: '' });
    adminDiaryLog_(diaryId, 'AdminRestored', actorUsername, 'Cancellation reversed by Admin' + (reason ? ': ' + reason : '') + ' - back to Pending with ' + (d.AssignedToUsername || 'nobody'));
    return { success: true };
  });
}

// Breaks the link between a Diary number and its bill; the Diary item goes back to Pending (it can be entered or linked again).
function adminDelinkDiary(diaryId, reason, actorUsername) {
  requireAdmin_(actorUsername);
  if (!String(reason || '').trim()) return { success: false, message: 'A reason is required.' };
  const d = getDiaryById(diaryId);
  if (!d) return { success: false, message: 'Diary item not found.' };
  if (!d.LinkedEntryID) return { success: false, message: 'This Diary number is not linked to any bill.' };
  const entryId = d.LinkedEntryID;
  const entry = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { Status: 'Pending', LinkedEntryID: '' });
    if (entry) {
      const remaining = getDiaryRowsForEntry_(entryId).map(x => x.DiaryID).filter(x => x !== diaryId);
      const upd = {};
      if (entry.PayeeType === 'Bulk') upd.DiaryIDs = remaining.join(', ');
      if (entry.DiaryID === diaryId) {
        upd.DiaryID = remaining[0] || '';
        if (!remaining.length) upd.DiaryBypassReason = (entry.DiaryBypassReason ? entry.DiaryBypassReason + ' | ' : '') + 'Diary ' + diaryId + ' de-linked by ' + actorUsername + ' on ' + fmtDate_(new Date()) + ': ' + reason.trim();
      }
      if (Object.keys(upd).length) updateRowByKey(SHEETS.ENTRIES, 'EntryID', entryId, upd);
    }
    adminDiaryLog_(diaryId, 'AdminDelinked', actorUsername, 'De-linked from Bill ' + entryId + ' by Admin: ' + reason.trim());
    return { success: true, entryId: entryId };
  });
}

// Attaches a (not yet linked) Bill-type Diary number to an existing bill. A bulk bill can take several Diary numbers.
function adminLinkDiaryToBill(diaryId, entryId, reason, actorUsername) {
  requireAdmin_(actorUsername);
  entryId = String(entryId || '').trim().toUpperCase();
  if (!entryId) return { success: false, message: 'Enter the Bill ID.' };
  if (!String(reason || '').trim()) return { success: false, message: 'A reason is required.' };
  const d = getDiaryById(diaryId);
  if (!d) return { success: false, message: 'Diary item not found.' };
  if (d.ItemType !== 'Bill') return { success: false, message: 'Only a Bill-type Diary number can be linked to a bill.' };
  if (d.LinkedEntryID) return { success: false, message: 'Already linked to Bill ' + d.LinkedEntryID + ' - De-link it first.' };
  if (d.Status !== 'Pending' || truthy_(d.PendingOfficeConfirmation)) {
    return { success: false, message: 'This Diary number is "' + d.Status + '"' + (truthy_(d.PendingOfficeConfirmation) ? ' (sent to an office)' : '') + ' - it must be Pending to be linked. Resume or restore it first.' };
  }
  const entry = getTable(SHEETS.ENTRIES).find(e => e.EntryID === entryId);
  if (!entry) return { success: false, message: 'Bill ' + entryId + ' was not found.' };
  if (statusEquals_(entry.Status, STATUS.CANCELLED)) return { success: false, message: 'Bill ' + entryId + ' is cancelled.' };
  const existing = getDiaryRowsForEntry_(entryId);
  if (entry.PayeeType !== 'Bulk' && existing.length) {
    return { success: false, message: 'Bill ' + entryId + ' is already linked to ' + existing.map(x => x.DiaryID).join(', ') + ' - De-link that first (a single bill carries one Diary number).' };
  }
  return withLock_(() => {
    updateRowByKey(SHEETS.DIARY, 'DiaryID', diaryId, { Status: 'Entered', LinkedEntryID: entryId });
    const all = existing.map(x => x.DiaryID).concat([diaryId]);
    const upd = {};
    if (!entry.DiaryID) upd.DiaryID = diaryId;
    if (entry.PayeeType === 'Bulk') upd.DiaryIDs = all.join(', ');
    if (Object.keys(upd).length) updateRowByKey(SHEETS.ENTRIES, 'EntryID', entryId, upd);
    adminDiaryLog_(diaryId, 'AdminLinked', actorUsername, 'Linked to Bill ' + entryId + ' by Admin: ' + reason.trim());
    const rows = existing.concat([getDiaryById(diaryId)]);
    const warnings = entry.PayeeType === 'Bulk'
      ? diaryMismatchWarningsMulti_(rows, Number(entry.Amount || 0))
      : diaryMismatchWarnings_(getDiaryById(diaryId), Number(entry.Amount || 0), false);
    return { success: true, warnings: warnings };
  });
}
