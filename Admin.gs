/**
 * ADMIN.GS
 * Fixed version (Standalone)
 */

// Hardcode settings here so the file works standalone
var STR_SETTINGS = "NASTAVENIA";
var STR_PIN = "85592";

// --- AUTHORIZATION ---

function verifyAdminPin(inputPin) {
   return String(inputPin).trim() === STR_PIN;
}

// --- USER MANAGEMENT ---

function addUser(name) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(STR_SETTINGS);
    if (!sheet) { 
      sheet = ss.insertSheet(STR_SETTINGS); 
      sheet.appendRow(["MENO PRACOVNÍKA"]); 
    }
    
    var cleanName = String(name).trim();
    if (cleanName === "") return getUsersList();

    var data = sheet.getDataRange().getValues();
    // Duplicate check
    var exists = data.some(function(r){ return String(r[0]).toLowerCase() === cleanName.toLowerCase(); });
    
    if (!exists) {
      sheet.appendRow([cleanName]);
    }
    
    return getUsersList();
  } catch (e) { 
    logSystemError("AddUser Error: " + e.message, "Admin"); 
    return ["Error: " + e.message]; 
  }
}

function removeUser(name) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(STR_SETTINGS);
    if (!sheet) return getUsersList();
    
    var data = sheet.getDataRange().getValues();
    var cleanName = String(name).trim();
    
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === cleanName) { 
        sheet.deleteRow(i + 1); 
        break; // Remove only the first occurrence and exit
      }
    }
    return getUsersList();
  } catch (e) { 
    logSystemError("DelUser Error: " + e.message, "Admin"); 
    return ["Error: " + e.message]; 
  }
}

function getUsersList() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var userSheet = ss.getSheetByName(STR_SETTINGS);
    
    // If sheet doesn't exist, create it automatically to avoid returning an error
    if (!userSheet) {
       userSheet = ss.insertSheet(STR_SETTINGS);
       userSheet.appendRow(["MENO PRACOVNÍKA"]);
       userSheet.appendRow(["Skladník 1"]); // Add default worker
       return ["Skladník 1"];
    }

    var users = ["Skladník 1"]; 
    if (userSheet.getLastRow() >= 2) {
      // Read column A
      var raw = userSheet.getRange(2, 1, userSheet.getLastRow() - 1, 1).getValues().flat();
      var filtered = raw.filter(function(u) { return u && String(u).trim() !== ""; });
      if (filtered.length > 0) {
        users = filtered.map(function(u){ return String(u).trim(); });
      }
    }
    return users;
  } catch (e) { 
    // Return error as a list element so it is visible in the UI
    return ["Skladník 1", "Error: " + e.message]; 
  }
}

// --- WAREHOUSE MANAGEMENT (CREATE/DELETE) ---

function createNewSheet(name) {
  try {
    if (!name || name.trim() === "") return {success: false, msg: "Zadajte názov!"};
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss.getSheetByName(name)) return {success: false, msg: "Hárok s týmto názvom už existuje."};
    
    var newSheet = ss.insertSheet(name);
    newSheet.getRange(1, 1, 1, 9).setValues([["Značka", "PLU", "Názov karty", "SKU", "EAN", "Plán", "Realita", "Rozdiel", "Poznámka"]]);
    newSheet.getRange(1, 1, 1, 9).setFontWeight("bold").setBackground("#d9ead3").setBorder(true, true, true, true, true, true);
    newSheet.setFrozenRows(1);
    
    return {success: true, msg: "Sklad '" + name + "' vytvorený!"};
  } catch(e) { return {success: false, msg: "Chyba: " + e.message}; }
}

function deleteTargetSheet(sheetId, password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ Nesprávne heslo!"};
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // Use getSheetById from Main.gs or local logic if Main is not available
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }
    
    if (!sheet) return {success: false, msg: "Hárok nenájdený."};
    
    var name = sheet.getName();
    var bName = createHiddenBackup(ss, sheet); 
    ss.deleteSheet(sheet);
    
    writeToLog("ADMIN", "DELETE", "OK", "Deleted Sheet: " + name, "DELETE", 0, 0, "SYSTEM", "Admin", new Date());
    return {success: true, msg: "Sklad zmazaný. Záloha: " + bName};
  } catch(e) { return {success: false, msg: "Chyba: " + e.message}; }
}

// --- CRUD OPERATIONS (Create, Read, Update, Delete) ---

function adminUpdateItem(sheetId, row, data, user, password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ Auth Error"};
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch(e) { return {success: false, msg: "Server busy"}; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }
    
    if (!sheet) return {success: false, msg: "Sheet not found"};
    var range = sheet.getRange(row, 1, 1, 9);
    var currentVals = range.getValues()[0];
    var newPlan = Math.floor(Number(data.plan) || 0);
    var newReal = Math.floor(Number(data.real) || 0);
    var newRow = [String(data.brand), String(data.plu), String(data.name), String(data.code), String(data.ean), newPlan, newReal, "", currentVals[8]];
    range.setValues([newRow]);
    sheet.getRange(row, 8).setFormulaR1C1("=N(RC[-1])-RC[-2]"); 
    
    var cache = CacheService.getScriptCache();
    cache.put("VERSION_" + sheetId, String(Date.now()), 21600);
    writeToLog(data.plu, data.code, data.ean, data.name, "ADMIN_EDIT", currentVals[6], newReal, sheet.getName(), user, new Date());
    return {success: true, msg: "Uložené!"};
  } catch(e) { return {success: false, msg: e.message}; } finally { lock.releaseLock(); }
}

function adminCreateItem(sheetId, data, user, password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ Auth Error"};
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch(e) { return {success: false, msg: "Server busy"}; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }

    if (!sheet) return {success: false, msg: "Sheet not found"};
    
    var newPlan = Math.floor(Number(data.plan) || 0);
    var newReal = Math.floor(Number(data.real) || 0);
    
    sheet.appendRow([String(data.brand), String(data.plu), String(data.name), String(data.code), String(data.ean), newPlan, newReal, "", ""]);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 8).setFormulaR1C1("=N(RC[-1])-RC[-2]");
    
    var cache = CacheService.getScriptCache();
    cache.put("VERSION_" + sheetId, String(Date.now()), 21600);
    writeToLog(data.plu, data.code, data.ean, data.name, "ADMIN_ADD", 0, newReal, sheet.getName(), user, new Date());
    return {success: true, msg: "Pridané!"};
  } catch(e) { return {success: false, msg: e.message}; } finally { lock.releaseLock(); }
}

function adminDeleteItem(sheetId, row, user, password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ Auth Error"};
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch(e) { return {success: false, msg: "Server busy"}; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }

    if (!sheet) return {success: false, msg: "Sheet not found"};
    
    var range = sheet.getRange(row, 1, 1, 5);
    var vals = range.getValues()[0];
    sheet.deleteRow(row);
    
    var cache = CacheService.getScriptCache();
    cache.put("VERSION_" + sheetId, String(Date.now()), 21600);
    writeToLog(vals[1], vals[3], vals[4], vals[2], "ADMIN_DEL", 0, 0, sheet.getName(), user, new Date());
    return {success: true, msg: "Zmazané!"};
  } catch(e) { return {success: false, msg: e.message}; } finally { lock.releaseLock(); }
}

// --- BACKUPS ---

function createHiddenBackup(ss, sheet) {
  try {
    var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd.MM.yyyy_HH-mm");
    var backupName = sheet.getName() + "_BACKUP_" + timestamp;
    if (ss.getSheetByName(backupName)) { backupName += "_" + Math.floor(Math.random() * 100); }
    var backup = sheet.copyTo(ss);
    backup.setName(backupName);
    backup.hideSheet(); 
    return backupName;
  } catch (e) {
    throw new Error("Backup failed: " + e.message);
  }
}

function getBackupsList(password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ Auth Error"};
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ss.getSheets();
    var backups = [];
    
    for(var i=0; i<sheets.length; i++) {
        var s = sheets[i];
        if(s.getName().indexOf("_BACKUP_") !== -1) {
            backups.push({
                id: s.getSheetId(),
                name: s.getName()
            });
        }
    }
    backups.sort(function(a,b){ return b.name.localeCompare(a.name); });
    return {success: true, list: backups};
  } catch(e) { return {success: false, msg: e.message}; }
}

function deleteBackupSheet(sheetId, password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ Auth Error"};
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }

    if(sheet) {
        var name = sheet.getName();
        ss.deleteSheet(sheet);
        writeToLog("ADMIN", "DEL_BACKUP", "OK", "Deleted: " + name, "DELETE", 0, 0, "SYSTEM", "Admin", new Date());
        return {success: true};
    }
    return {success: false, msg: "Sheet not found"};
  } catch(e) { return {success: false, msg: e.message}; }
}

// --- DATA IMPORT (IMPORT) ---

function processXlsxUpload(rawData, targetSheetId, password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ CHYBA: Nesprávne admin heslo!"};
  if (!rawData || !rawData.length) return {success: false, msg: "❌ CHYBA: Prázdny súbor."};

  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch(e) { return {success: false, msg: "Server busy"}; }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var impSheet = ss.getSheetByName("FLEX_IMPORT");
    if (!impSheet) { impSheet = ss.insertSheet("FLEX_IMPORT"); }
    impSheet.clear();
    
    var maxRows = Math.min(rawData.length, 15000);
    var dataToWrite = rawData.slice(0, maxRows);
    var maxCols = 0;
    for (var i = 0; i < dataToWrite.length; i++) {
        if (dataToWrite[i].length > maxCols) maxCols = dataToWrite[i].length;
    }
    if (maxCols === 0) return {success: false, msg: "❌ CHYBA: Žiadne stĺpce."};

    for (var i = 0; i < dataToWrite.length; i++) {
        while (dataToWrite[i].length < maxCols) { dataToWrite[i].push(""); }
    }
    
    impSheet.getRange(1, 1, dataToWrite.length, maxCols).setValues(dataToWrite);
    SpreadsheetApp.flush(); 
    
    lock.releaseLock(); 
    return runImportFromSidebar(targetSheetId, password);

  } catch(e) {
    return {success: false, msg: "Upload chyba: " + e.message};
  } finally { try { lock.releaseLock(); } catch(e){} }
}

function runImportFromSidebar(targetSheetId, password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ CHYBA: Nesprávne admin heslo!"};

  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch(e) { return {success: false, msg: "Server busy"}; }
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var targetSheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == targetSheetId) { targetSheet = sheets[i]; break; } }
    
    if (!targetSheet) return {success: false, msg: "Cieľový hárok neexistuje"};

    var impSheet = ss.getSheetByName("FLEX_IMPORT");
    if (!impSheet) return {success: false, msg: "Chýba hárok FLEX_IMPORT"};
    
    var rawData = impSheet.getDataRange().getValues();
    if (rawData.length < 1) return {success: false, msg: "Import dáta sú prázdne"};

    var headerRowIndex = -1;
    var colMap = { brand: -1, plu: -1, name: -1, code: -1, ean: -1, plan: -1 };
    
    for (var r = 0; r < Math.min(rawData.length, 20); r++) {
        var row = rawData[r].map(function(c){ return String(c).toLowerCase().trim(); });
        
        if (row.indexOf("kód karty") !== -1 && row.indexOf("názov karty") !== -1) {
            headerRowIndex = r;
            colMap.plu = row.indexOf("kód karty");
            colMap.name = row.indexOf("názov karty");
            
            colMap.brand = row.indexOf("obchodný typ");
            colMap.code = row.indexOf("kód používaný výrobcom");
            colMap.ean = row.indexOf("čiarový kód");
            
            var planIdx = row.indexOf("disponibilný stav");
            if (planIdx === -1) planIdx = row.indexOf("disponibiln"); 
            colMap.plan = planIdx;
            
            break;
        }
    }

    if (headerRowIndex === -1 || colMap.plu === -1) {
        return {success: false, msg: "❌ CHYBA: Nenašiel sa stĺpec 'Kód karty' alebo hlavička."};
    }

    var newData = [];
    var seenKeys = {};
    
    for (var r = headerRowIndex + 1; r < rawData.length; r++) {
       var row = rawData[r];
       var rawPlu = (colMap.plu > -1) ? row[colMap.plu] : "";
       
       if (!rawPlu || String(rawPlu).trim() === "") continue;
       
       var key = String(rawPlu).trim();
       if (seenKeys[key]) continue; 
       seenKeys[key] = true;

       var brand = (colMap.brand > -1) ? String(row[colMap.brand]) : "";
       var brandMatch = brand.match(/\[(.*?)\]/);
       if (brandMatch && brandMatch[1]) {
           brand = brandMatch[1];
       } 

       var name = (colMap.name > -1) ? String(row[colMap.name]) : "";
       var code = (colMap.code > -1) ? String(row[colMap.code]) : "";
       var ean = (colMap.ean > -1) ? String(row[colMap.ean]) : "";
       
       var planVal = 0;
       if (colMap.plan > -1) {
           var pv = row[colMap.plan];
           if (typeof pv === 'string') pv = pv.replace(',', '.').replace(/\s/g, '');
           planVal = Math.floor(Number(pv)) || 0;
       }

       newData.push([brand, key, name, code, ean, planVal, 0, "", ""]);
    }

    var backupMsg = "";
    if (targetSheet.getLastRow() > 1) {
       try {
         var bName = createHiddenBackup(ss, targetSheet);
         backupMsg = " (Záloha: " + bName + ")";
       } catch(e) { return {success: false, msg: "❌ Záloha zlyhala: " + e.message}; }
    }

    targetSheet.clear();
    targetSheet.getRange(1, 1, 1, 9).setValues([["Značka", "PLU", "Názov karty", "SKU", "EAN", "Plán", "Realita", "Rozdiel", "Poznámka"]]);
    targetSheet.getRange(1, 1, 1, 9).setFontWeight("bold").setBackground("#d9ead3").setBorder(true, true, true, true, true, true);
    
    if (newData.length > 0) {
      targetSheet.getRange(2, 1, newData.length, 9).setValues(newData);
      targetSheet.getRange(2, 8, newData.length, 1).setFormulaR1C1("=N(RC[-1])-RC[-2]");
      targetSheet.getRange(2, 1, newData.length, 9).setHorizontalAlignment("left");
      targetSheet.autoResizeColumns(1, 9);
      
      var rangeH = targetSheet.getRange(2, 8, newData.length, 1);
      var rules = [];
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setBackground("#fecaca").setRanges([rangeH]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground("#fed7aa").setRanges([rangeH]).build());
      targetSheet.setConditionalFormatRules(rules);
    }
    
    var cache = CacheService.getScriptCache();
    cache.put("VERSION_" + targetSheetId, String(Date.now()), 21600);

    writeToLog("ADMIN", "IMPORT", "OK", "Imported " + newData.length + " items", "IMPORT", 0, 0, targetSheet.getName(), "Admin", new Date());
    SpreadsheetApp.flush(); 
    return {success: true, msg: "Import úspešný! Načítaných " + newData.length + " položiek." + backupMsg};
    
  } catch(e) { 
    logSystemError("Import Error: " + e.message, "Admin");
    return {success: false, msg: "Chyba: " + e.message}; 
  } finally { 
    lock.releaseLock(); 
  }
}

function runClearLogsFromSidebar(password) {
  if (!verifyAdminPin(password)) return {success: false, msg: "⛔ Nesprávne heslo!"};
  var lock = LockService.getScriptLock();
  try { lock.waitLock(2000); } catch(e) { return {success: false, msg: "Server busy"}; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName("Log");
    if (!logSheet) return {success: false, msg: "Chyba: Log hárok neexistuje."};
    
    var bName = "";
    if(logSheet.getLastRow() > 1) {
       try { bName = createHiddenBackup(ss, logSheet); logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 10).clearContent(); } 
       catch(e) { return {success: false, msg: "❌ Záloha zlyhala!"}; }
    }
    
    logSheet.getRange(1, 1, 1, 10).setValues([["Čas", "PLU", "SKU", "EAN", "Názov tovaru", "Akcia", "Hárok", "Užívateľ", "Bolo", "Je"]]);
    writeToLog("ADMIN", "CLEAR", "OK", "Logs Cleared", "CLEAR", 0, 0, "LOGS", "Admin", new Date());
    return {success: true, msg: "Logy vymazané! (Záloha: " + bName + ")"};
  } catch(e) { return {success: false, msg: "Chyba: " + e.message}; } finally { lock.releaseLock(); }
}