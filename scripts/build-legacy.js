/* ============================================================
   build-legacy.js - turns the original Google Apps Script web page
   (legacy-src/*.html) into the three plain files the React website
   loads: body.html (screens), styles.css and scripts.js.
   Runs automatically as part of "npm run build".
   ============================================================ */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'legacy-src');
const OUT = path.join(__dirname, '..', 'client', 'public', 'legacy');
fs.mkdirSync(OUT, { recursive: true });

const read = f => fs.readFileSync(path.join(SRC, f + '.html'), 'utf8');

const stripTag = (text, tag) => text.replace(new RegExp('^\\s*<' + tag + '[^>]*>', 'i'), '').replace(new RegExp('</' + tag + '>\\s*$', 'i'), '');

// 1) styles
fs.writeFileSync(path.join(OUT, 'styles.css'), stripTag(read('Styles').trim(), 'style'));

// 2) scripts (Scripts.html first, then ScriptsDiary.html, which deliberately overrides some of its functions)
const scripts = stripTag(read('Scripts').trim(), 'script') + '\n\n' + stripTag(read('ScriptsDiary').trim(), 'script');
fs.writeFileSync(path.join(OUT, 'scripts.js'), scripts);

// 3) the page body, with every include('...') replaced by that file's content
let index = read('Index');
const body = index.slice(index.indexOf('<body>') + 6, index.lastIndexOf('</body>'));
const html = body.replace(/<\?!=\s*include\('([A-Za-z]+)'\);?\s*\?>/g, (m, name) => {
  if (name === 'Scripts' || name === 'ScriptsDiary') return '';
  return read(name);
});
if (/<\?!=/.test(html)) throw new Error('An include() was not replaced in Index.html');
fs.writeFileSync(path.join(OUT, 'body.html'), html);

console.log('Legacy screens built: body.html ' + html.length + ' bytes, scripts.js ' + scripts.length + ' bytes.');
