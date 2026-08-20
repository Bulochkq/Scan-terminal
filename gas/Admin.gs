/**
 * ADMIN.GS — керування користувачами, складами, позиціями, бекапами, імпорт.
 *
 * Перевірка PIN тут НЕ робиться — це завдання Api.gs (requirePin_).
 * Так секрет перевіряється рівно в одному місці.
 */

// ------------------------------------------------------------ користувачі

function getUsersList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CFG.SETTINGS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(CFG.SETTINGS_SHEET);
    sheet.appendRow(['MENO PRACOVNÍKA']);
    sheet.appendRow(['Skladník 1']);
    return ['Skladník 1'];
  }

  if (sheet.getLastRow() < 2) return ['Skladník 1'];

  var raw = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  var users = [];
  for (var i = 0; i < raw.length; i++) {
    var v = String(raw[i][0] || '').trim();
    if (v) users.push(v);
  }
  return users.length ? users : ['Skladník 1'];
}

function addUser(name) {
  var clean = String(name || '').trim();
  if (!clean) return getUsersList();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CFG.SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CFG.SETTINGS_SHEET);
    sheet.appendRow(['MENO PRACOVNÍKA']);
  }

  var data = sheet.getDataRange().getValues();
  var exists = data.some(function (r) {
    return String(r[0]).trim().toLowerCase() === clean.toLowerCase();
  });
  if (!exists) sheet.appendRow([clean]);

  return getUsersList();
}

function removeUser(name) {
  var clean = String(name || '').trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CFG.SETTINGS_SHEET);
  if (!sheet) return getUsersList();

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) { // з 1 — заголовок не чіпаємо
    if (String(data[i][0]).trim() === clean) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return getUsersList();
}

// ---------------------------------------------------------------- склади

function createNewSheet(name) {
  var clean = String(name || '').trim();
  if (!clean) throw new Error('Zadajte názov skladu.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(clean)) throw new Error('Hárok s týmto názvom už existuje.');

  var sheet = ss.insertSheet(clean);
  applyHeader_(sheet);
  sheet.setFrozenRows(1);

  return { msg: 'Sklad «' + clean + '» vytvorený.', id: String(sheet.getSheetId()) };
}

function deleteTargetSheet(sheetId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getSheetById_(ss, sheetId);
  if (!sheet) throw new Error('Hárok nenájdený.');

  var name = sheet.getName();
  var backupName = createHiddenBackup_(ss, sheet);
  ss.deleteSheet(sheet);

  writeToLog('ADMIN', 'DELETE', 'OK', 'Zmazaný sklad: ' + name, 'DELETE', 0, 0, 'SYSTEM', 'Admin', nowStamp_());
  return { msg: 'Sklad zmazaný. Záloha: ' + backupName };
}

function applyHeader_(sheet) {
  var r = sheet.getRange(1, 1, 1, CFG.COL_COUNT);
  r.setValues([CFG.HEADERS]);
  r.setFontWeight('bold').setBackground('#d9ead3').setBorder(true, true, true, true, true, true);
}

// -------------------------------------------------------------- позиції

function adminCreateItem(sheetId, data, user) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('Server busy'); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getSheetById_(ss, sheetId);
    if (!sheet) throw new Error('SHEET_NOT_FOUND');

    var d = data || {};
    var plu = String(d.plu || '').trim();
    if (!plu) throw new Error('PLU je povinné.');
    if (findRowByPlu_(sheet, plu)) throw new Error('Položka s PLU ' + plu + ' už existuje.');

    sheet.appendRow([
      String(d.brand || ''), plu, String(d.name || ''), String(d.code || ''),
      String(d.ean || ''), toInt_(d.plan), toInt_(d.real), '', ''
    ]);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, CFG.COL_DIFF).setFormulaR1C1('=N(RC[-1])-RC[-2]');

    bumpVersion_(sheetId);
    writeToLog(plu, d.code, d.ean, d.name, 'ADMIN_ADD', 0, toInt_(d.real), sheet.getName(), user, nowStamp_());
    return { msg: 'Pridané.', row: lastRow };
  } finally { lock.releaseLock(); }
}

function adminUpdateItem(sheetId, row, data, user) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('Server busy'); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getSheetById_(ss, sheetId);
    if (!sheet) throw new Error('SHEET_NOT_FOUND');
    if (row < CFG.DB_START_ROW) throw new Error('Некоректний рядок.');

    var d = data || {};
    var range = sheet.getRange(row, 1, 1, CFG.COL_COUNT);
    var current = range.getValues()[0];

    range.setValues([[
      String(d.brand || ''), String(d.plu || ''), String(d.name || ''),
      String(d.code || ''), String(d.ean || ''),
      toInt_(d.plan), toInt_(d.real), '', current[8]
    ]]);
    sheet.getRange(row, CFG.COL_DIFF).setFormulaR1C1('=N(RC[-1])-RC[-2]');

    bumpVersion_(sheetId);
    writeToLog(d.plu, d.code, d.ean, d.name, 'ADMIN_EDIT',
               toInt_(current[6]), toInt_(d.real), sheet.getName(), user, nowStamp_());
    return { msg: 'Uložené.' };
  } finally { lock.releaseLock(); }
}

function adminDeleteItem(sheetId, row, user) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('Server busy'); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getSheetById_(ss, sheetId);
    if (!sheet) throw new Error('SHEET_NOT_FOUND');
    if (row < CFG.DB_START_ROW) throw new Error('Некоректний рядок.');

    var vals = sheet.getRange(row, 1, 1, 5).getValues()[0];
    sheet.deleteRow(row);

    bumpVersion_(sheetId);
    writeToLog(vals[1], vals[3], vals[4], vals[2], 'ADMIN_DEL', 0, 0, sheet.getName(), user, nowStamp_());
    return { msg: 'Zmazané.' };
  } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- імпорт

/**
 * Приймає ВЖЕ РОЗІБРАНІ рядки з браузера.
 *
 * Парсинг PDF і Excel робиться на клієнті (PDF.js + SheetJS) — саме тому
 * фронтенд і виноситься з Apps Script: тут PDF прочитати нічим.
 *
 * rows: [{ brand, plu, name, code, ean, plan }, ...]
 * mode: 'replace' (за замовчуванням) або 'merge' — оновити план, зберігши Realita
 */
function importRows(sheetId, rows, mode) {
  if (!rows || !rows.length) throw new Error('Немає рядків для імпорту.');

  var lock = LockService.getScriptLock();
  try { lock.waitLock(60000); } catch (e) { throw new Error('Server busy'); }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getSheetById_(ss, sheetId);
    if (!sheet) throw new Error('Cieľový hárok neexistuje.');

    // Дублікати PLU не ковтаємо мовчки — у тестовій версії вони пропускались
    // непомітно, через що частина товару тихо не потрапляла в склад.
    var seen = {};
    var duplicates = [];
    var clean = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var plu = String(r.plu == null ? '' : r.plu).trim();
      if (!plu) continue;
      if (seen[plu]) { if (duplicates.length < 20) duplicates.push(plu); continue; }
      seen[plu] = true;
      clean.push({
        brand: String(r.brand || '').trim(),
        plu:   plu,
        name:  String(r.name || '').trim(),
        code:  String(r.code || '').trim(),
        ean:   String(r.ean || '').trim(),
        plan:  toInt_(r.plan)
      });
    }

    if (!clean.length) throw new Error('Po spracovaní nezostali žiadne platné riadky.');

    var backupName = '';
    if (sheet.getLastRow() > 1) backupName = createHiddenBackup_(ss, sheet);

    var keepReal = {};
    if (mode === 'merge' && sheet.getLastRow() >= CFG.DB_START_ROW) {
      var old = sheet.getRange(CFG.DB_START_ROW, 2, sheet.getLastRow() - CFG.DB_START_ROW + 1, 6).getValues();
      for (var k = 0; k < old.length; k++) {
        var oPlu = String(old[k][0] || '').trim();
        if (oPlu) keepReal[oPlu] = toInt_(old[k][5]);
      }
    }

    var out = clean.map(function (c) {
      var real = (mode === 'merge' && keepReal[c.plu] !== undefined) ? keepReal[c.plu] : 0;
      return [c.brand, c.plu, c.name, c.code, c.ean, c.plan, real, '', ''];
    });

    sheet.clear();
    applyHeader_(sheet);
    sheet.setFrozenRows(1);

    sheet.getRange(CFG.DB_START_ROW, 1, out.length, CFG.COL_COUNT).setValues(out);
    sheet.getRange(CFG.DB_START_ROW, CFG.COL_DIFF, out.length, 1).setFormulaR1C1('=N(RC[-1])-RC[-2]');
    sheet.getRange(CFG.DB_START_ROW, 1, out.length, CFG.COL_COUNT).setHorizontalAlignment('left');

    var diffRange = sheet.getRange(CFG.DB_START_ROW, CFG.COL_DIFF, out.length, 1);
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
        .setBackground('#fecaca').setRanges([diffRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
        .setBackground('#fed7aa').setRanges([diffRange]).build()
    ]);

    bumpVersion_(sheetId);
    writeToLog('ADMIN', 'IMPORT', 'OK', 'Import ' + out.length + ' položiek', 'IMPORT',
               0, out.length, sheet.getName(), 'Admin', nowStamp_());
    SpreadsheetApp.flush();

    return {
      msg: 'Import hotový: ' + out.length + ' položiek.',
      count: out.length,
      duplicates: duplicates,
      duplicateCount: rows.length - clean.length,
      backup: backupName
    };
  } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- бекапи

function createHiddenBackup_(ss, sheet) {
  // Формат дати навмисно сортується як текст: yyyyMMdd_HHmmss.
  // Старий формат dd.MM.yyyy сортувався неправильно.
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  var name = sheet.getName() + '_BACKUP_' + stamp;
  if (ss.getSheetByName(name)) name += '_' + Math.floor(Math.random() * 1000);

  var copy = sheet.copyTo(ss);
  copy.setName(name);
  copy.hideSheet();
  return name;
}

function getBackupsList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var out = [];
  for (var i = 0; i < sheets.length; i++) {
    var n = sheets[i].getName();
    if (n.indexOf('_BACKUP_') === -1) continue;
    out.push({ id: String(sheets[i].getSheetId()), name: n, rows: Math.max(0, sheets[i].getLastRow() - 1) });
  }
  out.sort(function (a, b) { return b.name.localeCompare(a.name); });
  return out;
}

function deleteBackupSheet(sheetId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getSheetById_(ss, sheetId);
  if (!sheet) throw new Error('Záloha nenájdená.');
  if (sheet.getName().indexOf('_BACKUP_') === -1) {
    throw new Error('Toto nie je záloha — mazanie zrušené.');
  }
  var name = sheet.getName();
  ss.deleteSheet(sheet);
  writeToLog('ADMIN', 'DEL_BACKUP', 'OK', 'Zmazaná záloha: ' + name, 'DELETE', 0, 0, 'SYSTEM', 'Admin', nowStamp_());
  return { msg: 'Záloha zmazaná.' };
}
