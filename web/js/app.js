/**
 * APP.JS — логіка терміналу.
 *
 * Порт зі Scripts.html тестової версії. Поведінка навмисно збережена
 * один-в-один; змінився транспорт (API замість google.script.run) і
 * виправлені знайдені баги — вони позначені коментарем ВИПРАВЛЕНО.
 */
'use strict';

var CFG = window.APP_CONFIG;

// ------------------------------------------------------------ стан

var localDB = [];
var rowIndex = {};            // номер рядка в таблиці -> індекс у localDB
var currentItem = null;
var currentSheetId = '';
var currentSheetName = '';
var currentUser = '';
var sessionId = 'S_' + Math.random().toString(36).slice(2, 11);

var adminPin = null;          // перевіряється НА СЕРВЕРІ, тут лише кешується на сесію
var lastSyncTime = 0;
var pingTimer = null;
var isPinging = false;

var pendingDelta = 0, batchTimer = null, isBatching = false;
var batchStartValue = null, batchTimestamp = '', lastActionDir = 0;
var currentActionType = 'manual';
var pendingWrites = {};
var lastUserActionTime = 0;

var zoomSeconds = 1.0, zoomEnabled = true, soundEnabled = true;
var flashTimeout = null, busyTimeout = null;
var html5QrCode = null, isFlashOn = false;
var currentBackups = [];
var audioCtx = null;

var listState = {
  mode: 'user',
  filter: { all: true, miss: false, extra: false, done: false, note: false },
  selectedPlu: null
};

// ------------------------------------------------------------ помічники

/** ВИПРАВЛЕНО: раніше назви товарів і складів вставлялись у HTML без екранування. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

function getLoaderHtml(text) {
  return '<div class="spinner-container"><div class="custom-loader"></div>' +
         '<div class="spinner-text">' + escapeHtml(text || 'Načítavam...') + '</div></div>';
}

function getBrandBadge(brand) {
  if (!brand) return '';
  var t = brand.length > 25 ? brand.slice(0, 25) + '...' : brand;
  return '<span class="brand-list-badge">' + escapeHtml(t) + '</span>';
}

function errText(e) {
  return (e && e.message) ? e.message : String(e);
}

/**
 * Показує червону картку помилки і перезапускає анімацію струшування.
 * Без примусового reflow браузер не програє ту саму анімацію вдруге —
 * при двох невдалих сканах поспіль друге виглядало б «мертвим».
 */
function showScanError(text) {
  var el = document.getElementById('errCard');
  var $el = $(el);
  $el.removeClass('hidden shake-anim').text(text);
  void el.offsetWidth;
  $el.addClass('shake-anim');
}

// ------------------------------------------------------------ звук

function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('touchstart', unlockAudio, { passive: true });
document.addEventListener('click', unlockAudio);

function playTone(freq, type, dur) {
  if (!soundEnabled) return;
  unlockAudio();
  if (!audioCtx) return;
  try {
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + dur);
    o.stop(audioCtx.currentTime + dur);
  } catch (e) {}
}
function sndOk()   { playTone(1200, 'sine', 0.08); }
function sndDone() { playTone(523, 'sine', 0.1); setTimeout(function () { playTone(784, 'sine', 0.2); }, 150); }
function sndOver() { playTone(150, 'sawtooth', 0.3); }
function sndErr()  { playTone(100, 'square', 0.15); }

// ------------------------------------------------------------ модалки

var promptResolver = null, confirmResolver = null;

function showMsg(title, text) {
  $('#msgTitle').text(title);
  $('#msgText').html(escapeHtml(text).replace(/\n/g, '<br>'));
  $('#msgModal').removeClass('hidden');
}
function closeMsg() { $('#msgModal').addClass('hidden'); }

function showPrompt(title, placeholder, defaultValue, isPassword) {
  return new Promise(function (resolve) {
    promptResolver = resolve;
    $('#promptTitle').text(title);
    $('#promptInput').val(defaultValue || '')
      .attr('placeholder', placeholder || '')
      .attr('type', isPassword ? 'password' : 'text');
    $('#promptEye').toggleClass('hidden', !isPassword);
    $('#promptModal').removeClass('hidden');
    setTimeout(function () { $('#promptInput').focus(); }, 50);
  });
}
function togglePromptPass() {
  var $i = $('#promptInput');
  $i.attr('type', $i.attr('type') === 'password' ? 'text' : 'password');
}
function submitPrompt() {
  var v = $('#promptInput').val();
  $('#promptModal').addClass('hidden');
  if (promptResolver) promptResolver(v);
  promptResolver = null;
}
function cancelPrompt() {
  $('#promptModal').addClass('hidden');
  if (promptResolver) promptResolver(null);
  promptResolver = null;
}

function showConfirm(title, text, destructive) {
  return new Promise(function (resolve) {
    confirmResolver = resolve;
    $('#confirmTitle').text(title);
    $('#confirmText').html(escapeHtml(text).replace(/\n/g, '<br>'));
    $('#confirmYesBtn').removeClass('lb-go lb-del').addClass(destructive ? 'lb-del' : 'lb-go');
    $('#confirmModal').removeClass('hidden');
  });
}
function answerConfirm(res) {
  $('#confirmModal').addClass('hidden');
  if (confirmResolver) confirmResolver(res);
  confirmResolver = null;
}

function setAdminBusy(busy, text) {
  if (busyTimeout) clearTimeout(busyTimeout);
  if (busy) {
    $('#adminLoadingText').text(text || 'SPRACOVÁVAM...');
    $('#adminProcessOverlay').removeClass('hidden');
    busyTimeout = setTimeout(function () { $('#adminProcessOverlay').addClass('hidden'); }, 180000);
  } else {
    $('#adminProcessOverlay').addClass('hidden');
  }
}
window.setAdminBusy = setAdminBusy;
window.showMsg = showMsg;
window.showConfirm = showConfirm;

/**
 * ВИПРАВЛЕНО: PIN більше не порівнюється в браузері.
 * Раніше в коді сторінки лежав рядок if (p !== "85592") — тобто секрет бачив
 * будь-хто, хто відкрив «переглянути код». Тепер перевіряє сервер.
 */
function ensurePin() {
  if (adminPin) return Promise.resolve(adminPin);
  return showPrompt('🔑 Admin PIN:', '', '', true).then(function (p) {
    if (p === null || p === '') return null;
    return API.auth(p).then(function (res) {
      if (res.valid) { adminPin = p; return p; }
      showMsg('Chyba', '⛔ Nesprávny PIN');
      return null;
    }).catch(function (e) {
      showMsg('Chyba', errText(e));
      return null;
    });
  });
}
window.ensurePin = ensurePin;

// ------------------------------------------------------------ селекти

function renderCustomSelects() {
  $('.custom-select:not(#camSelect)').each(function () {
    var $sel = $(this);
    var $wrapper, $trigger, $options;

    if ($sel.parent().hasClass('custom-select-wrapper')) {
      $wrapper = $sel.parent();
      $trigger = $wrapper.find('.custom-select-trigger');
      $options = $wrapper.find('.custom-options');
    } else {
      $sel.wrap('<div class="custom-select-wrapper"></div>');
      $sel.after('<div class="custom-select-trigger"></div><div class="custom-options"></div>');
      $wrapper = $sel.parent();
      $trigger = $wrapper.find('.custom-select-trigger');
      $options = $wrapper.find('.custom-options');

      $trigger.on('click', function (e) {
        if ($sel.prop('disabled')) return;
        $('.custom-select-wrapper').not($wrapper).removeClass('open');
        $wrapper.toggleClass('open');
        e.stopPropagation();
      });
      $wrapper.on('click', '.custom-option', function (e) {
        var $o = $(this);
        $wrapper.removeClass('open');
        // ВИПРАВЛЕНО: .data() приводить типи — ID аркуша "0012" ставало числом 12.
        // .attr() віддає рядок як є.
        $sel.val($o.attr('data-value')).trigger('change');
        $options.find('.custom-option').removeClass('selected');
        $o.addClass('selected');
        $trigger.html(escapeHtml($o.text()) + '<span class="custom-arrow">▼</span>');
        e.stopPropagation();
      });
    }

    var selText = $sel.find('option:selected').text() || $sel.find('option').first().text() || '';
    $trigger.html(escapeHtml(selText) + '<span class="custom-arrow">▼</span>');
    $trigger.toggleClass('disabled', !!$sel.prop('disabled'));

    $options.empty();
    $sel.children('option').each(function () {
      var $o = $(this);
      if ($o.prop('disabled') && $o.val() === '') return;
      $options.append('<div class="custom-option' + ($o.is(':selected') ? ' selected' : '') +
                      '" data-value="' + escapeHtml($o.val()) + '">' + escapeHtml($o.text()) + '</div>');
    });
  });
}

$(document).on('click', function (e) {
  if (!$(e.target).closest('.custom-select-wrapper').length) $('.custom-select-wrapper').removeClass('open');
  if (!$(e.target).closest('.uni-filter-wrapper').length) $('.uni-filter-popover').removeClass('active');
});

function toggleFilterPopover(e) {
  if (e) e.stopPropagation();
  $('.uni-filter-popover').toggleClass('active');
}

// ------------------------------------------------------------ старт

function init() {
  $('#suVersion').text('v' + CFG.APP_VERSION);
  $('#suSite').text(CFG.SITE_NAME || '—');

  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    $('#manualToggleBtn, #cameraBtn').show();
  } else {
    $('#manualToggleBtn, #cameraBtn').hide();
    $('#codeInput').attr('inputmode', 'text');
  }

  try {
    var z = localStorage.getItem('localZoomSeconds'); if (z) zoomSeconds = parseFloat(z);
    var ze = localStorage.getItem('localZoomEnabled'); if (ze !== null) zoomEnabled = (ze === 'true');
    var se = localStorage.getItem('localSoundEnabled'); if (se !== null) soundEnabled = (se === 'true');
  } catch (e) {}

  if (!API.isConfigured()) {
    showMsg('Nie je nastavené API',
      'Otvorte súbor web/js/config.js a vložte adresu svojho Apps Script (končí na /exec).');
  }

  // ШВИДКІСТЬ: будимо Apps Script одразу при відкритті сторінки.
  // Після простою Google піднімає екземпляр скрипта заново, і перша дія
  // платить 5–10 секунд — саме звідси бралось «учора створення складу
  // тривало 10 секунд, а сьогодні 2». Поки людина обирає користувача
  // і склад, скрипт уже прогрітий.
  API.warm().catch(function () {});

  loadInitData();

  $('#pNoteInput').on('input', function () {
    var val = $(this).val();
    var orig = (currentItem ? currentItem.note : '') || '';
    var changed = val !== orig;
    $('#btnSaveNote').toggleClass('active-state', changed).prop('disabled', !changed);
  });

  $('#promptInput').on('keyup', function (e) { if (e.key === 'Enter') submitPrompt(); });

  $('#mq').on('input', function () {
    var v = $(this).val().replace(/[^0-9]/g, '');
    if (v !== '') { var n = parseInt(v, 10); if (n > 999) n = 999; $(this).val(n); }
  }).on('blur', function () {
    var n = parseInt($(this).val(), 10);
    if (isNaN(n) || n < 1) $(this).val(1);
  });

  $('#codeInput').on('keyup', function (e) {
    if (e.key === 'Enter') { doScan($(this).val()); $(this).val(''); }
  });

  // ВИПРАВЛЕНО: тут викликався звичайний fetch, який браузер при закритті
  // вкладки скасовує — тобто останнє сканування перед закриттям губилось.
  // sendBeacon саме для цього й існує: браузер дошле запит уже після виходу.
  window.addEventListener('pagehide', function () {
    if (isBatching && currentItem && pendingDelta !== 0) {
      API.writeBeacon({
        row: currentItem.row,
        plu: currentItem.plu,
        forceValue: currentItem.real,
        clientOldValue: batchStartValue,
        type: currentActionType,
        timestamp: batchTimestamp
      }, currentSheetId, currentUser, sessionId);
      isBatching = false; pendingDelta = 0;
    }
    if (currentSheetId) API.leaveBeacon(currentSheetId, sessionId);
  });
  window.addEventListener('online', function () { updateSyncUI('online'); flushOutbox(); });
  window.addEventListener('offline', function () { updateSyncUI('offline'); });

  renderCustomSelects();
  updateOutboxUI();
}

function loadInitData() {
  $('#setupUserSelect, #setupSheetSelect, #importSheetSelect').prop('disabled', true);
  renderCustomSelects();

  API.init().then(function (data) {
    updateUserSelect(data.users);
    updateSheetSelects(data.sheets);
    $('#setupUserSelect, #setupSheetSelect, #importSheetSelect').prop('disabled', false);
    renderCustomSelects();
    if (data.pinIsDefault) {
      console.warn('Admin PIN ще не змінено — виконай setupAdminPin() у редакторі Apps Script.');
    }
  }).catch(function (e) {
    $('#setupUserSelect, #setupSheetSelect').html('<option>⚠️ Chyba pripojenia</option>');
    renderCustomSelects();
    showMsg('Chyba pripojenia', errText(e));
  });
}

function updateUserSelect(users) {
  var $u = $('#setupUserSelect').empty();
  $u.append('<option value="" selected disabled>-- Vyberte --</option>');
  (users || []).forEach(function (u) {
    $u.append('<option value="' + escapeHtml(u) + '">' + escapeHtml(u) + '</option>');
  });
  renderCustomSelects();
}

function updateSheetSelects(sheets) {
  var $s = $('#setupSheetSelect').empty();
  var $i = $('#importSheetSelect').empty();
  $s.append('<option value="" selected disabled>-- Vyberte --</option>');
  $i.append('<option value="" selected disabled>-- Vyberte --</option>');

  if (!sheets || !sheets.length) {
    $s.append('<option value="">(Žiadne sklady)</option>');
  } else {
    // ВИПРАВЛЕНО: раніше в текст опції дописувалась кількість рядків «(1234)»,
    // а потім вирізалась регуляркою /\(\d+\)$/. Склад із назвою на кшталт
    // «Sklad A (2024)» через це втрачав частину назви — а назва складу
    // використовується для пошуку в логах.
    sheets.forEach(function (sh) {
      var opt = '<option value="' + escapeHtml(sh.id) + '">' + escapeHtml(sh.name) + '</option>';
      $s.append(opt); $i.append(opt);
    });
  }
  renderCustomSelects();
  updateAdminState();
}

function refreshSheetList() {
  $('.ref-btn').addClass('busy');
  loadInitData();
  setTimeout(function () { $('.ref-btn').removeClass('busy'); }, 800);
}

function updateSyncUI(status, extra) {
  var $p = $('#syncStatus');
  $p.removeClass('s-ok s-save s-err s-queue');
  $('.footer-wrapper, .input-group').removeClass('offline-disabled');

  if (status === 'online')       $p.text('🟢 ONLINE').addClass('s-ok');
  else if (status === 'saving')  $p.text('💾 UKLADÁM').addClass('s-save');
  else if (status === 'queue')   $p.text('📥 V RADE: ' + extra).addClass('s-queue');
  else if (status === 'offline') { $p.text('🔴 OFFLINE').addClass('s-err'); }
}

function updateOutboxUI() {
  var n = Outbox.count();
  if (n > 0) updateSyncUI('queue', n);
  else if (navigator.onLine) updateSyncUI('online');
  else updateSyncUI('offline');
}

// ------------------------------------------------------------ адмін-панель

function showAdminPanel() {
  ensurePin().then(function (pin) {
    if (!pin) return;
    $('#adminCard').removeClass('hidden');
    $('#setupGrid').removeClass('single-mode');
    updateAdminState();
  });
}
function closeAdminPanel() {
  $('#adminCard').addClass('hidden');
  $('#setupGrid').addClass('single-mode');
}
function updateAdminState() {
  var v = $('#importSheetSelect').val();
  $('#adminDependent').toggleClass('ag-disabled', !v);
}

function reqAddUser() {
  showPrompt('Meno pracovníka:', 'Meno', '').then(function (name) {
    if (!name) return;
    setAdminBusy(true, 'PRIDÁVAM...');
    return API.userAdd(name).then(function (r) {
      setAdminBusy(false); updateUserSelect(r.users);
    });
  }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

function reqDelUser() {
  var name = $('#setupUserSelect').val();
  if (!name) { showMsg('Info', 'Najprv vyberte užívateľa.'); return; }
  showConfirm('Vymazať užívateľa?', 'Naozaj vymazať: ' + name + '?', true).then(function (ok) {
    if (!ok) return;
    setAdminBusy(true, 'MAŽEM...');
    return API.userDel(name).then(function (r) {
      setAdminBusy(false); updateUserSelect(r.users);
    });
  }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

function reqCreateSheet() {
  ensurePin().then(function (pin) {
    if (!pin) return;
    return showPrompt('Názov skladu:', 'Napr. Sklad A', '').then(function (n) {
      if (!n) return;
      setAdminBusy(true, 'VYTVÁRAM SKLAD...');
      return API.sheetCreate(n, pin).then(function (r) {
        setAdminBusy(false); showMsg('Hotovo', r.msg); refreshSheetList();
      });
    });
  }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

function reqDeleteSheet() {
  var id = $('#importSheetSelect').val();
  if (!id) return;
  var name = $('#importSheetSelect option:selected').text();
  ensurePin().then(function (pin) {
    if (!pin) return;
    return showConfirm('VYMAZAŤ SKLAD?', '⚠️ Naozaj vymazať sklad «' + name + '»?\nVytvorí sa záloha.', true)
      .then(function (ok) {
        if (!ok) return;
        setAdminBusy(true, 'MAŽEM...');
        return API.sheetDelete(id, pin).then(function (r) {
          setAdminBusy(false); showMsg('Hotovo', r.msg); refreshSheetList();
        });
      });
  }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

function reqClearLogs() {
  ensurePin().then(function (pin) {
    if (!pin) return;
    return showConfirm('Vymazať logy?', 'História bude zálohovaná a vymazaná.', true).then(function (ok) {
      if (!ok) return;
      setAdminBusy(true, 'MAŽEM...');
      return API.logsClear(pin).then(function (r) { setAdminBusy(false); showMsg('Hotovo', r.msg); });
    });
  }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

// ------------------------------------------------------------ імпорт / експорт

function openImport() {
  var id = $('#importSheetSelect').val();
  if (!id) { showMsg('Info', 'Najprv vyberte sklad.'); return; }
  $('#impTargetName').text($('#importSheetSelect option:selected').text());
  Importer.reset();
  $('#importModal').removeClass('hidden');
}
function closeImport() { $('#importModal').addClass('hidden'); }

function exportSheet() {
  var id = $('#importSheetSelect').val();
  if (!id) { showMsg('Info', 'Najprv vyberte sklad.'); return; }
  var name = $('#importSheetSelect option:selected').text();

  setAdminBusy(true, 'PRIPRAVUJEM XLSX...');
  // SheetJS вантажиться на вимогу — на старті сторінки його немає
  Importer.ensureXlsx()
    .then(function () {
      return API.loadSheet(id, function (done, total) {
        setAdminBusy(true, 'NAČÍTAVAM ' + done + ' / ' + total);
      });
    })
    .then(function (res) {
      generateXlsx(res.data, name);
      setAdminBusy(false);
    })
    .catch(function (e) {
      setAdminBusy(false); showMsg('Chyba', errText(e));
    });
}

function generateXlsx(data, sheetName) {
  try {
    var aoa = [['Značka', 'PLU', 'Názov karty', 'SKU', 'EAN', 'Plán', 'Realita', 'Rozdiel', 'Poznámka']];
    data.forEach(function (i) {
      aoa.push([i.brand, i.plu, i.name, i.code, i.ean, i.plan, i.real, i.real - i.plan, i.note]);
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sklad');
    var d = new Date();
    var stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    XLSX.writeFile(wb, sheetName + '_' + stamp + '.xlsx');
  } catch (e) {
    showMsg('Chyba', 'Export zlyhal: ' + errText(e));
  }
}

// ------------------------------------------------------------ бекапи

function openBackups() {
  ensurePin().then(function (pin) {
    if (!pin) return;
    $('#backupModal').removeClass('hidden');
    $('#backupList').html(getLoaderHtml('Hľadám zálohy...'));
    $('#backupSearchInput').val('');
    return API.backupList(pin).then(function (res) {
      currentBackups = res.list || [];
      filterBackups();
    });
  }).catch(function (e) {
    $('#backupList').html('<div class="list-empty">' + escapeHtml(errText(e)) + '</div>');
  });
}
function closeBackups() { $('#backupModal').addClass('hidden'); }

/** ВИПРАВЛЕНО: регулярний вираз відповідає формату імені бекапа yyyyMMdd_HHmmss. */
function extractDateFromName(name) {
  var m = String(name).match(/_BACKUP_(\d{8}_\d{6})/);
  return m ? m[1] : '00000000_000000';
}

function filterBackups() {
  var term = $('#backupSearchInput').val().toLowerCase().trim();
  var sort = $('#backupSortSelect').val();

  var list = currentBackups.filter(function (b) { return b.name.toLowerCase().indexOf(term) !== -1; });
  list.sort(function (a, b) {
    if (sort === 'name_asc') return a.name.localeCompare(b.name);
    var ta = extractDateFromName(a.name), tb = extractDateFromName(b.name);
    return sort === 'date_asc' ? ta.localeCompare(tb) : tb.localeCompare(ta);
  });

  var $c = $('#backupList').empty();
  if (!list.length) { $c.html('<div class="list-empty">Žiadne zálohy.</div>'); return; }

  list.forEach(function (b) {
    // ВИПРАВЛЕНО: назва більше не вставляється в onclick — апостроф у назві
    // складу раніше ламав обидві кнопки.
    var $row = $('<div class="backup-list-item">' +
      '<div class="bu-name">' + escapeHtml(b.name) + '</div>' +
      '<div class="bu-rows">' + (b.rows || 0) + ' r.</div>' +
      '<div class="bu-actions">' +
        '<button class="bu-btn bu-open">✏️ OTVORIŤ</button>' +
        '<button class="bu-btn bu-del">🗑 ZMAZAŤ</button>' +
      '</div></div>');
    $row.find('.bu-open').on('click', function () { closeBackups(); openUniversalList('backup', b.id, b.name); });
    $row.find('.bu-del').on('click', function () { reqDeleteBackup(b.id, b.name); });
    $c.append($row);
  });
}

function reqDeleteBackup(id, name) {
  showConfirm('Vymazať zálohu?', 'Nenávratne zmazať «' + name + '»?', true).then(function (ok) {
    if (!ok) return;
    $('#backupList').html(getLoaderHtml('Mažem...'));
    return API.backupDelete(id, adminPin).then(function () { openBackups(); });
  }).catch(function (e) { showMsg('Chyba', errText(e)); });
}

// ------------------------------------------------------------ список товарів

function openMissing() { openUniversalList('user'); }

function openUniversalList(mode, overrideId, overrideName) {
  var sheetId = overrideId || (mode === 'admin' ? $('#importSheetSelect').val() : currentSheetId);
  if (!sheetId) { showMsg('Info', 'Najprv vyberte sklad!'); return; }

  listState.mode = mode;
  listState.selectedPlu = null;
  listState.filter = { all: true, miss: false, extra: false, done: false, note: false };
  updateUniFilterUI();

  $('#uniSearchInput').val('');
  $('#uniSortSelect').val('miss_prio');
  renderCustomSelects();
  $('#universalListModal').removeClass('hidden');
  $('#uniListContainer').html(getLoaderHtml('Načítavam...'));
  $('#uniModalTitle').text(mode === 'user' ? '📦 ZOZNAM' : (mode === 'admin' ? '✏️ EDITOR' : '⌚ ZÁLOHA'));
  $('#ubAdd').toggleClass('hidden', mode === 'user');
  updateUniActions();

  if (mode === 'user' && localDB.length) {
    $('#uniSheetName').text(currentSheetName);
    renderUniversalList();
    return;
  }

  API.loadSheet(sheetId, function (done, total) {
    $('#uniListContainer').html(getLoaderHtml('Načítavam ' + done + ' / ' + total));
  }).then(function (res) {
    setLocalDB(res.data);
    if (mode !== 'user') currentSheetId = sheetId;
    $('#uniSheetName').text(overrideName || res.sheetName);
    renderUniversalList();
  }).catch(function (e) {
    $('#universalListModal').addClass('hidden');
    showMsg('Chyba', errText(e));
  });
}

function closeUniversalList() {
  $('#universalListModal').addClass('hidden');
  $('.uni-filter-popover').removeClass('active');
}

function toggleUniFilter(type) {
  var f = listState.filter;
  if (type === 'all') {
    f.all = $('#chkUniAll').is(':checked');
    f.miss = f.extra = f.done = f.note = f.all;
  } else {
    f[type] = $('#chkUni' + type.charAt(0).toUpperCase() + type.slice(1)).is(':checked');
    f.all = f.miss && f.extra && f.done && f.note;
  }
  updateUniFilterUI();
  renderUniversalList();
}

function updateUniFilterUI() {
  var f = listState.filter;
  $('#chkUniAll').prop('checked', f.all);
  $('#chkUniMiss').prop('checked', f.miss);
  $('#chkUniExtra').prop('checked', f.extra);
  $('#chkUniDone').prop('checked', f.done);
  $('#chkUniNote').prop('checked', f.note);
  $('#uniFilterLabel').text(f.all ? 'Všetko' : 'Filtrované');
}

function renderUniversalList() {
  var $c = $('#uniListContainer').empty();
  var term = $('#uniSearchInput').val().toLowerCase().trim();
  var sort = $('#uniSortSelect').val();
  var f = listState.filter;

  var filtered = localDB.filter(function (it) {
    if (term) {
      var hay = (it.name + ' ' + it.plu + ' ' + it.ean + ' ' + it.code).toLowerCase();
      if (hay.indexOf(term) === -1) return false;
    }
    if (f.all) return true;
    if (f.miss && it.real < it.plan) return true;
    if (f.extra && it.real > it.plan) return true;
    if (f.done && it.real === it.plan) return true;
    if (f.note && it.note && it.note.trim()) return true;
    return false;
  });

  filtered.sort(function (a, b) {
    switch (sort) {
      case 'name_asc':  return a.name.localeCompare(b.name);
      case 'name_desc': return b.name.localeCompare(a.name);
      case 'qty_desc':  return b.real - a.real;
      case 'qty_asc':   return a.real - b.real;
      case 'plan_desc': return b.plan - a.plan;
      case 'plan_asc':  return a.plan - b.plan;
      default:          return (b.plan - b.real) - (a.plan - a.real);
    }
  });

  if (!filtered.length) { $c.html('<div class="list-empty">Nič sa nenašlo.</div>'); return; }

  var limit = term ? filtered.length : 150;
  var shown = Math.min(filtered.length, limit);
  var html = [];

  for (var i = 0; i < shown; i++) {
    var it = filtered[i];
    var diff = it.real - it.plan;
    var cls = 'uni-row ' + (diff < 0 ? 'ac-miss' : (diff > 0 ? 'ac-extra' : 'ac-ok'));
    if (listState.selectedPlu === it.plu) cls += ' selected-row';
    var color = diff < 0 ? '#dc2626' : (diff > 0 ? '#d97706' : '#059669');
    var note = (it.note && it.note.trim())
      ? '<div class="item-note-display">📝 ' + escapeHtml(it.note) + '</div>' : '';

    html.push(
      '<div class="' + cls + '" data-plu="' + escapeHtml(it.plu) + '">' +
        '<div class="ac-info">' +
          '<div class="ac-name">' + escapeHtml(it.name) + '</div>' +
          (it.brand ? '<span class="ac-brand">' + escapeHtml(it.brand) + '</span>' : '') +
          note +
          '<div class="ac-meta">' +
            '<span class="ac-pill">PLU: ' + escapeHtml(it.plu) + '</span>' +
            (it.ean ? '<span class="ac-pill">EAN: ' + escapeHtml(it.ean) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="ac-stats">' +
          '<div class="ac-diff" style="color:' + color + '">' + (diff > 0 ? '+' : '') + diff + '</div>' +
          '<div class="ac-nums">' + it.real + ' / ' + it.plan + '</div>' +
        '</div>' +
      '</div>'
    );
  }
  if (filtered.length > shown) {
    html.push('<div class="list-hint">… ďalších ' + (filtered.length - shown) + ' skrytých — použite hľadanie …</div>');
  }

  $c.html(html.join(''));
  // ВИПРАВЛЕНО: було .data('plu') — jQuery перетворював "0012345" на число
  // 12345, і подальший пошук у localDB не знаходив нічого. PLU з провідними
  // нулями приходять з ERP постійно, тобто вибір товару просто не працював.
  $c.find('.uni-row').on('click', function () { selectUniRow($(this).attr('data-plu')); });
}

function selectUniRow(plu) {
  plu = String(plu);
  listState.selectedPlu = (listState.selectedPlu === plu) ? null : plu;
  updateUniActions();
  renderUniversalList();
}

function updateUniActions() {
  var has = listState.selectedPlu !== null;
  $('#ubScan, #ubEdit, #ubNote, #ubImg').prop('disabled', !has);
}

function uniAction(type, e) {
  if (e) e.stopPropagation();
  if (type === 'add') { openEditItemModal('new'); return; }
  if (!listState.selectedPlu) return;

  var item = localDB.find(function (i) { return i.plu === listState.selectedPlu; });
  if (!item) return;

  if (type === 'scan') {
    closeUniversalList();
    if (listState.mode === 'admin') {
      // ВИПРАВЛЕНО: раніше вхід у термінал з редактора не запускав синхронізацію,
      // тож зміни інших пристроїв не підтягувались.
      closeAdminPanel();
      currentSheetName = $('#uniSheetName').text();
      currentUser = currentUser || 'Admin';
      $('#infoUser').text(currentUser);
      $('#infoSheet').text(currentSheetName);
      $('#setupOverlay').addClass('hidden');
      startPing();
    }
    doScan(item.plu);
  } else if (type === 'edit') {
    openEditItemModal(item.row);
  } else if (type === 'note') {
    editNoteFor(item);
  } else if (type === 'img') {
    window.open('https://www.google.com/search?tbm=isch&q=' +
      encodeURIComponent((item.name || '') + ' ' + (item.code || '')), '_blank');
  }
}

function editNoteFor(item) {
  showPrompt('Poznámka — ' + item.name, 'Text poznámky...', item.note || '').then(function (text) {
    if (text === null || text === item.note) return;
    updateSyncUI('saving');
    return API.note(currentSheetId, item.row, text, currentUser || 'Admin').then(function (res) {
      item.note = res.note;
      updateOutboxUI();
      renderUniversalList();
      if (currentItem && currentItem.plu === item.plu) $('#pNoteInput').val(res.note);
    });
  }).catch(function (e) { updateOutboxUI(); showMsg('Chyba', errText(e)); });
}

// ------------------------------------------------------------ редактор позиції

function openEditItemModal(mode) {
  if (mode === 'new') {
    $('#editRowId').val('new');
    $('#editName,#editPlu,#editCode,#editEan').val('');
    $('#editPlan,#editReal').val('0');
    $('#eimTitle').text('NOVÝ TOVAR');
    $('#btnDelItem').addClass('hidden');
  } else {
    var it = localDB.find(function (i) { return i.row === mode; });
    if (!it) return;
    $('#editRowId').val(mode);
    $('#editName').val(it.name); $('#editPlu').val(it.plu);
    $('#editCode').val(it.code); $('#editEan').val(it.ean);
    $('#editPlan').val(it.plan); $('#editReal').val(it.real);
    $('#eimTitle').text('UPRAVIŤ TOVAR');
    $('#btnDelItem').removeClass('hidden');
  }
  $('#editorEditModal').removeClass('hidden');
}
function closeEditItemModal() { $('#editorEditModal').addClass('hidden'); }

function saveEditItem() {
  var rowVal = $('#editRowId').val();
  var isNew = rowVal === 'new';
  var data = {
    name: $('#editName').val(), plu: $('#editPlu').val(), code: $('#editCode').val(),
    ean: $('#editEan').val(), plan: $('#editPlan').val(), real: $('#editReal').val(), brand: ''
  };
  if (!String(data.plu).trim()) { showMsg('Info', 'PLU je povinné.'); return; }

  ensurePin().then(function (pin) {
    if (!pin) return;
    $('#btnSaveItem').prop('disabled', true).text('UKLADÁM...');

    var p = isNew
      ? API.itemCreate(currentSheetId, data, currentUser || 'Admin', pin)
      : (function () {
          var row = parseInt(rowVal, 10);
          var orig = localDB.find(function (i) { return i.row === row; });
          if (orig) data.brand = orig.brand;
          return API.itemUpdate(currentSheetId, row, data, currentUser || 'Admin', pin);
        })();

    return p.then(function () {
      $('#btnSaveItem').prop('disabled', false).text('💾 ULOŽIŤ');
      closeEditItemModal();
      reloadCurrentList();
    });
  }).catch(function (e) {
    $('#btnSaveItem').prop('disabled', false).text('💾 ULOŽIŤ');
    showMsg('Chyba', errText(e));
  });
}

function deleteEditItem() {
  var rowVal = $('#editRowId').val();
  if (rowVal === 'new') return;
  showConfirm('Vymazať tovar?', 'Naozaj vymazať túto položku?', true).then(function (ok) {
    if (!ok) return;
    return ensurePin().then(function (pin) {
      if (!pin) return;
      return API.itemDelete(currentSheetId, parseInt(rowVal, 10), currentUser || 'Admin', pin)
        .then(function () { closeEditItemModal(); reloadCurrentList(); });
    });
  }).catch(function (e) { showMsg('Chyba', errText(e)); });
}

function reloadCurrentList() {
  $('#uniListContainer').html(getLoaderHtml('Obnovujem...'));
  return API.loadSheet(currentSheetId, function (done, total) {
    $('#uniListContainer').html(getLoaderHtml('Načítavam ' + done + ' / ' + total));
  }).then(function (res) {
    setLocalDB(res.data);
    renderUniversalList();
    calcStats();
  }).catch(function (e) { showMsg('Chyba', errText(e)); });
}

// ------------------------------------------------------------ робота терміналу

function setLocalDB(data) {
  localDB = data || [];
  rowIndex = {};
  for (var i = 0; i < localDB.length; i++) rowIndex[localDB[i].row] = i;
}

function startApp() {
  currentUser = $('#setupUserSelect').val();
  currentSheetId = $('#setupSheetSelect').val();
  if (!currentUser || !currentSheetId) { showMsg('Info', 'Vyberte užívateľa a sklad!'); return; }

  currentSheetName = $('#setupSheetSelect option:selected').text();
  $('#setupOverlay').addClass('hidden');
  setUiLoading(true, 'Sťahujem databázu...');
  updateSyncUI('online');

  API.loadSheet(currentSheetId, function (done, total) {
    setUiLoading(true, 'Sťahujem ' + done + ' / ' + total);
  }).then(function (res) {
    if (!res.data.length) {
      setUiLoading(false);
      $('#setupOverlay').removeClass('hidden');
      showMsg('Prázdny sklad', 'Tento sklad je prázdny.\nPrejdite do ADMIN ZÓNY a naimportujte tovar.');
      return;
    }
    setLocalDB(res.data);
    lastSyncTime = res.serverTime || Date.now();
    $('#infoUser').text(currentUser);
    $('#infoSheet').text(currentSheetName);
    calcStats();
    setUiLoading(false);
    startPing();
    flushOutbox();
  }).catch(function (e) {
    setUiLoading(false);
    $('#setupOverlay').removeClass('hidden');
    showMsg('Chyba', errText(e));
  });
}

function resetToSetup() {
  if (isBatching) flushChanges();
  if (currentSheetId) API.leave(currentSheetId, sessionId).catch(function () {});
  stopPing();
  $('#setupOverlay').removeClass('hidden');
  $('#productCard').addClass('hidden');
  $('#waitingMsg').removeClass('hidden');
  $('#qtyControls').addClass('disabled-ctrl');
  currentItem = null;
  setLocalDB([]);
  currentSheetId = '';
  refreshSheetList();
}

function setUiLoading(loading, text) {
  $('.input-group, .tool-row, .qty-row').toggleClass('ui-disabled', !!loading);
  if (loading) $('#readyIndicator').html(getLoaderHtml(text || 'Načítavam...')).addClass('busy');
  else {
    $('#readyIndicator').text('PRIPRAVENÝ').removeClass('busy');
    if (!currentItem) $('#qtyControls').addClass('disabled-ctrl');
  }
}

// --- синхронізація ---

function startPing() {
  stopPing();
  pingTimer = setInterval(doPing, CFG.PING_INTERVAL_MS);
}
function stopPing() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; }

/**
 * ВИПРАВЛЕНО (двічі):
 *  1. Раніше синхронізація раз на 3 секунди вичитувала ВСЮ колонку кількостей.
 *     На 24 000 рядків це спалювало денну квоту Apps Script за кілька годин.
 *     Тепер сервер віддає лише зміни з кеша, а інтервал — 20 секунд.
 *  2. Раніше порівнювалась довжина списку з довжиною колонки, і будь-який
 *     «порожній» рядок у таблиці спричиняв нескінченне перезавантаження.
 */
function doPing() {
  if (!currentSheetId || isPinging || isBatching || !navigator.onLine) return;
  isPinging = true;

  API.ping(currentSheetId, currentUser, sessionId, lastSyncTime)
    .then(function (res) {
      isPinging = false;
      updateOutboxUI();

      if (res.others && res.others.length) {
        $('#conflictUser').text(res.others.join(', '));
        $('#conflictBanner').removeClass('hidden');
      } else {
        $('#conflictBanner').addClass('hidden');
      }

      if (res.stale) { refresh(false); return; }

      var changed = false;
      var userActive = (Date.now() - lastUserActionTime) < 5000;

      (res.changes || []).forEach(function (c) {
        var idx = rowIndex[c.r];
        if (idx === undefined) return;
        if (pendingWrites[c.r]) return;
        if (currentItem && currentItem.row === c.r && userActive) return;
        if (localDB[idx].real !== c.v) { localDB[idx].real = c.v; changed = true; }
      });

      if (res.serverTime) lastSyncTime = res.serverTime;

      if (changed) {
        calcStats();
        if (currentItem && rowIndex[currentItem.row] !== undefined && !userActive) {
          currentItem.real = localDB[rowIndex[currentItem.row]].real;
          updateUI();
        }
      }
      flushOutbox();
    })
    .catch(function () {
      isPinging = false;
      updateSyncUI('offline');
    });
}

function refresh(hard) {
  if (hard && isBatching) flushChanges();
  if (hard) {
    currentItem = null;
    $('#productCard, #errCard').addClass('hidden');
    $('#codeInput').val('');
    $('#waitingMsg').removeClass('hidden');
    $('#qtyControls').addClass('disabled-ctrl');
    $('#pcLogList').html('<div class="log-placeholder">Čakám na akcie...</div>');
  }
  setUiLoading(true, 'Obnovujem...');
  API.loadSheet(currentSheetId, function (d, t) { setUiLoading(true, 'Načítavam ' + d + ' / ' + t); })
    .then(function (res) {
      var openPlu = currentItem ? currentItem.plu : null;
      setLocalDB(res.data);
      lastSyncTime = res.serverTime || Date.now();
      currentSheetName = res.sheetName || currentSheetName;
      $('#infoSheet').text(currentSheetName);

      // ВИПРАВЛЕНО: після м'якого оновлення currentItem далі вказував на об'єкт
      // зі СТАРОГО масиву. Картка товару показувала одні цифри, localDB містив
      // інші, а наступне сканування писало у «відчеплений» об'єкт.
      if (openPlu) {
        var fresh = localDB.find(function (i) { return i.plu === openPlu; });
        if (fresh) { currentItem = fresh; updateUI(); }
        else closeUI();
      }

      calcStats();
      setUiLoading(false);
      updateOutboxUI();
    })
    .catch(function (e) { setUiLoading(false); showMsg('Chyba', errText(e)); });
}

// --- сканування ---

function doScan(code) {
  if (!localDB.length) return;
  code = String(code || '').trim();
  if (!code) return;
  if (isBatching) flushChanges();

  currentItem = null;
  $('#productCard, #errCard').addClass('hidden');

  var matches = localDB.filter(function (i) {
    return i.plu === code || i.ean === code || i.code === code;
  });

  if (matches.length > 1) {
    sndErr();
    showScanError('⚠️ DUPLIKÁT: ' + code);
    if (zoomEnabled) flash({ plu: code, name: 'Nájdených viac zhôd', code: '--', ean: '--' }, 'DUPLIKÁT!', 'f-red');
    $('#qtyControls').addClass('disabled-ctrl');
    return;
  }
  if (!matches.length) {
    sndErr();
    showScanError('Neznámy kód: ' + code);
    if (zoomEnabled) flash({ plu: code, name: 'Neznámy kód', code: '--', ean: '--' }, 'CHYBA', 'f-red');
    $('#qtyControls').addClass('disabled-ctrl');
    return;
  }

  $('#qtyControls').removeClass('disabled-ctrl');
  currentItem = matches[0];
  currentActionType = 'scan';
  modifyItem(1);
}

function act(dir) {
  if (!currentItem) return;
  var qty = parseInt($('#mq').val(), 10) || 1;
  var change = dir * qty;

  if (currentItem.real + change < 0) {
    sndErr();
    if (zoomEnabled) flash(currentItem, 'NEMOŽNO ÍSŤ POD 0!', 'f-red');
    return;
  }
  if (isBatching && lastActionDir !== 0 && Math.sign(change) !== Math.sign(lastActionDir)) flushChanges();

  lastActionDir = change;
  currentActionType = 'manual';
  modifyItem(change);
  $('#mq').val(1);
  if (document.activeElement) document.activeElement.blur();
}

function modifyItem(change) {
  lastUserActionTime = Date.now();

  if (!isBatching) {
    isBatching = true;
    batchStartValue = currentItem.real;
    var n = new Date();
    batchTimestamp =
      String(n.getDate()).padStart(2, '0') + '.' + String(n.getMonth() + 1).padStart(2, '0') + '.' + n.getFullYear() +
      ' ' + String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0') + ':' + String(n.getSeconds()).padStart(2, '0');
  }

  currentItem.real += change;
  if (currentItem.real < 0) currentItem.real = 0;

  var idx = rowIndex[currentItem.row];
  if (idx !== undefined) localDB[idx].real = currentItem.real;

  updateUI();
  pendingDelta += change;
  pendingWrites[currentItem.row] = true;

  updateOptimisticLog(currentItem, batchStartValue, currentItem.real, currentActionType, batchTimestamp);

  var color = 'f-blue';
  if (currentItem.real === currentItem.plan) { color = 'f-green'; sndDone(); }
  else if (currentItem.real > currentItem.plan) { color = 'f-orange'; sndOver(); }
  else sndOk();
  if (zoomEnabled) flash(currentItem, currentItem.name, color);

  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(flushChanges, CFG.BATCH_DELAY_MS);
}

function flushChanges() {
  if (!currentItem || pendingDelta === 0) return;

  var payload = {
    row: currentItem.row,
    plu: currentItem.plu,                 // сервер звіряє PLU перед записом
    forceValue: currentItem.real,
    clientOldValue: batchStartValue,
    type: currentActionType,
    timestamp: batchTimestamp
  };
  var sheetId = currentSheetId, user = currentUser;

  $('#pcLogList').children().first().removeClass('pending new-item');
  isBatching = false; pendingDelta = 0; batchStartValue = null; lastActionDir = 0;
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }

  updateSyncUI('saving');

  API.write(payload, sheetId, user, sessionId)
    .then(function () {
      delete pendingWrites[payload.row];
      Outbox.remove(sheetId, payload.row);
      updateOutboxUI();
    })
    .catch(function (e) {
      // ВИПРАВЛЕНО: раніше невдалий запис просто зникав, і наступна
      // синхронізація тихо повертала стару кількість.
      // pendingWrites НЕ знімаємо: поки запис лежить у черзі, синхронізація
      // не має права перетерти локальне (правильне) значення серверним.
      Outbox.add({ item: payload, sheetId: sheetId, user: user, sessionId: sessionId });
      updateOutboxUI();
      if (String(errText(e)).indexOf('ROW_MOVED') !== -1) {
        showMsg('Dáta sa zmenili', 'Položka sa v hárku presunula. Obnovujem zoznam.');
        refresh(true);
      }
    });
}

var isFlushingOutbox = false;

function flushOutbox() {
  // Захист від паралельного запуску: flushOutbox смикається і з ping,
  // і з події «мережа з'явилась». Два одночасні проходи дублювали записи.
  if (isFlushingOutbox || !Outbox.count() || !navigator.onLine) return;
  isFlushingOutbox = true;

  Outbox.flush(function (entry, res) {
    if (res) delete pendingWrites[entry.item.row];
  }).then(function (left) {
    isFlushingOutbox = false;
    updateOutboxUI();
    if (left === 0) updateSyncUI('online');
  }).catch(function () {
    isFlushingOutbox = false;
    updateOutboxUI();
  });
}

function reqSaveNote() {
  if (!currentItem) return;
  var txt = $('#pNoteInput').val();
  var $btn = $('#btnSaveNote');
  if ($btn.prop('disabled')) return;

  $btn.prop('disabled', true).text('⏳').removeClass('active-state');
  updateSyncUI('saving');

  API.note(currentSheetId, currentItem.row, txt, currentUser)
    .then(function (res) {
      currentItem.note = res.note;
      var idx = rowIndex[currentItem.row];
      if (idx !== undefined) localDB[idx].note = res.note;
      $('#pNoteInput').val(res.note);
      $btn.prop('disabled', true).text('💾');
      updateOutboxUI();
    })
    .catch(function (e) {
      $btn.prop('disabled', false).addClass('active-state').text('💾');
      updateOutboxUI();
      showMsg('Chyba', 'Poznámku sa nepodarilo uložiť: ' + errText(e));
    });
}

// ------------------------------------------------------------ інтерфейс товару

function updateUI() {
  if (!currentItem) return;
  $('#waitingMsg, #errCard').addClass('hidden');
  $('#productCard').removeClass('hidden');
  $('#qtyControls').removeClass('disabled-ctrl');

  $('#pName').text(currentItem.name);
  $('#pCode').text(currentItem.plu);
  $('#pMpn').text(currentItem.code || '--');

  if (currentItem.brand) {
    var b = currentItem.brand.length > 25 ? currentItem.brand.slice(0, 25) + '...' : currentItem.brand;
    $('#pBrand').text(b).removeClass('hidden');
  } else $('#pBrand').addClass('hidden');

  if (currentItem.ean) $('#pEan').text(currentItem.ean).removeClass('no-ean');
  else $('#pEan').text('BEZ EAN').addClass('no-ean');

  $('#pPlan').text(currentItem.plan);
  $('#pReal').text(currentItem.real);

  var diff = currentItem.real - currentItem.plan;
  $('#pDiff').text((diff > 0 ? '+' : '') + diff)
    .css('color', diff === 0 ? '#d97706' : (diff > 0 ? '#059669' : '#dc2626'));

  $('#pNoteInput').val(currentItem.note || '');
  $('#btnSaveNote').removeClass('active-state').prop('disabled', true);
  calcStats();
}

function closeUI() {
  if (isBatching) flushChanges();
  $('#productCard').addClass('hidden');
  $('#waitingMsg').removeClass('hidden');
  $('#qtyControls').addClass('disabled-ctrl');
  currentItem = null;
}

function calcStats() {
  var plan = 0, real = 0, miss = 0, extra = 0, capped = 0, done = 0;
  localDB.forEach(function (i) {
    plan += i.plan; real += i.real; capped += Math.min(i.real, i.plan);
    if (i.real < i.plan) miss += i.plan - i.real; else extra += i.real - i.plan;
    if (i.real >= i.plan) done++;
  });
  $('#qPlan').text(plan); $('#qReal').text(real);
  $('#qMiss').text(miss); $('#qExtra').text(extra);
  $('#qFinished').text(done + ' / ' + localDB.length);
  // ВИПРАВЛЕНО: на порожньому складі шкала показувала 100%.
  var pct = 0;
  if (plan > 0) pct = Math.round(capped / plan * 100);
  else if (localDB.length && real > 0) pct = 100;
  $('#progBar').css('width', Math.min(pct, 100) + '%');
  $('#statsSheetName').text(currentSheetName || '--');
}

function openStats() { calcStats(); $('#statsModal').removeClass('hidden'); }
function closeStats() { $('#statsModal').addClass('hidden'); }

// ------------------------------------------------------------ лог

function updateOptimisticLog(item, oldVal, newVal, type, time) {
  var $list = $('#pcLogList');
  $list.find('.log-placeholder').remove();
  var $top = $list.children().first();
  var same = $top.hasClass('pending') && $top.attr('data-plu') === String(item.plu);

  var diff = newVal - oldVal;
  var html = compactLogHtml(time, item.plu, item.name, item.ean, type === 'scan' ? 'SKEN' : 'MANUÁL',
                            diff >= 0 ? 'badge-green' : 'badge-red', oldVal, newVal, item.code, item.brand);

  if (same) $top.html(html);
  else {
    $list.prepend('<div class="log-item new-item pending flash-anim" data-plu="' + escapeHtml(item.plu) + '">' + html + '</div>');
    if ($list.children().length > 20) $list.children().last().remove();
  }

  var t = String(time).split(' ')[1] || time;
  $('#lastAction').removeClass('hidden act-success act-danger')
    .addClass(diff >= 0 ? 'act-success' : 'act-danger')
    .html(escapeHtml(t) + ' | ULOŽENÉ: ' + oldVal + ' ➝ ' + newVal);
}

function codePills(plu, code, ean) {
  return '<span class="code-pill">PLU: ' + escapeHtml(plu) + '</span>' +
         (code ? ' <span class="code-pill">SKU: ' + escapeHtml(code) + '</span>' : '') +
         (ean ? ' <span class="code-pill">EAN: ' + escapeHtml(ean) + '</span>'
              : ' <span class="code-pill no-ean">BEZ EAN</span>');
}

function compactLogHtml(time, plu, name, ean, label, badge, oldVal, newVal, code, brand) {
  var parts = String(time).split(' ');
  return '<div class="l-time-row"><span>' + escapeHtml(time) + '</span></div>' +
    '<div class="l-main-row">' +
      '<div class="l-info" style="width:100%;">' +
        '<div class="l-name">' + escapeHtml(name) + '</div>' +
        (brand ? '<div>' + getBrandBadge(brand) + '</div>' : '') +
      '</div>' +
      '<div class="l-act-group"><div class="l-act">' +
        '<span class="act-badge ' + badge + '">' + escapeHtml(label) + '</span>' +
        '<span class="val-change">' + escapeHtml(String(oldVal)) + ' <span class="la-arrow">➝</span> ' + escapeHtml(String(newVal)) + '</span>' +
      '</div></div>' +
    '</div>' +
    '<div class="l-codes-row">' + codePills(plu, code, ean) + '</div>';
}

function openLog() {
  $('#logModal').removeClass('hidden');
  $('#logSheetName').text(currentSheetName);
  var $c = $('#fullLogList').html(getLoaderHtml('Načítavam históriu...'));

  API.logs(currentSheetId).then(function (res) {
    var logs = res.logs || [];
    $c.empty();
    if (!logs.length) { $c.html('<div class="list-empty">Zatiaľ žiadne akcie.</div>'); return; }

    var html = logs.map(function (it) {
      var act = String(it.action);
      var badge = act === 'POZNÁMKA' ? 'badge-purple'
                : (parseInt(it.newVal, 10) < parseInt(it.oldVal, 10) ? 'badge-red' : 'badge-green');

      if (['IMPORT', 'CLEAR', 'DELETE', 'ADMIN', 'ERROR'].indexOf(act) !== -1) {
        return '<div class="log-admin-row">' +
          '<div style="font-size:10px;font-weight:700;color:#6b7280;">' + escapeHtml(it.time) + '</div>' +
          '<div style="font-size:13px;font-weight:800;color:#1f2937;">' + escapeHtml(it.name) + '</div>' +
          '<div><span class="act-badge ' + badge + '">' + escapeHtml(act) + '</span></div></div>';
      }

      if (act === 'POZNÁMKA') {
        return '<div class="fl-row log-note-row">' +
          '<div class="note-header"><div class="l-info">' +
            '<span class="l-timestamp">' + escapeHtml(it.time) + '</span>' +
            '<span class="l-name">' + escapeHtml(it.name) + '</span>' +
            '<div class="l-codes">' + codePills(it.plu, it.mpn, it.ean) + '</div>' +
          '</div><div class="l-act"><span class="act-badge badge-purple">POZNÁMKA</span></div></div>' +
          '<div class="note-body">' +
            '<div class="note-old"><div class="note-val-label">Bolo:</div><div class="note-val-text" style="color:#6b7280;">' +
              escapeHtml(it.oldVal || '(prázdne)') + '</div></div>' +
            '<div class="note-arrow">▼</div>' +
            '<div class="note-new"><div class="note-val-label" style="color:#7c3aed;">Je:</div><div class="note-val-text">' +
              escapeHtml(it.newVal || '(prázdne)') + '</div></div>' +
          '</div></div>';
      }

      return '<div class="fl-row">' +
        '<div class="l-info">' +
          '<span class="l-timestamp">' + escapeHtml(it.time) + ' · ' + escapeHtml(it.user) + '</span>' +
          '<span class="l-name">' + escapeHtml(it.name) + '</span>' +
          '<div class="l-codes">' + codePills(it.plu, it.mpn, it.ean) + '</div>' +
        '</div>' +
        '<div class="l-act">' +
          '<span class="act-badge ' + badge + '">' + escapeHtml(act) + '</span>' +
          '<span class="val-change">' + escapeHtml(it.oldVal) + ' <span class="la-arrow">➝</span> ' + escapeHtml(it.newVal) + '</span>' +
        '</div></div>';
    }).join('');

    $c.html(html);
  }).catch(function (e) {
    $c.html('<div class="list-empty">' + escapeHtml(errText(e)) + '</div>');
  });
}
function closeLog() { $('#logModal').addClass('hidden'); }

// ------------------------------------------------------------ спалах

function flash(item, name, cls) {
  if (flashTimeout) clearTimeout(flashTimeout);
  $('#flashOverlay').removeClass().addClass(cls);
  $('#flashCode').text((item && item.plu) || '0000');
  $('#flashName').text((item && item.name) || name || '');
  $('#flashSku').text((item && item.code) || '--');
  $('#flashEan').text((item && item.ean) || '--');
  flashTimeout = setTimeout(hideFlash, zoomSeconds * 1000);
}
function hideFlash() {
  if (flashTimeout) clearTimeout(flashTimeout);
  flashTimeout = null;
  $('#flashOverlay').addClass('hidden');
}

// ------------------------------------------------------------ налаштування

function openLocalSettings() {
  $('#localZoomRange').val(zoomSeconds);
  $('#zoomToggleCheck').prop('checked', zoomEnabled);
  $('#soundToggleCheck').prop('checked', soundEnabled);
  updateRangeLabel(zoomSeconds);
  $('#localSettingsModal').removeClass('hidden');
}
function closeLocalSettings() { $('#localSettingsModal').addClass('hidden'); }
function updateRangeLabel(v) { $('#rangeVal').text(parseFloat(v).toFixed(1) + ' s'); }
function saveLocalSettings() {
  zoomSeconds = parseFloat($('#localZoomRange').val());
  zoomEnabled = $('#zoomToggleCheck').is(':checked');
  soundEnabled = $('#soundToggleCheck').is(':checked');
  try {
    localStorage.setItem('localZoomSeconds', zoomSeconds);
    localStorage.setItem('localZoomEnabled', zoomEnabled);
    localStorage.setItem('localSoundEnabled', soundEnabled);
  } catch (e) {}
  closeLocalSettings();
}

function toggleKey() {
  var $i = $('#codeInput');
  if ($i.attr('inputmode') === 'none') { $i.attr('inputmode', 'text').focus(); $('#manualToggleBtn').addClass('active'); }
  else { $i.attr('inputmode', 'none'); $('#manualToggleBtn').removeClass('active'); }
}

// ------------------------------------------------------------ камера

function startCam() {
  if (typeof Html5Qrcode === 'undefined') {
    showMsg('Kamera', 'Knižnica skenera sa ešte nenačítala. Skúste o chvíľu znova.');
    return;
  }
  $('#camera-fullscreen').show();
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) { $('#camSelectWrapper').hide(); realStart(null); return; }

  Html5Qrcode.getCameras().then(function (devices) {
    var $sel = $('#camSelect').empty();
    var target = null, back = null, nonFront = null;

    (devices || []).forEach(function (d) {
      $sel.append('<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.label || d.id) + '</option>');
      var l = (d.label || '').toLowerCase();
      if (/back|rear|environment/.test(l)) back = d.id;
      if (!/front|selfie/.test(l)) nonFront = d.id;
    });

    if (devices && devices.length) {
      $('#camSelectWrapper').show();
      var saved = localStorage.getItem('preferredCam');
      target = (saved && devices.some(function (d) { return d.id === saved; })) ? saved
             : (back || nonFront || devices[devices.length - 1].id);
      $sel.val(target);
    }
    realStart(target);
  }).catch(function () { realStart(null); });
}

function realStart(camId) {
  isFlashOn = false; updateFlashBtn();
  if (html5QrCode) { try { html5QrCode.clear(); } catch (e) {} }
  $('#reader').empty();
  html5QrCode = new Html5Qrcode('reader');

  var box = Math.min(window.innerWidth * 0.7, 250);
  var startCfg = camId ? { deviceId: { exact: camId } } : { facingMode: 'environment' };

  setTimeout(function () {
    html5QrCode.start(startCfg, { fps: 10, qrbox: box }, function (text) {
      stopCam(); doScan(text);
    }, function () {})
      .then(function () {
        $('#camFlash').removeClass('hidden');
        var v = document.querySelector('#reader video');
        if (v) v.setAttribute('playsinline', 'true');
      })
      .catch(function (err) {
        if (camId) { realStart(null); }
        else { showMsg('Kamera', 'Kameru sa nepodarilo spustiť: ' + errText(err)); stopCam(); }
      });
  }, 100);
}

function changeCamera() {
  var id = $('#camSelect').val();
  if (!id) return;
  localStorage.setItem('preferredCam', id);
  killStream();
  if (html5QrCode) {
    html5QrCode.stop().then(function () {
      html5QrCode.clear(); html5QrCode = null;
      setTimeout(function () { realStart(id); }, 300);
    }).catch(function () { html5QrCode = null; realStart(id); });
  } else realStart(id);
}

function killStream() {
  try {
    var v = document.querySelector('#reader video');
    if (v && v.srcObject) v.srcObject.getTracks().forEach(function (t) { t.stop(); });
  } catch (e) {}
}

function stopCam() {
  $('#camera-fullscreen').hide();
  $('#camFlash').removeClass('active').addClass('hidden');
  isFlashOn = false;
  killStream();
  if (html5QrCode) {
    html5QrCode.stop().then(function () { html5QrCode.clear(); html5QrCode = null; })
      .catch(function () { html5QrCode = null; });
  }
}

function toggleFlash() {
  var v = document.querySelector('#reader video');
  if (!v || !v.srcObject) return;
  var track = v.srcObject.getVideoTracks()[0];
  if (!track) return;
  isFlashOn = !isFlashOn;
  track.applyConstraints({ advanced: [{ torch: isFlashOn }] }).catch(function () {});
  updateFlashBtn();
}
function updateFlashBtn() { $('#camFlash').toggleClass('active', isFlashOn); }

// ------------------------------------------------------------ запуск

$(function () {
  init();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      // Оновлення застосунку: поки ви правите код і перезаливаєте на Cloudflare,
      // без цього телефони могли б місяцями показувати стару закешовану версію.
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showConfirm('Nová verzia', 'Je dostupná novšia verzia aplikácie. Načítať teraz?', false)
              .then(function (ok) {
                if (!ok) return;
                sw.postMessage('skipWaiting');
                location.reload();
              });
          }
        });
      });
      // перевіряємо оновлення при кожному відкритті
      reg.update().catch(function () {});
    }).catch(function () {});
  }
});
