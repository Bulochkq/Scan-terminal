/**
 * SHEETS.JS — склади на головній: список, картка складу; на ПК ще й меню головної.
 * Остання зміна: v3.1.6 (див. PROGRESS.md у корені репо)
 *
 * Запит власника (29.09.2026): замість випадного списку «Sklad» в адмінці —
 * повний, зручний список складів: коли створений, стан, скільки пораховано,
 * коли і хто працював востаннє; перейменування, зміна стану і журнал САМЕ
 * цього складу. Усе для власника і správcu (база: api_sheets, api_sheet_update).
 *
 * v3.1.6 (запит власника 30.09.2026): на ПК список у вузькій картці був дрібним і
 * незручним. Тепер від 1024 px головна — сторінка на весь екран: бічне меню (Home),
 * велика таблиця складів із сортуванням і фільтрами за станом, картка складу —
 * панеллю справа. Телефон бачить компактні картки, як раніше. Обидва вигляди малює
 * той самий render() з тих самих даних, а який із них видно — вирішує CSS.
 * Працівник на ПК бачить ту саму таблицю без цифр (api_sheets йому недоступна):
 * назва, стан і «Spustiť terminál».
 *
 * Стани (004_sheets_status.sql):
 *   prep     Príprava   — завантажено, ще не рахували (сам стає «Prebieha» з першим сканом)
 *   active   Prebieha   — інвентура йде
 *   done     Dokončený  — порахували; термінал попереджає перед скануванням
 *   archived Archív     — не показується у виборі складу для терміналу
 */
(function (global) {
  'use strict';

  var STATUS = {
    prep:     { label: 'Príprava',  note: 'Tovar je nahratý, inventúra ešte nezačala. Po prvom skene sa stav sám zmení na „Prebieha“.' },
    active:   { label: 'Prebieha',  note: 'Inventúra prebieha.' },
    done:     { label: 'Dokončený', note: 'Inventúra je hotová. Terminál pred skenovaním upozorní, že sklad je dokončený.' },
    archived: { label: 'Archív',    note: 'Sklad sa neukazuje vo výbere pre terminál. Dáta zostávajú, stav sa dá kedykoľvek zmeniť.' }
  };
  // aktívne hore, archív dole
  var ORDER = { active: 0, prep: 1, done: 2, archived: 3 };

  /** v3.1.6: фільтри над таблицею на ПК. «Aktuálne» — усе, крім архіву. */
  var CHIPS = [
    { f: 'current',  label: 'Aktuálne',  test: function (s) { return s.status !== 'archived'; } },
    { f: 'active',   label: 'Prebieha',  test: function (s) { return s.status === 'active'; } },
    { f: 'prep',     label: 'Príprava',  test: function (s) { return s.status === 'prep'; } },
    { f: 'done',     label: 'Dokončené', test: function (s) { return s.status === 'done'; } },
    { f: 'archived', label: 'Archív',    test: function (s) { return s.status === 'archived'; } }
  ];

  /** v3.1.6: колонки таблиці для správcu (opt — ховаються на вужчому ПК). */
  var COLS = [
    { k: 'name',   label: 'Sklad' },
    { k: 'status', label: 'Stav' },
    { k: 'items',  label: 'Položky', num: true },
    { k: 'done',   label: 'Sedí',    num: true, opt: true },
    { k: 'plan',   label: 'Plán',    num: true, opt: true },
    { k: 'real',   label: 'Realita', num: true, opt: true },
    { k: 'pct',    label: 'Hotovo' },
    { k: 'lastTs', label: 'Posledná práca' }
  ];

  var L = {
    list: [],          // повний огляд (api_sheets) — лише správca / vlastník
    basic: [],         // склади з api_init (назва + стан) — для працівника на ПК
    loaded: false, error: '', loading: null, gen: 0,
    showArchived: false, current: null,
    chip: 'current', sort: { k: '', dir: 1 }
  };

  function esc(s) { return global.escapeHtml(s); }
  function errText(e) { return (e && e.message) ? e.message : String(e); }
  function fmt(n) { return Number(n || 0).toLocaleString('sk-SK'); }
  /** Словацька множина: 1 položka, 2–4 položky, 0 і 5+ položiek. */
  function plural(n, one, few, many) { return n === 1 ? one : (n >= 2 && n <= 4 ? few : many); }
  function isAdmin() { return global.Auth.can('admin'); }

  /** Скільки «зроблено»: та сама формула, що в «Prehľad» терміналу (надлишок не рахується). */
  function pct(s) {
    var plan = Number(s.plan) || 0;
    if (plan > 0) return Math.min(100, Math.round((Number(s.capped) || 0) / plan * 100));
    return (s.items && Number(s.real) > 0) ? 100 : 0;
  }

  /** 'DD.MM.YYYY HH:MI' → 'DD.MM. HH:MI' для короткого рядка. */
  function shortDate(t) { return t && t.length >= 16 ? t.slice(0, 6) + ' ' + t.slice(11, 16) : (t || ''); }
  function dateOnly(t) { return t ? String(t).slice(0, 10) : '—'; }

  function statusLabel(st) { return (STATUS[st] || {}).label || st || ''; }
  function statusPill(st) { return '<span class="st-pill st-' + esc(st) + '">' + esc(statusLabel(st)) + '</span>'; }

  function findIn(list, id) {
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function find(id) { return findIn(L.list, id); }

  // ------------------------------------------------------------ дані

  /**
   * v3.1.6: виклик, поки попередній запит ще йде, отримує той самий запит — без дублів
   * (при вході список просять кілька місць одразу). force — дані щойно змінились
   * (новий склад, імпорт, «Obnoviť»): дочекатися поточного запиту і взяти свіжий.
   */
  function load(force) {
    if (!isAdmin()) return Promise.resolve();
    if (L.loading) return force ? L.loading.then(function () { return load(); }) : L.loading;
    var gen = L.gen;
    if (!L.list.length) render();                      // покаже «Načítavam…»
    L.loading = global.API.sheets().then(function (res) {
      if (gen !== L.gen) return;                       // тим часом вийшли з акаунта
      L.list = res.sheets || [];
      L.loaded = true;
      L.error = '';
      render();
      if (L.current) {
        var fresh = find(L.current.id);
        if (fresh) { L.current = fresh; fillDetail(); } else closeDetail();
      }
    }).catch(function (e) {
      if (e.isAuth || gen !== L.gen) return;
      // PGRST202 = у базі ще немає функції api_sheets (не запущено 004_sheets_status.sql)
      L.error = e.code === 'PGRST202'
        ? 'Databáza ešte nie je aktualizovaná — v Supabase spustite súbor supabase/migrations/004_sheets_status.sql.'
        : errText(e);
      render();
    }).then(function () { if (gen === L.gen) L.loading = null; });
    return L.loading;
  }

  /** v3.1.6: склади з api_init (є в кожного, хто увійшов) — таблиця працівника на ПК. */
  function setBasic(sheets) {
    L.basic = (sheets || []).map(function (s) {
      return { id: String(s.id), name: s.name, status: s.status || 'active' };
    });
    renderDesk();
  }

  function render() { renderCards(); renderDesk(); }

  // ------------------------------------------------------------ телефон: картки в адмінці

  function renderCards() {
    var $l = $('#shList');
    if (!$l.length) return;
    if (!L.loaded) {
      $('#shCount').text('');
      $('#shSearchBox, #shArchToggle').addClass('hidden');
      $l.html(L.error ? '<div class="list-empty">' + esc(L.error) + '</div>' : global.getLoaderHtml('Načítavam sklady…'));
      return;
    }
    var term = String($('#shSearch').val() || '').toLowerCase().trim();
    var all = sortList(L.list);
    var archived = all.filter(function (s) { return s.status === 'archived'; }).length;
    var visible = all.filter(function (s) {
      if (!L.showArchived && s.status === 'archived' && !term) return false;
      return !term || s.name.toLowerCase().indexOf(term) !== -1;
    });

    $('#shCount').text(L.list.length ? '(' + L.list.length + ')' : '');
    $('#shSearchBox').toggleClass('hidden', L.list.length <= 6);
    $('#shArchToggle').toggleClass('hidden', !archived || !!term)
      .html(global.icon(L.showArchived ? 'chevron-down' : 'chevron-right') +
            '<span>' + (L.showArchived ? 'Skryť archív' : 'Zobraziť archív') + ' (' + archived + ')</span>');

    $l.empty();
    if (!visible.length) {
      $l.html('<div class="list-empty">' + (L.list.length ? 'Nič sa nenašlo.' : 'Zatiaľ žiadne sklady — vytvorte prvý tlačidlom „Nový sklad“.') + '</div>');
      return;
    }
    visible.forEach(function (s) {
      var p = pct(s);
      var $row = $('<button type="button" class="sh-row">' +
        '<div class="sh-main">' +
          '<div class="sh-name"><span class="sh-title">' + esc(s.name) + '</span>' + statusPill(s.status) + '</div>' +
          '<div class="sh-meta">' + fmt(s.items) + ' pol. · ' + p + ' % · ' +
            (s.last ? 'naposledy ' + esc(shortDate(s.last)) : 'zatiaľ bez práce') + '</div>' +
          '<div class="sh-bar"><div style="width:' + p + '%"></div></div>' +
        '</div>' + global.icon('chevron-right', 'sh-go') + '</button>');
      $row.on('click', function () { openDetail(s.id); });
      $l.append($row);
    });
  }

  function toggleArchived() { L.showArchived = !L.showArchived; renderCards(); }

  // ------------------------------------------------------------ ПК: таблиця на всю сторінку (v3.1.6)

  /** Без вибраної колонки — як і на телефоні: спершу «Prebieha», архів у кінці, далі за назвою. */
  function sortList(list) {
    var k = L.sort.k, dir = L.sort.dir;
    return list.slice().sort(function (a, b) {
      if (k) {
        var va = sortVal(a, k), vb = sortVal(b, k);
        var c = typeof va === 'string' ? va.localeCompare(vb, 'sk') : va - vb;
        if (c) return c * dir;
      }
      return ((ORDER[a.status] || 0) - (ORDER[b.status] || 0)) || a.name.localeCompare(b.name, 'sk');
    });
  }
  function sortVal(s, k) {
    if (k === 'name') return s.name;
    if (k === 'status') return ORDER[s.status] || 0;
    if (k === 'pct') return pct(s);
    return Number(s[k]) || 0;
  }
  /** Той самий заголовок ще раз — зворотний порядок. Числа й дата спершу від найбільшого. */
  function sortBy(k) {
    if (L.sort.k === k) L.sort.dir = -L.sort.dir;
    else L.sort = { k: k, dir: (k === 'name' || k === 'status') ? 1 : -1 };
    renderDesk();
  }

  function renderDesk() {
    var $t = $('#hdTable');
    if (!$t.length) return;
    var admin = isAdmin();
    $('#hdMain').toggleClass('is-member', !admin);
    $('#homeDesk .hd-admin').toggleClass('hidden', !admin);
    $('#hdTitle').text(admin ? 'Sklady' : 'Vyberte sklad');

    // працівник архів не бачить (як і у виборі складу на телефоні)
    var src = admin ? L.list : L.basic.filter(function (s) { return s.status !== 'archived'; });
    var chips = CHIPS.filter(function (c) { return admin || c.f !== 'archived'; });
    if (!chips.some(function (c) { return c.f === L.chip; })) L.chip = 'current';
    $('#hdChips').html(chips.map(function (c) {
      var n = src.filter(c.test).length;
      if (!n && c.f !== 'current' && c.f !== L.chip) return '';          // порожні фільтри не заважають
      return '<button type="button" class="chip' + (c.f === L.chip ? ' active' : '') + '" data-f="' + c.f + '">' +
             esc(c.label) + '<span class="chip-n">' + n + '</span></button>';
    }).join(''));

    var cur = src.filter(function (s) { return s.status !== 'archived'; });
    var items = cur.reduce(function (a, s) { return a + (Number(s.items) || 0); }, 0);
    $('#hdSub').text(!admin ? 'Vyberte sklad a spustite terminál.'
      : !L.loaded ? ''
      : cur.length + ' ' + plural(cur.length, 'aktuálny sklad', 'aktuálne sklady', 'aktuálnych skladov') +
        ' · ' + fmt(items) + ' ' + plural(items, 'položka', 'položky', 'položiek'));

    if (admin && !L.loaded) {
      $t.html(L.error ? '<div class="list-empty">' + esc(L.error) + '</div>' : global.getLoaderHtml('Načítavam sklady…'));
      $('#hdFoot').text('');
      return;
    }

    var term = String($('#hdSearch').val() || '').toLowerCase().trim();
    var chip = chips.filter(function (c) { return c.f === L.chip; })[0];
    var rows = sortList(src.filter(function (s) {
      return chip.test(s) && (!term || s.name.toLowerCase().indexOf(term) !== -1);
    }));

    if (!rows.length) {
      $t.html('<div class="list-empty">' + (src.length ? 'Nič sa nenašlo.'
        : admin ? 'Zatiaľ žiadne sklady — vytvorte prvý tlačidlom „Nový sklad“.' : 'Zatiaľ žiadne sklady.') + '</div>');
      $('#hdFoot').text('');
      return;
    }
    $t.html(admin ? adminTable(rows) : memberTable(rows));
    $('#hdFoot').text(admin
      ? 'Kliknite na sklad — vpravo sa otvorí jeho karta: tovar, história, import, export a stav.'
      : 'Kliknite na sklad — spustí sa terminál.');
  }

  function adminTable(rows) {
    var head = COLS.map(function (c) {
      var on = L.sort.k === c.k;
      return '<th class="sortable' + (c.num ? ' num' : '') + (c.opt ? ' opt' : '') +
             (on ? ' sorted' + (L.sort.dir > 0 ? ' asc' : '') : '') + '" data-k="' + c.k + '" title="Zoradiť">' +
             esc(c.label) + (on ? global.icon('chevron-down') : '') + '</th>';
    }).join('') + '<th></th>';
    var openId = L.current ? String(L.current.id) : '';
    var body = rows.map(function (s) {
      var p = pct(s);
      return '<tr tabindex="0" data-id="' + esc(s.id) + '"' + (String(s.id) === openId ? ' class="is-open"' : '') + '>' +
        '<td><div class="t-name">' + esc(s.name) + '</div><div class="t-sub">vytvorený ' + esc(dateOnly(s.created)) + '</div></td>' +
        '<td>' + statusPill(s.status) + '</td>' +
        '<td class="num">' + fmt(s.items) + '</td>' +
        '<td class="num opt">' + fmt(s.done) + '</td>' +
        '<td class="num opt">' + fmt(s.plan) + '</td>' +
        '<td class="num opt">' + fmt(s.real) + '</td>' +
        '<td class="c-pct"><div class="t-pct"><div class="t-bar"><div style="width:' + p + '%"></div></div><span>' + p + ' %</span></div></td>' +
        '<td class="c-last">' + lastCell(s) + '</td>' +
        '<td class="c-act"><button type="button" class="btn btn-secondary btn-start" title="Spustiť terminál v tomto sklade">' +
          global.icon('scan-barcode') + '<span>Spustiť</span></button></td>' +
      '</tr>';
    }).join('');
    return '<table class="sh-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function lastCell(s) {
    if (!s.last) return '<span class="t-sub">zatiaľ bez práce</span>';
    var who = [s.lastBy, (s.lastAction && global.LogView) ? global.LogView.actionLabel(s.lastAction) : '']
      .filter(function (x) { return !!x; }).join(' · ');
    return '<div>' + esc(shortDate(s.last)) + '</div>' + (who ? '<div class="t-sub">' + esc(who) + '</div>' : '');
  }

  function memberTable(rows) {
    return '<table class="sh-table"><thead><tr><th>Sklad</th><th>Stav</th><th></th></tr></thead><tbody>' +
      rows.map(function (s) {
        return '<tr tabindex="0" data-id="' + esc(s.id) + '"><td><div class="t-name">' + esc(s.name) + '</div></td>' +
               '<td>' + statusPill(s.status) + '</td>' +
               '<td class="c-act"><button type="button" class="btn btn-secondary btn-start">' +
                 global.icon('scan-barcode') + '<span>Spustiť terminál</span></button></td></tr>';
      }).join('') + '</tbody></table>';
  }

  /** «Spustiť» у рядку: «Dokončený» / «Archív» термінал сам перепитає (startApp). */
  function startRow(id) {
    var s = find(id) || findIn(L.basic, id);
    if (!s) return;
    closeDetail();
    global.startApp(s.id, s.name, s.status);
  }

  // ------------------------------------------------------------ картка складу

  function openDetail(id) {
    L.current = find(id);
    if (!L.current) return;
    fillDetail();
    $('#sheetModal').removeClass('hidden');
    markOpen();
  }
  function closeDetail() {
    L.current = null;
    $('#sheetModal').addClass('hidden');
    markOpen();
  }
  /** Рядок, чия картка відкрита, підсвічений у таблиці (ПК). */
  function markOpen() {
    var id = L.current ? String(L.current.id) : '';
    $('#hdTable tbody tr').each(function () { $(this).toggleClass('is-open', $(this).attr('data-id') === id); });
  }

  function fillDetail() {
    var s = L.current;
    if (!s) return;
    var p = pct(s);
    var items = Number(s.items) || 0, capped = Number(s.capped) || 0;
    $('#sdName').text(s.name);
    $('#sdPill').html(statusPill(s.status));
    $('#sdCreated').text('Vytvorený ' + (s.created || '—'));
    $('#sdStatus button').removeClass('active').filter('[data-s="' + s.status + '"]').addClass('active');
    $('#sdStatusNote').text((STATUS[s.status] || {}).note || '');
    $('#sdItems').text(fmt(items));
    $('#sdDone').text(fmt(s.done));
    $('#sdPlan').text(fmt(s.plan));
    $('#sdReal').text(fmt(s.real));
    // Chýba / Naviac — ті самі числа, що «Prehľad» у терміналі: Σ(plán − realita) і Σ(realita − plán) по позиціях
    $('#sdMiss').text(fmt(Math.max(0, (Number(s.plan) || 0) - capped)));
    $('#sdExtra').text(fmt(Math.max(0, (Number(s.real) || 0) - capped)));
    $('#sdBar').css('width', p + '%');
    $('#sdPct').text(p + ' %');
    $('#sdPctLbl').text('hotovo · sedí ' + fmt(s.done) + ' z ' + fmt(items) + ' ' + plural(items, 'položky', 'položiek', 'položiek'));
    var last = s.last
      ? 'Naposledy ' + esc(s.last) + (s.lastBy ? ' · ' + esc(s.lastBy) : '') +
        (s.lastAction && global.LogView ? ' · ' + esc(global.LogView.actionLabel(s.lastAction)) : '')
      : 'V sklade sa zatiaľ nepracovalo.';
    $('#sdLast').html(global.icon('clock') + '<span>' + last + '</span>');
  }

  function setStatus(st) {
    var s = L.current;
    if (!s || s.status === st || !STATUS[st]) return;
    global.setAdminBusy(true, 'Ukladám stav…');
    global.API.sheetUpdate(s.id, { status: st }).then(function () {
      global.setAdminBusy(false);
      s.status = st;
      fillDetail();
      render();
      global.refreshSheetList();          // термінал: архівні зникають зі списку
    }).catch(function (e) { global.setAdminBusy(false); global.showMsg('Chyba', errText(e)); });
  }

  function rename() {
    var s = L.current;
    if (!s) return;
    global.showPrompt('Nový názov skladu', 'Názov skladu', s.name).then(function (name) {
      if (name === null) return;
      name = String(name).trim();
      if (!name || name === s.name) return;
      global.setAdminBusy(true, 'Premenúvam…');
      return global.API.sheetUpdate(s.id, { name: name }).then(function () {
        global.setAdminBusy(false);
        s.name = name;
        fillDetail();
        render();
        global.refreshSheetList();
      });
    }).catch(function (e) { global.setAdminBusy(false); global.showMsg('Chyba', errText(e)); });
  }

  /** Дії з карткою: самі вікна (таблиця, імпорт, журнал…) відкриваються поверх неї. */
  function act(what) {
    var s = L.current;
    if (!s) return;
    if (what === 'items')    return global.openTableEditor(s.id, s.name);
    if (what === 'logs')     return global.LogView.open({ admin: true, sheetId: s.id, sheetName: s.name });
    if (what === 'import')   return global.openImport(s.id, s.name);
    if (what === 'export')   return global.exportSheet(s.id, s.name);
    if (what === 'rename')   return rename();
    if (what === 'delete')   return global.reqDeleteSheet(s.id, s.name);
    if (what === 'terminal') { closeDetail(); return global.startApp(s.id, s.name, s.status); }
  }

  // ------------------------------------------------------------ меню головної на ПК (v3.1.6)

  /**
   * «História», «Zálohy», «Ľudia» — ті самі вікна, що й на телефоні, але на ПК вони
   * стають праворуч від меню (app.css), тож меню працює як перемикач сторінок.
   * У цих вікнах немає незбережених змін, тому перемикання просто закриває попереднє.
   * Таблиця товару та імпорт (з картки складу) закривають і меню — там можуть бути
   * незбережені зміни, їх закривають лише власною кнопкою.
   */
  function go(page) {
    if (page !== 'sheets' && !isAdmin()) return;
    closeDetail();
    if (page !== 'people' && !$('#peopleModal').hasClass('hidden')) global.People.close();
    if (page !== 'backups' && !$('#backupModal').hasClass('hidden')) global.closeBackups();
    var logsOpen = !$('#logsModal').hasClass('hidden');
    // журнал одного складу (з картки) і загальний — те саме вікно; «História» = загальний
    if (logsOpen && (page !== 'history' || !$('#logsModal').hasClass('lg-all'))) { global.LogView.close(); logsOpen = false; }
    if (page === 'people' && $('#peopleModal').hasClass('hidden')) global.People.open();
    else if (page === 'backups' && $('#backupModal').hasClass('hidden')) global.openBackups();
    else if (page === 'history' && !logsOpen) global.openAdminLogs();
    syncNav();
  }

  /** Підсвітити в меню сторінку, яка зараз відкрита (вікна закриваються й власним хрестиком). */
  function syncNav() {
    var page = 'sheets';
    if (!$('#peopleModal').hasClass('hidden')) page = 'people';
    else if (!$('#backupModal').hasClass('hidden')) page = 'backups';
    else if (!$('#logsModal').hasClass('hidden') && $('#logsModal').hasClass('lg-all')) page = 'history';
    $('#homeDesk .hd-nav-item').removeClass('active').filter('[data-nav="' + page + '"]').addClass('active');
  }

  $(function () {
    $('#hdChips').on('click', '.chip', function () { L.chip = $(this).attr('data-f'); renderDesk(); });
    $('#hdTable').on('click', 'th.sortable', function () { sortBy($(this).attr('data-k')); });
    $('#hdTable').on('click', '.btn-start', function (e) {
      e.stopPropagation();
      startRow($(this).closest('tr').attr('data-id'));
    });
    // správca: клік по складу — картка справа; працівник: одразу термінал (іншої дії в нього немає)
    $('#hdTable').on('click', 'tbody tr', function () {
      var id = $(this).attr('data-id');
      if (isAdmin()) openDetail(id); else startRow(id);
    });
    // з клавіатури: Tab до рядка, Enter — як клік
    $('#hdTable').on('keydown', 'tbody tr', function (e) {
      if (e.key === 'Enter' && e.target === this) { e.preventDefault(); $(this).trigger('click'); }
    });

    if (global.MutationObserver) {
      var mo = new MutationObserver(syncNav);
      ['peopleModal', 'backupModal', 'logsModal'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
    }

    // Esc закриває картку складу — якщо поверх неї нічого не відкрито
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !L.current) return;
      if ($('#msgModal, #promptModal, #confirmModal, #editorModal, #logsModal, #importModal, #peopleModal, #personModal, #backupModal, #pwModal')
            .filter(':not(.hidden)').length) return;
      closeDetail();
    });
  });

  global.Sheets = {
    STATUS: STATUS,
    statusLabel: statusLabel,
    load: load, setBasic: setBasic, render: render, toggleArchived: toggleArchived,
    openDetail: openDetail, closeDetail: closeDetail, setStatus: setStatus, act: act,
    reset: function () {
      L.gen++;
      L.list = []; L.basic = []; L.loaded = false; L.error = ''; L.loading = null;
      L.current = null; L.showArchived = false; L.chip = 'current'; L.sort = { k: '', dir: 1 };
      $('#sheetModal').addClass('hidden');
      $('#shList, #hdTable, #hdChips').empty();
      $('#shSearch, #hdSearch').val('');
      $('#hdSub, #hdFoot').text('');
    }
  };
  global.Home = { go: go, syncNav: syncNav };

})(window);
