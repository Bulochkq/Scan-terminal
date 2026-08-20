/**
 * LOGGER.GS — запис і читання історії.
 */

function getLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CFG.LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CFG.LOG_SHEET);
    sheet.appendRow(CFG.LOG_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function writeToLog(plu, mpn, ean, name, action, oldVal, newVal, sheetName, user, timestamp) {
  try {
    var logSheet = getLogSheet_();

    if (logSheet.getLastRow() >= CFG.MAX_LOG_ROWS) {
      try {
        createHiddenBackup_(SpreadsheetApp.getActiveSpreadsheet(), logSheet);
        logSheet.getRange(2, 1, logSheet.getLastRow() - 1, CFG.LOG_HEADERS.length).clearContent();
      } catch (e) {
        Logger.log('Ротація логу не вдалась: ' + e);
      }
    }

    var t = timestamp;
    if (t instanceof Date) {
      t = Utilities.formatDate(t, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
    }

    logSheet.appendRow([
      String(t || nowStamp_()), plu, mpn, ean, name, action,
      sheetName, user, oldVal, newVal
    ]);
  } catch (e) {
    Logger.log('Запис у лог не вдався: ' + e);
  }
}

function logSystemError(msg, user) {
  Logger.log('ERROR [' + (user || 'Server') + ']: ' + msg);
  try {
    writeToLog('SYS', 'ERR', 'ERR', 'SYSTEM ERROR', 'ERROR', 0, 0, 'SYSTEM', user || 'Server', nowStamp_());
  } catch (e) { /* лог не має ламати основну дію */ }
}

/**
 * Читає ТІЛЬКИ хвіст логу, а не весь аркуш.
 * Тестова версія вичитувала всі 5000 рядків при кожному відкритті історії.
 */
function getRecentLogs(sheetName) {
  try {
    var logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.LOG_SHEET);
    if (!logSheet) return [];

    var lastRow = logSheet.getLastRow();
    if (lastRow < 2) return [];

    var startRow = Math.max(2, lastRow - CFG.LOG_READ_LIMIT + 1);
    var numRows = lastRow - startRow + 1;
    if (numRows < 1) return [];

    var data = logSheet.getRange(startRow, 1, numRows, CFG.LOG_HEADERS.length).getValues();
    var logs = [];

    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      if (String(row[6]) !== String(sheetName)) continue;

      var t = row[0];
      if (t instanceof Date) {
        t = Utilities.formatDate(t, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
      }

      logs.push({
        time:   String(t),
        plu:    String(row[1]),
        mpn:    String(row[2]),
        ean:    String(row[3]),
        name:   String(row[4]),
        action: String(row[5]),
        user:   String(row[7]),
        oldVal: String(row[8]),
        newVal: String(row[9])
      });

      if (logs.length >= 200) break;
    }
    return logs;
  } catch (e) {
    Logger.log('Читання логу не вдалось: ' + e);
    return [];
  }
}

function clearLogs() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { throw new Error('Server busy'); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName(CFG.LOG_SHEET);
    if (!logSheet) throw new Error('Log hárok neexistuje.');

    var backupName = '';
    if (logSheet.getLastRow() > 1) {
      backupName = createHiddenBackup_(ss, logSheet);
      logSheet.getRange(2, 1, logSheet.getLastRow() - 1, CFG.LOG_HEADERS.length).clearContent();
    }

    logSheet.getRange(1, 1, 1, CFG.LOG_HEADERS.length).setValues([CFG.LOG_HEADERS]);
    writeToLog('ADMIN', 'CLEAR', 'OK', 'Logy vymazané', 'CLEAR', 0, 0, 'LOGS', 'Admin', nowStamp_());

    return { msg: 'Logy vymazané. Záloha: ' + (backupName || 'nebola potrebná') };
  } finally { lock.releaseLock(); }
}
