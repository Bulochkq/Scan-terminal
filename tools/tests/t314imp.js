// v3.1.4: імпорт — стилізовані списки відповідності колонок (без запису в базу).
const { spawn } = require('child_process'); const fs = require('fs');
const [,, browser, profile, url, outDir, xlsx] = process.argv; const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) pass++; else { fail++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); } }
(async () => {
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}_${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
  let t; for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x => x.type === 'page'); } catch (e) {} if (!t) await sleep(200); }
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const p = {}; const errs = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && p[d.id]) { p[d.id](d.result); delete p[d.id]; }
    if (d.method === 'Runtime.exceptionThrown') errs.push((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || d.params.exceptionDetails.text).slice(0, 300)); };
  const cmd = (method, params = {}) => new Promise(r => { const i = ++id; p[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => { const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result.value; };
  const shot = async name => fs.writeFileSync(outDir + '/' + name + '.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('DOM.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url }); await sleep(3000);
  await ev(`window.__imp = []; API.importRows = function () { __imp.push(arguments); return Promise.resolve({ msg: 'x', count: 0 }); };
            Auth.setMe({ id: 'u1', email: 'a@b.sk', name: 'Adam', role: 'admin' }); openImport('7', 'Hayes'); 1`);
  await sleep(300);
  const doc = await cmd('DOM.getDocument', {});
  const node = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#impFileInput' });
  await cmd('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [xlsx] });
  for (let i = 0; i < 40; i++) { await sleep(250); if (await ev(`!$('#impStepMap').hasClass('hidden')`)) break; }
  ok(await ev(`!$('#impStepMap').hasClass('hidden')`), 'mapping step shown');
  // v3.1.6: числа й коди з файлу Hayes (82 рядки, сума «Disponibilný stav» = 520 — пораховано окремо в node)
  ok(await ev(`$('#impSummary').text().indexOf('Plán spolu: 520') !== -1`), 'plan sum chip = 520 (Hayes file)', await ev(`$('#impSummary').text()`));
  ok(await ev(`$('#impPreviewBody tr').first().find('td').map(function(){return $(this).text()}).get().join('|')`) ===
     '840087|Hayes Adaptér front I.S. to 180 IS Mount Bracket for 180mm Front Rotor|844171001035|98-18640|6|HAYES', 'first preview row parsed',
     await ev(`$('#impPreviewBody tr').first().find('td').map(function(){return $(this).text()}).get().join('|')`));
  const n = await ev(`$('#impMapGrid .custom-select-wrapper').length`);
  ok(n >= 5, 'mapping selects are styled', n);
  ok(await ev(`$('#impMapGrid select:visible').length`) === 0, 'no native selects visible');
  await ev(`$('#impMapGrid .custom-select-trigger').eq(1).click(); 1`); await sleep(250);
  await shot('i1_import_map');
  // змінити відповідність через стилізований список → перерахунок
  const before = await ev(`JSON.stringify(Importer._state ? 1 : 0)`);
  await ev(`$('#impMapGrid .custom-select-wrapper').eq(1).find('.custom-option').eq(0).click(); 1`); await sleep(300);
  ok(await ev(`$('#impMapGrid .imp-map-field').eq(1).hasClass('ok')`) === false, 'choosing “nepoužiť” updates mapping');
  ok(await ev(`$('#impTargetName').text()`) === 'Hayes', 'target sheet shown');
  ok(await ev(`/[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(document.getElementById('importModal').innerText)`) === false, 'no emoji in import');
  if (errs.length) { console.log('  JS ERRORS:', errs); fail += errs.length; }
  console.log(pass + ' passed, ' + fail + ' failed');
  ws.close(); proc.kill();
})();
