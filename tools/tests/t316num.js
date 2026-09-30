// v3.1.6: розбір чисел і кодів з імпорту (web/js/importer.js) — без браузера.
// Запуск: node tools/tests/t316num.js [шлях до xlsx.full.min.js — тоді ще й перевірка справжнім SheetJS]
// Приватні функції importer.js дістаємо, дописавши перед кінцем IIFE рядок, що їх виставляє назовні.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '../../web/js/importer.js'), 'utf8')
  .replace(/\}\)\(window\);\s*$/, 'global.__t = { detectDecimal: detectDecimal, parseQty: parseQty, cellQty: cellQty, cellCode: cellCode, state: function () { return state; }, setState: function (s) { state = s; }, buildRows: buildRows };\n})(window);');
const win = {};
const ctx = { window: win, $: function () { return { length: 0 }; }, console };
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const T = win.__t;
let pass = 0, fail = 0;
function eq(got, want, name) { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log('  ✗', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); } }

// --- десятковий знак колонки
eq(T.detectDecimal(['1', '2', '1,234', '15']), '.', 'EN thousands among plain ints → decimal "."');
eq(T.detectDecimal(['1', '2', '1.234', '15']), ',', 'SK/DE thousands "1.234" among plain ints → decimal ","');
eq(T.detectDecimal(['5,000', '12,000', '1,500']), ',', 'fixed 3 decimals in every value → decimal ","');
eq(T.detectDecimal(['12,5', '3', '1,234']), ',', '"12,5" votes decimal comma');
eq(T.detectDecimal(['1.234,50', '7']), ',', 'both separators → rightmost is decimal');
eq(T.detectDecimal(['1,234.50', '7']), '.', 'both separators (EN) → "."');
eq(T.detectDecimal(['1,234,567', '4']), '.', 'repeated comma = thousands');
eq(T.detectDecimal(['0,500', '2']), ',', 'leading zero → decimal');
eq(T.detectDecimal(['', 'x', '4']), ',', 'only integers → default ","');

// --- число з тексту
eq(T.parseQty('1,234', '.'), 1234, '"1,234" in EN column');
eq(T.parseQty('1,234', ','), 1, '"1,234" in fixed-decimals column = 1,234 → 1');
eq(T.parseQty('1.234,00', ','), 1234, '"1.234,00"');
eq(T.parseQty('1,234.00', ','), 1234, '"1,234.00" (per-value override)');
eq(T.parseQty('1 234', ','), 1234, 'space thousands');
eq(T.parseQty('1 234,5', ','), 1234, 'nbsp thousands + decimal');
eq(T.parseQty('12,5', ','), 12, '"12,5" → 12');
eq(T.parseQty('-3', ','), -3, 'negative');
eq(T.parseQty('5-', ','), -5, 'trailing minus');
eq(T.parseQty('6 ks', ','), 6, 'unit text');
eq(T.parseQty('', ','), 0, 'empty');
eq(T.parseQty('abc', ','), 0, 'no digits');

// --- клітинки: число з Excel і текст
T.setState({ grid: [['h', 'h', 'h'], ['1,234', '8.59E+12', '0012345'], ['6', '844171000472', '8.44171E+11']],
             vals: [['h', 'h', 'h'], [1234, 8590000000000, '0012345'], [6, '844171000472', 844171000472]],
             headerRow: 0, mapping: {}, fileName: '', parsed: [] });
eq(T.cellQty(1, 0, ','), 1234, 'Excel number 1234 shown as "1,234" → 1234');
eq(T.cellQty(2, 0, ','), 6, 'plain number');
eq(T.cellCode(1, 1), '8590000000000', 'EAN as number "8.59E+12" → all digits');
eq(T.cellCode(2, 1), '844171000472', 'EAN as text stays');
eq(T.cellCode(1, 2), '0012345', 'text code keeps leading zeros');
eq(T.cellCode(2, 2), '844171000472', 'UPC as number "8.44171E+11" → all digits');
T.setState({ grid: [['x'], ['2.9999999999']], vals: [['x'], [2.9999999999]], headerRow: 0, mapping: {}, fileName: '', parsed: [] });
eq(T.cellQty(1, 0, ','), 3, 'float noise from Excel formula → 3');

// --- buildRows цілком (як у вікні імпорту)
T.setState({ grid: [['Kód karty', 'Názov karty', 'Čiarový kód', 'Disponibilný stav'],
                    ['840087', 'Adaptér', '8.59E+12', '1,234'], ['840025', 'Adaptér 2', '', '6']],
             vals: [['Kód karty', 'Názov karty', 'Čiarový kód', 'Disponibilný stav'],
                    ['840087', 'Adaptér', 8590000000000, 1234], ['840025', 'Adaptér 2', '', 6]],
             headerRow: 0, mapping: { plu: 0, name: 1, ean: 2, code: -1, plan: 3, brand: -1 }, fileName: '', parsed: [] });
eq(T.buildRows().map(r => [r.plu, r.ean, r.plan]), [['840087', '8590000000000', 1234], ['840025', '', 6]], 'buildRows XLSX');
T.setState({ grid: [['PLU', 'Plan'], ['1', '1.234,00'], ['2', '12,5'], ['3', '7']], vals: [],
             headerRow: 0, mapping: { plu: 0, name: -1, ean: -1, code: -1, plan: 1, brand: -1 }, fileName: '', parsed: [] });
eq(T.buildRows().map(r => r.plan), [1234, 12, 7], 'buildRows CSV/PDF text (SK format)');
T.setState({ grid: [['PLU', 'Plan'], ['1', '1,234'], ['2', '15'], ['3', '2,500']], vals: [],
             headerRow: 0, mapping: { plu: 0, name: -1, ean: -1, code: -1, plan: 1, brand: -1 }, fileName: '', parsed: [] });
eq(T.buildRows().map(r => r.plan), [1234, 15, 2500], 'buildRows text with EN thousands');

// --- справжній SheetJS (якщо передали шлях до бібліотеки): Excel з форматом «#,##0» і EAN числом, CSV по-словацьки
if (process.argv[2]) {
  const XLSX = require(path.resolve(process.argv[2]));
  const ws = XLSX.utils.aoa_to_sheet([['Kód karty', 'Názov karty', 'Čiarový kód', 'Disponibilný stav'],
                                      ['840087', 'Adaptér', 8590000000000, 1234], ['840025', 'Adaptér 2', '844171000472', 5]]);
  ws.D2.z = '#,##0'; ws.D3.z = '#,##0.00';
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }).Sheets.S;
  const grid = XLSX.utils.sheet_to_json(back, { header: 1, raw: false, defval: '' }).map(r => r.map(c => String(c)));
  const vals = XLSX.utils.sheet_to_json(back, { header: 1, raw: true, defval: '' });
  eq(grid[1][3], '1,234', 'SheetJS really formats 1234 as "1,234" (the old bug)');
  T.setState({ grid, vals, headerRow: 0, mapping: { plu: 0, name: 1, ean: 2, code: -1, plan: 3, brand: -1 }, fileName: '', parsed: [] });
  eq(T.buildRows().map(r => [r.plu, r.ean, r.plan]), [['840087', '8590000000000', 1234], ['840025', '844171000472', 5]], 'real SheetJS XLSX round-trip');

  const csv = 'PLU;Plan\n0012;1 234\n2;1.234,00\n3;12,5\n';
  const cws = XLSX.read(Buffer.from(csv), { type: 'buffer', raw: true });
  const cs = cws.Sheets[cws.SheetNames[0]];
  T.setState({ grid: XLSX.utils.sheet_to_json(cs, { header: 1, raw: false, defval: '' }).map(r => r.map(c => String(c))),
               vals: XLSX.utils.sheet_to_json(cs, { header: 1, raw: true, defval: '' }),
               headerRow: 0, mapping: { plu: 0, name: -1, ean: -1, code: -1, plan: 1, brand: -1 }, fileName: '', parsed: [] });
  eq(T.buildRows().map(r => [r.plu, r.plan]), [['0012', 1234], ['2', 1234], ['3', 12]], 'real SheetJS CSV (SK format, leading zeros)');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
