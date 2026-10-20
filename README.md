# UE Finance ERP - Node.js + React version

This is your Google Apps Script project (ERP & Budget Utilization Module) converted to a
Node.js server with a React website. All your accounting logic (bill pipeline, Section 149/153
tax, Diary, Confirmation, Reconciliation, Reports, AI report) is your ORIGINAL code, running
unchanged on the server. Data is stored in one file: `data/db.json` (no Google Sheets needed).

First login: **admin / admin123** (change it when asked).

## Quick start (any computer with Node 18+)
    npm install
    npm start
Then open http://localhost:3000

## What is where
- `server/gas/*.gs`   your original files, untouched
- `server/gas-shim.js` stands in for Google Sheets/Cache/Properties/Drive
- `server/store.js`    the database file (data/db.json)
- `server/index.js`    the web server and API
- `client/`            the React website;  `legacy-src/` your original screens
- `scripts/smoke-test.js`  automatic self-test (`npm test`)

## Notes
- Data resets if the host wipes its disk (free hosts do). Use a persistent disk and set DATA_DIR.
- AI Report: log in as Admin, Reports > AI Report, paste your Gemini key.
- Diary attachments are stored in `data/files`.
