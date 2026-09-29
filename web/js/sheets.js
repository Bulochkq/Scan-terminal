/**
 * SHEETS.JS — склади в адміністрації: повний список і картка складу.
 * Остання зміна: v3.1.4 (див. PROGRESS.md у корені репо)
 *
 * Запит власника (29.09.2026): замість випадного списку «Sklad» в адмінці —
 * повний, зручний список складів: коли створений, стан, скільки пораховано,
 * коли і хто працював востаннє; перейменування, зміна стану і журнал САМЕ
 * цього складу. Усе для власника і správcu (база: api_sheets, api_sheet_update).
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

  var L = { list: [], showArchived: false, current: null };

  function esc(s) { return global.escapeHtml(s); }
  function errText(e) { return (e && e.message) ? e.message : String(e); }
  function fmt(n) { return Number(n || 0).toLocaleString('sk-SK'); }

  /** Скільки «зроблено»: та сама формула, що в «Prehľad» терміналу (надлишок не рахується). */
  function pct(s) {
    var plan = Number(s.plan) || 0;
    if (plan > 0) return Math.min(100, Math.round((Number(s.capped) || 0) / plan * 100));
    return (s.items && Number(s.real) > 0) ? 100 : 0;
  }

  /** 'DD.MM.YYYY HH:MI' → 'DD.MM. HH:MI' для короткого рядка. */
  function shortDate(t) { return t && t.length >= 16 ? t.slice(0, 6) + ' ' + t.slice(11, 16) : (t || ''); }

  function statusLabel(st) { return (STATUS[st] || {}).label || st || ''; }
  function statusPill(st) { return '<span class="st-pill st-' + esc(st) + '">' + esc(statusLabel(st)) + '</span>'; }

  function find(id) {
    for (var i = 0; i < L.list.length; i++) if (L.list[i].id === String(id)) return L.list[i];
    return null;
  }

  // ------------------------------------------------------------ список в адмінці

  function load() {
    if (!global.Auth.can('admin')) return Promise.resolve();
    if (!L.list.length) $('#shList').html(global.getLoaderHtml('Načítavam sklady…'));
    return global.API.sheets().then(function (res) {
      L.list = res.sheets || [];
      render();
      if (L.current) {
        var fresh = find(L.current.id);
        if (fresh) { L.current = fresh; fillDetail(); } else closeDetail();
      }
    }).catch(function (e) {
      if (e.isAuth) return;
      // PGRST202 = у базі ще немає функції api_sheets (не запущено 004_sheets_status.sql)
      var msg = e.code === 'PGRST202'
        ? 'Databáza ešte nie je aktualizovaná — v Supabase spustite súbor supabase/migrations/004_sheets_status.sql.'
        : errText(e);
      $('#shList').html('<div class="list-empty">' + esc(msg) + '</div>');
    });
  }

  function render() {
    var term = String($('#shSearch').val() || '').toLowerCase().trim();
    var all = L.list.slice().sort(function (a, b) {
      return ((ORDER[a.status] || 0) - (ORDER[b.status] || 0)) || a.name.localeCompare(b.name, 'sk');
    });
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

    var $l = $('#shList').empty();
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

  function toggleArchived() { L.showArchived = !L.showArchived; render(); }

  // ------------------------------------------------------------ картка складу

  function openDetail(id) {
    L.current = find(id);
    if (!L.current) return;
    fillDetail();
    $('#sheetModal').removeClass('hidden');
  }
  function closeDetail() { L.current = null; $('#sheetModal').addClass('hidden'); }

  function fillDetail() {
    var s = L.current;
    if (!s) return;
    var p = pct(s);
    $('#sdName').text(s.name);
    $('#sdCreated').text('Vytvorený ' + (s.created || '—'));
    $('#sdStatus button').removeClass('active').filter('[data-s="' + s.status + '"]').addClass('active');
    $('#sdStatusNote').text((STATUS[s.status] || {}).note || '');
    $('#sdItems').text(fmt(s.items));
    $('#sdDone').text(fmt(s.done));
    $('#sdPlan').text(fmt(s.plan));
    $('#sdReal').text(fmt(s.real));
    $('#sdBar').css('width', p + '%');
    $('#sdPct').text(p + ' %');
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

  global.Sheets = {
    STATUS: STATUS,
    statusLabel: statusLabel,
    load: load, render: render, toggleArchived: toggleArchived,
    openDetail: openDetail, closeDetail: closeDetail, setStatus: setStatus, act: act,
    reset: function () { L.list = []; L.current = null; L.showArchived = false; $('#shList').empty(); }
  };

})(window);
