/**
 * API.GS — єдина точка входу для статичного фронтенду на Cloudflare.
 *
 * ВАЖЛИВО ПРО CORS:
 * Apps Script не вміє відповідати на preflight-запит (OPTIONS). Тому клієнт
 * шле POST із типом text/plain — це "простий запит", який preflight не
 * викликає. Тіло при цьому все одно JSON. Не додавай на клієнті заголовок
 * Content-Type: application/json — усе відразу зламається.
 */

function doPost(e) {
  var out;
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('Порожній запит.');
    var req = JSON.parse(e.postData.contents);
    out = routeAction_(String(req.action || ''), req);
    if (out && out.ok === undefined) out.ok = true;
  } catch (err) {
    var msg = String((err && err.message) || err);
    out = { ok: false, error: msg, auth: msg.indexOf('AUTH:') === 0 };
    try { logSystemError(msg, 'API'); } catch (_) {}
  }
  return jsonOut_(out);
}

/** Відкрий URL у браузері — має відповісти {ok:true}. Зручно для перевірки деплою. */
function doGet(e) {
  return jsonOut_({
    ok: true,
    service: 'Skladový terminál API',
    version: '3.0',
    time: nowStamp_()
  });
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function routeAction_(action, p) {
  switch (action) {
    // --- читання ---
    case 'warm':          return apiWarm_();
    case 'init':          return apiInit_();
    case 'sheet':         return apiSheet_(p);
    case 'ping':          return apiPing_(p);
    case 'leave':         return apiLeave_(p);
    case 'logs':          return apiLogs_(p);

    // --- запис під час сканування ---
    case 'write':         return apiWrite_(p);
    case 'note':          return apiNote_(p);

    // --- авторизація ---
    case 'auth':          return { valid: verifyAdminPin(p.pin) };

    // --- користувачі ---
    case 'userAdd':       clearInitCache_(); return { users: addUser(p.name) };
    case 'userDel':       clearInitCache_(); return { users: removeUser(p.name) };

    // --- склади ---
    case 'sheetCreate':   return apiSheetCreate_(p);
    case 'sheetDelete':   return apiSheetDelete_(p);

    // --- позиції ---
    case 'itemCreate':    return apiItemCreate_(p);
    case 'itemUpdate':    return apiItemUpdate_(p);
    case 'itemDelete':    return apiItemDelete_(p);

    // --- імпорт (рядки вже розібрані у браузері) ---
    case 'import':        return apiImport_(p);

    // --- бекапи та логи ---
    case 'backupList':    return apiBackupList_(p);
    case 'backupDelete':  return apiBackupDelete_(p);
    case 'logsClear':     return apiLogsClear_(p);

    default:
      throw new Error('Невідома дія: ' + action);
  }
}

// ---------------------------------------------------------------- читання

/**
 * ШВИДКІСТЬ: раніше тут для КОЖНОГО аркуша викликався getLastRow(). Це
 * найповільніша операція Spreadsheet API, а init — найчастіший запит.
 * З накопиченими бекапами виходили десятки таких викликів на кожне відкриття
 * застосунку. Кількість рядків для вибору складу не потрібна — прибрано.
 *
 * Плюс відповідь кешується на 60 секунд і скидається при будь-якій зміні
 * списку складів чи користувачів.
 */
function apiInit_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('INIT');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* впало — рахуємо заново */ }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var blocked = [CFG.LOG_SHEET, CFG.IMPORT_SHEET, CFG.SETTINGS_SHEET, 'LOG', 'log'];
  var list = [];

  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    var n = s.getName();
    if (blocked.indexOf(n) !== -1) continue;
    if (n.indexOf('_BACKUP_') !== -1) continue;
    if (s.isSheetHidden()) continue;
    list.push({ id: String(s.getSheetId()), name: n });
  }

  var users = ['Skladník 1'];
  try { users = getUsersList(); } catch (e) { /* список не критичний */ }

  var out = { sheets: list, users: users, pinIsDefault: isPinDefault_() };
  try { cache.put('INIT', JSON.stringify(out), 60); } catch (e) {}
  return out;
}

/** Скидається після створення/видалення складу або зміни користувачів. */
function clearInitCache_() {
  try { CacheService.getScriptCache().remove('INIT'); } catch (e) {}
}

/**
 * Найдешевший можливий виклик — щоб «розбудити» скрипт.
 * Apps Script після простою піднімає екземпляр заново, і перша дія платить
 * 5–10 секунд. Клієнт смикає це одразу при відкритті сторінки, поки людина
 * ще обирає користувача — і до першого натискання скрипт уже теплий.
 */
function apiWarm_() {
  return { warm: true };
}

/**
 * Читання складу порціями. На 24 000 рядків одна відповідь була б надто
 * великою, тому клієнт довантажує наступні куски сам.
 */
function apiSheet_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getSheetById_(ss, p.sheetId);
  if (!sheet) throw new Error('SHEET_NOT_FOUND');

  var lastRow = sheet.getLastRow();
  var total = Math.max(0, lastRow - CFG.DB_START_ROW + 1);

  var offset = Math.max(0, toInt_(p.offset));
  var limit = toInt_(p.limit) || CFG.SHEET_CHUNK;
  if (limit > CFG.SHEET_CHUNK) limit = CFG.SHEET_CHUNK;

  // ШВИДКІСТЬ: рядки їдуть масивами, а не об'єктами. На 24 000 позицій
  // повторювані назви полів ("brand","plu","name"...) — це кілька мегабайт
  // зайвого JSON. Порядок полів описаний у cols нижче, клієнт їх розкладає.
  var data = [];
  if (total > 0 && offset < total) {
    var take = Math.min(limit, total - offset);
    var values = sheet.getRange(CFG.DB_START_ROW + offset, 1, take, CFG.COL_COUNT).getValues();

    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      // Порожні технічні рядки пропускаємо, але НЕ ламаємо нумерацію:
      // row завжди відповідає реальному рядку в таблиці.
      if (!r[1] && !r[2] && !r[4]) continue;
      data.push([
        CFG.DB_START_ROW + offset + i,
        String(r[0] || ''),
        String(r[1] || ''),
        String(r[2] || 'Bez názvu'),
        String(r[3] || ''),
        String(r[4] || ''),
        toInt_(r[5]),
        toInt_(r[6]),
        String(r[8] || '')
      ]);
    }
  }

  return {
    cols: ['row', 'brand', 'plu', 'name', 'code', 'ean', 'plan', 'real', 'note'],
    data: data,
    offset: offset,
    total: total,
    done: (offset + limit) >= total,
    sheetName: sheet.getName(),
    serverTime: Date.now()
  };
}

/**
 * Дешева синхронізація. НЕ читає таблицю взагалі — тільки кеш.
 * Саме це рятує денну квоту: стара версія раз на 3 секунди вичитувала
 * всю колонку кількостей, що на 24k рядків з'їдало ліміт за години.
 */
function apiPing_(p) {
  var cache = CacheService.getScriptCache();
  var now = Date.now();
  var sid = String(p.sessionId || '');

  // присутність
  var pKey = 'ACT_' + p.sheetId;
  var raw = cache.get(pKey);
  var list = {};
  try { list = raw ? JSON.parse(raw) : {}; } catch (e) { list = {}; }

  var others = [];
  Object.keys(list).forEach(function (k) {
    if (now - (list[k].t || 0) > CFG.PRESENCE_TTL_MS) { delete list[k]; return; }
    if (k !== sid) others.push(list[k].u);
  });
  list[sid] = { u: String(p.user || '?'), t: now };
  cache.put(pKey, JSON.stringify(list), 300);

  // зміни з інших пристроїв
  var since = Number(p.since || 0);
  var changes = [];
  var stale = false;
  var cRaw = cache.get('CHG_' + p.sheetId);
  if (cRaw) {
    var arr = [];
    try { arr = JSON.parse(cRaw); } catch (e) { arr = []; }
    // Якщо найстаріший запис у буфері новіший за since — ми щось пропустили.
    if (since && arr.length && arr[0].t > since) stale = true;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].t > since) changes.push(arr[i]);
    }
  }

  return { others: others, changes: changes, stale: stale, serverTime: now };
}

function apiLeave_(p) {
  var cache = CacheService.getScriptCache();
  var pKey = 'ACT_' + p.sheetId;
  var raw = cache.get(pKey);
  if (!raw) return {};
  try {
    var list = JSON.parse(raw);
    delete list[String(p.sessionId || '')];
    cache.put(pKey, JSON.stringify(list), 300);
  } catch (e) {}
  return {};
}

function apiLogs_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getSheetById_(ss, p.sheetId);
  if (!sheet) return { logs: [] };
  return { logs: getRecentLogs(sheet.getName()) };
}

// ---------------------------------------------------------------- запис

function apiWrite_(p) {
  var item = p.item || {};

  // Захист від сміття: у стабільній версії він був, у тестовій зник.
  if (item.forceValue === undefined || item.forceValue === null) {
    throw new Error('Порожнє значення кількості.');
  }
  var qty = Number(item.forceValue);
  if (isNaN(qty)) throw new Error('Некоректне значення кількості.');
  qty = Math.floor(qty);
  if (qty < 0) qty = 0;

  var row = toInt_(item.row);
  if (row < CFG.DB_START_ROW) throw new Error('Некоректний номер рядка.');

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, retry: true, error: 'Server busy' }; }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getSheetById_(ss, p.sheetId);
    if (!sheet) throw new Error('SHEET_NOT_FOUND');

    // Рядок перевіряємо за PLU — якщо адміністратор щось видалив або
    // зробив імпорт, поки тривало сканування, ми не запишемо в чужий товар.
    var info = sheet.getRange(row, 2, 1, 4).getValues()[0];
    var pluOnRow = String(info[0] || '');
    if (item.plu && pluOnRow && pluOnRow !== String(item.plu)) {
      var found = findRowByPlu_(sheet, String(item.plu));
      if (!found) throw new Error('ROW_MOVED: položka sa v hárku nenašla, obnovte dáta.');
      row = found;
      info = sheet.getRange(row, 2, 1, 4).getValues()[0];
    }

    var cell = sheet.getRange(row, CFG.COL_REAL);
    var serverOld = toInt_(cell.getValue());
    var logOld = (item.clientOldValue !== undefined && item.clientOldValue !== null)
      ? toInt_(item.clientOldValue) : serverOld;

    if (qty !== serverOld || logOld !== qty) {
      cell.setValue(qty);
      var label = (item.type === 'scan') ? 'SKEN' : 'MANUÁL';
      writeToLog(info[0], info[2], info[3], info[1], label, logOld, qty,
                 sheet.getName(), p.user, item.timestamp || nowStamp_());
      pushChange_(p.sheetId, row, qty);
      SpreadsheetApp.flush();
    }
    return { newReal: qty, row: row };
  } finally {
    lock.releaseLock();
  }
}

function apiNote_(p) {
  var row = toInt_(p.row);
  if (row < CFG.DB_START_ROW) throw new Error('Некоректний номер рядка.');

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, retry: true, error: 'Server busy' }; }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getSheetById_(ss, p.sheetId);
    if (!sheet) throw new Error('SHEET_NOT_FOUND');

    var cell = sheet.getRange(row, CFG.COL_NOTE);
    var oldNote = String(cell.getValue() || '');
    var input = String(p.note == null ? '' : p.note).trim();
    var finalNote = input === '' ? '' : (input + ' / ' + String(p.user || '?'));

    if (oldNote !== finalNote) {
      cell.setValue(finalNote);
      var info = sheet.getRange(row, 2, 1, 4).getValues()[0];
      writeToLog(info[0], info[2], info[3], info[1], 'POZNÁMKA',
                 oldNote, finalNote, sheet.getName(), p.user, nowStamp_());
    }
    return { note: finalNote };
  } finally {
    lock.releaseLock();
  }
}

function findRowByPlu_(sheet, plu) {
  var last = sheet.getLastRow();
  if (last < CFG.DB_START_ROW) return null;
  var col = sheet.getRange(CFG.DB_START_ROW, 2, last - CFG.DB_START_ROW + 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]) === plu) return CFG.DB_START_ROW + i;
  }
  return null;
}

/** Кільцевий буфер останніх змін — з нього живиться дешевий ping. */
function pushChange_(sheetId, row, val) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'CHG_' + sheetId;
    var raw = cache.get(key);
    var arr = [];
    try { arr = raw ? JSON.parse(raw) : []; } catch (e) { arr = []; }
    arr.push({ t: Date.now(), r: row, v: val });
    if (arr.length > CFG.CHANGE_BUFFER) arr = arr.slice(arr.length - CFG.CHANGE_BUFFER);
    cache.put(key, JSON.stringify(arr), 21600);
  } catch (e) { /* синхронізація не має ламати запис */ }
}

function bumpVersion_(sheetId) {
  try {
    CacheService.getScriptCache().remove('CHG_' + sheetId);
  } catch (e) {}
}

// ---------------------------------------------------------------- адмін

function apiSheetCreate_(p) {
  requirePin_(p.pin);
  var res = createNewSheet(p.name);
  clearInitCache_();
  return res;
}

function apiSheetDelete_(p) {
  requirePin_(p.pin);
  var res = deleteTargetSheet(p.sheetId);
  clearInitCache_();
  return res;
}

function apiItemCreate_(p) {
  requirePin_(p.pin);
  return adminCreateItem(p.sheetId, p.data, p.user);
}

function apiItemUpdate_(p) {
  requirePin_(p.pin);
  return adminUpdateItem(p.sheetId, toInt_(p.row), p.data, p.user);
}

function apiItemDelete_(p) {
  requirePin_(p.pin);
  return adminDeleteItem(p.sheetId, toInt_(p.row), p.user);
}

function apiImport_(p) {
  requirePin_(p.pin);
  return importRows(p.sheetId, p.rows, p.mode);
}

function apiBackupList_(p) {
  requirePin_(p.pin);
  return { list: getBackupsList() };
}

function apiBackupDelete_(p) {
  requirePin_(p.pin);
  return deleteBackupSheet(p.sheetId);
}

function apiLogsClear_(p) {
  requirePin_(p.pin);
  return clearLogs();
}
