/* Automatic self-test: starts the server on a temporary database and walks one bill through the whole pipeline. */
const { spawn } = require('child_process');
const os = require('os'), path = require('path'), fs = require('fs');
const PORT = 3099;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-test-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, DATA_DIR: dir }, stdio: 'pipe' });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
const post = async (u, b) => (await fetch('http://localhost:' + PORT + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
let token, fails = 0;
const call = async (fn, ...args) => { const r = await post('/api/call', { token, fn, args }); if (!r.ok) throw new Error(fn + ': ' + r.error); return r.result; };
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra))); if (!cond) fails++; };
(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch('http://localhost:' + PORT + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 200)); } }
  const bad = await post('/api/login', { username: 'admin', password: 'wrong' });
  check('wrong password refused', bad.ok && bad.result.success === false, bad);
  const lg = await post('/api/login', { username: 'admin', password: 'admin123' });
  check('admin login', lg.ok && lg.result.success, lg); token = lg.result.token;
  const noTok = await post('/api/call', { token: 'x', fn: 'getCampuses', args: [] });
  check('call without session refused', !noTok.ok && /SESSION/.test(noTok.error), noTok);
  const al = await call('saveAllocation', 'admin', { newCampusName: 'Main Campus', headCode: 'B-101', headName: 'Electricity', fy: '2026-27', amount: 1000000 });
  check('allocation saved', al.success, al);
  const campuses = await call('getCampuses'); const heads = await call('getBudgetHeads');
  check('campus + head listed', campuses.length === 1 && heads.length === 1, { campuses, heads });
  await call('addBankAccount', 'admin', { title: 'UE Main', bankName: 'HBL', accountNumber: 'PK00HBL0000000001', accountTitle: 'UE Main', number: 'PK00HBL0000000001' });
  await call('addReceivingOffice', 'admin', 'Estate Office');
  const accts = await call('getBankAccounts'), offs = await call('getReceivingOffices');
  const entry = {
    payeeType: 'Vendor', vendorName: 'ABC Traders', cnic: '12345678', iban: 'PK36SCBL0000001123456702', bankName: 'SCB',
    campusId: campuses[0].CampusID, campusName: 'Main Campus', headId: heads[0].HeadID, headCode: 'B-101', headName: 'Electricity',
    entryDate: '2026-10-18', fy: '2026-27', billNo: 'INV-1', billDescription: 'Electricity bill', amount: 100000,
    billNature: 'Supply of Goods', fbrStatus: 'Filer', taxpayerType: 'Company', applyIncomeTax: true,
    payFromAccountId: accts[0] && accts[0].AccountID, receivingOfficeId: offs[0] && offs[0].OfficeID, diaryBypassReason: 'smoke test'
  };
  const prev = await call('previewTaxCalculation', { ...entry, payeeType: 'Vendor', amount: 100000, billNature: 'Supply of Goods', taxpayerType: 'Company', fbrStatus: 'Filer', applyIT: true });
  check('tax preview works', prev && typeof prev === 'object', prev);
  const sub = await call('submitEntry', entry, 'admin');
  check('bill saved', sub.success, sub); const id = sub.entryId || sub.id;
  const rec = await call('getBillsByStatus', 'Received', '2026-27');
  check('bill is in Received', rec.length === 1, rec.length);
  check('processed', (await call('markProcessed', [id], 'admin')).success);
  check('passed', (await call('markPassed', [id], 'admin')).success);
  const paid = await call('markPaidAndGenerateIBFT', [id], '2026-10-19', 'admin');
  check('paid + IBFT batch', paid.success, paid);
  const q = await call('getPaymentsNeedingConfirmation', '2026-27');
  check('in confirmation queue', q.length === 1, q);
  check('confirmed', (await call('confirmPayments', [id], 'admin')).success);
  const rep = await call('getYearlyBudgetReport', '2026-27', []);
  check('yearly report returns data', !!rep, rep);
  const sys = await call('systemCheck');
  check('system check runs', !!sys);
  const u = await call('addUser', 'admin', 'clerk1', 'longpassword1', 'Clerk One', 'DiaryClerk');
  check('add user', u.success, u);
  srv.kill(); await new Promise(r => setTimeout(r, 600)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log(fails ? fails + ' TEST(S) FAILED\n' + log.slice(-1500) : 'ALL TESTS PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERROR ' + e.message + '\n' + log.slice(-1500)); srv.kill(); process.exit(1); });
