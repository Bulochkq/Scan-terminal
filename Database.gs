/**
 * DATABASE.GS
 * Fixed version (Standalone)
 */

// --- GETTING DATA (READ) ---

function getInitData() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ss.getSheets();
    var sheetList = [];
    // Hardcode ignored sheets here to not depend on Main.gs
    var blocked = ["Log", "FLEX_IMPORT", "NASTAVENIA", "LOG", "log"];
    
    for (var i = 0; i < sheets.length; i++) {
      var s = sheets[i];
      var n = s.getName();
      if (blocked.indexOf(n) === -1) {
        if(n.indexOf("_BACKUP_") !== -1) {
             sheetList.push({ name: "📦 " + n, id: s.getSheetId(), isBackup: true });
        } else if (!s.isSheetHidden()) {
             sheetList.push({ name: n, id: s.getSheetId(), isBackup: false });
        }
      }
    }
    
    // Get the users list (now this function works standalone in Admin.gs)
    var safeUsers = ["Skladník 1"];
    try { 
        if (typeof getUsersList === 'function') {
            safeUsers = getUsersList(); 
        }
    } catch(e) { 
        safeUsers = ["Error loading users: " + e.message];
    }
    
    // Get the URL from Main.gs, but if it doesn't exist, set a placeholder
    var url = "";
    try { url = DEPLOYMENT_URL; } catch(e) { url = ScriptApp.getService().getUrl(); }

    return { sheets: sheetList, users: safeUsers, deployUrl: url };
  } catch (e) { return { sheets: [], users: ["Critical Error: " + e.message], deployUrl: "" }; }
}

function getSheetData(sheetId, user, sessionId) {
  if (!sheetId) return { status: "error", msg: "Nebol vybraný žiadny hárok" };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // Local function to find the sheet, to avoid dependency on Main.gs
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }

    if (!sheet) return { status: "error", msg: "SHEET_NOT_FOUND" };
    
    var lockRes = acquireSheetLock(sheetId, user, sessionId);
    var lastRow = sheet.getLastRow();
    var db = [];
    
    var startRow = 2; // Hardcoded start row
    
    if (lastRow >= startRow) {
      var range = sheet.getRange(startRow, 1, lastRow - startRow + 1, 9);
      var data = range.getValues();
      
      for (var i = 0; i < data.length; i++) {
        var r = data[i];
        if (!r[1] && !r[2]) continue; 
        
        db.push({
          row: startRow + i,
          brand: String(r[0] || ""),
          plu: String(r[1] || ""),
          name: String(r[2] || "Bez názvu"),
          code: String(r[3] || ""),
          ean: String(r[4] || ""),
          plan: Math.floor(Number(r[5]) || 0),
          real: Math.floor(Number(r[6]) || 0),
          note: String(r[8] || "") 
        });
      }
    }
    return { status: "success", data: db, sheetName: sheet.getName(), otherUser: lockRes.otherUser, dataVersion: lockRes.dataVersion }; 
  } catch(e) { return { status: "error", msg: e.message }; }
}

// --- WRITING DATA (WRITE) ---

function processQueueItem(item, sheetId, user, sessionId) {
  if (!sheetId) return { status: "error", msg: "No sheet ID" };
  var newQty = Math.floor(Number(item.forceValue));
  if (newQty < 0) newQty = 0; 
  acquireSheetLock(sheetId, user, sessionId);
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch(e) { return { status: "retry", msg: "Server busy" }; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }

    if (!sheet) return { status: "error", msg: "SHEET_NOT_FOUND" };
    var range = sheet.getRange(item.row, 7);
    var serverOldQty = Math.floor(Number(range.getValue()) || 0);
    var logOldQty = (item.clientOldValue !== undefined) ? item.clientOldValue : serverOldQty;
    if (newQty !== serverOldQty || logOldQty !== newQty) {
      range.setValue(newQty);
      var actionLabel = (item.type === "scan") ? "SKEN" : "MANUÁL";
      var info = sheet.getRange(item.row, 2, 1, 4).getValues()[0];
      writeToLog(info[0], info[2], info[3], info[1], actionLabel, logOldQty, newQty, sheet.getName(), user, item.timestamp || new Date());
      SpreadsheetApp.flush(); 
    }
    return { status: "success", newReal: newQty };
  } catch(e) { return { status: "error", msg: e.message }; } finally { lock.releaseLock(); }
}

function saveProductNote(sheetId, row, noteText, user, sessionId) {
  if (!sheetId) return { status: "error", msg: "No sheet ID" };
  acquireSheetLock(sheetId, user, sessionId);
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch(e) { return { status: "retry", msg: "Server busy" }; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = null;
    var sheets = ss.getSheets();
    for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }

    if (!sheet) return { status: "error", msg: "SHEET_NOT_FOUND" };
    var range = sheet.getRange(row, 9);
    var oldNote = String(range.getValue() || "");
    var rawInput = String(noteText || "").trim();
    var finalNoteToSave = "";
    if (rawInput !== "") { finalNoteToSave = rawInput + " / " + user; }
    if (oldNote !== finalNoteToSave) {
       range.setValue(finalNoteToSave);
       var info = sheet.getRange(row, 2, 1, 4).getValues()[0];
       writeToLog(info[0], info[2], info[3], info[1], "POZNÁMKA", oldNote, finalNoteToSave, sheet.getName(), user, Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm:ss"));
    }
    return { status: "success", note: finalNoteToSave };
  } catch(e) { return { status: "error", msg: e.message }; } finally { lock.releaseLock(); }
}

// --- LOCKING AND SYNCHRONIZATION (LOCKS) ---

function acquireSheetLock(sheetId, user, sessionId) {
  if (!sheetId) return { success: false };
  var cache = CacheService.getScriptCache();
  var lockKey = "ACTIVITY_" + sheetId; 
  var versionKey = "VERSION_" + sheetId;
  
  var otherUser = null;
  var cachedJson = cache.get(lockKey);
  var now = Date.now();
  if (cachedJson) {
    var cachedData = JSON.parse(cachedJson);
    if (cachedData.id !== sessionId && (now - (cachedData.time || 0) < 35000)) { otherUser = cachedData.user; }
  }
  if (!otherUser) { cache.put(lockKey, JSON.stringify({ user: user, id: sessionId, time: now }), 40); }
  
  var currentVersion = cache.get(versionKey) || "0";

  var allReals = [];
  try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = null;
      var sheets = ss.getSheets();
      for(var i=0; i<sheets.length; i++) { if(sheets[i].getSheetId() == sheetId) { sheet = sheets[i]; break; } }

      if(sheet) {
        var lastRow = sheet.getLastRow();
        var startRow = 2; 
        if (lastRow >= startRow) {
          allReals = sheet.getRange(startRow, 7, lastRow - startRow + 1, 1).getValues().flat();
          allReals = allReals.map(function(v) { return Math.floor(Number(v) || 0); });
        }
      }
  } catch(e) { logSystemError("Sync Read Error: " + e.message, user); }
  
  return { success: true, allReals: allReals, otherUser: otherUser, dataVersion: currentVersion };
}

function releaseSheetLock(sheetId, user, sessionId) {
  if (!sheetId) return;
  var cache = CacheService.getScriptCache();
  var lockKey = "ACTIVITY_" + sheetId;
  var cachedJson = cache.get(lockKey);
  if (cachedJson) {
      var cachedData = JSON.parse(cachedJson);
      if (cachedData.id === sessionId) { cache.remove(lockKey); }
  }
}