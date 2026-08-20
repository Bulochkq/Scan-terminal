/**
 * API.JS — шар доступу до даних. Замінює google.script.run.
 *
 * Увесь інший код спілкується з сервером ТІЛЬКИ через цей файл. Якщо колись
 * захочеш поміняти Google Таблицю на щось інше — переписується лише цей файл,
 * решта застосунку не змінюється.
 *
 * ЧОМУ ТУТ НЕМАЄ ЗАГОЛОВКА Content-Type:
 * Apps Script не вміє відповідати на preflight-запит (OPTIONS). Якщо додати
 * Content-Type: application/json, браузер спершу надішле OPTIONS, отримає
 * помилку — і жоден запит не пройде. Рядок у body автоматично йде як
 * text/plain, а це «простий запит», для якого preflight не потрібен.
 */
(function (global) {
  'use strict';

  var CFG = global.APP_CONFIG;

  function isConfigured() {
    return CFG.API_URL && CFG.API_URL.indexOf('ВСТАВ_СЮДИ') === -1;
  }

  function once(action, params) {
    var payload = Object.assign({ action: action }, params || {});
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, CFG.REQUEST_TIMEOUT_MS);

    return fetch(CFG.API_URL, {
      method: 'POST',
      body: JSON.stringify(payload),   // без headers — інакше зламається CORS
      redirect: 'follow',
      signal: controller.signal,
      keepalive: false
    })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) {
          var httpErr = new Error('Сервер повернув ' + res.status);
          // 429/500/503 від Google — тимчасові, має сенс повторити
          httpErr.transient = (res.status === 429 || res.status >= 500);
          throw httpErr;
        }
        return res.text();
      })
      .then(function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          // Найчастіша причина — деплой зроблено без доступу «Anyone»,
          // і Google повернув HTML сторінки входу замість JSON.
          throw new Error('Сервер відповів не JSON. Перевір, що веб-додаток задеплоєно з доступом «Anyone».');
        }
        if (data.ok === false) {
          var err = new Error(data.error || 'Помилка сервера');
          err.isAuth = !!data.auth;
          err.transient = !!data.retry;   // «Server busy» від LockService
          throw err;
        }
        return data;
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          var t = new Error('Сервер не відповів вчасно.');
          t.transient = true;
          throw t;
        }
        // Обрив мережі — fetch кидає TypeError без корисних деталей
        if (e instanceof TypeError) e.transient = true;
        throw e;
      });
  }

  /**
   * Повторює запит при тимчасових збоях.
   *
   * Apps Script під навантаженням віддає «Server busy» (глобальний замок
   * зайнятий), а на слабкому Wi-Fi запит може просто обірватись. Раніше
   * будь-який такий збій одразу ставав помилкою на екрані — саме це виглядало
   * як «зв'язок відпадає». Тепер вони мовчки переграються.
   */
  function call(action, params, attempt) {
    if (!isConfigured()) {
      return Promise.reject(new Error(
        'Не налаштовано API_URL. Відкрий web/js/config.js і встав адресу свого Apps Script.'
      ));
    }

    var tries = attempt || 0;
    var max = CFG.MAX_RETRIES == null ? 2 : CFG.MAX_RETRIES;

    return once(action, params).catch(function (e) {
      if (!e.transient || tries >= max) throw e;
      var wait = 700 * Math.pow(2, tries);   // 0.7с, 1.4с, 2.8с
      return new Promise(function (resolve) { setTimeout(resolve, wait); })
        .then(function () { return call(action, params, tries + 1); });
    });
  }

  /** Рядки приходять масивами — розкладаємо назад в об'єкти. */
  function decodeRows(cols, rows) {
    if (!rows || !rows.length) return [];
    if (!cols) return rows;                     // старий формат — уже об'єкти
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var src = rows[i], obj = {};
      for (var c = 0; c < cols.length; c++) obj[cols[c]] = src[c];
      out[i] = obj;
    }
    return out;
  }

  /** Завантаження складу порціями, з повідомленням про прогрес. */
  function loadSheet(sheetId, onProgress) {
    var all = [];
    var meta = { sheetName: '', total: 0, serverTime: 0 };

    function next(offset) {
      return call('sheet', { sheetId: sheetId, offset: offset, limit: CFG.CHUNK_SIZE })
        .then(function (res) {
          var rows = decodeRows(res.cols, res.data);
          all = all.concat(rows);

          meta.sheetName = res.sheetName;
          meta.total = res.total;
          meta.serverTime = res.serverTime;

          if (typeof onProgress === 'function') {
            onProgress(Math.min(offset + CFG.CHUNK_SIZE, res.total), res.total);
          }

          // ВИПРАВЛЕНО: раніше цикл зупинявся, якщо порція повернула нуль
          // рядків. Але порожня порція — це не кінець даних: якщо в таблиці
          // є блок службових рядків без PLU, усе, що йде ПІСЛЯ нього, просто
          // ніколи не завантажувалось. Тепер орієнтуємось лише на offset/total.
          if (res.done) return null;
          if (offset + CFG.CHUNK_SIZE >= res.total) return null;   // страховка від нескінченного циклу
          return next(offset + CFG.CHUNK_SIZE);
        });
    }

    return next(0).then(function () {
      return { data: all, sheetName: meta.sheetName, total: meta.total, serverTime: meta.serverTime };
    });
  }

  global.API = {
    isConfigured: isConfigured,
    raw: call,

    warm:        function ()                   { return once('warm'); },  // без повторів — просто будимо скрипт
    init:        function ()                   { return call('init'); },
    loadSheet:   loadSheet,

    /** Надійна відправка при закритті вкладки — fetch там уже скасовується. */
    writeBeacon: function (item, sheetId, user, sid) {
      if (!navigator.sendBeacon || !isConfigured()) return false;
      try {
        var body = new Blob(
          [JSON.stringify({ action: 'write', item: item, sheetId: sheetId, user: user, sessionId: sid })],
          { type: 'text/plain;charset=UTF-8' }
        );
        return navigator.sendBeacon(CFG.API_URL, body);
      } catch (e) { return false; }
    },

    leaveBeacon: function (sheetId, sid) {
      if (!navigator.sendBeacon || !isConfigured()) return false;
      try {
        var body = new Blob(
          [JSON.stringify({ action: 'leave', sheetId: sheetId, sessionId: sid })],
          { type: 'text/plain;charset=UTF-8' }
        );
        return navigator.sendBeacon(CFG.API_URL, body);
      } catch (e) { return false; }
    },
    ping:        function (sheetId, user, sid, since) {
                   return call('ping', { sheetId: sheetId, user: user, sessionId: sid, since: since });
                 },
    leave:       function (sheetId, sid)       { return call('leave', { sheetId: sheetId, sessionId: sid }); },
    logs:        function (sheetId)            { return call('logs', { sheetId: sheetId }); },

    write:       function (item, sheetId, user, sid) {
                   return call('write', { item: item, sheetId: sheetId, user: user, sessionId: sid });
                 },
    note:        function (sheetId, row, note, user) {
                   return call('note', { sheetId: sheetId, row: row, note: note, user: user });
                 },

    auth:        function (pin)                { return call('auth', { pin: pin }); },

    userAdd:     function (name)               { return call('userAdd', { name: name }); },
    userDel:     function (name)               { return call('userDel', { name: name }); },

    sheetCreate: function (name, pin)          { return call('sheetCreate', { name: name, pin: pin }); },
    sheetDelete: function (sheetId, pin)       { return call('sheetDelete', { sheetId: sheetId, pin: pin }); },

    itemCreate:  function (sheetId, data, user, pin) {
                   return call('itemCreate', { sheetId: sheetId, data: data, user: user, pin: pin });
                 },
    itemUpdate:  function (sheetId, row, data, user, pin) {
                   return call('itemUpdate', { sheetId: sheetId, row: row, data: data, user: user, pin: pin });
                 },
    itemDelete:  function (sheetId, row, user, pin) {
                   return call('itemDelete', { sheetId: sheetId, row: row, user: user, pin: pin });
                 },

    importRows:  function (sheetId, rows, mode, pin) {
                   return call('import', { sheetId: sheetId, rows: rows, mode: mode, pin: pin });
                 },

    backupList:   function (pin)               { return call('backupList', { pin: pin }); },
    backupDelete: function (sheetId, pin)      { return call('backupDelete', { sheetId: sheetId, pin: pin }); },
    logsClear:    function (pin)               { return call('logsClear', { pin: pin }); }
  };

  /**
   * OUTBOX — черга записів, які не пройшли (немає зв'язку, сервер зайнятий).
   * Раніше невдалий запис просто зникав, а наступна синхронізація тихо
   * повертала стару кількість. Тепер він лежить у localStorage і
   * відправляється, щойно зв'язок повернувся.
   */
  var OUTBOX_KEY = 'termOutbox_v3';

  var Outbox = {
    all: function () {
      try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); }
      catch (e) { return []; }
    },
    save: function (list) {
      try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch (e) {}
    },
    add: function (entry) {
      var list = Outbox.all();
      // Один рядок — один запис у черзі: пишеться абсолютне значення,
      // тому останнє завжди перекриває попереднє.
      list = list.filter(function (x) {
        return !(x.sheetId === entry.sheetId && x.item.row === entry.item.row);
      });
      list.push(entry);
      Outbox.save(list);
      return list.length;
    },
    remove: function (sheetId, row) {
      Outbox.save(Outbox.all().filter(function (x) {
        return !(x.sheetId === sheetId && x.item.row === row);
      }));
    },
    count: function () { return Outbox.all().length; },
    clear: function () { Outbox.save([]); },

    /** Пробує відправити все, що накопичилось. Повертає кількість тих, що лишились. */
    flush: function (onEach) {
      var list = Outbox.all();
      if (!list.length) return Promise.resolve(0);

      var chain = Promise.resolve();
      var failed = [];

      list.forEach(function (entry) {
        chain = chain.then(function () {
          return global.API.write(entry.item, entry.sheetId, entry.user, entry.sessionId)
            .then(function (res) {
              if (typeof onEach === 'function') onEach(entry, res, null);
            })
            .catch(function (err) {
              failed.push(entry);
              if (typeof onEach === 'function') onEach(entry, null, err);
            });
        });
      });

      return chain.then(function () {
        Outbox.save(failed);
        return failed.length;
      });
    }
  };

  global.Outbox = Outbox;

})(window);
