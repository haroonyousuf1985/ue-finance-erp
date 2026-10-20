/* ============================================================
   UE Finance ERP - web server (Node.js + Express)
   - Serves the React website (client/dist)
   - Offers the few web addresses the website talks to (/api/...)
   - Runs the original accounting code through gas-shim.js
   ============================================================ */
process.env.TZ = 'Asia/Karachi';   // must be set before anything touches dates

const path = require('path');
const fs = require('fs');
const express = require('express');
const { loadGas } = require('./load-gas');
const { flushSync, DB_FILE } = require('./store');

const gas = loadGas();

// Create every table and the first login (admin / admin123) if this is a brand-new database.
const readyMsg = gas.initializeSystem();
console.log('[setup] ' + readyMsg);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

function wrap(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req.body || {});
      res.json({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      res.json({ ok: false, error: (err && err.message) ? err.message : String(err) });
    }
  };
}

app.post('/api/login', wrap(b => gas.apiLogin(b.username, b.password)));
app.post('/api/logout', wrap(b => gas.apiLogout(b.token)));
app.post('/api/call', wrap(b => gas.apiCall(b.token, b.fn, Array.isArray(b.args) ? b.args : [])));
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), dataFile: path.basename(DB_FILE) }));

const dist = path.join(__dirname, '..', 'client', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.log('[setup] The website has not been built yet - building it now (about 20 seconds)...');
  try {
    require('child_process').execSync('npx vite build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  } catch (e) {
    console.error('[setup] Could not build the website automatically. Run "npm run build" and then "npm start".');
  }
}
app.use(express.static(dist));
app.get('*', (req, res) => {
  const index = path.join(dist, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(503).send('The website is not built yet. Run: npm run build');
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(' UE Finance ERP is running on port ' + PORT);
  console.log(' First login:  admin  /  admin123');
  console.log('==================================================');
});
process.on('SIGTERM', () => { flushSync(); server.close(() => process.exit(0)); });
