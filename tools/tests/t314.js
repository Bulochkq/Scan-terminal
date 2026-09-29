// v3.1.4: іконки, форми входу, адмінка зі складами, картка складу, люди, свій пароль, нотатки в таблиці.
const { spawn } = require('child_process'); const fs = require('fs');
const [,, browser, profile, url, outDir] = process.argv; const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) pass++; else { fail++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); } }

async function session(w, h, mobile, fn) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const dir = `${profile}_${w}_${Date.now()}`;
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let t; for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x => x.type === 'page'); } catch (e) {} if (!t) await sleep(200); }
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const p = {}; const errs = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && p[d.id]) { p[d.id](d.result); delete p[d.id]; }
    if (d.method === 'Runtime.exceptionThrown') errs.push((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || d.params.exceptionDetails.text).slice(0, 300)); };
  const cmd = (method, params = {}) => new Promise(r => { const i = ++id; p[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => { const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result.value; };
  const shot = async name => fs.writeFileSync(outDir + '/' + name + '.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await cmd('Page.navigate', { url }); await sleep(3000);
  await fn(ev, shot);
  if (errs.length) { console.log('  JS ERRORS:', errs); fail += errs.length; }
  ws.close(); proc.kill(); await sleep(800);
}

const MOCKS = `
  window.__w = [];
  window.mkInit = function (role, name, id) { API.init = function () { return Promise.resolve({ sheets: [
      {id:'1',name:'Hayes',status:'active'},{id:'2',name:'Shimano',status:'prep'},{id:'3',name:'Tatra',status:'done'},{id:'4',name:'Starý 2025',status:'archived'}],
      me: { id: id || ('u-' + role), email: name.split(' ')[0].toLowerCase() + '@firma.sk', name: name, role: role }, serverTime: Date.now() }); }; };
  window.SHEETS = [
    { id:'1', name:'Hayes', status:'active', created:'28.09.2026 10:14', items:514, plan:1200, real:380, done:120, capped:360, last:'29.09.2026 10:02', lastBy:'Peter Novák', lastAction:'SKEN', lastTs: 1 },
    { id:'2', name:'Shimano', status:'prep', created:'28.09.2026 11:00', items:2410, plan:5100, real:0, done:0, capped:0, last:'28.09.2026 11:02', lastBy:'Import', lastAction:'IMPORT', lastTs: 1 },
    { id:'3', name:'Tatra', status:'done', created:'20.09.2026 09:00', items:88, plan:140, real:140, done:88, capped:140, last:'25.09.2026 16:40', lastBy:'Jana Kováčová', lastAction:'SKEN', lastTs: 1 },
    { id:'4', name:'Starý 2025', status:'archived', created:'01.10.2025 08:00', items:900, plan:1500, real:1490, done:880, capped:1480, last:'10.10.2025 12:00', lastBy:'Ján Majiteľ', lastAction:'SKEN', lastTs: 1 } ];
  API.sheets = function () { __w.push(['sheets']); return Promise.resolve({ sheets: JSON.parse(JSON.stringify(SHEETS)) }); };
  API.sheetUpdate = function (id, f) { __w.push(['sheetUpdate', id, f]); SHEETS.forEach(function (s) { if (s.id === id) { if (f.status) s.status = f.status; if (f.name) s.name = f.name; } }); return Promise.resolve({ msg: 'Uložené.' }); };
  API.logsAll = function (sheetId) { __w.push(['logsAll', sheetId || null]); return Promise.resolve({ cols:['id','time','sheet','plu','name','code','ean','action','worker','oldVal','newVal'], data:[[1,'29.09.2026 10:02:11','Hayes','840025','Hayes Adaptér','98-15282','844171000472','SKEN','Peter Novák','0','1']], total: 1 }); };
  API.people = function () { return Promise.resolve({ me: 'u-owner', people: [
    { id: 'u-owner', email: 'jan@firma.sk', name: 'Ján Majiteľ', role: 'owner', active: true, lastLogin: '29.09.2026 09:12' },
    { id: 'u-admin', email: 'adam@firma.sk', name: 'Adam Správca', role: 'admin', active: true, lastLogin: '29.09.2026 10:40' },
    { id: 'u-p', email: 'peter@firma.sk', name: 'Peter Novák', role: 'member', active: true, lastLogin: '' } ], invites: [] }); };
  API.loadSheet = function () { return Promise.resolve({ data: [
    { row: 1, brand: 'Hayes', plu: '840025', name: 'Hayes Adaptér front I.S. 160', code: '98-15282', ean: '844171000472', plan: 4, real: 1, note: '' },
    { row: 2, brand: 'Hayes', plu: '840087', name: 'Hayes Adaptér front', code: '98-18640', ean: '844171001035', plan: 6, real: 6, note: 'stará' } ], total: 2, serverTime: Date.now() }); };
  API.changes = function () { return Promise.resolve({ changes: [], count: 2, serverTime: Date.now() }); };
  API.note = function (id, n) { __w.push(['note', id, n]); return Promise.resolve({ note: n }); };
  Auth.changePassword = function (p) { __w.push(['pw', p.length]); return Promise.resolve(true); };
  1`;

const EMOJI = `(function(){ var re = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u; return re.test(document.body.innerText); })()`;
const BROKEN_USES = `Array.from(document.querySelectorAll('use')).filter(function(u){ var h = u.getAttribute('href'); return !document.getElementById(h.slice(1)); }).length`;

(async () => {
  await session(1366, 820, false, async (ev, shot) => {
    ok(await ev(`!$('#loginCard').hasClass('hidden') && !$('#loginForm').hasClass('hidden') && $('#regForm').hasClass('hidden')`), 'login form visible, register hidden');
    ok(await ev(`document.querySelectorAll('.pass-eye').length`) === 0, 'no eye icon');
    ok(await ev(`$('#regPass').attr('autocomplete') === 'new-password' && $('#regPass2').attr('autocomplete') === 'new-password' && $('#loginPass').attr('autocomplete') === 'current-password'`), 'autocomplete attrs fixed in HTML');
    ok(await ev(BROKEN_USES) === 0, 'all icon references resolve', await ev(BROKEN_USES));
    ok(await ev(`document.querySelector('.su-logo svg').getBoundingClientRect().width`) > 20, 'logo icon rendered');
    ok(await ev(EMOJI) === false, 'no emoji visible on login');
    await shot('m1_login');

    await ev(`$('#loginEmail').val('jan@firma.sk'); toggleLoginMode(); 1`); await sleep(200);
    ok(await ev(`!$('#regForm').hasClass('hidden') && $('#regEmail').val()`) === 'jan@firma.sk', 'email carried to register form');
    await ev(`$('#regPass').val('abcdef'); $('#regPass2').val('abcdxx'); doRegister(); 1`); await sleep(150);
    ok(await ev(`$('#regErr').text()`) === 'Heslá sa nezhodujú.', 'register mismatch error');
    await shot('m2_register');
    await ev(`toggleLoginMode(); 1`);

    // власник входить → адмінка відкрита сама
    await ev(MOCKS);
    await ev(`mkInit('owner', 'Ján Majiteľ', 'u-owner'); Auth.signIn = function () { return Promise.resolve({}); }; $('#loginEmail').val('jan@firma.sk'); $('#loginPass').val('heslo123'); doLogin(); 1`);
    await sleep(1200);
    ok(await ev(`!$('#adminCard').hasClass('hidden')`), 'admin panel open by default');
    ok(await ev(`$('#adminOpenBtn').hasClass('hidden')`), 'Administrácia button hidden while panel open');
    ok(await ev(`$('#shList .sh-row').length`) === 3, 'sheet list shows 3 (archive hidden)', await ev(`$('#shList .sh-row').length`));
    ok(await ev(`$('#shList .sh-row').first().find('.sh-title').text()`) === 'Hayes', 'active sheet first');
    ok(await ev(`$('#shArchToggle').text()`) === 'Zobraziť archív (1)', 'archive toggle', await ev(`$('#shArchToggle').text()`));
    ok(await ev(`$('#setupSheetSelect option').map(function(){return $(this).text()}).get().join('|')`) === 'Vyberte…|Hayes|Shimano|Tatra — Dokončený', 'terminal select hides archive, marks done', await ev(`$('#setupSheetSelect option').map(function(){return $(this).text()}).get().join('|')`));
    ok(await ev(EMOJI) === false, 'no emoji on setup/admin');
    await shot('m3_setup_admin');

    await ev(`Sheets.toggleArchived(); 1`); await sleep(150);
    ok(await ev(`$('#shList .sh-row').length`) === 4, 'archive shown after toggle');
    await ev(`Sheets.toggleArchived(); 1`);

    // картка складу
    await ev(`$('#shList .sh-row').first().click(); 1`); await sleep(300);
    ok(await ev(`!$('#sheetModal').hasClass('hidden') && $('#sdName').text()`) === 'Hayes', 'sheet card opens');
    ok(await ev(`$('#sdStatus button.active').attr('data-s')`) === 'active', 'status active selected');
    ok(await ev(`$('#sdPct').text()`) === '30 %', 'progress pct', await ev(`$('#sdPct').text()`));
    ok(await ev(`$('#sdLast').text()`) === 'Naposledy 29.09.2026 10:02 · Peter Novák · Sken', 'last activity text', await ev(`$('#sdLast').text()`));
    await shot('m4_sheet_card');
    await ev(`Sheets.setStatus('done'); 1`); await sleep(500);
    ok(await ev(`JSON.stringify(__w.filter(function(x){return x[0]==='sheetUpdate'}).pop())`) === JSON.stringify(['sheetUpdate', '1', { status: 'done' }]), 'status update call');
    ok(await ev(`$('#sdStatus button.active').attr('data-s')`) === 'done', 'status shown as done');
    await ev(`Sheets.act('rename'); 1`); await sleep(200);
    await ev(`$('#promptInput').val('Hayes 2026'); submitPrompt(); 1`); await sleep(500);
    ok(await ev(`$('#sdName').text()`) === 'Hayes 2026', 'renamed in card', await ev(`$('#sdName').text()`));
    await ev(`Sheets.act('logs'); 1`); await sleep(1800);
    ok(await ev(`JSON.stringify(__w.filter(function(x){return x[0]==='logsAll'}).pop())`) === JSON.stringify(['logsAll', '1']), 'per-sheet logs requested for sheet 1');
    ok(await ev(`$('#lgSheetName').text()`) === 'Hayes 2026', 'log title = sheet');
    ok(await ev(`$('#lgClearBtn').hasClass('hidden')`), 'no clear button in per-sheet log');
    await ev(`LogView.close(); Sheets.closeDetail(); 1`);
    await ev(`openAdminLogs(); 1`); await sleep(1200);
    ok(await ev(`!$('#lgClearBtn').hasClass('hidden')`), 'owner sees clear button in all-sheets log');
    await ev(`LogView.close(); 1`);

    // люди: свій рядок → свій пароль; роль — стилізований список
    await ev(`People.open(); 1`); await sleep(700);
    ok(await ev(`$('#ppList .pp-row').first().find('[data-act=pass]').prop('disabled')`) === false, 'own Heslo enabled');
    ok(await ev(`$('#ppList .custom-select-wrapper.cs-compact').length`) === 3, 'role selects are styled', await ev(`$('#ppList .custom-select-wrapper.cs-compact').length`));
    await ev(`$('#ppList .pp-row').eq(2).find('.custom-select-trigger').click(); 1`); await sleep(250);
    await shot('m5_people_dropdown');
    ok(await ev(`$('#ppList .pp-row').eq(2).find('.custom-select-wrapper').hasClass('open')`), 'styled dropdown opens');
    await ev(`$(document.body).click(); 1`);
    await ev(`$('#ppList .pp-row').first().find('[data-act=pass]').click(); 1`); await sleep(300);
    ok(await ev(`!$('#pwModal').hasClass('hidden') && $('#pwUser').val() === Auth.me().email`) === true, 'own password modal with hidden username');
    await ev(`$('#pwNew').val('noveheslo1'); $('#pwNew2').val('noveheslo2'); savePw(); 1`); await sleep(150);
    ok(await ev(`$('#pwErr').text()`) === 'Heslá sa nezhodujú.', 'pw mismatch');
    await shot('m6_pw');
    await ev(`$('#pwNew2').val('noveheslo1'); savePw(); 1`); await sleep(400);
    ok(await ev(`$('#pwModal').hasClass('hidden') && JSON.stringify(__w.filter(function(x){return x[0]==='pw'}).pop())`) === JSON.stringify(['pw', 10]), 'own password saved');
    await ev(`closeMsg(); People.openAdd(); 1`); await sleep(200);
    ok(/^[a-z]{5}[2-9]{3}$/.test(await ev(`$('#npPass').val()`)), 'add form pre-fills generated password');
    await ev(`People.closeAdd(); People.close(); 1`);

    // термінал: іконки, нотатка прямо в таблиці
    await ev(`$('#setupSheetSelect').val('1'); startApp(); 1`); await sleep(1300);
    ok(await ev(`$('#setupOverlay').hasClass('hidden')`), 'terminal started');
    ok(await ev(EMOJI) === false, 'no emoji in terminal');
    await shot('m7_terminal');
    await ev(`openMissing(); 1`); await sleep(1800);
    const noteOk = await ev(`(function(){ var t = Tabulator.findTable('#edTable')[0]; var c = t.getRows()[0].getCell('note');
      c.edit(true); var inp = c.getElement().querySelector('input'); if (!inp) return 'no-editor';
      inp.value = 'chýba krabica'; inp.dispatchEvent(new Event('change')); inp.blur(); return 'ok'; })()`);
    await sleep(600);
    ok(noteOk === 'ok', 'note editor opens in read mode', noteOk);
    ok(await ev(`JSON.stringify(__w.filter(function(x){return x[0]==='note'}).pop())`) === JSON.stringify(['note', 1, 'chýba krabica']), 'inline note saved via api_note', await ev(`JSON.stringify(__w)`));
    ok(await ev(`localDB[0].note`) === 'chýba krabica', 'terminal localDB updated');
    ok(await ev(`Tabulator.findTable('#edTable')[0].getColumns().filter(function(c){return c.getDefinition().editor}).length`) === 1, 'read mode: only note editable');
    await shot('m8_list_note');
    await ev(`Editor.close(); 1`); await sleep(300);

    // «Dokončený» — термінал питає
    await ev(`resetToSetup(); 1`); await sleep(600);
    await ev(`startApp('3', 'Tatra', 'done'); 1`); await sleep(200);
    ok(await ev(`!$('#confirmModal').hasClass('hidden') && $('#confirmTitle').text()`) === 'Sklad je dokončený', 'done sheet asks before scanning');
    await ev(`answerConfirm(false); 1`);
    ok(await ev(`!$('#adminCard').hasClass('hidden')`), 'admin panel open again after returning from terminal');
  });

  await session(390, 844, true, async (ev, shot) => {
    await shot('m9_m_login');
    await ev(MOCKS);
    await ev(`mkInit('admin', 'Adam Správca', 'u-admin'); Auth.signIn = function () { return Promise.resolve({}); }; $('#loginEmail').val('adam@firma.sk'); $('#loginPass').val('heslo123'); doLogin(); 1`);
    await sleep(1200);
    await shot('m10_m_setup');
    await ev(`document.querySelector('#adminCard').scrollIntoView(); 1`); await sleep(200);
    await shot('m11_m_admin');
    await ev(`Sheets.openDetail('1'); 1`); await sleep(300);
    await shot('m12_m_sheet');
    await ev(`Sheets.closeDetail(); $('#setupSheetSelect').val('1'); startApp(); 1`); await sleep(1300);
    await shot('m13_m_terminal');
    ok(await ev(EMOJI) === false, 'phone: no emoji');
  });

  console.log(pass + ' passed, ' + fail + ' failed');
})();
