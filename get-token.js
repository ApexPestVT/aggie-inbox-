// aggie-inbox — one-time Gmail refresh-token minting (run ONCE on your PC as Sales@)
//
//   node get-token.js <CLIENT_ID> <CLIENT_SECRET>
//
// Opens a Google sign-in link in your browser. Sign in as Sales@ApexPestSolutionsllc.com,
// approve, and the refresh token prints here. Paste it into Render as GOOGLE_REFRESH_TOKEN.
// Nothing is stored on disk. No dependencies.
'use strict';
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

const [, , CLIENT_ID, CLIENT_SECRET] = process.argv;
if (!CLIENT_ID || !CLIENT_SECRET) { console.error('usage: node get-token.js <CLIENT_ID> <CLIENT_SECRET>'); process.exit(1); }
const PORT = 8765;
const REDIRECT = 'http://localhost:' + PORT + '/cb';
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + [
  'client_id=' + encodeURIComponent(CLIENT_ID),
  'redirect_uri=' + encodeURIComponent(REDIRECT),
  'response_type=code',
  'scope=' + encodeURIComponent(SCOPE),
  'access_type=offline',
  'prompt=consent',
  'login_hint=' + encodeURIComponent('Sales@ApexPestSolutionsllc.com'),
].join('&');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/cb') { res.end('waiting for Google…'); return; }
  const code = u.searchParams.get('code');
  if (!code) { res.end('No code in the callback. Error: ' + (u.searchParams.get('error') || '?')); return; }
  const body = 'code=' + encodeURIComponent(code) + '&client_id=' + encodeURIComponent(CLIENT_ID) + '&client_secret=' + encodeURIComponent(CLIENT_SECRET) + '&redirect_uri=' + encodeURIComponent(REDIRECT) + '&grant_type=authorization_code';
  const rq = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
    let raw = ''; r.on('data', (c) => raw += c); r.on('end', () => {
      let j = {}; try { j = JSON.parse(raw); } catch (e) { }
      if (!j.refresh_token) { res.end('<h2>No refresh token came back.</h2><pre>' + raw + '</pre><p>Revoke the app at myaccount.google.com/permissions and run again.</p>'); console.error('no refresh token:', raw); return; }
      res.end('<h2>Done. Go back to the terminal.</h2>');
      console.log('\n\nGOOGLE_REFRESH_TOKEN=' + j.refresh_token + '\n\nPaste that into Render (Environment) exactly as printed. Close this window.');
      setTimeout(() => process.exit(0), 500);
    });
  });
  rq.on('error', (e) => { res.end('token exchange failed: ' + e.message); });
  rq.write(body); rq.end();
});
server.listen(PORT, () => {
  console.log('Opening Google sign-in… (if nothing opens, paste this into your browser)\n\n' + authUrl + '\n');
  const cmd = process.platform === 'win32' ? 'start "" "' + authUrl.replace(/&/g, '^&') + '"' : (process.platform === 'darwin' ? 'open "' + authUrl + '"' : 'xdg-open "' + authUrl + '"');
  exec(cmd, () => { });
});
