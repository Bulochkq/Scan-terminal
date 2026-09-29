/**
 * EDITOR.JS — єдина табличка складу (Editor) і табличка журналу (LogView).
 * Остання зміна: v3.1.4 (див. PROGRESS.md у корені репо)
 *
 * v3.1.2: «Zoznam tovaru» і «Tabuľka skladu» об'єднано в ОДНУ таблицю.
 *  - За замовчуванням — ЛИШЕ ПЕРЕГЛЯД (замкнено): випадково нічого не змінити.
 *    Вибрати рядок кліком → «Skenovať» (як скан, +1), «Foto» (пошук фото),
 *    «Poznámka» (нотатка, як і на картці товару).
 *  - v3.1.4: нотатку можна змінити й прямо в таблиці (двоклік по клітинці) —
 *    будь-хто, хто увійшов, зокрема працівник; зберігається одразу (api_note).
 *  - «Upraviť» (лише správca / власник) вмикає режим як у Google Таблиці:
 *    двоклік = правка, Ctrl+C/V, Ctrl+Z, нові/видалені рядки. У базу — лише
 *    після «Uložiť zmeny», і лише змінені поля (api_items_save).
 *  - Якщо змінено Realita, разом з нею йде стара Realita (old_real). Якщо хтось
 *    у цей час сканував, база не перетре скан, а поверне конфлікт.
 *
 * Бібліотека Tabulator (MIT) вантажиться лише при першому відкритті.
 */
(function (global) {
  'use strict';

  var LIB_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.3.1/js/tabulator.min.js';
  var LIB_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.3.1/css/tabulator_simple.min.css';
  var SAVE_CHUNK = 300;

  var TEXT_FIELDS = ['brand', 'plu', 'name', 'code', 'ean', 'note'];
  var NUM_FIELDS  = ['plan', 'real'];
  var FIELDS = TEXT_FIELDS.concat(NUM_FIELDS);

  // ------------------------------------------------------------ бібліотека

  var libPromise = null;
  function ensureLib() {
    if (global.Tabulator) return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LIB_CSS;
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = LIB_JS; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { libPromise = null; reject(new Error('Nepodarilo sa načítať tabuľku. Skontrolujte pripojenie.')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function esc(v) { return global.escapeHtml(v); }
  function narrow() { return global.innerWidth < 760; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function plural(n, one, few, many) { return n === 1 ? one : (n >= 2 && n <= 4 ? few : many); }

  // =====================================================================
  //  ТАБЛИЦЯ ТОВАРІВ
  // =====================================================================

  var S = null;   // стан відкритої таблиці

  function isNewId(id) { return String(id).indexOf('new_') === 0; }

  function normVal(field, v) {
    if (NUM_FIELDS.indexOf(field) !== -1) {
      var n = parseInt(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'), 10);
      return isNaN(n) ? 0 : n;
    }
    return String(v == null ? '' : v).trim();
  }

  function isCellDirty(d, field) {
    if (isNewId(d.id)) return true;
    var o = S.orig[d.id];
    return !!o && normVal(field, d[field]) !== normVal(field, o[field]);
  }
  function isRowDirty(d) {
    if (isNewId(d.id)) return true;
    for (var i = 0; i < FIELDS.length; i++) if (isCellDirty(d, FIELDS[i])) return true;
    return false;
  }

  function toRow(r) {
    return { id: r.row, brand: r.brand || '', plu: r.plu || '', name: r.name || '', code: r.code || '',
             ean: r.ean || '', plan: Number(r.plan) || 0, real: Number(r.real) || 0, note: r.note || '' };
  }

  // ------------------------------------------------------------ колонки

  function textFormatter(cell) {
    var d = cell.getRow().getData();
    cell.getElement().classList.toggle('cell-dirty', S.unlocked && !isNewId(d.id) && isCellDirty(d, cell.getField()));
    return esc(cell.getValue());
  }
  function numMutator(v) {
    var n = parseInt(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'), 10);
    return isNaN(n) ? 0 : n;
  }
  function realMutator(v) { return Math.max(0, numMutator(v)); }
  function textMutator(v) { return String(v == null ? '' : v).trim(); }
  function diffOf(d) { return (Number(d.real) || 0) - (Number(d.plan) || 0); }

  function columns() {
    var edit = S.unlocked;
    var hideOnPhone = narrow();
    function txt(field, title, width, extra) {
      return Object.assign({
        title: title, field: field, width: width, formatter: textFormatter,
        editor: edit ? 'input' : false,
        mutatorEdit: textMutator, mutatorClipboard: textMutator
      }, extra || {});
    }
    function numCol(field, title, mut) {
      return {
        title: title, field: field, width: hideOnPhone ? 54 : (field === 'plan' ? 78 : 90),
        hozAlign: 'right', sorter: 'number', formatter: textFormatter,
        editor: edit ? 'number' : false, editorParams: { selectContents: true },
        mutatorEdit: mut, mutatorClipboard: mut
      };
    }
    return [
      txt('brand', 'Značka', 100, { visible: !hideOnPhone }),
      txt('plu', 'PLU', hideOnPhone ? 76 : 96),
      // на телефоні назва гнучка, щоб Plán / Realita / Rozdiel завжди були видні
      hideOnPhone ? txt('name', 'Názov', undefined, { widthGrow: 1, minWidth: 110 })
                  : txt('name', 'Názov', 280, { widthGrow: 3, minWidth: 160 }),
      txt('code', 'SKU', 118, { visible: !hideOnPhone }),
      txt('ean', 'EAN', 124, { visible: !hideOnPhone }),
      numCol('plan', 'Plán', numMutator),
      numCol('real', hideOnPhone ? 'Real' : 'Realita', realMutator),
      {
        title: hideOnPhone ? 'Rozd.' : 'Rozdiel', field: 'diff', width: hideOnPhone ? 54 : 90, hozAlign: 'right', editor: false,
        formatter: function (cell) {
          var v = diffOf(cell.getRow().getData());
          var el = cell.getElement();
          el.classList.toggle('diff-neg', v < 0);
          el.classList.toggle('diff-pos', v > 0);
          return (v > 0 ? '+' : '') + v;
        },
        sorter: function (a, b, aRow, bRow) { return diffOf(aRow.getData()) - diffOf(bRow.getData()); },
        accessorDownload: function (v, d) { return diffOf(d); }
      },
      // нотатку можна правити і в режимі перегляду (двоклік) — одразу в базу, див. saveNoteInline
      txt('note', 'Poznámka', 200, { widthGrow: 2, visible: !hideOnPhone || edit, editor: 'input' })
    ];
  }

  // ------------------------------------------------------------ фільтри

  function filterFn(d) {
    if (isNewId(d.id)) return true;
    var f = S.chip;
    if (f === 'miss'    && !(d.real < d.plan)) return false;
    if (f === 'extra'   && !(d.real > d.plan)) return false;
    if (f === 'done'    && !(d.real === d.plan)) return false;
    if (f === 'note'    && !String(d.note || '').trim()) return false;
    if (f === 'changed' && !(isRowDirty(d) || S.deleted[d.id])) return false;
    if (S.search) {
      var hay = (d.plu + ' ' + d.ean + ' ' + d.code + ' ' + d.name + ' ' + d.brand + ' ' + d.note).toLowerCase();
      if (hay.indexOf(S.search) === -1) return false;
    }
    return true;
  }
  function applyFilter() { if (S && S.table) S.table.setFilter(filterFn); }

  // ------------------------------------------------------------ зміни

  var countTimer = null;
  function scheduleCount() { clearTimeout(countTimer); countTimer = setTimeout(updateInfo, 150); }

  function collectChanges() {
    if (!S || !S.table || !S.unlocked) return { updates: [], inserts: [], deletes: [], problems: [], total: 0 };
    var data = S.table.getData();
    var ups = [], ins = [], dels = [], problems = [], pluCount = {};

    data.forEach(function (d) {
      if (S.deleted[d.id]) return;
      var p = normVal('plu', d.plu);
      if (p) pluCount[p] = (pluCount[p] || 0) + 1;
    });

    data.forEach(function (d) {
      if (S.deleted[d.id]) { if (!isNewId(d.id)) dels.push({ op: 'delete', id: d.id }); return; }
      var plu = normVal('plu', d.plu);
      if (isNewId(d.id)) {
        var fields = {};
        FIELDS.forEach(function (k) { fields[k] = normVal(k, d[k]); });
        if (!plu) problems.push('Nový riadok nemá PLU');
        else if (pluCount[plu] > 1) problems.push('PLU ' + plu + ' je v tabuľke viackrát');
        ins.push({ op: 'insert', tmp: d.id, fields: fields });
        return;
      }
      var o = S.orig[d.id], f = {}, n = 0;
      FIELDS.forEach(function (k) {
        var nv = normVal(k, d[k]);
        if (nv !== normVal(k, o[k])) { f[k] = nv; n++; }
      });
      if (!n) return;
      if ('plu' in f && !plu) problems.push('Riadok «' + (d.name || d.id) + '» nemá PLU');
      if ('plu' in f && plu && pluCount[plu] > 1) problems.push('PLU ' + plu + ' je v tabuľke viackrát');
      var ch = { op: 'update', id: d.id, fields: f };
      if ('real' in f) ch.old_real = normVal('real', o.real);
      ups.push(ch);
    });

    return { updates: ups, inserts: ins, deletes: dels, problems: problems, total: ups.length + ins.length + dels.length };
  }

  function updateInfo() {
    if (!S || !S.table) return;
    var c = collectChanges();
    S.changeCount = c.total;
    $('#edInfo').text('Zobrazené ' + S.table.getDataCount('active') + ' z ' + S.table.getDataCount() + ' riadkov');
    $('#edDirty').text(c.total + ' ' + plural(c.total, 'zmena', 'zmeny', 'zmien')).toggleClass('hidden', c.total === 0);
    $('#edSaveBtn').prop('disabled', c.total === 0);
  }

  function selectedRow() {
    if (!S || !S.table || S.unlocked) return null;
    var rows = S.table.getSelectedRows();
    return rows.length ? rows[0] : null;
  }

  function updateSelectionUI() {
    var row = selectedRow();
    $('#edSelInfo').text(row ? (row.getData().plu + ' · ' + row.getData().name) : 'Kliknite na riadok')
      .toggleClass('muted', !row);
    $('#edBtnScan, #edBtnPhoto, #edBtnNote').prop('disabled', !row);
  }

  function updateModeUI() {
    var ed = !!(S && S.unlocked);
    $('#editorModal').toggleClass('ed-mode-edit', ed);
    $('#edReadActions').toggleClass('hidden', ed);
    $('#edEditActions').toggleClass('hidden', !ed);
    $('#edEditBar').toggleClass('hidden', !ed);
    $('#edBtnScan').toggleClass('hidden', !(S && S.context === 'terminal'));
    // v3.1.3: правка й експорт — лише správca і власник (база однаково не дасть)
    $('#editorModal .ed-admin-only').toggleClass('hidden', !global.Auth.can('admin'));
    $('#edHint').text(ed
      ? 'Dvojklik = upraviť · Ctrl+C / Ctrl+V · Ctrl+Z = späť · Ctrl+S = uložiť · klik na číslo riadku = označiť riadky'
      : 'Klik na riadok = vybrať · dvojklik na poznámku = upraviť · Ctrl+C = kopírovať' +
        (global.Auth.can('admin') ? ' · ostatné úpravy: tlačidlo „Upraviť“' : ''));
    if (ed) $('#edDirty').removeClass('hidden'); else $('#edDirty').addClass('hidden');
    updateSelectionUI();
  }

  // ------------------------------------------------------------ побудова таблиці

  function build(data) {
    if (S.table) { try { S.table.destroy(); } catch (e) {} S.table = null; }
    $('#edTable').empty();

    var edit = S.unlocked;
    var opts = {
      data: data,
      index: 'id',
      height: '100%',
      layout: 'fitColumns',
      placeholder: 'Žiadne položky',
      columnDefaults: { headerSort: true, resizable: true, headerTooltip: true },
      columns: columns(),
      rowHeader: { resizable: false, frozen: true, width: narrow() ? 34 : 46, hozAlign: 'center', formatter: 'rownum',
                   cssClass: 'ed-rownum', headerSort: false, editor: false },
      rowFormatter: function (row) {
        var d = row.getData(), el = row.getElement();
        el.classList.toggle('row-deleted', !!S.deleted[d.id]);
        el.classList.toggle('row-new', isNewId(d.id));
        el.classList.toggle('row-dirty', S.unlocked && !isNewId(d.id) && isRowDirty(d));
      }
    };

    if (edit) {
      Object.assign(opts, {
        history: true,
        clipboard: true,
        clipboardCopyStyled: false,
        clipboardCopyConfig: { rowHeaders: false, columnHeaders: false },
        clipboardCopyRowRange: 'range',
        clipboardPasteParser: 'range',
        clipboardPasteAction: 'range',
        selectableRange: 1,
        selectableRangeColumns: false,
        selectableRangeRows: true,
        selectableRangeClearCells: false,
        editTriggerEvent: 'dblclick'
      });
    } else {
      // ПЕРЕГЛЯД: редагується лише нотатка (двоклік), вставка вимкнена, вибір одного рядка
      Object.assign(opts, {
        editTriggerEvent: 'dblclick',
        selectableRows: 1,
        clipboard: 'copy',
        clipboardCopyStyled: false,
        clipboardCopyConfig: { rowHeaders: false, columnHeaders: true },
        clipboardCopyRowRange: 'selected'
      });
    }

    S.table = new Tabulator('#edTable', opts);
    S.table.on('tableBuilt', function () { applyFilter(); updateInfo(); updateModeUI(); });
    S.table.on('rowSelectionChanged', function () { updateSelectionUI(); });
    S.table.on('cellEdited', function (cell) {
      if (!S.unlocked) { saveNoteInline(cell); return; }
      cell.getRow().reformat(); scheduleCount();
    });
    S.table.on('clipboardPasted', function (clip, rowData, rows) { (rows || []).forEach(function (r) { r.reformat(); }); scheduleCount(); });
    S.table.on('historyUndo', function (a, c) { reformatComponent(c); scheduleCount(); });
    S.table.on('historyRedo', function (a, c) { reformatComponent(c); scheduleCount(); });
    S.table.on('dataFiltered', function () { scheduleCount(); });
  }

  /**
   * v3.1.4: нотатка, змінена в режимі перегляду, зберігається одразу — так само,
   * як кнопкою «Poznámka» чи на картці товару (права — будь-хто, хто увійшов).
   * Не вдалось — повертаємо старий текст, щоб таблиця не показувала неправду.
   */
  function saveNoteInline(cell) {
    if (!S || cell.getField() !== 'note') return;
    var row = cell.getRow(), id = row.getData().id;
    var before = S.orig[id] ? String(S.orig[id].note || '') : '';
    var val = String(cell.getValue() == null ? '' : cell.getValue()).trim();
    if (val === before.trim()) return;
    cell.getElement().classList.add('cell-saving');
    API.note(id, val).then(function (res) {
      if (!S) return;
      if (S.orig[id]) S.orig[id].note = res.note;
      row.update({ note: res.note });
      markCell(row, 'cell-saved');
      if (typeof global.onListNote === 'function') global.onListNote(id, res.note);
    }).catch(function (e) {
      if (!S) return;
      row.update({ note: before });
      markCell(row, '');
      if (!e.isAuth) global.showMsg('Poznámka sa neuložila', e.message || String(e));
    });
  }
  function markCell(row, cls) {
    try {
      var el = row.getCell('note').getElement();
      el.classList.remove('cell-saving');
      if (!cls) return;
      el.classList.add(cls);
      setTimeout(function () { el.classList.remove(cls); }, 1400);
    } catch (e) {}
  }

  function reformatComponent(c) {
    try {
      if (c && typeof c.getRow === 'function') c.getRow().reformat();
      else if (c && typeof c.reformat === 'function') c.reformat();
    } catch (e) {}
  }

  function origData() { return S.order.map(function (id) { return Object.assign({}, S.orig[id]); }); }

  function setBase(rows) {
    S.orig = {}; S.order = []; S.deleted = {}; S.seq = 0;
    return rows.map(function (r) {
      var d = toRow(r);
      S.orig[d.id] = Object.assign({}, d);
      S.order.push(d.id);
      return d;
    });
  }

  // ------------------------------------------------------------ відкриття / закриття

  /**
   * opts: { sheetId, sheetName, worker, context: 'terminal'|'admin', rows? }
   * rows — уже завантажений склад терміналу (localDB): тоді відкривається миттєво.
   */
  function open(opts) {
    if (S) closeNow();
    S = { sheetId: opts.sheetId, sheetName: opts.sheetName, worker: opts.worker || 'Admin',
          context: opts.context || 'admin', table: null, unlocked: false, saved: false,
          orig: {}, order: [], deleted: {}, seq: 0, chip: 'all', search: '', changeCount: 0 };

    $('#edSheetName').text(opts.sheetName);
    $('#edSearch').val('');
    $('#edChips .chip').removeClass('active').filter('[data-f="all"]').addClass('active');
    $('#edInfo').text('');
    $('#editorModal').removeClass('hidden');
    updateModeUI();

    var ready = ensureLib();
    var dataP = (opts.rows && opts.rows.length)
      ? ready.then(function () { return opts.rows; })
      : (global.setAdminBusy(true, 'Načítavam tabuľku…'),
         ready.then(function () { return API.loadSheet(opts.sheetId); }).then(function (res) { return res.data; }));

    return dataP.then(function (rows) {
      global.setAdminBusy(false);
      if (!S) return;
      build(setBase(rows));
    }).catch(function (e) {
      global.setAdminBusy(false);
      closeNow();
      global.showMsg('Chyba', e.message || String(e));
    });
  }

  function closeNow() {
    var wasSaved = S && S.saved, ctx = S && S.context;
    try { if (S && S.table) S.table.destroy(); } catch (e) {}
    S = null;
    $('#edTable').empty();
    $('#editorModal').addClass('hidden').removeClass('ed-mode-edit');
    if (wasSaved && typeof global.onTableSaved === 'function') global.onTableSaved(ctx);
  }

  function close() {
    if (!S) { $('#editorModal').addClass('hidden'); return; }
    var c = collectChanges();
    if (!c.total) { closeNow(); return; }
    global.showConfirm('Zahodiť zmeny?', 'Máte ' + c.total + ' neuložených ' + plural(c.total, 'zmenu', 'zmeny', 'zmien') +
      '. Naozaj zatvoriť bez uloženia?', true).then(function (ok) { if (ok) closeNow(); });
  }

  // ------------------------------------------------------------ замок (Upraviť / Zamknúť)

  /** v3.1.3: замість PIN — роль. Замок лишається: правка вмикається свідомо, а не випадковим кліком. */
  function unlock() {
    if (!S || S.unlocked) return;
    if (!global.Auth.can('admin')) {
      global.showMsg('Úpravy', 'Upravovať tabuľku môže len správca alebo vlastník.');
      return;
    }
    S.unlocked = true;
    build(S.table ? S.table.getData() : origData());
  }

  function lock() {
    if (!S || !S.unlocked) return;
    var c = collectChanges();
    var doLock = function () { S.unlocked = false; build(origData()); };
    if (!c.total) { doLock(); return; }
    global.showConfirm('Zamknúť bez uloženia?', 'Máte ' + c.total + ' neuložených ' + plural(c.total, 'zmenu', 'zmeny', 'zmien') +
      '. Zmeny sa zahodia.', true).then(function (ok) { if (ok) doLock(); });
  }

  // ------------------------------------------------------------ дії режиму перегляду

  function scanSelected() {
    var row = selectedRow();
    if (!row || S.context !== 'terminal') return;
    var id = row.getData().id;
    closeNow();
    if (typeof global.scanFromList === 'function') global.scanFromList(id);
  }

  function photoSelected() {
    var row = selectedRow();
    if (!row) return;
    var d = row.getData();
    global.open('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent((d.name || '') + ' ' + (d.code || d.ean || '')), '_blank');
  }

  function noteSelected() {
    var row = selectedRow();
    if (!row) return;
    var d = row.getData();
    global.showPrompt('Poznámka — ' + d.name, 'Text poznámky…', d.note || '').then(function (text) {
      if (text === null || text === d.note) return;
      global.setAdminBusy(true, 'Ukladám poznámku…');
      return API.note(d.id, text).then(function (res) {
        global.setAdminBusy(false);
        if (!S) return;
        row.update({ note: res.note });
        if (S.orig[d.id]) S.orig[d.id].note = res.note;
        if (typeof global.onListNote === 'function') global.onListNote(d.id, res.note);
      });
    }).catch(function (e) { global.setAdminBusy(false); global.showMsg('Chyba', e.message || String(e)); });
  }

  // ------------------------------------------------------------ дії режиму правки

  function setChip(f) {
    if (!S) return;
    S.chip = f;
    $('#edChips .chip').removeClass('active').filter('[data-f="' + f + '"]').addClass('active');
    applyFilter();
  }

  var searchTimer = null;
  function onSearch(v) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { if (!S) return; S.search = String(v || '').toLowerCase().trim(); applyFilter(); }, 250);
  }

  function addRow() {
    if (!S || !S.table || !S.unlocked) return;
    var id = 'new_' + (++S.seq);
    S.table.addRow({ id: id, brand: '', plu: '', name: '', code: '', ean: '', plan: 0, real: 0, note: '' }, true)
      .then(function (row) {
        S.table.scrollToRow(row, 'top', false);
        scheduleCount();
        setTimeout(function () { try { row.getCell('plu').edit(); } catch (e) {} }, 50);
      });
  }

  function toggleDelete() {
    if (!S || !S.table || !S.unlocked) return;
    var rows = [], seen = {};
    (S.table.getRanges() || []).forEach(function (r) {
      (r.getRows() || []).forEach(function (row) {
        var id = row.getData().id;
        if (!seen[id]) { seen[id] = 1; rows.push(row); }
      });
    });
    if (!rows.length) {
      global.showMsg('Upozornenie', 'Najprv označte riadky — kliknite na číslo riadku vľavo (Shift = viac riadkov).');
      return;
    }
    var allDeleted = rows.every(function (r) { return S.deleted[r.getData().id]; });
    rows.forEach(function (row) {
      var id = row.getData().id;
      if (isNewId(id)) { row.delete(); return; }
      if (allDeleted) delete S.deleted[id]; else S.deleted[id] = true;
      row.reformat();
    });
    scheduleCount();
  }

  function undo() { if (S && S.table && S.unlocked) S.table.undo(); }

  function exportXlsx() {
    if (!S || !S.table) return;
    global.Importer.ensureXlsx().then(function () {
      S.table.download('xlsx', S.sheetName + '_' + stamp() + '.xlsx', { sheetName: 'Sklad' });
    }).catch(function (e) { global.showMsg('Chyba', e.message || String(e)); });
  }

  // ------------------------------------------------------------ збереження

  function save() {
    if (!S || !S.table || !S.unlocked) return;
    try { if (document.activeElement) document.activeElement.blur(); } catch (e) {}
    var c = collectChanges();
    if (!c.total) { global.showMsg('Upozornenie', 'Nie sú žiadne zmeny na uloženie.'); return; }
    if (c.problems.length) {
      global.showMsg('Nedá sa uložiť', c.problems.slice(0, 8).join('\n') +
        (c.problems.length > 8 ? '\n… a ďalšie (' + (c.problems.length - 8) + ')' : ''));
      return;
    }

    var text = 'Upravené: ' + c.updates.length + '\nNové: ' + c.inserts.length + '\nZmazané: ' + c.deletes.length +
      (c.deletes.length ? '\n\nPred zmazaním sa automaticky uloží záloha skladu — dá sa obnoviť v časti Zálohy.' : '');

    global.showConfirm('Uložiť zmeny?', text, c.deletes.length > 0).then(function (ok) {
      if (!ok) return;
      var all = c.updates.concat(c.inserts, c.deletes);
      var total = { updated: 0, inserted: 0, deleted: 0, conflicts: [], errors: [] };
      var i = 0;
      global.setAdminBusy(true, 'Ukladám zmeny…');

      function next() {
        if (i >= all.length) return Promise.resolve();
        return API.itemsSave(S.sheetId, all.slice(i, i + SAVE_CHUNK)).then(function (r) {
          total.updated += r.updated; total.inserted += r.inserted; total.deleted += r.deleted;
          total.conflicts = total.conflicts.concat(r.conflicts || []);
          total.errors = total.errors.concat(r.errors || []);
          i += SAVE_CHUNK;
          global.setAdminBusy(true, 'Ukladám zmeny… ' + Math.min(i, all.length) + ' / ' + all.length);
          return next();
        });
      }

      return next().then(function () {
        global.setAdminBusy(false);
        S.saved = true;
        reportResult(total);
        return reload();
      }).catch(function (e) {
        global.setAdminBusy(false);
        if (e.isAuth || !S) return;   // вхід втрачено — таблицю закрив екран входу
        S.saved = true;   // частина пачок могла вже зберегтись
        global.showMsg('Chyba pri ukladaní', (e.message || String(e)) +
          '\n\nTabuľka sa načíta znova zo servera — skontrolujte, čo sa uložilo.');
        return reload();
      });
    });
  }

  function reportResult(t) {
    var lines = ['Upravené: ' + t.updated + ' · Nové: ' + t.inserted + ' · Zmazané: ' + t.deleted];
    if (t.conflicts.length) {
      lines.push('', 'Realita sa u ' + t.conflicts.length + ' položiek medzitým zmenila skenovaním, preto sa NEPREPÍSALA:');
      t.conflicts.slice(0, 8).forEach(function (x) {
        lines.push('• ' + x.plu + ' — zadali ste ' + x.yours + ', videli ste ' + x.seen + ', v sklade je teraz ' + x.actual);
      });
      lines.push('Ak má platiť vaša hodnota, zadajte ju znova a uložte.');
    }
    if (t.errors.length) {
      lines.push('', 'Neuložené riadky (' + t.errors.length + '):');
      t.errors.slice(0, 8).forEach(function (x) { lines.push('• ' + (x.plu || '?') + ' — ' + x.msg); });
    }
    global.showMsg(t.conflicts.length || t.errors.length ? 'Uložené s upozornením' : 'Uložené', lines.join('\n'));
  }

  /** Перечитати з бази — після збереження саме це і є правда. Режим правки лишається. */
  function reload() {
    if (!S) return Promise.resolve();
    var sheetId = S.sheetId;
    global.setAdminBusy(true, 'Načítavam tabuľku…');
    return API.loadSheet(sheetId).then(function (res) {
      global.setAdminBusy(false);
      if (!S || S.sheetId !== sheetId) return;
      var data = setBase(res.data);
      return S.table.replaceData(data).then(function () {
        if (S.unlocked) S.table.clearHistory();
        applyFilter(); updateInfo();
      });
    }).catch(function (e) { global.setAdminBusy(false); global.showMsg('Chyba', e.message || String(e)); });
  }

  // =====================================================================
  //  ТАБЛИЦЯ ЖУРНАЛУ (História)
  // =====================================================================

  var L = null;

  var ACTIONS = {
    'SKEN':       { label: 'Sken',          cls: 'act-scan',  group: 'scan' },
    'MANUÁL':     { label: 'Ručne',         cls: 'act-man',   group: 'manual' },
    'ÚPRAVA':     { label: 'Úprava',        cls: 'act-edit',  group: 'edit' },
    'ADMIN_EDIT': { label: 'Úprava',        cls: 'act-edit',  group: 'edit' },
    'ADMIN_ADD':  { label: 'Nová položka',  cls: 'act-edit',  group: 'edit' },
    'ADMIN_DEL':  { label: 'Zmazaná',       cls: 'act-del',   group: 'edit' },
    'POZNÁMKA':   { label: 'Poznámka',      cls: 'act-note',  group: 'note' },
    'IMPORT':     { label: 'Import',        cls: 'act-sys',   group: 'system' },
    'DELETE':     { label: 'Zmazaný sklad', cls: 'act-del',   group: 'system' },
    'CLEAR':      { label: 'Vymazanie',     cls: 'act-sys',   group: 'system' },
    'ÚČET':       { label: 'Účet',          cls: 'act-sys',   group: 'system' },   // v3.1.3: люди і ролі
    'SKLAD':      { label: 'Sklad',         cls: 'act-sys',   group: 'system' }    // v3.1.4: назва / стан складу
  };
  function actInfo(a) { return ACTIONS[a] || { label: a, cls: 'act-sys', group: 'system' }; }

  function logColumns(showSheet) {
    var phone = narrow();
    function t(field, title, width, extra) {
      return Object.assign({ title: title, field: field, width: width, formatter: function (c) { return esc(c.getValue()); } }, extra || {});
    }
    return [
      t('time', 'Čas', 142, { sorter: function (a, b, ar, br) { return ar.getData().id - br.getData().id; } }),
      t('sheet', 'Sklad', 110, { visible: showSheet && !phone }),
      t('plu', 'PLU', 92),
      t('name', 'Názov tovaru', 260, { widthGrow: 3, minWidth: 150 }),
      t('code', 'SKU', 110, { visible: !phone }),
      t('ean', 'EAN', 118, { visible: !phone }),
      {
        title: 'Akcia', field: 'action', width: 104,
        formatter: function (c) { var i = actInfo(c.getValue()); return '<span class="act-pill ' + i.cls + '">' + esc(i.label) + '</span>'; },
        accessorDownload: function (v) { return actInfo(v).label; }
      },
      t('worker', 'Pracovník', 100),
      t('oldVal', 'Bolo', 90, { hozAlign: 'right', tooltip: true }),
      t('newVal', 'Je', 90, { hozAlign: 'right', tooltip: true })
    ];
  }

  function logFilter(d) {
    if (L.chip !== 'all' && actInfo(d.action).group !== L.chip) return false;
    if (L.search) {
      var hay = (d.plu + ' ' + d.ean + ' ' + d.code + ' ' + d.name + ' ' + d.worker + ' ' + d.sheet + ' ' + d.time).toLowerCase();
      if (hay.indexOf(L.search) === -1) return false;
    }
    return true;
  }

  /**
   * opts: { admin: bool, sheetId?, sheetName? }
   *   admin без sheetId — журнал усіх складів (Správca+);
   *   admin із sheetId  — повний журнал ОДНОГО складу (v3.1.4, з картки складу);
   *   не admin          — останні 1000 записів поточного складу (термінал).
   * «Vymazať históriu» стирає ВЕСЬ журнал, тому кнопка є лише в загальному
   * журналі і лише у власника (v3.1.4).
   */
  function openLogs(opts) {
    L = { admin: !!opts.admin, sheetId: opts.sheetId, sheetName: opts.sheetName, chip: 'all', search: '', table: null };
    L.all = L.admin && !L.sheetId;
    $('#lgSheetName').text(L.all ? 'Všetky sklady' : (opts.sheetName || '—'));
    $('#lgSearch').val('');
    $('#lgChips .chip').removeClass('active').filter('[data-f="all"]').addClass('active');
    $('#lgClearBtn').toggleClass('hidden', !(L.all && global.Auth.can('owner')));
    $('#logsModal').removeClass('hidden');
    return loadLogs();
  }

  function loadLogs() {
    if (!L) return Promise.resolve();
    global.setAdminBusy(true, 'Načítavam históriu…');
    var p = L.admin
      ? API.logsAll(L.sheetId).then(function (res) {
          return (res.data || []).map(function (a) {
            var o = {}; res.cols.forEach(function (c, i) { o[c] = a[i]; }); return o;
          });
        })
      : API.logs(L.sheetId).then(function (res) {
          return (res.logs || []).map(function (x, i) {
            return { id: 1e9 - i, time: x.time, sheet: L.sheetName, plu: x.plu, name: x.name, code: x.mpn,
                     ean: x.ean, action: x.action, worker: x.user, oldVal: x.oldVal, newVal: x.newVal };
          });
        });

    return Promise.all([ensureLib(), p]).then(function (r) {
      global.setAdminBusy(false);
      if (!L) return;
      var rows = r[1];
      if (L.table) { return L.table.replaceData(rows).then(function () { L.table.setFilter(logFilter); logInfo(); }); }
      L.table = new Tabulator('#lgTable', {
        data: rows, index: 'id', height: '100%', layout: 'fitColumns',
        placeholder: 'Zatiaľ žiadne záznamy',
        columns: logColumns(L.all),
        columnDefaults: { headerSort: true, resizable: true, headerTooltip: true },
        selectableRange: 1, selectableRangeColumns: false, selectableRangeRows: false,
        clipboard: 'copy', clipboardCopyStyled: false, clipboardCopyRowRange: 'range',
        clipboardCopyConfig: { rowHeaders: false, columnHeaders: false }
      });
      L.table.on('tableBuilt', function () { L.table.setFilter(logFilter); logInfo(); });
      L.table.on('dataFiltered', function () { setTimeout(logInfo, 0); });
    }).catch(function (e) {
      global.setAdminBusy(false);
      global.showMsg('Chyba', e.message || String(e));
    });
  }

  function logInfo() {
    if (!L || !L.table) return;
    $('#lgInfo').text('Zobrazené ' + L.table.getDataCount('active') + ' z ' + L.table.getDataCount() + ' záznamov' +
      (L.admin ? '' : ' (posledných 1000 pre tento sklad)'));
  }

  function logChip(f) {
    if (!L) return;
    L.chip = f;
    $('#lgChips .chip').removeClass('active').filter('[data-f="' + f + '"]').addClass('active');
    if (L.table) L.table.setFilter(logFilter);
  }
  var lgTimer = null;
  function logSearch(v) {
    clearTimeout(lgTimer);
    lgTimer = setTimeout(function () { if (!L) return; L.search = String(v || '').toLowerCase().trim(); if (L.table) L.table.setFilter(logFilter); }, 250);
  }
  function logExport() {
    if (!L || !L.table) return;
    global.Importer.ensureXlsx().then(function () {
      L.table.download('xlsx', 'Historia_' + (L.all ? 'vsetky_sklady' : L.sheetName) + '_' + stamp() + '.xlsx', { sheetName: 'História' });
    }).catch(function (e) { global.showMsg('Chyba', e.message || String(e)); });
  }
  function closeLogs() {
    try { if (L && L.table) L.table.destroy(); } catch (e) {}
    L = null;
    $('#lgTable').empty();
    $('#logsModal').addClass('hidden');
  }

  // ------------------------------------------------------------ клавіатура

  document.addEventListener('keydown', function (e) {
    if (S && S.unlocked && (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
  });
  global.addEventListener('beforeunload', function (e) {
    if (S && S.unlocked && S.changeCount > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  global.Editor = {
    open: open, close: close, closeNow: closeNow, save: save, addRow: addRow, toggleDelete: toggleDelete, undo: undo,
    exportXlsx: exportXlsx, setChip: setChip, onSearch: onSearch, isOpen: function () { return !!S; },
    unlock: unlock, lock: lock, scanSelected: scanSelected, photoSelected: photoSelected, noteSelected: noteSelected
  };
  global.LogView = {
    open: openLogs, close: closeLogs, reload: loadLogs, setChip: logChip, onSearch: logSearch, exportXlsx: logExport,
    actionLabel: function (a) { return actInfo(a).label; }
  };

})(window);
