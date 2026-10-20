/* ================= AI Report (Google Gemini) =================
   Answers a plain-English question about the bill database using Google
   Gemini. The AI is given a CSV extract of the actual data and is
   explicitly instructed to work ONLY from that data - no outside knowledge,
   no opinions, no recommendations, only factual reporting grounded in what
   is actually on record. The API key is the user's own, entered once in
   Reports > AI Report, stored in this script's own Properties (never in a
   sheet cell, never returned back to the browser once saved).
   ================================================================= */

const AI_MODEL_DEFAULT = 'gemini-2.0-flash';

/* ---------- API key / model management (Admin-only to change) ---------- */
function saveGeminiApiKey(actorUsername, apiKey) {
  requireAdmin_(actorUsername);
  apiKey = String(apiKey || '').trim();
  if (!apiKey) return { success:false, message:'Enter an API key.' };
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', apiKey);
  return { success:true };
}
function clearGeminiApiKey(actorUsername) {
  requireAdmin_(actorUsername);
  PropertiesService.getScriptProperties().deleteProperty('GEMINI_API_KEY');
  return { success:true };
}
function saveGeminiModel(actorUsername, model) {
  requireAdmin_(actorUsername);
  model = String(model || '').trim();
  if (model) PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', model);
  else PropertiesService.getScriptProperties().deleteProperty('GEMINI_MODEL');
  return { success:true };
}
function getGeminiModel_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || AI_MODEL_DEFAULT;
}
// Anyone can check WHETHER a key is set (needed to show the right UI state) -
// the key value itself is never returned.
function getGeminiKeyStatus() {
  const hasKey = !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  return { hasKey: hasKey, model: getGeminiModel_() };
}

/* ---------- Dataset the AI is allowed to see ---------- */
// One row per actual beneficiary (bulk bills expanded, same as every other
// report) - covers everything needed for consumption comparisons,
// bill-status lookups, per-person bill history, and tax-by-section totals.
function buildAIDataset_(fy) {
  let entries = getTable(SHEETS.ENTRIES);
  if (fy) entries = entries.filter(e => fyMatches_(e.FY, fy));
  const bulkParents = entries.filter(e => e.PayeeType === 'Bulk');
  const normalRows = entries.filter(e => e.PayeeType !== 'Bulk');
  const rows = normalRows.concat(expandBulkItems_(bulkParents));

  const cols = ['EntryID','EntryDate','FY','CampusName','HeadCode','HeadName','PayeeType','VendorName','EmployeeID',
    'CNIC_NTN','BillNo','BillDescription','BillNature','Amount','IncomeTaxSection','IncomeTaxAmount','SalesTaxAmount',
    'PSTAmount','SecurityAmount','PenaltyAmount','OtherDeductionAmount','NetAmount','Status',
    'ProcessedDate','PassedDate','PaidDate'];
  const lines = [cols.join(',')];
  rows.forEach(e => { lines.push(cols.map(c => aiCsvEscape_(e[c])).join(',')); });
  return { csv: lines.join('\n'), rowCount: rows.length, columns: cols };
}
function aiCsvEscape_(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = (v instanceof Date) ? Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Karachi', 'yyyy-MM-dd') : String(v);
  if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/* ---------- Main entry point ---------- */
// filters (optional): { fy }
function askAIReport(question, fy, username) {
  question = String(question || '').trim();
  if (!question) return { success:false, message:'Enter a question.' };
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return { success:false, message:'No Gemini API key has been set yet - an Admin needs to add one above first.' };

  const dataset = buildAIDataset_(fy);
  if (dataset.rowCount === 0) return { success:false, message:'No bills found for that Financial Year - try "All Years" or a different one.' };
  // Gemini's context window is generous, but this keeps requests reasonably
  // sized/fast - if it's ever hit, narrowing the Financial Year filter is
  // the fix (the message below tells the user exactly that).
  if (dataset.csv.length > 4000000) {
    return { success:false, message:'That much data is too large for one request - please pick a specific Financial Year above to narrow it down.' };
  }

  const systemInstruction =
    'You are a reporting assistant for a university campus budget and accounting system. ' +
    'You will be given a CSV extract of the bill database (one row per beneficiary/bill) and a question about it. ' +
    'Answer using ONLY the data in the CSV below - never use outside knowledge, never guess, and never invent figures ' +
    'or bill IDs that are not present in the data. ' +
    'You must not offer opinions, recommendations, advice, warnings, or suggestions of any kind, even if asked - your ' +
    'only job is factual reporting: summaries, totals, counts, comparisons, and lists drawn strictly from the given data. ' +
    'If the data does not contain enough information to answer, say so plainly instead of guessing or extrapolating. ' +
    'When useful, present figures in a markdown table. Cite specific Bill IDs (the EntryID column) when referencing ' +
    'individual bills. All currency figures are in PKR (Pakistani Rupees). Columns: ' + dataset.columns.join(', ') + '.';

  const payload = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text:
      'DATA (CSV, ' + dataset.rowCount + ' rows):\n' + dataset.csv + '\n\nQUESTION: ' + question
    }] }],
    generationConfig: { temperature: 0.1 }
  };

  const model = getGeminiModel_();
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) +
    ':generateContent?key=' + encodeURIComponent(apiKey);

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    return { success:false, message: 'Could not reach Gemini: ' + err.message };
  }

  const code = res.getResponseCode();
  let body;
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { body = {}; }

  if (code !== 200) {
    const msg = (body.error && body.error.message) ? body.error.message : ('Gemini API returned HTTP ' + code);
    return { success:false, message: msg };
  }

  const candidate = body.candidates && body.candidates[0];
  const finishReason = candidate && candidate.finishReason;
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map(p => p.text || '').join('')
    : '';

  if (!text) {
    if (finishReason === 'SAFETY') return { success:false, message:'Gemini declined to answer that question (safety filter). Try rephrasing it.' };
    return { success:false, message:'Gemini returned an empty response - try rephrasing the question or check the API key.' };
  }

  return { success:true, answer: text, rowCount: dataset.rowCount, model: model };
}