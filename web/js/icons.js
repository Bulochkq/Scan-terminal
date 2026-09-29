/**
 * ICONS.JS — однотонні іконки для HTML, який будується в JavaScript.
 * Остання зміна: v3.1.4 (див. PROGRESS.md у корені репо)
 *
 * ПРАВИЛО ПРОЕКТУ: жодних емодзі в інтерфейсі. Лише лінійні іконки одного
 * набору — Lucide (як у Flex Bike Analytics). Самі малюнки лежать спрайтом на
 * початку web/index.html; нову іконку додає tools/build-icons.js.
 *
 *   icon('trash-2')            → <svg class="ic">…</svg>
 *   icon('loader-circle', 'ic-spin')
 */
(function (global) {
  'use strict';

  global.icon = function (name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  };

})(window);
