# Guide 2 - Put it on the internet to test (Render.com, free)

You need the GitHub repository from Guide 1 (steps 1-3).

1. Create a free account at render.com (sign in with GitHub).
2. Click **New +** > **Web Service** > connect your `ue-finance-erp` repository.
3. Fill in:
   - Language/Runtime: **Node**
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Instance type: **Free**
4. Click **Create Web Service**. After 3-5 minutes Render shows a link like `https://ue-finance-erp.onrender.com`.
5. Open it and log in with admin / admin123.

## Things to know
- Free instances sleep after ~15 minutes of no use; the first visit afterwards takes about a minute.
- **Free Render has no permanent disk: data resets on every restart/redeploy.** This is fine for testing.
  For real use, either (a) paid Render with a Disk mounted at `/var/data` and an environment variable
  `DATA_DIR` = `/var/data`, or (b) ask a developer to swap `server/store.js` for a real database (PostgreSQL).
- Do not use real salaries/CNICs/IBANs on a test deployment.
- Other hosts work the same way (Railway, Fly.io, a VPS): build `npm install && npm run build`, start `npm start`.
  The app uses the `PORT` environment variable automatically.

## Test checklist after deploying
- Login page appears, admin login works, password change works.
- Add allocation, enter a bill, take it through Processing > Passing > Payment > Confirmation.
- Download an IBFT CSV and a PDF report.
- Reports > AI Report (needs your Gemini key; the server must be able to reach the internet).
