/**
 * BUILD-ICONS.JS — збирає однотонні іконки Lucide в один спрайт усередині web/index.html.
 * Остання зміна: v3.1.4 (див. PROGRESS.md)
 *
 * ПРАВИЛО ПРОЕКТУ (від власника, 29.09.2026): жодних емодзі в інтерфейсі — лише
 * однотонні лінійні іконки ОДНОГО набору. Набір — Lucide (lucide.dev, ISC), той
 * самий, що у Flex Bike Analytics (lucide-react), щоб програми фірми виглядали
 * однаково.
 *
 * ЯК ДОДАТИ ІКОНКУ:
 *   1. знайти назву на https://lucide.dev/icons ;
 *   2. дописати її в ICONS нижче;
 *   3. запустити з кореня репо:  node tools/build-icons.js
 *   4. у HTML:  <svg class="ic"><use href="#i-назва"></use></svg>
 *      у JS:    icon('назва')   (web/js/icons.js)
 *
 * Чому спрайт у самій сторінці, а не окремим файлом чи бібліотекою з CDN:
 * посилання #i-… всередині документа працюють у всіх браузерах без винятків,
 * іконки є одразу (без мерехтіння) і офлайн — service worker кешує сторінку.
 * Уся збірка — ~12 КБ проти ~400 КБ бібліотеки з усіма іконками.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LUCIDE_VERSION = '1.48.0';

const ICONS = [
  // загальні
  'x', 'check', 'plus', 'minus', 'search', 'refresh-cw', 'loader-circle', 'info', 'triangle-alert',
  'circle-check', 'circle-x', 'chevron-down', 'chevron-right', 'arrow-left', 'arrow-right',
  // бренд і навігація
  'package', 'warehouse', 'shield', 'settings', 'chart-column', 'clipboard-list', 'history',
  // люди і вхід
  'user', 'users', 'user-plus', 'user-x', 'user-check', 'key-round', 'log-in', 'log-out', 'mail', 'dices',
  // склад і дані
  'upload', 'download', 'file-spreadsheet', 'archive', 'rotate-ccw', 'trash-2', 'pencil', 'eraser',
  'calendar', 'clock',
  // таблиця
  'lock', 'lock-open', 'save', 'undo-2', 'image', 'sticky-note', 'scan-line',
  // термінал
  'scan-barcode', 'camera', 'keyboard', 'zap'
];

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'web', 'index.html');
const BEGIN = '<!-- ICONS:BEGIN';
const END = '<!-- ICONS:END -->';

async function fetchIcon(name) {
  const url = `https://cdn.jsdelivr.net/npm/lucide-static@${LUCIDE_VERSION}/icons/${name}.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Іконки «${name}» немає (${res.status}): ${url}`);
  const svg = await res.text();
  const inner = svg.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/\s*\n\s*/g, '')
    .replace(/\s+\/>/g, '/>')
    .trim();
  if (!inner) throw new Error(`Порожня іконка «${name}»`);
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`;
}

(async () => {
  const unique = [...new Set(ICONS)];
  const symbols = await Promise.all(unique.map(fetchIcon));
  const sprite = [
    `${BEGIN} — згенеровано tools/build-icons.js (${unique.length} іконок), вручну не правити -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" id="iconSprite" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">`,
    `<!-- Lucide v${LUCIDE_VERSION} — https://lucide.dev — ISC License, Copyright (c) Lucide Icons and Contributors -->`,
    ...symbols,
    `</svg>`,
    END
  ].join('\n');

  let html = fs.readFileSync(INDEX, 'utf8');
  const a = html.indexOf(BEGIN), b = html.indexOf(END);
  if (a === -1 || b === -1) throw new Error('У web/index.html немає міток ICONS:BEGIN / ICONS:END');
  html = html.slice(0, a) + sprite + html.slice(b + END.length);
  fs.writeFileSync(INDEX, html);
  console.log(`OK: ${unique.length} іконок записано в web/index.html`);
})().catch((e) => { console.error(e.message); process.exit(1); });
