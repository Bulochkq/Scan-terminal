// v3.1.5: стилізований вибір камери + оновлення картки складу після збереження таблиці.
const { spawn } = require('child_process'); const fs = require('fs');
const [,, browser, profile, url, outDir] = process.argv; const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cmd('Page.navigate', { url }); await sleep(3000);

  ok(await ev(`$('.js-version').first().text()`) === 'v3.1.5', 'version 3.1.5', await ev(`$('.js-version').first().text()`));

  // камера: дві підставні камери, реальний старт замінено
  await ev(`window.__cam = []; window.Html5Qrcode = { getCameras: function () { return Promise.resolve([{ id: 'f1', label: 'Front camera' }, { id: 'b1', label: 'Back camera' }]); } };
            realStart = function (id) { __cam.push(id); }; html5QrCode = null; startCam(); 1`);
  await sleep(500);
  ok(await ev(`$('#camSelectWrapper .custom-select-wrapper.cs-dark').length`) === 1, 'camera select is styled (dark)');
  ok(await ev(`$('#camSelectWrapper .custom-select-trigger .cs-text').text()`) === 'Back camera', 'back camera preselected', await ev(`$('#camSelectWrapper .custom-select-trigger').text()`));
  ok(await ev(`JSON.stringify(__cam)`) === '["b1"]', 'started with back camera', await ev(`JSON.stringify(__cam)`));
  await ev(`$('#camSelectWrapper .custom-select-trigger').click(); 1`); await sleep(250);
  ok(await ev(`$('#camSelectWrapper .custom-select-wrapper').hasClass('open-up')`), 'camera list opens upward (bottom of screen)');
  await shot('c1_camera_select');
  await ev(`$('#camSelectWrapper .custom-option').filter(function(){ return $(this).text() === 'Front camera'; }).click(); 1`); await sleep(600);
  ok(await ev(`JSON.stringify(__cam)`) === '["b1","f1"]', 'switching camera via styled list calls changeCamera', await ev(`JSON.stringify(__cam)`));
  ok(await ev(`localStorage.getItem('preferredCam')`) === 'f1', 'preferred camera remembered');
  await ev(`stopCam(); 1`);

  // картка складу оновлюється після збереження таблиці з адмінки
  await ev(`window.__n = 0; API.sheets = function () { __n++; return Promise.resolve({ sheets: [] }); };
            Auth.setMe({ id: 'u1', email: 'a@b.sk', name: 'Adam', role: 'admin' }); onTableSaved('admin'); 1`);
  await sleep(300);
  ok(await ev(`__n`) === 1, 'Sheets.load after admin table save', await ev(`__n`));

  if (errs.length) { console.log('  JS ERRORS:', errs); fail += errs.length; }
  console.log(pass + ' passed, ' + fail + ' failed');
  ws.close(); proc.kill();
})();
