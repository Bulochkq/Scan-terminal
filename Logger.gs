/**
 * LOGGER.GS
 * Safe version 2.53
 */

function logSystemError(msg, user) {
  writeToLog("SYS", "ERR", "ERR", "SYSTEM ERROR", "ERROR", 0, 0, "SYSTEM", user || "Server", msg);
}

function writeToLog(plu, mpn, ean, name, action, oldQty, newQty, sheetName, user, timestampStr) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // Use "Log" directly to avoid errors if the logSheetName variable has not loaded yet
    var logSheet = ss.getSheetByName("Log");
    
    if (!logSheet) {
      logSheet = ss.insertSheet("Log");
      logSheet.appendRow(["Čas", "PLU", "SKU", "EAN", "Názov tovaru", "Akcia", "Hárok", "Užívateľ", "Bolo", "Je"]);
    }

    // Clear old logs (safe check)
    if (logSheet.getLastRow() > 5000) {
       try {
         // Check if the backup function exists before calling it
         if (typeof createHiddenBackup === 'function') {
            createHiddenBackup(ss, logSheet);
         }
         logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 10).clearContent();
       } catch(e) {
         // Ignore clearing errors to prevent breaking the write process
       }
    }
    
    // Date formatting
    var finalTime = timestampStr;
    if (timestampStr instanceof Date) {
        finalTime = Utilities.formatDate(timestampStr, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm:ss");
    }
    
    logSheet.appendRow([finalTime, plu, mpn, ean, name, action, sheetName, user, oldQty, newQty]);
  } catch(e) {
    Logger.log("WriteLog Error: " + e);
  }
}

function getRecentLogs(sheetName) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName("Log");
    if (!logSheet) return [];
    
    var lastRow = logSheet.getLastRow();
    if (lastRow < 2) return []; 
    
    // Get all data
    var data = logSheet.getRange(2, 1, lastRow - 1, 10).getValues(); 
    var logs = [];
    var count = 0;
    
    // Iterate backwards (newest first)
    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      
      // row[6] is the sheet name
      if (String(row[6]) === String(sheetName)) { 
         var t = row[0];
         
         // Date format check
         if (t instanceof Date) {
            t = Utilities.formatDate(t, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm:ss");
         }
         
         logs.push({
           time: String(t), 
           plu: String(row[1]), 
           mpn: String(row[2]), 
           ean: String(row[3]),
           name: String(row[4]), 
           action: String(row[5]), 
           user: String(row[7]),
           oldVal: String(row[8]), 
           newVal: String(row[9])
         });
         
         count++;
         if (count >= 1000) break; // Limit of 1000 records
      }
    }
    return logs;
  } catch (e) { 
    return []; 
  }
}

function getLogsForClient(sheetId) {
  try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      // getSheetById function is defined in Main.gs, which is fine
      var sheet = getSheetById(ss, sheetId);
      if(!sheet) return [];
      return getRecentLogs(sheet.getName());
  } catch(e) { 
      return []; 
  }
}