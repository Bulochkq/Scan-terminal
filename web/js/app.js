/**
 * APP.JS — логіка терміналу.
 * Остання зміна: v3.1.6 (див. PROGRESS.md у корені репо)
 *
 * v3.1.6: головна на ПК — сторінка на весь екран (#homeDesk, sheets.js); тут лише
 * перемикання (#setupOverlay.is-home після входу) і дані людини в бічному меню.
 *
 * v3.1.3: вхід за e-mailом і паролем (auth.js), ролі Vlastník / Správca /
 * Pracovník. Список «Pracovník» на старті і спільний адмін-PIN прибрано:
 * хто працює — видно з входу, що йому можна — вирішує база за роллю.
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
         '<div class="spinner-text">' + escapeHtml(text || 'Načítavam…') + '</div></div>';
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
  // вхід щойно втрачено — причину покаже екран входу, а не купа вікон «Chyba»
  if (authLost) return;
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
    $('#promptModal').removeClass('hidden');
    setTimeout(function () { $('#promptInput').focus(); }, 50);
  });
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

/**
 * Універсальне вікно очікування (v3.0.2).
 *
 * Раніше між діями людини і відповіддю сервера (напр. перевірка PIN) нічого
 * не показувалось — здавалось, що програма зависла. Тепер будь-яке очікування
 * показує вікно з анімацією, а якщо Google відповідає повільно — ще й скільки
 * секунд ми вже чекаємо, щоб було видно, що процес живий.
 *
 * Вікно з'являється із затримкою 200 мс: швидкі дії не «блимають».
 * Повторний виклик setAdminBusy(true, 'новий текст') лише оновлює текст.
 */
var busyShowTimer = null, busyTickTimer = null, busyStartedAt = 0, busyActive = false;

function setAdminBusy(busy, text) {
  if (busyTimeout) clearTimeout(busyTimeout);
  if (busy) {
    $('#adminLoadingText').text(text || 'Spracovávam…');
    if (!busyActive) {
      busyActive = true;
      busyStartedAt = Date.now();
      $('#adminLoadingHint').text('');
      busyShowTimer = setTimeout(function () { $('#adminProcessOverlay').removeClass('hidden'); }, 200);
      busyTickTimer = setInterval(function () {
        var s = Math.round((Date.now() - busyStartedAt) / 1000);
        if (s >= 20)     $('#adminLoadingHint').text('Server odpovedá pomaly… ' + s + ' s');
        else if (s >= 4) $('#adminLoadingHint').text('Čakám na server… ' + s + ' s');
      }, 1000);
    }
    // страховка: вікно ніколи не лишиться висіти назавжди
    busyTimeout = setTimeout(function () { setAdminBusy(false); }, 180000);
  } else {
    busyActive = false;
    clearTimeout(busyShowTimer);
    clearInterval(busyTickTimer);
    $('#adminProcessOverlay').addClass('hidden');
  }
}
window.setAdminBusy = setAdminBusy;
window.showMsg = showMsg;
window.showConfirm = showConfirm;

window.showPrompt = showPrompt;

// ------------------------------------------------------------ вхід (v3.1.3)

/**
 * Екран входу. Спільний адмін-PIN (v3.0–v3.1.2) прибрано: його знали всі, хто
 * хоч раз адміністрував, і в журналі не було видно, ХТО саме щось змінив.
 * Тепер у кожного свій e-mail і пароль, а що можна — вирішує роль у базі.
 */
var loginMode = 'login';          // 'login' | 'register' (перший вхід запрошеного)
var authLost = false;

/** Помилка під активною формою (вхід або перший вхід). */
function showLoginErr(text) {
  var $e = $(loginMode === 'register' ? '#regErr' : '#loginErr');
  $('#loginErr, #regErr').addClass('hidden').text('');
  $e.toggleClass('hidden', !text).text(text || '');
}

/**
 * v3.1.4: дві окремі форми замість однієї з перемиканням атрибутів — див.
 * коментар у index.html (менеджер паролів Chrome пропонує пароль лише тоді,
 * коли поле з самого початку позначене як «нове»).
 */
function setLoginMode(mode) {
  var reg = mode === 'register';
  // e-mail переносимо в іншу форму, щоб не набирати двічі
  var email = $(loginMode === 'register' ? '#regEmail' : '#loginEmail').val();
  loginMode = mode;
  if (email) $(reg ? '#regEmail' : '#loginEmail').val(email);
  $('#loginForm').toggleClass('hidden', reg);
  $('#regForm').toggleClass('hidden', !reg);
  $('#loginModeBtn').html(reg ? icon('arrow-left') + '<span>Už mám heslo — prihlásiť sa</span>'
                              : '<span>Prvé prihlásenie — vytvoriť si heslo</span>');
  $('#loginHint').text(reg
    ? 'Funguje len pre e-mail, ktorý správca pridal v časti „Ľudia a prístupy“.'
    : 'Účet vám vytvorí správca. Heslo ste zabudli? Nové vám nastaví správca.');
  showLoginErr('');
}
function toggleLoginMode() {
  setLoginMode(loginMode === 'login' ? 'register' : 'login');
  var first = loginMode === 'register' ? ($('#regEmail').val() ? '#regPass' : '#regEmail')
                                       : ($('#loginEmail').val() ? '#loginPass' : '#loginEmail');
  setTimeout(function () { $(first).focus(); }, 30);
}

/** Прибрати все, що лишилось від попередньої людини, і показати вхід. */
function showLogin(message) {
  stopPing();
  if (typeof Editor !== 'undefined' && $('#editorModal').is(':visible')) Editor.closeNow();
  $('#logsModal, #peopleModal, #personModal, #pwModal, #sheetModal, #importModal, #backupModal, #statsModal, #promptModal, #confirmModal').addClass('hidden');
  if (typeof LogView !== 'undefined') LogView.close();
  if (typeof Sheets !== 'undefined') Sheets.reset();
  setAdminBusy(false);
  closeAdminPanel();
  currentItem = null;
  setLocalDB([]);
  currentSheetId = '';
  currentUser = '';
  $('#productCard, #errCard').addClass('hidden');
  $('#waitingMsg').removeClass('hidden');
  $('#qtyControls').addClass('disabled-ctrl');

  $('#setupOverlay').removeClass('hidden is-home');
  $('#setupCard').addClass('hidden');
  $('#loginCard').removeClass('hidden');
  setLoginMode('login');
  if (!$('#loginEmail').val()) $('#loginEmail').val(readLocal('termLastEmail') || '');
  $('#loginPass, #regPass, #regPass2').val('');
  if (message) showLoginErr(message);
  authLost = false;
  setTimeout(function () { $($('#loginEmail').val() ? '#loginPass' : '#loginEmail').focus(); }, 50);
}

function showSetup() {
  $('#loginCard').addClass('hidden');
  $('#setupCard').removeClass('hidden');
  // v3.1.6: на ПК (від 1024 px) замість карток — головна на весь екран (app.css)
  $('#setupOverlay').addClass('is-home');
  renderMe();
  if (Auth.can('admin')) Sheets.load();
}

/**
 * Картка «хто увійшов». v3.1.4: власнику і správcovi адміністрація відкрита
 * одразу (запит власника) — кнопка «Administrácia» лишається лише для того,
 * щоб відкрити її знову після закриття.
 */
function renderMe() {
  var me = Auth.me();
  $('#meName').text(me ? me.name : 'Načítavam účet…');
  $('#meRole').text(me ? Auth.roleLabel(me.role) + ' · ' + me.email : '');
  $('#meAvatar').text(me ? Auth.initials(me.name) : '…').attr('class', 'me-av' + (me ? ' role-' + me.role : ''));
  // v3.1.6: те саме в бічному меню головної на ПК (e-mail — у підказці, щоб не обрізався)
  $('#hdName').text(me ? me.name : 'Načítavam účet…');
  $('#hdRole').text(me ? Auth.roleLabel(me.role) : '');
  $('#hdAvatar').text(me ? Auth.initials(me.name) : '…').attr('class', 'me-av' + (me ? ' role-' + me.role : ''));
  $('#homeDesk .hd-me').attr('title', me ? me.name + ' · ' + me.email : '');
  currentUser = me ? me.name : '';
  if (Auth.can('admin')) {
    if ($('#adminCard').hasClass('hidden') && !adminClosedByUser) showAdminPanel();
    else $('#adminOpenBtn').toggleClass('hidden', !$('#adminCard').hasClass('hidden'));
  } else {
    closeAdminPanel();
    $('#adminOpenBtn').addClass('hidden');
  }
  Sheets.render();                  // таблиця на ПК: у správcu з цифрами, у працівника — без
}

function doLogin(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  var email = String($('#loginEmail').val() || '').trim().toLowerCase();
  var pass = String($('#loginPass').val() || '');
  if (!email || !pass) { showLoginErr('Zadajte e-mail aj heslo.'); return; }
  submitAuth(Auth.signIn(email, pass), email, '#loginBtn', 'Prihlasujem…');
}

/** Перший вхід запрошеної людини: сама задає пароль. */
function doRegister(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  var email = String($('#regEmail').val() || '').trim().toLowerCase();
  var pass = String($('#regPass').val() || '');
  if (!email || !pass) { showLoginErr('Zadajte e-mail aj heslo.'); return; }
  if (pass.length < 6) { showLoginErr('Heslo musí mať aspoň 6 znakov.'); return; }
  if (pass !== $('#regPass2').val()) { showLoginErr('Heslá sa nezhodujú.'); return; }
  submitAuth(Auth.signUp(email, pass), email, '#regBtn', 'Vytváram…');
}

function submitAuth(promise, email, btn, busyText) {
  showLoginErr('');
  var $btn = $(btn), html = $btn.html();
  $btn.prop('disabled', true).html(icon('loader-circle', 'ic-spin') + '<span>' + busyText + '</span>');
  promise.then(function () {
    writeLocal('termLastEmail', email);
    $('#loginPass, #regPass, #regPass2').val('');
    authLost = false;
    adminClosedByUser = false;
    showSetup();
    loadInitData();
  }).catch(function (e) {
    showLoginErr(errText(e));
  }).then(function () {
    $btn.prop('disabled', false).html(html);
  });
}

/**
 * Вихід. Якщо на пристрої лежать ще не відправлені скани (не було інтернету),
 * спершу пробуємо їх дослати. Не вийшло — чесно питаємо: після виходу вони
 * лишаться на пристрої і підуть під ім'ям наступного, хто тут увійде (кількість
 * при цьому правильна — губити скани гірше, ніж підпис у журналі).
 */
function doLogout() {
  if (isBatching) flushChanges();
  var pending = Outbox.count();
  (pending ? flushOutbox() : Promise.resolve(0)).then(function (left) {
    if (!left) return true;
    return showConfirm('Neodoslané skeny',
      'Na tomto zariadení čaká ' + left + ' zmien na odoslanie (asi nie je internet).\n' +
      'Po odhlásení zostanú uložené a odošlú sa hneď, ako sa tu niekto prihlási — v histórii potom budú pod jeho menom.\n\n' +
      'Odhlásiť sa aj tak?', true);
  }).then(function (ok) {
    if (!ok) return;
    return Auth.signOut().then(function () { showLogin(''); });
  });
}

/**
 * Зміна СВОГО пароля (зі стартового екрана і з «Ľudia a prístupy»).
 * v3.1.4: окрема форма з полями «нове heslo» замість двох вікон-запитань —
 * так менеджер паролів у браузері запропонує надійний пароль і оновить збережений.
 */
function changeOwnPassword() {
  var me = Auth.me();
  if (!me) return;
  $('#pwWho').text(me.name + ' · ' + me.email);
  $('#pwUser').val(me.email);
  $('#pwNew, #pwNew2').val('');
  $('#pwErr').addClass('hidden').text('');
  $('#pwModal').removeClass('hidden');
  setTimeout(function () { $('#pwNew').focus(); }, 50);
}
function closePw() { $('#pwModal').addClass('hidden'); $('#pwNew, #pwNew2').val(''); }

function savePw(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  var p1 = String($('#pwNew').val() || ''), p2 = String($('#pwNew2').val() || '');
  var err = function (t) { $('#pwErr').toggleClass('hidden', !t).text(t || ''); };
  if (p1.length < 6) { err('Heslo musí mať aspoň 6 znakov.'); return; }
  if (p1 !== p2) { err('Heslá sa nezhodujú.'); return; }
  err('');
  var $btn = $('#pwSaveBtn').prop('disabled', true).text('Ukladám…');
  Auth.changePassword(p1).then(function () {
    closePw();
    showMsg('Hotovo', 'Heslo je zmenené. Nabudúce sa prihláste novým heslom.');
  }).catch(function (e) {
    err(errText(e));
  }).then(function () { $btn.prop('disabled', false).text('Uložiť heslo'); });
}
window.changeOwnPassword = changeOwnPassword;

/**
 * База відхилила вхід: токен уже не оновити, акаунт вимкнули або видалили.
 * Незавершену «пачку» кладемо в чергу (скан справжній — дошлеться після входу),
 * виходимо на пристрої і показуємо причину на екрані входу.
 */
window.onAuthError = function (err) {
  if (authLost) return;
  authLost = true;
  var entry = takeBatchEntry();
  if (entry) { Outbox.add(entry); updateOutboxUI(); }
  var msg = (err && err.message && !/^HTTP \d+$/.test(err.message)) ? err.message : 'Prihlásenie vypršalo. Prihláste sa znova.';
  if (/JWT|token|permission denied/i.test(msg)) msg = 'Prihlásenie vypršalo. Prihláste sa znova.';
  Auth.signOut().then(function () { showLogin(msg); });
};

/** Бібліотека сама помітила, що вхід закінчився (напр. вихід в іншій вкладці). */
window.onSignedOut = function () {
  if (!$('#loginCard').hasClass('hidden')) return;
  var entry = takeBatchEntry();
  if (entry) Outbox.add(entry);
  showLogin('Boli ste odhlásený.');
};

// ------------------------------------------------------------ селекти

/**
 * Стилізовані випадні списки: кожен <select class="custom-select"> отримує
 * власний список у стилі програми (системний виглядає на кожному пристрої
 * по-своєму). root — оновити лише селекти всередині цього блоку.
 *
 * v3.1.4: + неактивні пункти (сірі, з підказкою «чому» в title),
 *         + компактний варіант (<select class="custom-select cs-compact">),
 *         + список відкривається ВГОРУ, якщо внизу екрана не вміщується.
 */
function renderCustomSelects(root) {
  $(root || document).find('.custom-select').each(function () {
    var $sel = $(this);
    var $wrapper, $trigger, $options;

    if ($sel.parent().hasClass('custom-select-wrapper')) {
      $wrapper = $sel.parent();
      $trigger = $wrapper.find('.custom-select-trigger');
      $options = $wrapper.find('.custom-options');
    } else {
      // варіанти вигляду (cs-compact, cs-dark) — з класів самого select
      var variants = (($sel.attr('class') || '').match(/\bcs-[a-z]+/g) || []).join(' ');
      $sel.wrap('<div class="custom-select-wrapper' + (variants ? ' ' + variants : '') + '"></div>');
      $sel.after('<div class="custom-select-trigger"></div><div class="custom-options"></div>');
      $wrapper = $sel.parent();
      $trigger = $wrapper.find('.custom-select-trigger');
      $options = $wrapper.find('.custom-options');

      $trigger.on('click', function (e) {
        e.stopPropagation();
        if ($sel.prop('disabled')) return;
        $('.custom-select-wrapper').not($wrapper).removeClass('open');
        var opening = !$wrapper.hasClass('open');
        if (opening) {
          // місця внизу мало (останній рядок у списку, низ екрана) — відкрити вгору
          var r = $wrapper[0].getBoundingClientRect();
          var need = Math.min(280, $options[0].scrollHeight || 200) + 12;
          // cs-up — завжди вгору (вибір камери внизу екрана, під ним кнопки камери)
          $wrapper.toggleClass('open-up', $wrapper.hasClass('cs-up') || (window.innerHeight - r.bottom < need && r.top > need));
        }
        $wrapper.toggleClass('open', opening);
      });
      $wrapper.on('click', '.custom-option', function (e) {
        var $o = $(this);
        e.stopPropagation();
        if ($o.hasClass('disabled')) return;
        $wrapper.removeClass('open');
        // ВИПРАВЛЕНО: .data() приводить типи — ID аркуша "0012" ставало числом 12.
        // .attr() віддає рядок як є.
        $sel.val($o.attr('data-value')).trigger('change');
        $options.find('.custom-option').removeClass('selected');
        $o.addClass('selected');
        $trigger.html('<span class="cs-text">' + escapeHtml($o.text()) + '</span>' + icon('chevron-down', 'custom-arrow'));
      });
    }

    var selText = $sel.find('option:selected').text() || $sel.find('option').first().text() || '';
    $trigger.html('<span class="cs-text">' + escapeHtml(selText) + '</span>' + icon('chevron-down', 'custom-arrow'));
    $trigger.toggleClass('disabled', !!$sel.prop('disabled'));
    $trigger.attr('title', $sel.attr('title') || null);

    $options.empty();
    $sel.children('option').each(function () {
      var $o = $(this);
      if ($o.prop('disabled') && $o.val() === '') return;
      var off = $o.prop('disabled');
      $options.append('<div class="custom-option' + ($o.is(':selected') ? ' selected' : '') + (off ? ' disabled' : '') +
                      '" data-value="' + escapeHtml($o.val()) + '"' +
                      (off && $o.attr('title') ? ' title="' + escapeHtml($o.attr('title')) + '"' : '') + '>' +
                      escapeHtml($o.text()) + '</div>');
    });
  });
}
window.renderCustomSelects = renderCustomSelects;

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
  $('.js-version').text('v' + CFG.APP_VERSION);
  $('.js-ver').text(CFG.APP_VERSION);
  $('.js-site').text(CFG.SITE_NAME || '—');

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
    showMsg('Nie je nastavená databáza',
      'Otvorte súbor web/js/config.js a vyplňte SUPABASE_URL a SUPABASE_KEY.');
  }

  // v3.1.3: є збережений вхід — одразу вибір складу (база підтвердить у фоні),
  // немає — екран входу.
  if (typeof supabase === 'undefined') {
    showLogin('Knižnica prihlásenia sa nenačítala. Skontrolujte internet a obnovte stránku.');
  } else if (Auth.start()) {
    showSetup();
    loadInitData();
  } else {
    showLogin('');
  }

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

  // Закриття вкладки посеред «пачки» натискань: зміна кладеться в чергу
  // (localStorage) І паралельно пробує дійти до бази. Якщо дійде — повтор з
  // черги нічого не додасть удруге (той самий opId); якщо ні — дошлеться
  // при наступному відкритті. v3.1.0
  window.addEventListener('pagehide', function () {
    var entry = takeBatchEntry();
    if (entry) { Outbox.add(entry); API.scanKeepalive(entry); }
  });
  window.addEventListener('online', function () { updateSyncUI('online'); flushOutbox(); });
  window.addEventListener('offline', function () { updateSyncUI('offline'); });

  renderCustomSelects();
  updateOutboxUI();
}

/**
 * ШВИДКІСТЬ: список складів запам'ятовується на пристрої.
 *
 * Apps Script відповідав на init від 2 до 70 секунд, і весь цей час стартовий
 * екран був мертвий. Тепер останній отриманий список показується миттєво, а
 * свіжий підтягується у фоні і тихо замінює його (вибране не скидається).
 * v3.1.3: той самий запит повертає профіль того, хто увійшов (ім'я, роль).
 */
var INIT_CACHE_KEY = 'termInit_v2';

function readLocal(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function writeLocal(key, val) {
  try { localStorage.setItem(key, val); } catch (e) {}
}

function loadInitData() {
  var cached = null;
  try { cached = JSON.parse(readLocal(INIT_CACHE_KEY) || 'null'); } catch (e) { cached = null; }

  if (cached) {
    applyInitData(cached);
  } else {
    $('#setupSheetSelect').prop('disabled', true);
    renderCustomSelects();
  }

  API.init().then(function (data) {
    if (!data.me) {
      // фронтенд уже новий, а база ще стара (не запущено 003_accounts_roles.sql)
      showMsg('Databáza nie je aktualizovaná',
        'V Supabase ešte nebol spustený súbor supabase/migrations/003_accounts_roles.sql.');
      return;
    }
    Auth.setMe(data.me);
    renderMe();
    writeLocal(INIT_CACHE_KEY, JSON.stringify({ sheets: data.sheets }));
    applyInitData(data);
  }).catch(function (e) {
    if (e.isAuth) return;            // onAuthError уже показав екран входу
    // Є збережений список — працюємо з ним, помилку не показуємо:
    // людина може спокійно почати роботу, а сервер відповість пізніше.
    if (cached && Auth.me()) { console.warn('init:', errText(e)); return; }
    $('#setupSheetSelect').html('<option value="">Chyba pripojenia</option>');
    renderCustomSelects();
    showMsg('Chyba pripojenia', errText(e));
  });
}

/** Заповнює список складів, зберігаючи те, що вже вибрано (або вибране минулого разу). */
function applyInitData(data) {
  var keep = $('#setupSheetSelect').val() || readLocal('termLastSheet');
  updateSheetSelects(data.sheets);
  selectIfExists('#setupSheetSelect', keep);
  $('#setupSheetSelect').prop('disabled', false);
  renderCustomSelects();
}

function selectIfExists(sel, value) {
  if (!value) return;
  var $s = $(sel);
  var has = $s.find('option').filter(function () { return this.value === String(value); }).length;
  if (has) $s.val(String(value));
}

/**
 * Склади для терміналу. v3.1.4: «Archív» сюди не потрапляє (власник/správca
 * запускає його з картки складу в адмінці), «Dokončený» підписаний — щоб не
 * сканувати в уже закритий список випадково.
 */
var sheetStatus = {};             // id складу → стан (prep/active/done/archived)

function updateSheetSelects(sheets) {
  var $s = $('#setupSheetSelect').empty();
  $s.append('<option value="" selected disabled>Vyberte…</option>');
  sheetStatus = {};
  var list = (sheets || []).filter(function (sh) {
    sheetStatus[sh.id] = sh.status || 'active';
    return sh.status !== 'archived';
  });

  if (!list.length) {
    $s.append('<option value="">(Žiadne sklady)</option>');
  } else {
    // ВИПРАВЛЕНО: раніше в текст опції дописувалась кількість рядків «(1234)»,
    // а потім вирізалась регуляркою /\(\d+\)$/. Склад із назвою на кшталт
    // «Sklad A (2024)» через це втрачав частину назви — а назва складу
    // використовується для пошуку в логах. Назву для терміналу беремо з
    // data-name, а не з тексту опції (там тепер буває «— Dokončený»).
    list.forEach(function (sh) {
      $s.append('<option value="' + escapeHtml(sh.id) + '" data-name="' + escapeHtml(sh.name) + '">' +
                escapeHtml(sh.name) + (sh.status === 'done' ? ' — Dokončený' : '') + '</option>');
    });
  }
  renderCustomSelects($s.closest('.su-field'));
  Sheets.setBasic(sheets);          // v3.1.6: таблиця працівника на головній ПК
}

/**
 * Оновити склади всюди: вибір для терміналу і список в адмінці.
 * v3.1.6: список správcu вантажиться завжди — на ПК він є головною сторінкою,
 * навіть коли адмін-картку на телефоні закрили.
 */
function refreshSheetList() {
  $('.ref-btn').addClass('busy');
  loadInitData();
  if (Auth.can('admin')) Sheets.load(true);
  setTimeout(function () { $('.ref-btn').removeClass('busy'); }, 800);
}
window.refreshSheetList = refreshSheetList;

function updateSyncUI(status, extra) {
  var $p = $('#syncStatus');
  $p.removeClass('s-ok s-save s-err s-queue');
  $('.footer-wrapper, .input-group').removeClass('offline-disabled');

  if (status === 'online')       $p.text('Online').addClass('s-ok');
  else if (status === 'saving')  $p.text('Ukladám…').addClass('s-save');
  else if (status === 'queue')   $p.text('Čaká na odoslanie: ' + extra).addClass('s-queue');
  else if (status === 'offline') { $p.text('Offline').addClass('s-err'); }
}

function updateOutboxUI() {
  var n = Outbox.count();
  if (n > 0) updateSyncUI('queue', n);
  else if (navigator.onLine) updateSyncUI('online');
  else updateSyncUI('offline');
}

// ------------------------------------------------------------ адмін-панель

/**
 * v3.1.3: без PIN — панель бачать лише správca і власник (база перевіряє кожну дію окремо).
 * v3.1.4: відкрита одразу після входу; замість випадного «Sklad» — повний список
 * складів (sheets.js). Закрив хрестиком — до наступного входу лишається закритою.
 */
var adminClosedByUser = false;

function showAdminPanel() {
  if (!Auth.can('admin')) {
    showMsg('Administrácia', 'Administrácia je dostupná len pre správcu alebo vlastníka.');
    return;
  }
  adminClosedByUser = false;
  $('#adminCard').removeClass('hidden');
  $('#adminOpenBtn').addClass('hidden');
  $('#setupGrid').removeClass('single-mode');
  Sheets.load();
}
function closeAdminPanel(byUser) {
  if (byUser) adminClosedByUser = true;
  $('#adminCard').addClass('hidden');
  $('#setupGrid').addClass('single-mode');
  $('#adminOpenBtn').toggleClass('hidden', !Auth.can('admin'));
}

function reqCreateSheet() {
  showPrompt('Názov nového skladu', 'Napr. Hayes 2026', '').then(function (n) {
    if (!n || !n.trim()) return;
    setAdminBusy(true, 'Vytváram sklad…');
    return API.sheetCreate(n.trim()).then(function (r) {
      setAdminBusy(false);
      loadInitData();
      // v3.1.6: одразу відкрити картку нового складу — там і «Import zo súboru»
      return Sheets.load(true).then(function () {
        if (r.id) Sheets.openDetail(r.id);
        showMsg('Hotovo', r.msg + '\nTeraz doň nahrajte tovar tlačidlom „Import zo súboru“ v karte skladu.');
      });
    });
  }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

function reqDeleteSheet(id, name) {
  if (!id) return;
  showConfirm('Zmazať sklad?', 'Naozaj vymazať sklad «' + name + '»?\nPred zmazaním sa vytvorí záloha — sklad sa dá obnoviť v časti Zálohy.', true)
    .then(function (ok) {
      if (!ok) return;
      setAdminBusy(true, 'Mažem…');
      return API.sheetDelete(id).then(function (r) {
        setAdminBusy(false);
        Sheets.closeDetail();
        showMsg('Hotovo', r.msg);
        refreshSheetList();
      });
    }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}
window.reqDeleteSheet = reqDeleteSheet;

function reqClearLogs() {
  showConfirm('Vymazať celú históriu?',
    'História zmien všetkých skladov sa natrvalo vymaže a nedá sa obnoviť.\nOdporúčame ju najprv stiahnuť tlačidlom „Export“.', true).then(function (ok) {
    if (!ok) return;
    setAdminBusy(true, 'Mažem históriu…');
    return API.logsClear().then(function (r) {
      setAdminBusy(false); showMsg('Hotovo', r.msg);
      if (document.getElementById('logsModal') && !$('#logsModal').hasClass('hidden')) LogView.reload();
    });
  }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

// ------------------------------------------------------------ імпорт / експорт

/**
 * v3.1.2: одна таблиця складу (editor.js). З адмін-панелі відкривається лише
 * для перегляду; правка — кнопкою із замком у самій таблиці.
 */
// v3.1.4: склад передається явно (з картки складу в адмінці), а не береться
// з випадного списку, якого більше немає.
function openTableEditor(id, name) {
  if (!id) return;
  Editor.open({ sheetId: id, sheetName: name, context: 'admin' });
}
window.openTableEditor = openTableEditor;

/** v3.1.2: журнал усіх складів у вигляді таблиці (замість прямого доступу до аркуша Log). */
function openAdminLogs() {
  LogView.open({ admin: true });
}

function openImport(id, name) {
  if (!id) return;
  $('#impTargetName').text(name);
  Importer.reset(id, name);
  $('#importModal').removeClass('hidden');
}
window.openImport = openImport;
function closeImport() { $('#importModal').addClass('hidden'); }

function exportSheet(id, name) {
  if (!id) return;
  setAdminBusy(true, 'Pripravujem XLSX…');
  // SheetJS вантажиться на вимогу — на старті сторінки його немає
  Importer.ensureXlsx()
    .then(function () {
      return API.loadSheet(id, function (done, total) {
        setAdminBusy(true, 'Načítavam ' + done + ' / ' + total);
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
  $('#backupModal').removeClass('hidden');
  $('#backupList').html(getLoaderHtml('Hľadám zálohy...'));
  $('#backupSearchInput').val('');
  API.backupList().then(function (res) {
    currentBackups = res.list || [];
    filterBackups();
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
      '<div class="bu-rows">' + (b.rows || 0) + ' r.' + (b.reason ? ' · ' + escapeHtml(b.reason) : '') + '</div>' +
      '<div class="bu-actions">' +
        '<button class="bu-btn bu-open">' + icon('rotate-ccw') + '<span>Obnoviť</span></button>' +
        '<button class="bu-btn bu-del">' + icon('trash-2') + '<span>Zmazať</span></button>' +
      '</div></div>');
    // v3.1.0: замість «відкрити бекап як склад» — відновлення складу з бекапу
    $row.find('.bu-open').on('click', function () { reqRestoreBackup(b.id, b.name); });
    $row.find('.bu-del').on('click', function () { reqDeleteBackup(b.id, b.name); });
    $c.append($row);
  });
}

function reqRestoreBackup(id, name) {
  showConfirm('Obnoviť zo zálohy?',
    'Sklad sa nahradí stavom zo zálohy «' + name + '».\nAktuálny stav sa pred tým tiež uloží ako záloha.', true)
    .then(function (ok) {
      if (!ok) return;
      setAdminBusy(true, 'Obnovujem sklad…');
      return API.backupRestore(id).then(function (r) {
        setAdminBusy(false); closeBackups(); showMsg('Hotovo', r.msg); refreshSheetList();
      });
    }).catch(function (e) { setAdminBusy(false); showMsg('Chyba', errText(e)); });
}

function reqDeleteBackup(id, name) {
  showConfirm('Vymazať zálohu?', 'Nenávratne zmazať «' + name + '»?', true).then(function (ok) {
    if (!ok) return;
    $('#backupList').html(getLoaderHtml('Mažem...'));
    return API.backupDelete(id).then(function () { openBackups(); });
  }).catch(function (e) { showMsg('Chyba', errText(e)); });
}

// ------------------------------------------------------------ список товарів (v3.1.2)

/**
 * «Zoznam» у терміналі = та сама таблиця, що й в адмінці (editor.js), відкрита
 * з уже завантаженого складу — тому миттєво. Правка — лише через замок.
 */
function openMissing() {
  if (!currentSheetId || !localDB.length) { showMsg('Upozornenie', 'Najprv spustite terminál so skladom.'); return; }
  if (isBatching) flushChanges();
  Editor.open({ sheetId: currentSheetId, sheetName: currentSheetName, worker: currentUser, context: 'terminal', rows: localDB });
}

/** «Skenovať» у таблиці: вибраний товар рахується так само, як відсканований (+1). */
function scanFromList(id) {
  var idx = rowIndex[id];
  if (idx === undefined) return;
  if (isBatching) flushChanges();
  $('#errCard').addClass('hidden');
  currentItem = localDB[idx];
  currentActionType = 'scan';
  $('#qtyControls').removeClass('disabled-ctrl');
  modifyItem(1);
  focusScanInput();
}

/** Нотатку змінили в таблиці — оновити і термінал. */
function onListNote(id, note) {
  var idx = rowIndex[id];
  if (idx === undefined) return;
  localDB[idx].note = note;
  if (currentItem && currentItem.row === id) $('#pNoteInput').val(note);
}

/** Таблицю закрили після збереження змін — термінал перечитує склад. */
function onTableSaved(ctx) {
  if (ctx === 'terminal' && currentSheetId) refresh(false);
  // v3.1.5: таблицю відкривали з картки складу — оновити цифри в картці й у списку складів
  else if (ctx === 'admin' && Auth.can('admin')) Sheets.load(true);
}

// ------------------------------------------------------------ робота терміналу

function setLocalDB(data) {
  localDB = data || [];
  rowIndex = {};
  for (var i = 0; i < localDB.length; i++) rowIndex[localDB[i].row] = i;
}

/**
 * v3.1.0: до свіжих даних з бази додаються зміни, які ще лежать у черзі
 * (не дійшли через зв'язок). Інакше після оновлення екран показав би менше,
 * ніж людина вже нарахувала, і вона б перераховувала вдруге.
 */
function applyPendingOverlay() {
  Outbox.all().forEach(function (e) {
    if (String(e.sheetId) !== String(currentSheetId)) return;
    var idx = rowIndex[e.row];
    if (idx !== undefined) localDB[idx].real = Math.max(0, localDB[idx].real + e.delta);
  });
}

/**
 * Запуск терміналу. Без параметрів — склад з вибору на стартовому екрані;
 * з параметрами — з картки складу в адмінці (v3.1.4, там можна і «Archív»).
 * «Dokončený» — спершу питаємо: інвентуру вже закрили, скан туди, найімовірніше, помилка.
 */
function startApp(sheetId, sheetName, status) {
  var me = Auth.me();
  if (!me) { showMsg('Upozornenie', 'Počkajte, kým sa načíta váš účet (alebo skontrolujte internet).'); return; }
  var id = sheetId || $('#setupSheetSelect').val();
  if (!id) { showMsg('Upozornenie', 'Vyberte sklad!'); return; }
  var name = sheetName || $('#setupSheetSelect option:selected').attr('data-name') || $('#setupSheetSelect option:selected').text();
  var st = status || sheetStatus[id];

  var go = function () { launchTerminal(me, id, name); };
  if (st === 'done' || st === 'archived') {
    showConfirm('Sklad je ' + (st === 'done' ? 'dokončený' : 'v archíve'),
      'Inventúra v sklade «' + name + '» je označená ako ' + (st === 'done' ? '„Dokončený“' : '„Archív“') +
      '.\nNaozaj v ňom chcete skenovať?', false).then(function (ok) { if (ok) go(); });
    return;
  }
  go();
}
window.startApp = startApp;

function launchTerminal(me, id, name) {
  currentUser = me.name;
  currentSheetId = id;
  currentSheetName = name;
  // наступного разу цей склад буде вибраний одразу
  writeLocal('termLastSheet', currentSheetId);
  $('#sheetModal').addClass('hidden');
  $('#setupOverlay').addClass('hidden');
  setUiLoading(true, 'Sťahujem databázu...');
  updateSyncUI('online');

  API.loadSheet(currentSheetId, function (done, total) {
    setUiLoading(true, 'Sťahujem ' + done + ' / ' + total);
  }).then(function (res) {
    if (!res.data.length) {
      setUiLoading(false);
      $('#setupOverlay').removeClass('hidden');
      showMsg('Prázdny sklad', 'Tento sklad je prázdny.\nV administrácii doň naimportujte tovar.');
      return;
    }
    setLocalDB(res.data);
    applyPendingOverlay();
    lastSyncTime = res.serverTime || Date.now();
    $('#infoUser').text(currentUser);
    $('#infoSheet').text(currentSheetName);
    calcStats();
    setUiLoading(false);
    focusScanInput();
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
  stopPing();
  $('#setupOverlay').removeClass('hidden');
  $('#productCard').addClass('hidden');
  $('#waitingMsg').removeClass('hidden');
  $('#qtyControls').addClass('disabled-ctrl');
  currentItem = null;
  setLocalDB([]);
  currentSheetId = '';
  // власнику і správcovi адміністрація знову відкрита (якщо сам її не закрив)
  if (Auth.can('admin') && !adminClosedByUser) showAdminPanel();
  refreshSheetList();
}

function setUiLoading(loading, text) {
  $('.input-group, .tool-row, .qty-row').toggleClass('ui-disabled', !!loading);
  if (loading) $('#readyIndicator').html(getLoaderHtml(text || 'Načítavam…')).addClass('busy');
  else {
    $('#readyIndicator').text('Pripravený na skenovanie').removeClass('busy');
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
 * Синхронізація з базою (v3.1.0): раз на PING_INTERVAL_MS питаємо «що
 * змінилось з моменту X» — база віддає лише змінені позиції. Кількість з бази
 * вважається правильною; зверху додаються лише наші ще не відправлені зміни.
 *
 * ВИПРАВЛЕНО: раніше синхронізація пропускалась, поки людина сканує, і швидкий
 * сканер хвилинами не бачив змін інших. Тепер пропускається лише позиція, яку
 * людина змінює прямо зараз.
 */
function doPing() {
  if (!currentSheetId || isPinging || !navigator.onLine) return;
  isPinging = true;
  var sheetAtStart = currentSheetId;

  API.changes(currentSheetId, lastSyncTime)
    .then(function (res) {
      isPinging = false;
      if (sheetAtStart !== currentSheetId) return;
      updateOutboxUI();

      // Позиції додали або видалили — простіше перечитати склад повністю.
      if (res.count !== localDB.length) { lastSyncTime = res.serverTime; refresh(false); return; }

      var changed = false;
      (res.changes || []).forEach(function (c) {
        // c = [id, real, note, plan, name, plu, ean, code, brand]
        var idx = rowIndex[c[0]];
        if (idx === undefined) return;
        var it = localDB[idx];
        it.note = c[2]; it.plan = c[3]; it.name = c[4]; it.plu = c[5]; it.ean = c[6]; it.code = c[7]; it.brand = c[8];
        changed = true;
        if (pendingWrites[c[0]]) return;                                   // наш запис ще летить
        if (isBatching && currentItem && currentItem.row === c[0]) return; // людина рахує цю позицію
        it.real = Math.max(0, c[1] + Outbox.sumFor(currentSheetId, c[0]));
      });
      lastSyncTime = res.serverTime;

      if (changed) { calcStats(); refreshCardNumbers(); }
      flushOutbox();
    })
    .catch(function () {
      isPinging = false;
      updateSyncUI('offline');
    });
}

function refresh(hard) {
  // v3.1.0: незавершену «пачку» відправляємо завжди — інакше після заміни
  // localDB різниця рахувалась би від нового об'єкта і вийшла б неправильною.
  if (isBatching) flushChanges();
  if (hard) {
    currentItem = null;
    $('#productCard, #errCard').addClass('hidden');
    $('#codeInput').val('');
    $('#waitingMsg').removeClass('hidden');
    $('#qtyControls').addClass('disabled-ctrl');
    $('#pcLogList').html('<div class="log-placeholder">Zatiaľ žiadne skeny</div>');
  }
  setUiLoading(true, 'Obnovujem...');
  API.loadSheet(currentSheetId, function (d, t) { setUiLoading(true, 'Načítavam ' + d + ' / ' + t); })
    .then(function (res) {
      var openPlu = currentItem ? currentItem.plu : null;
      setLocalDB(res.data);
      applyPendingOverlay();
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
    showScanError('Kód patrí viacerým položkám: ' + code);
    if (zoomEnabled) flash({ plu: code, name: 'Nájdených viac zhôd', code: '--', ean: '--' }, 'Duplicitný kód', 'f-red');
    $('#qtyControls').addClass('disabled-ctrl');
    return;
  }
  if (!matches.length) {
    sndErr();
    showScanError('Neznámy kód: ' + code);
    if (zoomEnabled) flash({ plu: code, name: 'Neznámy kód', code: '--', ean: '--' }, 'Neznámy kód', 'f-red');
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
    if (zoomEnabled) flash(currentItem, 'Realita nemôže byť pod 0', 'f-red');
    return;
  }
  if (isBatching && lastActionDir !== 0 && Math.sign(change) !== Math.sign(lastActionDir)) flushChanges();

  lastActionDir = change;
  currentActionType = 'manual';
  modifyItem(change);
  $('#mq').val(1);
  if (document.activeElement) document.activeElement.blur();
  focusScanInput();
}

/**
 * ВИПРАВЛЕНО (v3.1.0): після +/− фокус лишався «ніде», і наступний скан
 * пістолетом (він друкує як клавіатура) нікуди не потрапляв. Повертаємо фокус
 * у поле сканування. На телефоні клавіатура при цьому не вискакує
 * (inputmode="none"), якщо людина сама не ввімкнула клавіатуру.
 */
function focusScanInput() {
  setTimeout(function () {
    var el = document.getElementById('codeInput');
    if (!el || $('#setupOverlay').is(':visible')) return;
    var active = document.activeElement;
    if (active && active !== document.body && active !== el &&
        /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;   // людина пише нотатку — не заважаємо
    el.focus();
  }, 0);
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

  updateOptimisticLog(currentItem, batchStartValue, currentItem.real, currentActionType, batchTimestamp);

  var color = 'f-blue';
  if (currentItem.real === currentItem.plan) { color = 'f-green'; sndDone(); }
  else if (currentItem.real > currentItem.plan) { color = 'f-orange'; sndOver(); }
  else sndOk();
  if (zoomEnabled) flash(currentItem, currentItem.name, color);

  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(flushChanges, CFG.BATCH_DELAY_MS);
}

/**
 * Забирає накопичену «пачку» натискань як одну операцію {opId, delta, ...}
 * і скидає стан пачки. Повертає null, якщо відправляти нічого.
 */
function takeBatchEntry() {
  if (!isBatching || !currentItem) return null;
  var delta = currentItem.real - batchStartValue;
  var entry = delta === 0 ? null : {
    opId: API.newOpId(), sheetId: currentSheetId, row: currentItem.row, delta: delta,
    user: currentUser, type: currentActionType, time: batchTimestamp
  };
  isBatching = false; pendingDelta = 0; batchStartValue = null; lastActionDir = 0;
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  return entry;
}

/**
 * v3.1.0: у базу йде не «стало 7», а «+3» з унікальним opId. База додає
 * атомарно, тож двоє людей на одному товарі дають правильну суму, а повтор
 * при обриві мережі не додає вдруге.
 */
function flushChanges() {
  $('#pcLogList').children().first().removeClass('pending new-item');
  var entry = takeBatchEntry();
  if (entry) sendEntry(entry);
}

function sendEntry(entry) {
  pendingWrites[entry.row] = (pendingWrites[entry.row] || 0) + 1;
  updateSyncUI('saving');

  API.scan(entry).then(function (res) {
    doneWrite(entry.row);
    if (!res.duplicate) applyServerReal(entry.sheetId, entry.row, res.newReal);
    updateOutboxUI();
  }).catch(function (e) {
    doneWrite(entry.row);
    if (e.transient || e.isAuth) {
      // немає зв'язку — зміна чекає в черзі і дошлеться сама (той самий opId).
      // v3.1.3: так само при втраті входу — скан справжній, піде після входу.
      Outbox.add(entry);
      updateOutboxUI();
    } else {
      // справжня помилка: позицію видалили тощо — повертаємо правду з бази
      showMsg('Zmena sa neuložila', errText(e) + '\nObnovujem dáta zo servera.');
      refresh(false);
    }
  });
}

function doneWrite(row) {
  pendingWrites[row] = (pendingWrites[row] || 1) - 1;
  if (pendingWrites[row] <= 0) delete pendingWrites[row];
}

/**
 * Відповідь бази — правильна кількість (враховує і зміни інших людей).
 * Показуємо її + наші ще не відправлені зміни (черга і поточна пачка).
 */
function applyServerReal(sheetId, row, serverReal) {
  if (String(sheetId) !== String(currentSheetId) || pendingWrites[row]) return;
  var idx = rowIndex[row];
  if (idx === undefined) return;
  var it = localDB[idx];
  var inBatch = isBatching && currentItem && currentItem.row === row;
  var extra = Outbox.sumFor(sheetId, row) + (inBatch ? currentItem.real - batchStartValue : 0);
  var val = Math.max(0, serverReal + extra);
  if (inBatch) batchStartValue += val - it.real;   // різниця пачки лишається тією самою
  it.real = val;
  calcStats();
  refreshCardNumbers();
}

/** Оновлює лише цифри на картці товару (нотатку, яку людина пише, не чіпає). */
function refreshCardNumbers() {
  if (!currentItem || $('#productCard').hasClass('hidden')) return;
  $('#pPlan').text(currentItem.plan);
  $('#pReal').text(currentItem.real);
  var diff = currentItem.real - currentItem.plan;
  $('#pDiff').text((diff > 0 ? '+' : '') + diff)
    .css('color', diff === 0 ? '#d97706' : (diff > 0 ? '#059669' : '#dc2626'));
}

var isFlushingOutbox = null;

/** Досилає чергу. Повертає проміс з кількістю того, що лишилось (v3.1.3 — для виходу). */
function flushOutbox() {
  // Захист від паралельного запуску: flushOutbox смикається і з ping,
  // і з події «мережа з'явилась» — другий виклик чекає на перший.
  if (isFlushingOutbox) return isFlushingOutbox;
  if (!Outbox.count() || !navigator.onLine || !Auth.userId()) return Promise.resolve(Outbox.count());

  isFlushingOutbox = Outbox.flush(function (entry, res, err) {
    if (res && !res.duplicate) applyServerReal(entry.sheetId, entry.row, res.newReal);
    if (err) showMsg('Zmena sa neuložila', errText(err));
  }).catch(function () {}).then(function () {
    isFlushingOutbox = null;
    updateOutboxUI();
    return Outbox.count();
  });
  return isFlushingOutbox;
}

function reqSaveNote() {
  if (!currentItem) return;
  var txt = $('#pNoteInput').val();
  var $btn = $('#btnSaveNote');
  if ($btn.prop('disabled')) return;

  $btn.prop('disabled', true).html(icon('loader-circle', 'ic-spin')).removeClass('active-state');
  updateSyncUI('saving');

  API.note(currentItem.row, txt)
    .then(function (res) {
      currentItem.note = res.note;
      var idx = rowIndex[currentItem.row];
      if (idx !== undefined) localDB[idx].note = res.note;
      $('#pNoteInput').val(res.note);
      $btn.prop('disabled', true).html(icon('save'));
      updateOutboxUI();
    })
    .catch(function (e) {
      $btn.prop('disabled', false).addClass('active-state').html(icon('save'));
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
    .html(escapeHtml(t) + ' · uložené: ' + oldVal + ' ' + icon('arrow-right', 'la-arrow') + ' ' + newVal);
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
        '<span class="val-change">' + escapeHtml(String(oldVal)) + ' ' + icon('arrow-right', 'la-arrow') + ' ' + escapeHtml(String(newVal)) + '</span>' +
      '</div></div>' +
    '</div>' +
    '<div class="l-codes-row">' + codePills(plu, code, ean) + '</div>';
}

function openLog() {
  if (!currentSheetId) return;
  LogView.open({ admin: false, sheetId: currentSheetId, sheetName: currentSheetName });
}

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
      // v3.1.5: вибір камери — стилізований список (темний, відкривається вгору)
      renderCustomSelects($('#camSelectWrapper'));
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
