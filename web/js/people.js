/**
 * PEOPLE.JS — «Ľudia a prístupy»: хто працює в програмі і що кому можна.
 * Остання зміна: v3.1.4 (див. PROGRESS.md у корені репо)
 *
 * v3.1.4: іконки замість емодзі; роль — стилізований випадний список;
 *         «Heslo» у власному рядку = зміна СВОГО пароля (раніше було неактивне);
 *         у формі «Pridať človeka» пароль одразу придуманий (безпечніше, див. saveAdd).
 *
 * Правила ролей тут повторюють правила БАЗИ (003_accounts_roles.sql) навмисно:
 * база не пускає, а екран не показує кнопку, якої все одно не буде. Відмова
 * після натискання — гірший спосіб пояснювати правила, ніж неактивна кнопка з
 * підказкою «чому ні». Ті самі правила, що у Flex Bike Analytics (lib/auth.ts).
 */
(function (global) {
  'use strict';

  var P = { people: [], invites: [], meId: null, newRole: 'member' };
  var ROLES = ['member', 'admin', 'owner'];

  function esc(s) { return global.escapeHtml(s); }
  function me() { return global.Auth.me(); }
  function myRole() { var m = me(); return m ? m.role : ''; }
  function isOwner() { return myRole() === 'owner'; }
  function label(r) { return global.Auth.roleLabel(r); }
  function errText(e) { return (e && e.message) ? e.message : String(e); }

  // ------------------------------------------------------------ правила

  var ALLOW = { ok: true, why: '' };
  function deny(why) { return { ok: false, why: why }; }

  function otherOwners(id) {
    return P.people.filter(function (p) { return p.role === 'owner' && p.active && p.id !== id; }).length;
  }

  function canTouch(t) {
    if (!isOwner() && t.role === 'owner') return deny('Vlastníka môže upravovať len iný vlastník.');
    return ALLOW;
  }
  function canSetRole(t, next) {
    var c = canTouch(t); if (!c.ok) return c;
    if (next === t.role) return ALLOW;
    if (!isOwner() && next === 'owner') return deny('Vlastníka môže určiť len vlastník.');
    if (t.role === 'owner' && otherOwners(t.id) === 0) return deny('Toto je posledný vlastník. Najprv určte vlastníkom niekoho iného.');
    return ALLOW;
  }
  function canToggle(t) {
    if (t.id === P.meId) return deny('Seba vypnúť nemôžete — zamkli by ste sa zvonku.');
    var c = canTouch(t); if (!c.ok) return c;
    if (t.active && t.role === 'owner' && otherOwners(t.id) === 0) return deny('Toto je posledný vlastník programu.');
    return ALLOW;
  }
  function canDelete(t) {
    if (t.id === P.meId) return deny('Seba zmazať nemôžete. Požiadajte iného vlastníka.');
    var c = canTouch(t); if (!c.ok) return c;
    if (t.role === 'owner' && otherOwners(t.id) === 0) return deny('Toto je posledný vlastník programu.');
    return ALLOW;
  }
  /** Своє heslo — завжди можна (власне вікно зміни пароля), чуже — за правилами ролей. */
  function canPassword(t) {
    if (t.id === P.meId) return ALLOW;
    return canTouch(t);
  }

  // ------------------------------------------------------------ відкриття / список

  function open() {
    if (!global.Auth.can('admin')) { global.showMsg('Ľudia a prístupy', 'Túto časť môže otvoriť len správca alebo vlastník.'); return; }
    $('#ppSearch').val('');
    $('#ppLegend').html(ROLES.slice().reverse().map(function (r) {
      return '<div><span class="role-pill role-' + r + '">' + esc(label(r)) + '</span> ' + esc(global.Auth.ROLE_NOTE[r]) + '</div>';
    }).join(''));
    $('#peopleModal').removeClass('hidden');
    return load();
  }
  function close() { $('#peopleModal').addClass('hidden'); }

  function load() {
    $('#ppList').html(global.getLoaderHtml ? global.getLoaderHtml('Načítavam ľudí…') : 'Načítavam…');
    return global.API.people().then(function (res) {
      P.people = res.people || [];
      P.invites = res.invites || [];
      P.meId = res.me;
      render();
    }).catch(function (e) {
      $('#ppList').html('<div class="list-empty">' + esc(errText(e)) + '</div>');
    });
  }

  function matches(p, term) {
    return !term || ((p.name || '') + ' ' + (p.email || '')).toLowerCase().indexOf(term) !== -1;
  }

  /** html — уже безпечний вміст кнопки (іконка + текст). */
  function btn(cls, html, rule, action, title) {
    return '<button class="btn btn-xs ' + cls + '" data-act="' + action + '"' +
      (rule.ok ? (title ? ' title="' + esc(title) + '"' : '') : ' disabled title="' + esc(rule.why) + '"') + '>' + html + '</button>';
  }

  function render() {
    var term = String($('#ppSearch').val() || '').toLowerCase().trim();
    var active = P.people.filter(function (p) { return p.active; }).length;
    $('#ppCount').text(active + ' aktívnych' + (P.invites.length ? ' · ' + P.invites.length + ' čaká' : ''));

    var $list = $('#ppList').empty();
    var people = P.people.filter(function (p) { return matches(p, term); });

    people.forEach(function (p) {
      var you = p.id === P.meId;
      var roleSel = '<div class="pp-role"><select class="custom-select cs-compact" data-act="role"' +
        (canTouch(p).ok ? '' : ' disabled title="' + esc(canTouch(p).why) + '"') + '>' +
        ROLES.map(function (r) {
          var rule = canSetRole(p, r);
          return '<option value="' + r + '"' + (r === p.role ? ' selected' : '') +
                 (rule.ok ? '' : ' disabled title="' + esc(rule.why) + '"') + '>' + esc(label(r)) + '</option>';
        }).join('') + '</select></div>';

      var $row = $('<div class="pp-row' + (p.active ? '' : ' is-off') + '">' +
        '<div class="pp-av role-' + esc(p.role) + '">' + esc(global.Auth.initials(p.name || p.email)) + '</div>' +
        '<div class="pp-main">' +
          '<div class="pp-name">' + esc(p.name || p.email) +
            (you ? ' <span class="pp-you">vy</span>' : '') +
            (p.active ? '' : ' <span class="pp-off">vypnutý</span>') +
            (canTouch(p).ok ? ' <button class="pp-rename" data-act="rename" title="Zmeniť meno">' + global.icon('pencil') + '</button>' : '') +
          '</div>' +
          '<div class="pp-mail">' + esc(p.email) + ' · ' +
            (p.lastLogin ? 'naposledy ' + esc(p.lastLogin) : 'ešte sa neprihlásil') + '</div>' +
        '</div>' +
        '<div class="pp-ctrls">' + roleSel +
          btn('btn-secondary', global.icon(p.active ? 'user-x' : 'user-check') + '<span>' + (p.active ? 'Vypnúť' : 'Zapnúť') + '</span>', canToggle(p), 'toggle') +
          btn('btn-secondary', global.icon('key-round') + '<span>Heslo</span>', canPassword(p), 'pass') +
          btn('btn-danger-soft btn-icon', global.icon('trash-2'), canDelete(p), 'del', 'Zmazať natrvalo') +
        '</div>' +
      '</div>');

      $row.find('[data-act="role"]').on('change', function () { changeRole(p, this.value, this); });
      $row.find('[data-act="toggle"]').on('click', function () { toggle(p); });
      $row.find('[data-act="pass"]').on('click', function () {
        if (p.id === P.meId) global.changeOwnPassword(); else resetPassword(p);
      });
      $row.find('[data-act="del"]').on('click', function () { remove(p); });
      $row.find('[data-act="rename"]').on('click', function () { rename(p); });
      $list.append($row);
    });
    global.renderCustomSelects($list);

    var inv = P.invites.filter(function (i) { return matches(i, term); });
    if (inv.length) {
      $list.append('<div class="pp-section">Čakajú na prvé prihlásenie (' + inv.length + ')</div>');
      inv.forEach(function (i) {
        var rule = (!isOwner() && i.role === 'owner') ? deny('Pozvánku vlastníka môže zrušiť len vlastník.') : ALLOW;
        var $row = $('<div class="pp-row is-invite">' +
          '<div class="pp-av">' + global.icon('mail') + '</div>' +
          '<div class="pp-main">' +
            '<div class="pp-name">' + esc(i.name || i.email) + ' <span class="role-pill role-' + esc(i.role) + '">' + esc(label(i.role)) + '</span></div>' +
            '<div class="pp-mail">' + esc(i.email) + ' · pozvaný ' + esc(i.created) + ' · heslo si vytvorí sám cez „Prvé prihlásenie“</div>' +
          '</div>' +
          '<div class="pp-ctrls">' + btn('btn-secondary', global.icon('x') + '<span>Zrušiť pozvánku</span>', rule, 'cancel') + '</div>' +
        '</div>');
        $row.find('[data-act="cancel"]').on('click', function () { cancelInvite(i); });
        $list.append($row);
      });
    }

    if (!people.length && !inv.length) $list.html('<div class="list-empty">Nikto sa nenašiel.</div>');
  }

  // ------------------------------------------------------------ дії з людиною

  /** Усі зміни йдуть однаково: вікно очікування → база → свіжий список. */
  function run(busyText, promiseFn, doneText) {
    global.setAdminBusy(true, busyText);
    return promiseFn().then(function (r) {
      global.setAdminBusy(false);
      if (doneText) global.showMsg('Hotovo', typeof doneText === 'function' ? doneText(r) : doneText);
      return load();
    }).catch(function (e) {
      global.setAdminBusy(false);
      global.showMsg('Chyba', errText(e));
      return load();
    });
  }

  function changeRole(p, next, sel) {
    if (next === p.role) return;
    var go = function () {
      run('Mením rolu…', function () { return global.API.personUpdate(p.id, { role: next }); });
    };
    // «Ні» — повернути у списку стару роль (і в стилізованому теж)
    var undo = function () { sel.value = p.role; global.renderCustomSelects($(sel).closest('.pp-row')); };
    if (next === 'owner') {
      global.showConfirm('Urobiť vlastníkom?', (p.name || p.email) + ' bude môcť v programe všetko — aj meniť a odstraňovať iných vlastníkov (vrátane vás).', true)
        .then(function (ok) { if (ok) go(); else undo(); });
    } else if (p.id === P.meId) {
      global.showConfirm('Zmeniť vlastnú rolu?', 'Po zmene na „' + label(next) + '“ môžete stratiť prístup k tejto časti. Vrátiť vám ju môže len vlastník.', true)
        .then(function (ok) { if (ok) go(); else undo(); });
    } else go();
  }

  function toggle(p) {
    if (!p.active) {
      run('Zapínam prístup…', function () { return global.API.personUpdate(p.id, { active: true }); });
      return;
    }
    global.showConfirm('Vypnúť prístup?', (p.name || p.email) + ' sa nebude môcť prihlásiť ani skenovať (ak je práve prihlásený, pri ďalšej akcii ho program odhlási).\n' +
      'Jeho záznamy v histórii zostanú. Prístup sa dá kedykoľvek znova zapnúť.', true).then(function (ok) {
      if (ok) run('Vypínam prístup…', function () { return global.API.personUpdate(p.id, { active: false }); });
    });
  }

  function rename(p) {
    global.showPrompt('Meno', 'Meno a priezvisko', p.name || '').then(function (name) {
      if (name === null || !name.trim() || name.trim() === p.name) return;
      run('Ukladám…', function () { return global.API.personUpdate(p.id, { name: name.trim() }); });
    });
  }

  function resetPassword(p) {
    global.showPrompt('Nové heslo — ' + (p.name || p.email), 'aspoň 6 znakov', suggestPassword(), false).then(function (pw) {
      if (pw === null) return;
      pw = pw.trim();
      if (pw.length < 6) { global.showMsg('Heslo', 'Heslo musí mať aspoň 6 znakov.'); return; }
      run('Mením heslo…', function () { return global.API.personPassword(p.id, pw); },
          (p.name || p.email) + ' sa odteraz prihlási:\n\nE-mail: ' + p.email + '\nHeslo: ' + pw);
    });
  }

  function remove(p) {
    global.showConfirm('Natrvalo odstrániť?', (p.name || p.email) + ' (' + p.email + ') sa z programu úplne odstráni — aj prihlásenie.\n' +
      'Záznamy v histórii zostanú pod jeho menom.\n\nAk chcete prístup len dočasne zakázať, použite radšej „Vypnúť“.', true).then(function (ok) {
      if (ok) run('Odstraňujem…', function () { return global.API.personDelete(p.id); }, function (r) { return r.msg; });
    });
  }

  function cancelInvite(i) {
    global.showConfirm('Zrušiť pozvánku?', 'Pre ' + i.email + ' sa už nebude dať vytvoriť účet.', true).then(function (ok) {
      if (ok) run('Ruším pozvánku…', function () { return global.API.inviteDelete(i.email); });
    });
  }

  // ------------------------------------------------------------ нова людина

  /** 8 знаків без схожих (0/O, 1/l/I) — щоб легко продиктувати людині. */
  function suggestPassword() {
    var abc = 'abcdefghjkmnpqrstuvwxyz', dig = '23456789', out = '';
    var rnd = function (n) {
      try { var a = new Uint32Array(1); global.crypto.getRandomValues(a); return a[0] % n; }
      catch (e) { return Math.floor(Math.random() * n); }
    };
    for (var i = 0; i < 5; i++) out += abc.charAt(rnd(abc.length));
    for (var j = 0; j < 3; j++) out += dig.charAt(rnd(dig.length));
    return out;
  }

  function pickRole(r) {
    if (r === 'owner' && !isOwner()) return;
    P.newRole = r;
    $('#npRole button').removeClass('active').filter('[data-r="' + r + '"]').addClass('active');
    $('#npRoleNote').text(global.Auth.ROLE_NOTE[r] || '');
  }

  /**
   * v3.1.4: пароль одразу придуманий. Так акаунт створюється відразу і
   * «вільного» запрошення немає. Запрошення без пароля може «забрати» будь-хто,
   * хто знає цей e-mail і адресу програми, — поки людина не зайде сама.
   */
  function openAdd() {
    $('#npName, #npEmail').val('');
    $('#npPass').val(suggestPassword());
    $('#npRole button[data-r="owner"]').prop('disabled', !isOwner())
      .attr('title', isOwner() ? '' : 'Vlastníka môže pridať len vlastník.');
    pickRole('member');
    $('#personModal').removeClass('hidden');
    setTimeout(function () { $('#npName').focus(); }, 50);
  }
  function closeAdd() { $('#personModal').addClass('hidden'); }
  function genPass() { $('#npPass').val(suggestPassword()); }

  function saveAdd() {
    var name = String($('#npName').val() || '').trim();
    var email = String($('#npEmail').val() || '').trim().toLowerCase();
    var pass = String($('#npPass').val() || '').trim();
    var role = P.newRole;

    if (!name) { global.showMsg('Upozornenie', 'Zadajte meno.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { global.showMsg('Upozornenie', 'Zadajte platný e-mail.'); return; }
    if (pass && pass.length < 6) { global.showMsg('Upozornenie', 'Heslo musí mať aspoň 6 znakov (alebo ho nechajte prázdne).'); return; }

    var invited = false;
    global.setAdminBusy(true, 'Pridávam…');
    global.API.inviteSave(email, name, role).then(function (r) {
      // логін уже існував — база підключила його одразу; пароль задаємо окремо
      if (r.linked) return pass ? global.API.personPassword(r.id, pass).then(function () { return 'created'; }) : 'linked';
      invited = true;
      if (!pass) return 'invited';
      return global.Auth.createAccount(email, pass, name).then(function () { return 'created'; });
    }).then(function (how) {
      global.setAdminBusy(false);
      closeAdd();
      if (how === 'created') {
        global.showMsg('Účet je pripravený', name + ' (' + label(role) + ') sa môže prihlásiť hneď:\n\nE-mail: ' + email + '\nHeslo: ' + pass +
          '\n\nHeslo si môže neskôr zmeniť na úvodnej obrazovke (tlačidlo Heslo).');
      } else if (how === 'linked') {
        global.showMsg('Hotovo', 'Účet ' + email + ' už existoval — prístup je zapnutý. Prihlási sa svojím doterajším heslom.');
      } else {
        global.showMsg('Pozvánka je pripravená', name + ' si na úvodnej obrazovke klikne „Prvé prihlásenie“, zadá e-mail\n' + email + '\na vytvorí si heslo.');
      }
      return load();
    }).catch(function (e) {
      global.setAdminBusy(false);
      global.showMsg('Chyba', errText(e) + (invited
        ? '\n\nPozvánka zostala v zozname — človek si heslo môže vytvoriť sám cez „Prvé prihlásenie“, alebo pozvánku zrušte.'
        : ''));
      return load();
    });
  }

  global.People = {
    open: open, close: close, load: load, render: render,
    openAdd: openAdd, closeAdd: closeAdd, saveAdd: saveAdd, pickRole: pickRole, genPass: genPass
  };

})(window);
