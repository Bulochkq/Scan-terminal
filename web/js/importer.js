/**
 * IMPORTER.JS — читання PDF та Excel у браузері.
 * Остання зміна: v3.1.6 (точні числа й коди з Excel/CSV, «Plán spolu» у зведенні)
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
    grid: [],          // усі рядки файлу — текстом, як їх видно в Excel
    vals: [],          // ті самі клітинки «як є»: у Excel число лишається числом (v3.1.6)
    headerRow: -1,
    mapping: {},       // key -> індекс колонки (-1 = не використовується)
    fileName: '',
    parsed: []
  };

  // ------------------------------------------------------------ утиліти

  function norm(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /*
   * ВИПРАВЛЕНО (v3.1.6): план ≥ 1000 з Excel ламався. SheetJS з raw:false віддає
   * число так, як його показує формат клітинки: 1234 з форматом «#,##0» → «1,234»,
   * а старий toNumber міняв кому на крапку і брав 1,234 → 1 (так само «1.234,00» → 1).
   * Тепер з Excel береться саме число з клітинки (cellQty), а текст — CSV, PDF,
   * текстові клітинки — розбирається з урахуванням роздільників усієї колонки.
   */

  /** Прибирає роздільники тисяч-пробіли (звичайні й нерозривні) та апостроф («1'234»). */
  function squeeze(v) { return String(v == null ? '' : v).replace(/[\s  ']/g, ''); }

  /** Ціле число штук; округлення до тисячних спершу — щоб 2.9999999 з формули Excel не став 2. */
  function floorQty(n) { return Math.floor(Math.round(n * 1000) / 1000); }

  /**
   * Який знак у колонці десятковий — кома чи крапка. Одне число часто не скаже
   * («1,234» — це 1234 чи 1,234?), тому дивимось на всю колонку:
   *  — є і крапка, і кома → десятковий той, що правіше («1.234,50»);
   *  — знак повторюється («1,234,567») → це тисячі;
   *  — після знака не 3 цифри («12,5», «3,00»), перед ним 0 чи понад 3 цифри → десятковий;
   *  — лишились тільки «x,xxx»: якщо в колонці є й числа без знака — це тисячі
   *    (десяткові формат ставить у КОЖНЕ число, тисячі — лише в ≥ 1000),
   *    інакше — десятковий (ERP пише «5,000» = 5 штук).
   */
  function detectDecimal(texts) {
    var vote = { ',': 0, '.': 0 }, amb = { ',': 0, '.': 0 }, plain = 0;
    texts.forEach(function (t) {
      var s = squeeze(t).replace(/^[-+]|-$/g, '');
      if (!/\d/.test(s)) return;
      var nc = (s.match(/,/g) || []).length, nd = (s.match(/\./g) || []).length;
      if (nc && nd) { vote[s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.']++; return; }
      if (!nc && !nd) { plain++; return; }
      var sep = nc ? ',' : '.';
      if (nc > 1 || nd > 1) { vote[nc ? '.' : ',']++; return; }
      var parts = s.split(sep);
      if (parts[1].length !== 3 || !parts[0] || /^0+$/.test(parts[0]) || parts[0].length > 3) vote[sep]++;
      else amb[sep]++;
    });
    if (vote[','] !== vote['.']) return vote[','] > vote['.'] ? ',' : '.';
    var a = amb[','] >= amb['.'] ? ',' : '.';
    if (!amb[a]) return ',';                            // лише цілі числа — знак не важливий
    return plain ? (a === ',' ? '.' : ',') : a;
  }

  /** Кількість з тексту; dec — десятковий знак колонки (detectDecimal). */
  function parseQty(text, dec) {
    var s = squeeze(text);
    if (!/\d/.test(s)) return 0;
    var neg = /^-/.test(s) || /-$/.test(s);
    s = s.replace(/[^0-9.,]/g, '');
    var nc = (s.match(/,/g) || []).length, nd = (s.match(/\./g) || []).length;
    var d = dec || ',';
    if (nc && nd) d = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';   // саме число каже точно
    else if (nc > 1) d = '.';
    else if (nd > 1) d = ',';
    s = s.split(d === ',' ? '.' : ',').join('').replace(d, '.');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : floorQty(neg ? -n : n);
  }

  function textAt(r, c) {
    var row = state.grid[r];
    return String(row && row[c] != null ? row[c] : '').trim();
  }
  function rawAt(r, c) {
    var row = state.vals[r];
    return row ? row[c] : undefined;
  }

  /** Кількість з клітинки: число з Excel — як є, текст — через parseQty. */
  function cellQty(r, c, dec) {
    var raw = rawAt(r, c);
    if (typeof raw === 'number' && isFinite(raw)) return floorQty(raw);
    return parseQty(textAt(r, c), dec);
  }

  /**
   * ВИПРАВЛЕНО (v3.1.6): код (PLU, EAN, SKU), записаний в Excel ЧИСЛОМ, SheetJS
   * показував як «8.59E+12» (формат General) — такий EAN ніколи не збігся б зі
   * сканом. Для числа беремо всі цифри; текст лише з цифр (напр. «0012345» з
   * форматом «0000000») лишаємо як є — разом з нулями на початку.
   */
  function cellCode(r, c) {
    var text = textAt(r, c), raw = rawAt(r, c);
    if (typeof raw === 'number' && isFinite(raw) && Math.floor(raw) === raw && !/^\d+$/.test(text)) return String(raw);
    return text;
  }

  // --------------------------------------------------- читання Excel/CSV

  /** Повертає { grid: текст клітинок, vals: клітинки «як є» } — див. state. */
  function readSpreadsheet(file) {
    // v3.1.6: CSV — raw:true, тобто SheetJS нічого не розбирає сам: інакше він
    // читає числа по-англійськи («1.234,00» → 1.234, «12,5» → 125). Числа з CSV
    // розбирає parseQty, а коди лишаються текстом як у файлі (з нулями на початку).
    var isText = /\.(csv|txt)$/i.test(file.name);
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Súbor sa nepodarilo prečítať.')); };
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', raw: isText });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
          var vals = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
          resolve({
            grid: grid.map(function (r) { return r.map(function (c) { return String(c == null ? '' : c); }); }),
            vals: vals
          });
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

    setAdminBusy(true, 'Načítavam knižnicu…');

    var ready = isPdf ? ensurePdf() : ensureXlsx();

    ready
      .then(function () {
        setAdminBusy(true, 'Čítam súbor…');
        // PDF має лише текст — його числа розбирає parseQty (vals порожні)
        return isPdf ? readPdf(file).then(function (g) { return { grid: g, vals: [] }; }) : readSpreadsheet(file);
      })
      .then(function (res) {
        setAdminBusy(false);
        var grid = res && res.grid;
        if (!grid || !grid.length) throw new Error('Súbor je prázdny.');

        state.grid = grid;
        state.vals = res.vals || [];
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
        '<select class="custom-select" data-field="' + f.key + '">' + opts.join('') + '</select>' +
        '</div>'
      );
    });

    $grid.find('select').on('change', function () {
      state.mapping[$(this).attr('data-field')] = parseInt($(this).val(), 10);
      renderMapping();
      updatePreview();
    });
    // v3.1.4: стилізовані випадні списки, як усюди в програмі
    renderCustomSelects($grid);
  }

  function buildRows() {
    var m = state.mapping;
    var out = [];
    var brandRe = /\[(.*?)\]/;
    var first = state.headerRow + 1;

    // v3.1.6: десятковий знак вирішує вся колонка «Plán» (для тексту: CSV, PDF)
    var dec = ',';
    if (m.plan > -1) {
      var texts = [];
      for (var t = first; t < state.grid.length; t++) texts.push(textAt(t, m.plan));
      dec = detectDecimal(texts);
    }

    for (var r = first; r < state.grid.length; r++) {
      if (!state.grid[r]) continue;

      var plu = m.plu > -1 ? cellCode(r, m.plu) : '';
      if (!plu) continue;

      var brand = m.brand > -1 ? textAt(r, m.brand) : '';
      var bm = brand.match(brandRe);
      if (bm && bm[1]) brand = bm[1];

      out.push({
        plu:   plu,
        name:  m.name  > -1 ? textAt(r, m.name) : '',
        ean:   m.ean   > -1 ? cellCode(r, m.ean) : '',
        code:  m.code  > -1 ? cellCode(r, m.code) : '',
        plan:  m.plan  > -1 ? cellQty(r, m.plan, dec) : 0,
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
    var seen = {}, dup = 0, noName = 0, noPlan = 0, planSum = 0;
    rows.forEach(function (r) {
      if (seen[r.plu]) dup++; else { seen[r.plu] = true; planSum += r.plan; }
      if (!r.name) noName++;
      if (!r.plan) noPlan++;
    });

    var chips = [
      '<div class="imp-chip good">' + icon('circle-check') + '<span>Riadkov: ' + rows.length + '</span></div>',
      '<div class="imp-chip">' + icon('file-spreadsheet') + '<span>' + escapeHtml(state.fileName) + '</span></div>'
    ];
    // v3.1.6: súčet plánu — rýchla kontrola voči ERP (zlé čísla by sa tu hneď ukázali)
    if (state.mapping.plan > -1 && rows.length) {
      chips.push('<div class="imp-chip">' + icon('chart-column') + '<span>Plán spolu: ' +
                 planSum.toLocaleString('sk-SK') + '</span></div>');
    }
    if (dup)    chips.push('<div class="imp-chip warn">' + icon('triangle-alert') + '<span>Duplicitné PLU: ' + dup + ' (ponechá sa prvé)</span></div>');
    if (noName) chips.push('<div class="imp-chip warn">' + icon('triangle-alert') + '<span>Bez názvu: ' + noName + '</span></div>');
    if (noPlan) chips.push('<div class="imp-chip">' + icon('info') + '<span>Plán = 0: ' + noPlan + '</span></div>');
    if (!rows.length) chips.push('<div class="imp-chip bad">' + icon('circle-x') + '<span>Skontrolujte priradenie stĺpcov</span></div>');

    $('#impFileInfo').removeClass('hidden').html(chips.slice(1).join(''));
    $('#impSummary').html(chips.join(''));
  }

  function run() {
    if (!state.parsed.length) { showMsg('Upozornenie', 'Nie je čo importovať — skontrolujte priradenie stĺpcov.'); return; }
    if (state.mapping.plu === -1) { showMsg('Upozornenie', 'Stĺpec PLU je povinný.'); return; }

    var sheetId = state.sheetId;
    if (!sheetId) { showMsg('Upozornenie', 'Najprv vyberte sklad.'); return; }

    var keepReal = $('#impKeepReal').is(':checked');
    var mode = keepReal ? 'merge' : 'replace';
    var warn = keepReal
      ? 'Plán a názvy sa aktualizujú podľa súboru. Naskenované množstvá, poznámky aj položky, ktoré v súbore nie sú, zostanú zachované.'
      : 'VŠETKY dáta v sklade «' + state.sheetName + '» vrátane naskenovaných množstiev sa nahradia!';

    showConfirm('Importovať ' + state.parsed.length + ' položiek?', warn, !keepReal).then(function (ok) {
      if (!ok) return;
      saveTemplate(state.grid[state.headerRow] || [], state.mapping);
      setAdminBusy(true, 'Importujem ' + state.parsed.length + ' položiek…');

      // v3.1.3: без PIN — база пускає імпорт лише správcovi і власнику
      return API.importRows(sheetId, state.parsed, mode, function (done, total) {
        setAdminBusy(true, 'Importujem ' + done + ' / ' + total);
      })
        .then(function (res) {
          setAdminBusy(false);
          var msg = res.msg;
          if (res.duplicateCount) {
            msg += '\n\nPreskočené duplicitné PLU: ' + res.duplicateCount;
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
  }

  /** v3.1.4: цільовий склад передається явно (з картки складу), а не з випадного списку. */
  function reset(sheetId, sheetName) {
    state = { grid: [], vals: [], headerRow: -1, mapping: {}, fileName: '', parsed: [],
              sheetId: sheetId || '', sheetName: sheetName || '' };
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
