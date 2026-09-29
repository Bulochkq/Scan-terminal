/**
 * API.JS — шар доступу до даних (Supabase / Postgres).
 * Остання зміна: v3.1.4 (див. PROGRESS.md у корені репо)
 *
 * Увесь інший код спілкується з сервером ТІЛЬКИ через цей файл.
 *
 * v3.1.0: бекенд перенесено з Google Apps Script на Supabase. Apps Script
 * відповідав від 3 до 68 секунд і часто віддавав 404 або «чужу» відповідь
 * (заміри 28.09.2026) — див. PROGRESS.md. Тепер кожна дія — виклик функції
 * бази: POST {SUPABASE_URL}/rest/v1/rpc/<назва>. Таблиці з браузера напряму
 * недоступні (RLS), лише ці функції (supabase/migrations/*.sql).
 *
 * v3.1.3: кожен запит несе токен входу (auth.js). Без входу база не виконує
 * нічого. Адмін-PIN прибрано — що можна, база вирішує за роллю людини.
 *
 * ГОЛОВНЕ ДЛЯ ТОЧНОСТІ: сканування шле не «стало 7», а «додай +1» разом з
 * унікальним opId. База додає атомарно, а повтор того самого opId (обрив
 * мережі, повторна відправка з черги) нічого не додає вдруге.
 */
(function (global) {
  'use strict';

  var CFG = global.APP_CONFIG;

  function isConfigured() {
    return !!(CFG.SUPABASE_URL && CFG.SUPABASE_KEY);
  }

  /** Поле, яке обов'язково є у правильній відповіді функції. */
  var EXPECT = {
    api_init: 'sheets', api_items: 'cols', api_changes: 'changes', api_logs: 'logs',
    api_scan: 'newReal', api_note: 'note', api_import: 'count',
    api_items_save: 'updated', api_logs_all: 'cols',
    api_people: 'people', api_invite_save: 'msg', api_invite_delete: 'msg',
    api_person_update: 'msg', api_person_password: 'msg', api_person_delete: 'msg',
    api_sheets: 'sheets', api_sheet_update: 'msg'
  };

  // ------------------------------------------------------------ транспорт

  /**
   * Один виклик функції бази без повторів. token — токен входу (або null).
   *
   * Помилки позначаються, щоб решта коду знала, що робити:
   *   transient — зв'язок/перевантаження: повторити пізніше, нічого не губити;
   *   isAuth    — вхід недійсний (прострочений токен, вимкнений акаунт) → екран входу;
   *   isRole    — увійшов, але цю дію роль не дозволяє → лише повідомлення.
   */
  function rpc(fn, args, timeoutMs, keepalive, token) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeoutMs || CFG.REQUEST_TIMEOUT_MS);
    var headers = { 'apikey': CFG.SUPABASE_KEY, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    return fetch(CFG.SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(args || {}),
      signal: ctl.signal,
      keepalive: !!keepalive
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

        if (!res.ok) {
          var raw = String((data && (data.message || data.error)) || ('HTTP ' + res.status));
          var err = new Error(raw.replace(/^(AUTH|ROLE):\s*/, ''));
          err.status = res.status;
          err.code = data && data.code;
          err.isRole = /^ROLE:/.test(raw);
          // 401 = токен прострочений/недійсний або запит без входу
          err.isAuth = /^AUTH:/.test(raw) || res.status === 401;
          // 57014 = запит перервано по таймауту бази — має сенс повторити
          err.transient = res.status === 408 || res.status === 429 || res.status >= 500 ||
                          err.code === '57014';
          throw err;
        }
        if (data == null || (EXPECT[fn] && !(EXPECT[fn] in data))) {
          var bad = new Error('Server vrátil nesprávnu odpoveď.');
          bad.transient = true;
          throw bad;
        }
        return data;
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        var t = new Error('Server neodpovedal včas. Skúste to znova.');
        t.transient = true;
        throw t;
      }
      if (e instanceof TypeError) {           // обрив мережі — fetch не дає деталей
        var n = new Error('Nie je spojenie so serverom.');
        n.transient = true;
        throw n;
      }
      throw e;
    });
  }

  /**
   * Тонка анімована смужка вгорі екрана, поки йде запит, на який людина може
   * чекати. Фонова синхронізація (quiet) її не вмикає.
   */
  var inflight = 0;
  function netBar(delta) {
    inflight = Math.max(0, inflight + delta);
    if (typeof document === 'undefined') return;
    var el = document.getElementById('netBar');
    if (el) el.classList.toggle('hidden', inflight === 0);
  }

  function getToken() {
    return global.Auth ? global.Auth.token() : Promise.resolve(null);
  }

  /**
   * Виклик з повторами при тимчасових збоях (0,6 с → 1,2 с → 2,4 с).
   * v3.1.3: на 401 один раз оновлюємо токен входу і повторюємо — токен живе
   * годину, і людина не має помічати, що він змінився. Не вийшло — вхід
   * справді втрачено: onAuthError показує екран входу.
   */
  function call(fn, args, opts) {
    opts = opts || {};
    if (!isConfigured()) {
      return Promise.reject(new Error('Nie je nastavené pripojenie k databáze (web/js/config.js).'));
    }
    var max = opts.retries == null ? CFG.MAX_RETRIES : opts.retries;
    var refreshed = false;
    if (!opts.quiet) netBar(1);

    function attempt(n) {
      return getToken().then(function (tok) {
        return rpc(fn, args, opts.timeout, false, tok);
      }).catch(function (e) {
        if (e.status === 401 && !refreshed && global.Auth) {
          refreshed = true;
          return global.Auth.refresh().then(function (okRefresh) {
            if (!okRefresh) throw e;
            return attempt(n);
          });
        }
        if (!e.transient || n >= max) throw e;
        return new Promise(function (r) { setTimeout(r, 600 * Math.pow(2, n)); })
          .then(function () { return attempt(n + 1); });
      });
    }

    return attempt(0).then(
      function (v) { if (!opts.quiet) netBar(-1); return v; },
      function (e) {
        if (!opts.quiet) netBar(-1);
        if (e.isAuth && typeof global.onAuthError === 'function') global.onAuthError(e);
        throw e;
      }
    );
  }

  // ------------------------------------------------------------ допоміжне

  /** Рядки приходять масивами — розкладаємо в об'єкти. id позиції стає полем row. */
  function decodeRows(cols, rows) {
    var names = cols.map(function (c) { return c === 'id' ? 'row' : c; });
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var src = rows[i], obj = {};
      for (var c = 0; c < names.length; c++) obj[names[c]] = src[c];
      out[i] = obj;
    }
    return out;
  }

  var opSeq = 0;
  /** Унікальний id операції: час + лічильник + випадкове. */
  function newOpId() {
    opSeq++;
    return 'op_' + Date.now().toString(36) + '_' + opSeq.toString(36) + '_' +
           Math.random().toString(36).slice(2, 10);
  }

  function num(id) { return Number(id); }

  /** v3.1.3: ім'я працівника не надсилається — база бере його з входу. */
  function scanArgs(entry) {
    return {
      p_op_id: entry.opId, p_item_id: num(entry.row), p_delta: entry.delta,
      p_type: entry.type || 'scan', p_client_time: entry.time || ''
    };
  }

  // ------------------------------------------------------------ дії

  global.API = {
    isConfigured: isConfigured,
    newOpId: newOpId,

    init: function () { return call('api_init'); },

    /** Увесь склад одним запитом (27k рядків ≈ 1–2 с). */
    loadSheet: function (sheetId, onProgress) {
      return call('api_items', { p_sheet_id: num(sheetId) }, { timeout: 60000 }).then(function (res) {
        var data = decodeRows(res.cols, res.data || []);
        if (typeof onProgress === 'function') onProgress(data.length, data.length);
        return { data: data, sheetName: res.sheetName, total: data.length, serverTime: res.serverTime };
      });
    },

    /** Що змінилось на складі з моменту since (мс) — фонова синхронізація. */
    changes: function (sheetId, since) {
      return call('api_changes', { p_sheet_id: num(sheetId), p_since: Math.floor(since || 0) },
                  { quiet: true, retries: 0, timeout: 15000 });
    },

    logs: function (sheetId) { return call('api_logs', { p_sheet_id: num(sheetId), p_limit: 1000 }); },

    /** v3.1.2: журнал для адміністрації — усі склади; v3.1.4: або один склад (sheetId). */
    logsAll: function (sheetId) {
      return call('api_logs_all', { p_sheet_id: sheetId ? num(sheetId) : null, p_limit: 20000 }, { timeout: 60000 });
    },

    /**
     * Зміна кількості на delta. entry = {opId, row, delta, user, type, time}.
     * Повтор безпечний завдяки opId, тому повторюємо сміливо.
     */
    scan: function (entry, quiet) {
      return call('api_scan', scanArgs(entry), { quiet: !!quiet, retries: CFG.MAX_RETRIES });
    },

    /** Спроба дослати зміну при закритті вкладки (запис усе одно лежить у черзі). */
    scanKeepalive: function (entry) {
      var tok = global.Auth ? global.Auth.tokenSync() : null;
      try { rpc('api_scan', scanArgs(entry), 10000, true, tok).catch(function () {}); } catch (e) {}
    },

    note: function (itemId, note) {
      return call('api_note', { p_item_id: num(itemId), p_note: note || '' });
    },

    sheetCreate: function (name) { return call('api_sheet_create', { p_name: name }, { retries: 0 }); },
    /** v3.1.4: повний огляд складів для адміністрації (стан, цифри, остання робота). */
    sheets: function () { return call('api_sheets', {}); },
    /** v3.1.4: перейменувати / змінити стан. fields = { name?, status? } */
    sheetUpdate: function (sheetId, fields) {
      fields = fields || {};
      return call('api_sheet_update', {
        p_sheet_id: num(sheetId),
        p_name: fields.name == null ? null : fields.name,
        p_status: fields.status == null ? null : fields.status
      }, { retries: 0 });
    },
    sheetDelete: function (sheetId) { return call('api_sheet_delete', { p_sheet_id: num(sheetId) }, { timeout: 60000 }); },

    /**
     * v3.1.1: пачка змін з табличного редактора (update / insert / delete).
     * Повтор НЕ робимо автоматично: вставка нових рядків не ідемпотентна.
     */
    itemsSave: function (sheetId, changes) {
      return call('api_items_save', { p_sheet_id: num(sheetId), p_changes: changes }, { retries: 0, timeout: 90000 });
    },

    /**
     * Імпорт порціями по IMPORT_CHUNK рядків (одна велика порція вперлась би
     * в таймаут бази). Перша порція робить бекап і (режим replace) очищує склад.
     */
    importRows: function (sheetId, rows, mode, onProgress) {
      var size = CFG.IMPORT_CHUNK || 2000;
      var seen = {}, dup = 0;
      rows.forEach(function (r) { if (seen[r.plu]) dup++; else seen[r.plu] = 1; });
      var backup = '';
      var i = 0;

      function next() {
        if (i >= rows.length) {
          return call('api_import_done', { p_sheet_id: num(sheetId), p_total: rows.length - dup, p_mode: mode })
            .then(function (res) { return { msg: res.msg, count: res.count, backup: backup, duplicateCount: dup }; });
        }
        var part = rows.slice(i, i + size);
        var first = (i === 0);
        return call('api_import', { p_sheet_id: num(sheetId), p_rows: part, p_mode: mode, p_first: first },
                    { timeout: 90000 })
          .then(function (res) {
            if (first) backup = res.backup || '';
            i += size;
            if (typeof onProgress === 'function') onProgress(Math.min(i, rows.length), rows.length);
            return next();
          });
      }
      return next();
    },

    backupList: function () { return call('api_backup_list', {}); },
    backupDelete: function (id) { return call('api_backup_delete', { p_backup_id: num(id) }); },
    backupRestore: function (id) { return call('api_backup_restore', { p_backup_id: num(id) }, { timeout: 90000, retries: 0 }); },

    logsClear: function () { return call('api_logs_clear', {}); },

    // ---------------------------------------------- люди (v3.1.3, Správca+)

    people: function () { return call('api_people', {}); },
    inviteSave: function (email, name, role) {
      return call('api_invite_save', { p_email: email, p_name: name, p_role: role }, { retries: 0 });
    },
    inviteDelete: function (email) { return call('api_invite_delete', { p_email: email }, { retries: 0 }); },
    /** null у полі = «не змінювати». */
    personUpdate: function (id, fields) {
      fields = fields || {};
      return call('api_person_update', {
        p_id: id,
        p_name: fields.name == null ? null : fields.name,
        p_role: fields.role == null ? null : fields.role,
        p_active: fields.active == null ? null : !!fields.active
      }, { retries: 0 });
    },
    personPassword: function (id, password) {
      return call('api_person_password', { p_id: id, p_password: password }, { retries: 0 });
    },
    personDelete: function (id) { return call('api_person_delete', { p_id: id }, { retries: 0 }); }
  };

  /**
   * OUTBOX — черга змін, які не дійшли до сервера (немає зв'язку).
   *
   * v3.1.0 — ВИПРАВЛЕНО (двічі):
   *  1. Кожна зміна — окремий запис зі своїм opId (дельти не можна
   *     «перекривати» останньою, як раніше абсолютні значення).
   *  2. Раніше flush в кінці перезаписував чергу знімком невдалих — зміна,
   *     що потрапила в чергу ПІД ЧАС відправки, зникала (відтворено тестом).
   *     Тепер з черги видаляється рівно те, що підтвердив сервер (за opId).
   */
  var OUTBOX_KEY = 'termOutbox_v4';

  var Outbox = {
    all: function () {
      try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch (e) { return []; }
    },
    save: function (list) {
      try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch (e) {}
    },
    add: function (entry) {
      var list = Outbox.all();
      if (!list.some(function (x) { return x.opId === entry.opId; })) list.push(entry);
      Outbox.save(list);
      return list.length;
    },
    remove: function (opId) {
      Outbox.save(Outbox.all().filter(function (x) { return x.opId !== opId; }));
    },
    count: function () { return Outbox.all().length; },

    /** Сума ще не відправлених змін для позиції — щоб екран показував правильне число. */
    sumFor: function (sheetId, row) {
      return Outbox.all().reduce(function (s, x) {
        return (String(x.sheetId) === String(sheetId) && String(x.row) === String(row)) ? s + x.delta : s;
      }, 0);
    },

    /**
     * Відправляє чергу по одній. На тимчасовій помилці зупиняється (зв'язку
     * ще немає), на справжній (позиції вже не існує) — прибирає запис і
     * повідомляє через onEach. Повертає, скільки лишилось.
     *
     * v3.1.3: проблема з входом (isAuth) — теж зупинка, а НЕ видалення: скан
     * справжній, він дошлеться, щойно людина знову увійде.
     */
    flush: function (onEach) {
      var list = Outbox.all();
      var chain = Promise.resolve();
      var stop = false;

      list.forEach(function (entry) {
        chain = chain.then(function () {
          if (stop) return;
          return global.API.scan(entry, true).then(function (res) {
            Outbox.remove(entry.opId);
            if (typeof onEach === 'function') onEach(entry, res, null);
          }).catch(function (err) {
            if (err.transient || err.isAuth) { stop = true; return; }
            Outbox.remove(entry.opId);
            if (typeof onEach === 'function') onEach(entry, null, err);
          });
        });
      });

      return chain.then(function () { return Outbox.count(); });
    }
  };

  global.Outbox = Outbox;

})(window);
