/**
 * IMPORTER.JS — читання PDF та Excel у браузері.
 *
 * Саме заради цього файлу фронтенд і виноситься з Apps Script: там PDF
 * прочитати нічим. Обидва формати зводяться до однієї 2D-сітки, далі йде
 * спільний код зіставлення колонок.
 *
 * ВАЖЛИВО: працює з PDF, згенерованими системою (у них є текстовий шар).
 * Відсканований або сфотографований PDF тексту не містить — там потрібен OCR,
 * якого тут навмисно немає, бо на цифрах він помиляється.
 */
(function (global) {
  'use strict';

  // --------------------------------------------- ліниве завантаження бібліотек

  var LIBS = {
    xlsx: 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js',
    pdf:  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  };

  var loaded = {};

  function loadScript(url) {
    if (loaded[url]) return loaded[url];
    loaded[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () {
        loaded[url] = null;
        reject(new Error('Nepodarilo sa načítať knižnicu. Skontrolujte pripojenie k internetu.'));
      };
      document.head.appendChild(s);
    });
    return loaded[url];
  }

  /** SheetJS потрібен і для імпорту Excel, і для експорту XLSX. */
  function ensureXlsx() {
    if (global.XLSX) return Promise.resolve();
    return loadScript(LIBS.xlsx);
  }

  function ensurePdf() {
    if (global.pdfjsLib) return Promise.resolve();
    return loadScript(LIBS.pdf).then(function () {
      if (global.pdfjsLib) {
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
      }
    });
  }

  var FIELDS = [
    { key: 'plu',   label: 'PLU / Kód karty', required: true,
      hints: ['kód karty', 'kod karty', 'plu', 'kód', 'code'] },
    { key: 'name',  label: 'Názov', required: true,
      hints: ['názov karty', 'nazov karty', 'názov', 'nazov', 'name', 'popis'] },
    { key: 'ean',   label: 'EAN', required: false,
      hints: ['čiarový kód', 'ciarovy kod', 'ean', 'barcode'] },
    { key: 'code',  label: 'SKU', required: false,
      hints: ['kód používaný výrobcom', 'kod pouzivany vyrobcom', 'sku', 'mpn', 'výrobca'] },
    { key: 'plan',  label: 'Plán (množstvo)', required: false,
      hints: ['disponibilný stav', 'disponibiln', 'plán', 'plan', 'množstvo', 'mnozstvo', 'qty', 'stav'] },
    { key: 'brand', label: 'Značka', required: false,
      hints: ['obchodný typ', 'obchodny typ', 'značka', 'znacka', 'brand'] }
  ];

  var state = {
    grid: [],          // усі рядки файлу
    headerRow: -1,
    mapping: {},       // key -> індекс колонки (-1 = не використовується)
    fileName: '',
    parsed: []
  };

  // ------------------------------------------------------------ утиліти

  function norm(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function toNumber(v) {
    if (v == null || v === '') return 0;
    var s = String(v).replace(/ /g, '').replace(/\s/g, '').replace(',', '.');
    s = s.replace(/[^0-9.\-]/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : Math.floor(n);
  }

  // --------------------------------------------------- читання Excel/CSV

  function readSpreadsheet(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Súbor sa nepodarilo prečítať.')); };
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
          resolve(grid.map(function (r) { return r.map(function (c) { return String(c == null ? '' : c); }); }));
        } catch (err) {
          reject(new Error('Neplatný Excel súbor: ' + err.message));
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // -------------------------------------------------------- читання PDF

  function readPdf(file) {
    return file.arrayBuffer()
      .then(function (buf) { return pdfjsLib.getDocument({ data: buf }).promise; })
      .then(function (pdf) {
        var pages = [];
        for (var i = 1; i <= pdf.numPages; i++) pages.push(i);

        return pages.reduce(function (chain, num) {
          return chain.then(function (acc) {
            return pdf.getPage(num)
              .then(function (page) { return page.getTextContent(); })
              .then(function (tc) {
                tc.items.forEach(function (it) {
                  var s = String(it.str || '');
                  if (!s.trim()) return;
                  acc.push({
                    page: num,
                    x: Math.round(it.transform[4]),
                    y: Math.round(it.transform[5]),
                    str: s
                  });
                });
                return acc;
              });
          });
        }, Promise.resolve([]));
      })
      .then(function (items) {
        if (!items.length) {
          throw new Error(
            'V PDF sa nenašiel žiadny text. Pravdepodobne ide o sken alebo fotku — ' +
            'taký súbor sa načítať nedá. Použite prosím Excel alebo CSV export.'
          );
        }
        return itemsToGrid(items);
      });
  }

  /** Групує фрагменти тексту в рядки за координатою Y, потім у колонки за X. */
  function itemsToGrid(items) {
    // 1. рядки: однакова сторінка + близький Y
    items.sort(function (a, b) {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(a.y - b.y) > 3) return b.y - a.y;  // PDF: Y росте вгору
      return a.x - b.x;
    });

    var lines = [];
    var cur = null;
    items.forEach(function (it) {
      if (!cur || cur.page !== it.page || Math.abs(cur.y - it.y) > 3) {
        cur = { page: it.page, y: it.y, cells: [] };
        lines.push(cur);
      }
      cur.cells.push(it);
    });

    // 2. глобальні межі колонок — кластеризація позицій X
    var xs = [];
    lines.forEach(function (l) { l.cells.forEach(function (c) { xs.push(c.x); }); });
    xs.sort(function (a, b) { return a - b; });

    var centers = [];
    var group = [];
    for (var i = 0; i < xs.length; i++) {
      if (group.length && xs[i] - group[group.length - 1] > 12) {
        centers.push(group.reduce(function (s, v) { return s + v; }, 0) / group.length);
        group = [];
      }
      group.push(xs[i]);
    }
    if (group.length) centers.push(group.reduce(function (s, v) { return s + v; }, 0) / group.length);

    if (!centers.length) return [];

    // 3. розкладаємо кожен рядок по колонках
    return lines.map(function (l) {
      var row = new Array(centers.length).fill('');
      l.cells.forEach(function (c) {
        var best = 0, bestD = Infinity;
        for (var j = 0; j < centers.length; j++) {
          var d = Math.abs(centers[j] - c.x);
          if (d < bestD) { bestD = d; best = j; }
        }
        row[best] = row[best] ? (row[best] + ' ' + c.str.trim()) : c.str.trim();
      });
      return row;
    }).filter(function (r) {
      return r.some(function (c) { return c && c.trim() !== ''; });
    });
  }

  // ------------------------------------------- пошук заголовка і мапінгу

  function detectHeader(grid) {
    var limit = Math.min(grid.length, 30);
    var best = { row: -1, score: 0 };

    for (var r = 0; r < limit; r++) {
      var cells = grid[r].map(norm);
      var score = 0;
      FIELDS.forEach(function (f) {
        for (var h = 0; h < f.hints.length; h++) {
          if (cells.some(function (c) { return c && c.indexOf(f.hints[h]) !== -1; })) {
            score += f.required ? 2 : 1;
            break;
          }
        }
      });
      if (score > best.score) best = { row: r, score: score };
    }
    return best.score >= 3 ? best.row : -1;
  }

  function autoMap(headerCells) {
    var cells = headerCells.map(norm);
    var map = {};
    FIELDS.forEach(function (f) {
      map[f.key] = -1;
      for (var h = 0; h < f.hints.length && map[f.key] === -1; h++) {
        for (var i = 0; i < cells.length; i++) {
          if (cells[i] && cells[i].indexOf(f.hints[h]) !== -1) { map[f.key] = i; break; }
        }
      }
    });
    return map;
  }

  function templateKey(headerCells) {
    return 'impTpl_' + norm(headerCells.join('|')).slice(0, 120);
  }

  function loadTemplate(headerCells) {
    try {
      var raw = localStorage.getItem(templateKey(headerCells));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveTemplate(headerCells, map) {
    try { localStorage.setItem(templateKey(headerCells), JSON.stringify(map)); } catch (e) {}
  }

  // ------------------------------------------------------------- UI

  function onFilePicked(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    handleFile(file);
    input.value = '';
  }

  function handleFile(file) {
    state.fileName = file.name;
    var isPdf = /\.pdf$/i.test(file.name);

    setAdminBusy(true, 'NAČÍTAVAM KNIŽNICU...');

    var ready = isPdf ? ensurePdf() : ensureXlsx();

    ready
      .then(function () {
        setAdminBusy(true, 'ČÍTAM SÚBOR...');
        return isPdf ? readPdf(file) : readSpreadsheet(file);
      })
      .then(function (grid) {
        setAdminBusy(false);
        if (!grid || !grid.length) throw new Error('Súbor je prázdny.');

        state.grid = grid;
        state.headerRow = detectHeader(grid);

        if (state.headerRow === -1) {
          state.headerRow = 0;
          showMsg('Pozor', 'Hlavičku sa nepodarilo rozpoznať automaticky. Skontrolujte prosím priradenie stĺpcov ručne.');
        }

        var header = grid[state.headerRow] || [];
        state.mapping = loadTemplate(header) || autoMap(header);

        renderMapping();
        $('#impStepMap, #impStepGo').removeClass('hidden');
        updatePreview();
      })
      .catch(function (err) {
        setAdminBusy(false);
        showMsg('Chyba súboru', err.message || String(err));
      });
  }

  function renderMapping() {
    var header = state.grid[state.headerRow] || [];
    var colCount = state.grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);

    var $grid = $('#impMapGrid').empty();

    FIELDS.forEach(function (f) {
      var opts = ['<option value="-1">— nepoužiť —</option>'];
      for (var i = 0; i < colCount; i++) {
        var label = (header[i] && String(header[i]).trim()) ? header[i] : ('Stĺpec ' + (i + 1));
        opts.push('<option value="' + i + '"' + (state.mapping[f.key] === i ? ' selected' : '') + '>' +
                  escapeHtml(String(label).slice(0, 40)) + '</option>');
      }
      var ok = state.mapping[f.key] > -1;
      $grid.append(
        '<div class="imp-map-field ' + (f.required ? 'req ' : '') + (ok ? 'ok' : '') + '">' +
        '<div class="ed-label">' + escapeHtml(f.label) + (f.required ? ' *' : '') + '</div>' +
        '<select data-field="' + f.key + '">' + opts.join('') + '</select>' +
        '</div>'
      );
    });

    $grid.find('select').on('change', function () {
      state.mapping[$(this).data('field')] = parseInt($(this).val(), 10);
      renderMapping();
      updatePreview();
    });
  }

  function buildRows() {
    var m = state.mapping;
    var out = [];
    var brandRe = /\[(.*?)\]/;

    for (var r = state.headerRow + 1; r < state.grid.length; r++) {
      var row = state.grid[r];
      if (!row) continue;

      var plu = m.plu > -1 ? String(row[m.plu] == null ? '' : row[m.plu]).trim() : '';
      if (!plu) continue;

      var brand = m.brand > -1 ? String(row[m.brand] || '').trim() : '';
      var bm = brand.match(brandRe);
      if (bm && bm[1]) brand = bm[1];

      out.push({
        plu:   plu,
        name:  m.name  > -1 ? String(row[m.name]  || '').trim() : '',
        ean:   m.ean   > -1 ? String(row[m.ean]   || '').trim() : '',
        code:  m.code  > -1 ? String(row[m.code]  || '').trim() : '',
        plan:  m.plan  > -1 ? toNumber(row[m.plan]) : 0,
        brand: brand
      });
    }
    return out;
  }

  function updatePreview() {
    var rows = buildRows();
    state.parsed = rows;

    // таблиця попереднього перегляду
    var head = '<tr><th>PLU</th><th>Názov</th><th>EAN</th><th>SKU</th><th>Plán</th><th>Značka</th></tr>';
    $('#impPreviewHead').html(head);

    var body = rows.slice(0, 15).map(function (r) {
      return '<tr><td>' + escapeHtml(r.plu) + '</td><td>' + escapeHtml(r.name) + '</td>' +
             '<td>' + escapeHtml(r.ean) + '</td><td>' + escapeHtml(r.code) + '</td>' +
             '<td>' + r.plan + '</td><td>' + escapeHtml(r.brand) + '</td></tr>';
    }).join('');
    $('#impPreviewBody').html(body || '<tr><td colspan="6">Žiadne riadky</td></tr>');

    // зведення
    var seen = {}, dup = 0, noName = 0, noPlan = 0;
    rows.forEach(function (r) {
      if (seen[r.plu]) dup++; else seen[r.plu] = true;
      if (!r.name) noName++;
      if (!r.plan) noPlan++;
    });

    var chips = [
      '<div class="imp-chip good">✔ Riadkov: ' + rows.length + '</div>',
      '<div class="imp-chip">📄 ' + escapeHtml(state.fileName) + '</div>'
    ];
    if (dup)    chips.push('<div class="imp-chip warn">⚠ Duplicitné PLU: ' + dup + ' (ponechá sa prvé)</div>');
    if (noName) chips.push('<div class="imp-chip warn">⚠ Bez názvu: ' + noName + '</div>');
    if (noPlan) chips.push('<div class="imp-chip">ℹ Plán = 0: ' + noPlan + '</div>');
    if (!rows.length) chips.push('<div class="imp-chip bad">✖ Skontrolujte priradenie stĺpcov</div>');

    $('#impFileInfo').removeClass('hidden').html(chips.slice(1).join(''));
    $('#impSummary').html(chips.join(''));
  }

  function run() {
    if (!state.parsed.length) { showMsg('Info', 'Nie je čo importovať — skontrolujte priradenie stĺpcov.'); return; }
    if (state.mapping.plu === -1) { showMsg('Info', 'Stĺpec PLU je povinný.'); return; }

    var sheetId = $('#importSheetSelect').val();
    if (!sheetId) { showMsg('Info', 'Najprv vyberte sklad.'); return; }

    var keepReal = $('#impKeepReal').is(':checked');
    var mode = keepReal ? 'merge' : 'replace';
    var warn = keepReal
      ? 'Zoznam tovaru sa nahradí, ale už naskenované množstvá zostanú zachované.'
      : '⚠️ VŠETKY dáta v sklade vrátane naskenovaných množstiev sa nahradia!';

    showConfirm('Importovať ' + state.parsed.length + ' položiek?', warn, !keepReal).then(function (ok) {
      if (!ok) return;
      return ensurePin().then(function (pin) {
        if (!pin) return;
        saveTemplate(state.grid[state.headerRow] || [], state.mapping);
        setAdminBusy(true, 'IMPORTUJEM ' + state.parsed.length + ' POLOŽIEK...');

        return API.importRows(sheetId, state.parsed, mode, pin)
          .then(function (res) {
            setAdminBusy(false);
            var msg = res.msg;
            if (res.duplicateCount) {
              msg += '\n\n⚠️ Preskočené duplicitné PLU: ' + res.duplicateCount;
              if (res.duplicates && res.duplicates.length) {
                msg += '\n(' + res.duplicates.slice(0, 10).join(', ') + ')';
              }
            }
            if (res.backup) msg += '\n\nZáloha: ' + res.backup;
            closeImport();
            showMsg('Import hotový', msg);
            refreshSheetList();
          })
          .catch(function (err) {
            setAdminBusy(false);
            showMsg('Chyba importu', err.message || String(err));
          });
      });
    });
  }

  function reset() {
    state = { grid: [], headerRow: -1, mapping: {}, fileName: '', parsed: [] };
    $('#impStepMap, #impStepGo').addClass('hidden');
    $('#impFileInfo').addClass('hidden').empty();
    $('#impMapGrid').empty();
    $('#impPreviewHead, #impPreviewBody').empty();
    $('#impKeepReal').prop('checked', false);
  }

  // drag & drop
  $(function () {
    var $drop = $('#impDrop');
    if (!$drop.length) return;
    ['dragenter', 'dragover'].forEach(function (ev) {
      $drop.on(ev, function (e) { e.preventDefault(); e.stopPropagation(); $drop.addClass('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      $drop.on(ev, function (e) { e.preventDefault(); e.stopPropagation(); $drop.removeClass('dragover'); });
    });
    $drop.on('drop', function (e) {
      var f = e.originalEvent.dataTransfer.files[0];
      if (f) handleFile(f);
    });
  });

  global.Importer = {
    onFilePicked: onFilePicked,
    handleFile: handleFile,
    run: run,
    reset: reset,
    ensureXlsx: ensureXlsx      // потрібен також для експорту XLSX в app.js
  };

})(window);
