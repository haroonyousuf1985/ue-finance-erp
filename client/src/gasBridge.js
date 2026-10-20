/* ============================================================
   gasBridge.js - recreates the small piece of Google's browser
   API (google.script.run) that the screens were written against,
   and sends each call to this app's own server instead.
   ============================================================ */
async function post(url, body) {
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Cannot reach the server. Check your internet connection and try again.');
  }
  let data;
  try { data = await resp.json(); } catch (e) { throw new Error('The server sent an unreadable reply (HTTP ' + resp.status + ').'); }
  if (!data.ok) throw new Error(data.error || 'Unknown server error.');
  return data.result;
}

const ROUTES = {
  apiLogin: (u, p) => post('/api/login', { username: u, password: p }),
  apiLogout: t => post('/api/logout', { token: t }),
  apiCall: (token, fn, args) => post('/api/call', { token, fn, args })
};

function makeRunner(onSuccess, onFailure) {
  return new Proxy({}, {
    get(_, name) {
      if (name === 'withSuccessHandler') return fn => makeRunner(fn, onFailure);
      if (name === 'withFailureHandler') return fn => makeRunner(onSuccess, fn);
      if (name === 'withUserObject') return () => makeRunner(onSuccess, onFailure);
      if (typeof name !== 'string' || name === 'then') return undefined;
      return (...args) => {
        const route = ROUTES[name];
        const promise = route
          ? route(...args)
          : Promise.reject(new Error('Unknown server function: ' + name));
        promise.then(
          r => { if (onSuccess) onSuccess(r); },
          e => { if (onFailure) onFailure(e); else console.error(e); }
        );
      };
    }
  });
}

export function installGoogleScriptRun() {
  window.google = window.google || {};
  window.google.script = { run: makeRunner(null, null), host: { close() {} } };
}
