import React, { useEffect, useState } from 'react';
import { installGoogleScriptRun } from './gasBridge.js';

/* ============================================================
   App.jsx - the React shell.
   It prepares the browser (the google.script.run bridge), loads
   the finance screens (login, Diary, Entry, Processing, Passing,
   Payment, Confirmation, Reconciliation, Reports, Admin) and the
   PDF libraries, and then starts them.
   ============================================================ */

let started = false;

function loadScript(src, optional) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => (optional ? resolve() : reject(new Error('Could not load ' + src)));
    document.body.appendChild(el);
  });
}

async function startLegacyApp() {
  installGoogleScriptRun();

  const resp = await fetch('/legacy/body.html');
  if (!resp.ok) throw new Error('Could not load the screens (HTTP ' + resp.status + ').');
  const html = await resp.text();
  // Inserted straight into the page (not inside the React box) so every screen behaves exactly as in the original.
  document.body.insertAdjacentHTML('afterbegin', html);

  await loadScript('/legacy/scripts.js', false);

  // The original page started itself from window.onload; that event has already happened, so start it now.
  if (typeof window.onload === 'function') window.onload();

  // PDF export libraries (same ones as the original), loaded in the background. If the internet blocks them, only the PDF buttons are affected.
  loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', true)
    .then(() => loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js', true));
}

export default function App() {
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (started) return;
    started = true;
    startLegacyApp()
      .then(() => setStatus('ready'))
      .catch(err => { setStatus('error'); setMessage(err.message || String(err)); });
  }, []);

  if (status === 'ready') return null;
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '12vh 20px', textAlign: 'center', color: '#475569' }}>
      {status === 'loading' && <p style={{ fontSize: 18 }}>Loading UE Finance ERP...</p>}
      {status === 'error' && (
        <div>
          <p style={{ fontSize: 18, color: '#b91c1c', fontWeight: 700 }}>The application could not start.</p>
          <p>{message}</p>
          <button onClick={() => window.location.reload()} style={{ padding: '10px 18px', fontSize: 15 }}>Try again</button>
        </div>
      )}
    </div>
  );
}
