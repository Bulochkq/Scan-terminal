/**
 * CONFIG.GS — єдине місце з налаштуваннями.
 *
 * Усі файли Apps Script живуть в одному глобальному просторі імен,
 * тому дублювати ці константи в інших файлах не потрібно.
 */

var CFG = {
  LOG_SHEET:       'Log',
  SETTINGS_SHEET:  'NASTAVENIA',
  IMPORT_SHEET:    'FLEX_IMPORT',

  DB_START_ROW:    2,
  COL_COUNT:       9,   // A..I
  COL_REAL:        7,   // G — Realita
  COL_DIFF:        8,   // H — Rozdiel (формула)
  COL_NOTE:        9,   // I — Poznámka

  HEADERS: ['Značka', 'PLU', 'Názov karty', 'SKU', 'EAN', 'Plán', 'Realita', 'Rozdiel', 'Poznámka'],
  LOG_HEADERS: ['Čas', 'PLU', 'SKU', 'EAN', 'Názov tovaru', 'Akcia', 'Hárok', 'Užívateľ', 'Bolo', 'Je'],

  MAX_LOG_ROWS:    5000,  // після цього лог архівується і чиститься
  LOG_READ_LIMIT:  400,   // скільки рядків логу читати для історії
  CHANGE_BUFFER:   250,   // скільки останніх змін тримати в кеші для синхронізації
  PRESENCE_TTL_MS: 45000, // скільки секунд користувач вважається активним

  SHEET_CHUNK:     4000   // максимум рядків за один запит getSheet
};

/**
 * PIN зберігається у Script Properties, а не в коді.
 * Один раз виконай setupAdminPin('свій-новий-пін') у редакторі Apps Script.
 */
var LEGACY_PIN_ = '85592';

function getAdminPin_() {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  return stored || LEGACY_PIN_;
}

function isPinDefault_() {
  return !PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
}

/** Запусти вручну один раз, щоб задати власний PIN. */
function setupAdminPin(newPin) {
  var pin = String(newPin || '').trim();
  if (pin.length < 4) throw new Error('PIN має бути щонайменше 4 символи.');
  PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', pin);
  return 'PIN збережено.';
}

function verifyAdminPin(inputPin) {
  return String(inputPin == null ? '' : inputPin).trim() === getAdminPin_();
}

function requirePin_(pin) {
  if (!verifyAdminPin(pin)) throw new Error('AUTH: Nesprávne admin heslo.');
}

// --- спільні дрібні помічники ---

function getSheetById_(ss, id) {
  if (!id && id !== 0) return null;
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getSheetId()) === String(id)) return sheets[i];
  }
  return null;
}

function toInt_(v) {
  var n = Math.floor(Number(v));
  return isNaN(n) ? 0 : n;
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
}
