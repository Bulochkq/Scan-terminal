/**
 * MAIN.GS
 * 
 * WHY THIS FILE IS HERE:
 * This is the entry point of your application. Here we keep:
 * 1. Global settings (constants) used everywhere.
 * 2. The doGet() function, which runs the application.
 * 3. The include() function, which is the "glue" connecting HTML, CSS, and JS.
 */

// --- GLOBAL CONSTANTS (Settings) ---
var DEPLOYMENT_URL = "https://script.google.com/macros/s/AKfycbz-RY6-r9Q6FrYjCw-HiWNo5V1UAPUtwgqs15mgS1XgZMmQN0KRqhDlPUZP6cF2opRJoA/exec";
var logSheetName = "Log";
var importSheetName = "FLEX_IMPORT";
var settingsSheetName = "NASTAVENIA";
var dbStartRow = 2;
var ADMIN_PIN = "85592";

/**
 * Main function to launch the web application.
 * It is configured to use an HTML Template,
 * which allows utilizing the include() helper function.
 */
function doGet(e) {
  // Use createTemplateFromFile instead of createHtmlOutputFromFile
  return HtmlService.createTemplateFromFile('Index')
      .evaluate() // "Assembles" all files together
      .setTitle('📦 SKLADOVÝ TERMINÁL v2.52')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0');
}

/**
 * Helper function to include external files.
 * It fetches the content of the specified file (e.g., Styles.html) and inserts it into Index.html.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// --- MENU FOR GOOGLE SHEETS ---

function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('TERMINÁL (Admin)')
      .addItem('▶️ Otvoriť terminál', 'openAudioPanel')
      .addItem('🌍 Otvoriť na celú obrazovku', 'openWebAppLauncher')
      .addToUi();
}

function openAudioPanel() {
  // We use Index here as well so the sidebar has the same visual style
  var html = HtmlService.createTemplateFromFile('Index').evaluate().setTitle('📦 SKLADOVÝ TERMINÁL').setWidth(350);
  SpreadsheetApp.getUi().showSidebar(html);
}

function openWebAppLauncher() {
  var html = '<div style="text-align:center; font-family:sans-serif; padding:10px;">' +
      '<a href="' + DEPLOYMENT_URL + '" target="_blank" style="background:#1a73e8; color:white; text-decoration:none; padding:12px 20px; border-radius:8px; font-weight:bold; font-size:16px; display:block;">🚀 OTVORIŤ APP</a>' +
      '<div style="margin-top:10px; color:#666; font-size:12px;">Pre mobil / tablet</div></div>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setHeight(150), '📱 Webová Verzia');
}

// Helper function to retrieve a sheet by its ID
function getSheetById(ss, id) {
  if (!id) return null;
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() == id) return sheets[i];
  }
  return null;
}
