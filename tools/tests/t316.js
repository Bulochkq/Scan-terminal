// v3.1.6: головна на ПК — бічне меню, таблиця складів, картка складу панеллю справа; телефон — як раніше.
// Запуск: node t316.js "<chrome.exe>" "<тека профілю>" "http://127.0.0.1:8765/" "<тека скріншотів>"
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
  // справжній клік мишею в точку (перевіряє, що саме там лежить зверху)
  const click = async (x, y) => {
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const key = async k => {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
  };
  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await cmd('Page.navigate', { url }); await sleep(3000);
  await fn(ev, shot, click, key);
  if (errs.length) { console.log('  JS ERRORS:', errs); fail += errs.length; }
  ws.close(); proc.kill(); await sleep(800);
}

const MOCKS = `
  window.__w = [];
  window.mkInit = function (role, name, id) { API.init = function () { return Promise.resolve({ sheets: [
      {id:'1',name:'Hayes',status:'active'},{id:'2',name:'Shimano',status:'prep'},{id:'3',name:'Tatra',status:'done'},{id:'4',name:'Starý 2025',status:'archived'}],
      me: { id: id || ('u-' + role), email: name.split(' ')[0].toLowerCase() + '@firma.sk', name: name, role: role }, serverTime: Date.now() }); }; };
  window.SHEETS = [
    { id:'1', name:'Hayes', status:'active', created:'28.09.2026 10:14', items:514, plan:1200, real:380, done:120, capped:360, last:'29.09.2026 10:02', lastBy:'Peter Novák', lastAction:'SKEN', lastTs: 3 },
    { id:'2', name:'Shimano', status:'prep', created:'28.09.2026 11:00', items:2410, plan:5100, real:0, done:0, capped:0, last:'28.09.2026 11:02', lastBy:'Import', lastAction:'IMPORT', lastTs: 2 },
    { id:'3', name:'Tatra', status:'done', created:'20.09.2026 09:00', items:88, plan:140, real:140, done:88, capped:140, last:'25.09.2026 16:40', lastBy:'Jana Kováčová', lastAction:'SKEN', lastTs: 1 },
    { id:'4', name:'Starý 2025', status:'archived', created:'01.10.2025 08:00', items:900, plan:1500, real:1490, done:880, capped:1480, last:'10.10.2025 12:00', lastBy:'Ján Majiteľ', lastAction:'SKEN', lastTs: 0 } ];
  API.sheets = function () { __w.push(['sheets']); return Promise.resolve({ sheets: JSON.parse(JSON.stringify(SHEETS)) }); };
  API.sheetUpdate = function (id, f) { __w.push(['sheetUpdate', id, f]); SHEETS.forEach(function (s) { if (s.id === id) { if (f.status) s.status = f.status; if (f.name) s.name = f.name; } }); return Promise.resolve({ msg: 'Uložené.' }); };
  API.sheetCreate = function (n) { __w.push(['create', n]); SHEETS.push({ id:'5', name:n, status:'prep', created:'30.09.2026 12:00', items:0, plan:0, real:0, done:0, capped:0, last:'', lastBy:'', lastAction:'', lastTs: null }); return Promise.resolve({ id: '5', msg: 'Sklad «' + n + '» vytvorený.' }); };
  API.backupList = function () { return Promise.resolve({ list: [{ id:'9', name:'Hayes_BACKUP_20260929_101500', rows: 514, reason: 'IMPORT replace' }] }); };
  API.logsAll = function (sheetId) { __w.push(['logsAll', sheetId || null]); return Promise.resolve({ cols:['id','time','sheet','plu','name','code','ean','action','worker','oldVal','newVal'], data:[[1,'29.09.2026 10:02:11','Hayes','840025','Hayes Adaptér','98-15282','844171000472','SKEN','Peter Novák','0','1']], total: 1 }); };
  API.people = function () { return Promise.resolve({ me: 'u-owner', people: [
    { id: 'u-owner', email: 'jan@firma.sk', name: 'Ján Majiteľ', role: 'owner', active: true, lastLogin: '29.09.2026 09:12' },
    { id: 'u-p', email: 'peter@firma.sk', name: 'Peter Novák', role: 'member', active: true, lastLogin: '' } ], invites: [] }); };
  API.loadSheet = function () { return Promise.resolve({ data: [
    { row: 1, brand: 'Hayes', plu: '840025', name: 'Hayes Adaptér front I.S. 160', code: '98-15282', ean: '844171000472', plan: 4, real: 1, note: '' },
    { row: 2, brand: 'Hayes', plu: '840087', name: 'Hayes Adaptér front', code: '98-18640', ean: '844171001035', plan: 6, real: 6, note: 'stará' } ], total: 2, serverTime: Date.now() }); };
  API.changes = function () { return Promise.resolve({ changes: [], count: 2, serverTime: Date.now() }); };
  API.logs = function () { return Promise.resolve({ logs: [{ time: '29.09.2026 10:02:11', plu: '840025', name: 'Hayes Adaptér', mpn: '98-15282', ean: '844171000472', action: 'SKEN', user: 'Peter Novák', oldVal: '0', newVal: '1' }] }); };
  1`;
const LOGIN = (role, name, id) => `mkInit('${role}', '${name}', '${id}'); Auth.signIn = function () { return Promise.resolve({}); };
  $('#loginEmail').val('x@firma.sk'); $('#loginPass').val('heslo123'); doLogin(); 1`;

const EMOJI = `(function(){ var re = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u; return re.test(document.body.innerText); })()`;
const BROKEN_USES = `Array.from(document.querySelectorAll('use')).filter(function(u){ var h = u.getAttribute('href'); return !document.getElementById(h.slice(1)); }).length`;
const DISP = sel => `getComputedStyle(document.querySelector('${sel}')).display`;
const RECT = sel => `(function(){ var r = document.querySelector('${sel}').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()`;
const ROWS = `$('#hdTable tbody tr').map(function(){ return $(this).find('.t-name').text(); }).get().join('|')`;
const NAV = `$('#homeDesk .hd-nav-item.active').attr('data-nav')`;

(async () => {
  // ---------------------------------------------------------------- ПК, власник
  await session(1440, 900, false, async (ev, shot, click, key) => {
    ok(await ev(DISP('#homeDesk')) === 'none', 'login: desktop home hidden');
    ok(await ev(`!$('#loginCard').hasClass('hidden')`), 'login card visible');
    await ev(MOCKS);
    await ev(LOGIN('owner', 'Ján Majiteľ', 'u-owner')); await sleep(1200);

    ok(await ev(DISP('#homeDesk')) === 'grid', 'desktop home shown after login', await ev(DISP('#homeDesk')));
    ok(await ev(DISP('#setupGrid')) === 'none', 'phone cards hidden on desktop');
    ok(JSON.stringify(await ev(RECT('.hd-side'))) === JSON.stringify([0, 0, 240, 900]), 'sidebar 240px full height', await ev(RECT('.hd-side')));
    ok(await ev(`$('#hdName').text() + '|' + $('#hdRole').text()`) === 'Ján Majiteľ|Vlastník', 'sidebar user');
    ok(await ev(`$('.hd-ver .js-ver').text()`) === '3.1.6', 'sidebar version', await ev(`$('.hd-ver .js-ver').text()`));
    ok(await ev(`$('#homeDesk .hd-nav-item:visible').length`) === 4, 'owner sees 4 menu items');
    ok(await ev(NAV) === 'sheets', 'menu: Sklady active');
    ok(await ev(`$('#hdTitle').text()`) === 'Sklady', 'title');
    ok(await ev(`$('#hdSub').text() === '3 aktuálne sklady · ' + (3012).toLocaleString('sk-SK') + ' položiek'`), 'subtitle counts', await ev(`$('#hdSub').text()`));
    ok(await ev(ROWS) === 'Hayes|Shimano|Tatra', 'table: current sheets, active first', await ev(ROWS));
    ok(await ev(`$('#hdTable thead th').length`) === 9, '9 columns for admin');
    ok(await ev(`$('#hdChips .chip').map(function(){return $(this).text()}).get().join('|')`) === 'Aktuálne3|Prebieha1|Príprava1|Dokončené1|Archív1', 'chips with counts',
       await ev(`$('#hdChips .chip').map(function(){return $(this).text()}).get().join('|')`));
    ok(await ev(`$('#hdTable tbody tr').first().find('.t-pct span').text()`) === '30 %', 'progress in row');
    ok(await ev(`$('#hdTable tbody tr').first().find('.c-last').text()`) === '29.09. 10:02Peter Novák · Sken', 'last work cell', await ev(`$('#hdTable tbody tr').first().find('.c-last').text()`));
    ok(await ev(EMOJI) === false, 'no emoji on desktop home');
    ok(await ev(BROKEN_USES) === 0, 'all icons resolve');
    ok(await ev(`document.querySelector('.hd-table-card').scrollWidth <= document.querySelector('.hd-table-card').clientWidth + 1`), 'no horizontal scroll at 1440');
    await shot('d1_home_owner');

    // фільтри, сортування, пошук
    await ev(`$('#hdChips .chip[data-f=archived]').click(); 1`); await sleep(100);
    ok(await ev(ROWS) === 'Starý 2025', 'chip Archív');
    await ev(`$('#hdChips .chip[data-f=current]').click(); 1`); await sleep(100);
    await ev(`$('#hdTable th[data-k=pct]').click(); 1`); await sleep(100);
    ok(await ev(ROWS) === 'Tatra|Hayes|Shimano', 'sort by Hotovo desc', await ev(ROWS));
    await ev(`$('#hdTable th[data-k=pct]').click(); 1`); await sleep(100);
    ok(await ev(ROWS) === 'Shimano|Hayes|Tatra', 'sort by Hotovo asc', await ev(ROWS));
    ok(await ev(`$('#hdTable th.sorted').attr('data-k')`) === 'pct', 'sorted header marked');
    await ev(`$('#hdTable th[data-k=lastTs]').click(); 1`); await sleep(100);
    ok(await ev(ROWS) === 'Hayes|Shimano|Tatra', 'sort by last work (newest first)', await ev(ROWS));
    await ev(`$('#hdSearch').val('shi'); Sheets.render(); 1`); await sleep(100);
    ok(await ev(ROWS) === 'Shimano', 'search');
    await ev(`$('#hdSearch').val(''); Sheets.render(); 1`); await sleep(100);

    // картка складу — панель справа
    const hayes = await ev(`(function(){ var r = $('#hdTable tbody tr').filter(function(){ return $(this).find('.t-name').text() === 'Hayes'; })[0].querySelector('.t-name').getBoundingClientRect(); return [Math.round(r.left + 10), Math.round(r.top + 8)]; })()`);
    await click(hayes[0], hayes[1]); await sleep(400);
    ok(await ev(`!$('#sheetModal').hasClass('hidden') && $('#sdName').text()`) === 'Hayes', 'row click opens sheet card');
    ok(JSON.stringify(await ev(RECT('#sheetModal .sheet-card'))) === JSON.stringify([980, 0, 460, 900]), 'card is a right panel 460px, full height', await ev(RECT('#sheetModal .sheet-card')));
    ok(await ev(`$('#hdTable tbody tr.is-open .t-name').text()`) === 'Hayes', 'open row highlighted');
    ok(await ev(`$('#sdMiss').text() + '|' + $('#sdExtra').text()`) === '840|20', 'Chýba / Naviac', await ev(`$('#sdMiss').text() + '|' + $('#sdExtra').text()`));
    ok(await ev(`$('#sdPct').text() + '|' + $('#sdPctLbl').text()`) === '30 %|hotovo · sedí 120 z 514 položiek', 'progress label', await ev(`$('#sdPct').text() + '|' + $('#sdPctLbl').text()`));
    ok(await ev(`$('#sdPill .st-pill').text()`) === 'Prebieha', 'status pill in card');
    ok(await ev(`$('#sdLast').text()`) === 'Naposledy 29.09.2026 10:02 · Peter Novák · Sken', 'last activity');
    await shot('d2_sheet_panel');
    // таблиця під панеллю клікабельна: інший склад — панель перемикається
    const tatra = await ev(`(function(){ var r = $('#hdTable tbody tr').filter(function(){ return $(this).find('.t-name').text() === 'Tatra'; })[0].querySelector('.t-name').getBoundingClientRect(); return [Math.round(r.left + 10), Math.round(r.top + 8)]; })()`);
    await click(tatra[0], tatra[1]); await sleep(300);
    ok(await ev(`$('#sdName').text()`) === 'Tatra', 'clicking another row switches the panel');
    await key('Escape'); await sleep(200);
    ok(await ev(`$('#sheetModal').hasClass('hidden')`), 'Esc closes the panel');
    ok(await ev(`$('#hdTable tbody tr.is-open').length`) === 0, 'highlight removed');

    // меню: сторінки праворуч від меню, меню лишається
    await ev(`Home.go('people'); 1`); await sleep(700);
    ok(await ev(`!$('#peopleModal').hasClass('hidden')`), 'menu → people page');
    ok(JSON.stringify(await ev(RECT('#peopleModal'))) === JSON.stringify([240, 0, 1200, 900]), 'people page right of the menu', await ev(RECT('#peopleModal')));
    ok(await ev(NAV) === 'people', 'menu: people active');
    await shot('d3_people');
    await ev(`Home.go('backups'); 1`); await sleep(500);
    ok(await ev(`$('#peopleModal').hasClass('hidden') && !$('#backupModal').hasClass('hidden')`), 'switch people → backups');
    ok(await ev(NAV) === 'backups', 'menu: backups active');
    ok(await ev(`$('#backupList .backup-list-item').length`) === 1, 'backups listed');
    await ev(`closeBackups(); 1`); await sleep(200);
    ok(await ev(NAV) === 'sheets', 'closing page by its X returns menu to Sklady');
    await ev(`Home.go('history'); 1`); await sleep(1800);
    ok(await ev(`!$('#logsModal').hasClass('hidden') && $('#logsModal').hasClass('lg-all')`), 'menu → all-sheets history');
    ok(await ev(NAV) === 'history', 'menu: history active');
    ok(await ev(RECT('#logsModal') + '[0]') === 240, 'history right of the menu');
    await shot('d4_history');
    await ev(`Home.go('sheets'); 1`); await sleep(300);
    ok(await ev(`$('#logsModal').hasClass('hidden')`), 'Sklady closes history');
    // журнал одного складу з картки — у меню лишається «Sklady»; «História» перемикає на загальний
    await ev(`Sheets.openDetail('1'); Sheets.act('logs'); 1`); await sleep(1500);
    ok(await ev(`$('#lgSheetName').text()`) === 'Hayes', 'per-sheet history from card');
    ok(await ev(NAV) === 'sheets', 'per-sheet history keeps Sklady active');
    await ev(`Home.go('history'); 1`); await sleep(1500);
    ok(await ev(`$('#lgSheetName').text()`) === 'Všetky sklady', 'menu História switches to all sheets', await ev(`$('#lgSheetName').text()`));
    ok(await ev(`JSON.stringify(__w.filter(function(x){return x[0]==='logsAll'}).slice(-1)[0])`) === JSON.stringify(['logsAll', null]), 'all-sheets log requested');
    await ev(`Home.go('sheets'); 1`); await sleep(300);

    // таблиця товару з картки — на весь екран (закриває і меню: там бувають незбережені зміни)
    await ev(`Sheets.openDetail('1'); Sheets.act('items'); 1`); await sleep(1800);
    ok(JSON.stringify(await ev(RECT('#editorModal'))) === JSON.stringify([0, 0, 1440, 900]), 'item table covers the whole screen', await ev(RECT('#editorModal')));
    await ev(`Editor.close(); Sheets.closeDetail(); 1`); await sleep(300);

    // новий склад — одразу його картка
    await ev(`reqCreateSheet(); 1`); await sleep(200);
    await ev(`$('#promptInput').val('Nový 2026'); submitPrompt(); 1`); await sleep(800);
    ok(await ev(`!$('#sheetModal').hasClass('hidden') && $('#sdName').text()`) === 'Nový 2026', 'new sheet: its card opens', await ev(`$('#sdName').text()`));
    ok(await ev(`$('#msgText').text().indexOf('Import zo súboru') !== -1`), 'message points to Import');
    ok(await ev(`$('#sdPctLbl').text()`) === 'hotovo · sedí 0 z 0 položiek', 'empty sheet label', await ev(`$('#sdPctLbl').text()`));
    await ev(`closeMsg(); 1`);
    await shot('d5_new_sheet');
    await ev(`Sheets.closeDetail(); 1`);

    // «Spustiť» у рядку → термінал; назад — знову головна
    await ev(`$('#hdTable tbody tr').filter(function(){ return $(this).find('.t-name').text() === 'Hayes'; }).find('.btn-start').click(); 1`); await sleep(1300);
    ok(await ev(`$('#setupOverlay').hasClass('hidden') && $('#infoSheet').text()`) === 'Hayes', 'row Start launches terminal');
    ok(await ev(`$('#sheetModal').hasClass('hidden')`), 'no card over terminal');
    await shot('d6_terminal');
    await ev(`openLog(); 1`); await sleep(1500);
    ok(await ev(RECT('#logsModal') + '[0]') === 0, 'terminal history stays full screen (no menu offset)');
    await ev(`LogView.close(); resetToSetup(); 1`); await sleep(800);
    ok(await ev(DISP('#homeDesk')) === 'grid', 'back from terminal → desktop home', await ev(`[getComputedStyle(document.querySelector('#homeDesk')).display, document.getElementById('setupOverlay').className, $('#loginCard').hasClass('hidden'), $('#setupCard').hasClass('hidden'), $('#msgModal').hasClass('hidden') ? '' : $('#msgText').text()].join(' / ')`));
    // «Dokončený» зі «Spustiť» — термінал перепитує
    await ev(`$('#hdTable tbody tr').filter(function(){ return $(this).find('.t-name').text() === 'Tatra'; }).find('.btn-start').click(); 1`); await sleep(300);
    ok(await ev(`!$('#confirmModal').hasClass('hidden') && $('#confirmTitle').text()`) === 'Sklad je dokončený', 'done sheet asks before start');
    await ev(`answerConfirm(false); 1`);

    // вихід → знову вхід, головна схована
    await ev(`Auth.signOut = function () { return Promise.resolve(); }; doLogout(); 1`); await sleep(600);
    ok(await ev(DISP('#homeDesk')) === 'none' && await ev(`!$('#loginCard').hasClass('hidden')`), 'logout hides desktop home');
    ok(await ev(`$('#hdTable').children().length`) === 0, 'sheet table cleared on logout');
  });

  // ---------------------------------------------------------------- ПК, працівник
  await session(1440, 900, false, async (ev, shot, click) => {
    await ev(MOCKS);
    await ev(`API.sheets = function () { __w.push(['sheets']); return Promise.reject(new Error('ROLE: nie')); }; 1`);
    await ev(LOGIN('member', 'Peter Novák', 'u-p')); await sleep(1200);
    ok(await ev(DISP('#homeDesk')) === 'grid', 'member: desktop home');
    ok(await ev(`$('#hdTitle').text()`) === 'Vyberte sklad', 'member title');
    ok(await ev(`$('#homeDesk .hd-nav-item:visible').length`) === 1, 'member: only Sklady in menu');
    ok(await ev(`$('#homeDesk .hd-tools .btn-primary:visible').length`) === 0, 'member: no Nový sklad');
    ok(await ev(ROWS) === 'Hayes|Shimano|Tatra', 'member: sheets without archive', await ev(ROWS));
    ok(await ev(`$('#hdTable thead th').length`) === 3, 'member: 3 columns');
    ok(await ev(`__w.filter(function(x){return x[0]==='sheets'}).length`) === 0, 'member: api_sheets not called');
    await shot('d7_home_member');
    const r = await ev(`(function(){ var r = $('#hdTable tbody tr').first()[0].querySelector('.t-name').getBoundingClientRect(); return [Math.round(r.left + 10), Math.round(r.top + 8)]; })()`);
    await click(r[0], r[1]); await sleep(1300);
    ok(await ev(`$('#setupOverlay').hasClass('hidden') && $('#infoSheet').text()`) === 'Hayes', 'member: row click starts terminal');
  });

  // ---------------------------------------------------------------- вужчий ПК (1100): другорядні колонки сховані
  await session(1100, 800, false, async (ev, shot) => {
    await ev(MOCKS);
    await ev(LOGIN('admin', 'Adam Správca', 'u-admin')); await sleep(1200);
    ok(await ev(`$('#hdTable th.opt:visible').length`) === 0, '1100px: optional columns hidden');
    ok(await ev(`document.querySelector('.hd-table-card').scrollWidth <= document.querySelector('.hd-table-card').clientWidth + 1`), '1100px: no horizontal scroll');
    ok(await ev(`$('#homeDesk .hd-nav-item:visible').length`) === 4, 'správca sees menu');
    await shot('d8_home_1100');
    await ev(`Sheets.openDetail('2'); 1`); await sleep(300);
    await shot('d9_panel_1100');
  });

  // ---------------------------------------------------------------- телефон: як раніше
  await session(390, 844, true, async (ev, shot) => {
    await ev(MOCKS);
    await ev(LOGIN('admin', 'Adam Správca', 'u-admin')); await sleep(1200);
    ok(await ev(DISP('#homeDesk')) === 'none', 'phone: desktop home hidden');
    ok(await ev(`$('#setupCard').is(':visible') && $('#adminCard').is(':visible')`), 'phone: compact cards');
    ok(await ev(`$('#shList .sh-row').length`) === 3, 'phone: sheet cards');
    await ev(`Sheets.openDetail('1'); 1`); await sleep(300);
    const rc = await ev(RECT('#sheetModal .sheet-card'));
    ok(rc[0] >= 10 && rc[2] <= 370, 'phone: card is a centered popup', rc);
    ok(await ev(`$('#sdStats, .sd-stats').first().css('grid-template-columns').split(' ').length`) === 3, 'phone: 3 stat columns');
    await shot('m1_phone_card');
    await ev(`$('#sheetModal').trigger($.Event('click', { target: document.getElementById('sheetModal') })); 1`);
    await ev(`document.getElementById('sheetModal').click(); 1`); await sleep(200);
    ok(await ev(`$('#sheetModal').hasClass('hidden')`), 'phone: tap outside closes card');
    await shot('m2_phone_home');
    ok(await ev(EMOJI) === false, 'phone: no emoji');
  });

  console.log(pass + ' passed, ' + fail + ' failed');
})();
