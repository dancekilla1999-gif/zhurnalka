/* «Журналка» — кабинет управляющего. */
(function () {
  "use strict";
  var ZJ = window.ZJ, h = ZJ.h;

  // ------------------------------------------------------------ сессия
  ZJ.owner = function () { try { return JSON.parse(ZJ.store.get("zj_owner") || "null"); } catch (e) { return null; } };
  function setOwner(o) { ZJ.store.set("zj_owner", o ? JSON.stringify(o) : null); }
  function tok() { var o = ZJ.owner(); return o && o.token; }
  function call(fn, args) {
    return ZJ.api(fn, Object.assign({ p_token: tok() }, args || {})).catch(function (e) {
      if (e.hint === "auth") { setOwner(null); ZJ.toast(e.message, "bad"); ZJ.go("/login"); }
      throw e;
    });
  }
  function need() { if (!tok()) { ZJ.go("/login"); return false; } return true; }
  function fail(e) { ZJ.toast(e.message || "Ошибка", "bad"); }

  // ------------------------------------------------------------ каркас
  function topbar(point, tab) {
    var o = ZJ.owner() || {};
    return h("header", { class: "topbar no-print" },
      h("div", { class: "wrap topbar-in" },
        h("div", { class: "row", style: "gap:14px;min-width:0" },
          h("a", { class: "brand", href: "#/o", text: "Журналка" }),
          point ? h("span", { class: "venue-name", text: point.name }) : null),
        h("div", { class: "row" },
          h("span", { class: "small muted", text: o.email || "" }),
          h("button", { class: "btn ghost small", text: "Выйти", onclick: function () {
            call("zh_logout").catch(function () {}).then(function () { setOwner(null); ZJ.go("/"); });
          } }))),
      point ? h("nav", { class: "wrap tabs", "aria-label": "Разделы" },
        [["today", "Сегодня", ""], ["j", "Журналы", "/j/health"], ["units", "Оборудование", "/units"], ["team", "Команда", "/team"], ["settings", "Настройки", "/settings"]].map(function (t) {
          return h("a", { class: "tab" + (tab === t[0] ? " on" : ""), href: "#/o/p/" + point.id + t[2], text: t[1] });
        }).concat([h("a", { class: "tab tab-ai", href: "#/o/agents", text: "✦ Агенты" })])) : h("nav", { class: "wrap tabs", "aria-label": "Разделы" }, h("a", { class: "tab" + (tab === "points" ? " on" : ""), href: "#/o", text: "Точки" }), h("a", { class: "tab tab-ai" + (tab === "agents" ? " on" : ""), href: "#/o/agents", text: "✦ Агенты" })));
  }
  function page() { var m = h("main", { class: "wrap page" }); for (var i = 0; i < arguments.length; i++) ZJ.add(m, arguments[i]); return m; }
  function withPoint(id, tab, render) {
    if (!need()) return;
    ZJ.mount([topbar(null, tab), ZJ.loading()]);
    call("zh_point_get", { p_point: id }).then(function (p) {
      ZJ.mount([topbar(p, tab), render(p)]);
    }, function (e) { ZJ.mount([topbar(null, tab), page(h("div", { class: "card" }, h("p", { text: e.message }), h("a", { class: "btn", href: "#/o", text: "К списку точек" })))]); });
  }
  function reload() { ZJ.dispatch(); }
  ZJ.app = { tok: tok, call: call, need: need, fail: fail, topbar: topbar, page: page };

  // ------------------------------------------------------------ старт и вход
  ZJ.route("/", function () {
    var s = ZJ.staffSession && ZJ.staffSession();
    if (tok()) { ZJ.go("/o"); return; }
    if (s) { ZJ.go("/s"); return; }
    ZJ.mount(h("main", { class: "page narrow" },
      h("a", { class: "brand big", href: "#/", text: "Журналка" }),
      h("p", { class: "center muted", text: "Санитарные журналы общепита в телефоне" }),
      h("div", { class: "card form" },
        h("h2", { text: "Я управляющий или владелец" }),
        h("p", { class: "muted small", text: "Заведите точку, добавьте холодильники и пригласите сотрудников." }),
        h("a", { class: "btn primary wide", href: "#/register", text: "Зарегистрироваться — 7 дней бесплатно" }),
        h("a", { class: "btn wide", href: "#/login", text: "Войти" })),
      h("div", { class: "card form" },
        h("h2", { text: "Я сотрудник" }),
        h("p", { class: "muted small", text: "Нужен код точки от управляющего — или отсканируйте QR на холодильнике." }),
        h("a", { class: "btn wide", href: "#/code", text: "Ввести код" }))));
  });

  function authPage(mode) {
    var email = h("input", { type: "email", autocomplete: "email", required: true });
    var pass = h("input", { type: "password", autocomplete: mode === "login" ? "current-password" : "new-password", required: true, minlength: 8 });
    var name = h("input", { autocomplete: "name", placeholder: "Как к вам обращаться" });
    var err = h("p", { class: "form-err", role: "alert" });
    var btn = h("button", { class: "btn primary wide", type: "submit", text: mode === "login" ? "Войти" : "Создать аккаунт" });
    var form = h("form", { class: "card form", onsubmit: function (ev) {
      ev.preventDefault(); err.textContent = ""; btn.disabled = true;
      var p = mode === "login" ? ZJ.api("zh_login", { p_email: email.value, p_password: pass.value })
        : ZJ.api("zh_register", { p_email: email.value, p_password: pass.value, p_name: name.value });
      p.then(function (r) {
        if (r && r.error) throw new Error(r.error);
        setOwner(r); ZJ.go(mode === "login" ? "/o" : "/o/new");
      }).catch(function (e) { err.textContent = e.message; btn.disabled = false; });
    } },
      h("h1", { text: mode === "login" ? "Вход" : "Регистрация" }),
      mode === "register" ? h("label", null, "Имя", name) : null,
      h("label", null, "Почта", email),
      h("label", null, "Пароль" + (mode === "register" ? " (от 8 символов)" : ""), pass),
      err, btn,
      h("p", { class: "small muted center" }, mode === "login" ? h("a", { href: "#/register", text: "Нет аккаунта? Регистрация" }) : h("a", { href: "#/login", text: "Уже есть аккаунт? Войти" })));
    ZJ.mount(h("main", { class: "page narrow" }, h("a", { class: "brand big", href: "#/", text: "Журналка" }), form));
  }
  ZJ.route("/login", function () { authPage("login"); });
  ZJ.route("/register", function () { authPage("register"); });

  // ------------------------------------------------------------ точки
  ZJ.route("/o", function () {
    if (!need()) return;
    ZJ.mount([topbar(null), ZJ.loading()]);
    call("zh_me").then(function (me) {
      if (!me.points.length) { ZJ.go("/o/new"); return; }
      if (me.points.length === 1 && !sessionStorage.getItem("zj_list")) { try { sessionStorage.setItem("zj_list", "1"); } catch (e) {} ZJ.go("/o/p/" + me.points[0].id); return; }
      ZJ.mount([topbar(null), page(
        h("div", { class: "page-head" }, h("div", null, h("h1", { text: "Ваши точки" })), h("a", { class: "btn primary", href: "#/o/new", text: "+ Точка" })),
        h("div", { class: "jgrid" }, me.points.map(function (p) {
          var s = p.status, bad = s.alerts > 0, need = needs(s);
          return h("a", { class: "jcard " + (bad ? "bad" : need ? "todo" : "ok"), href: "#/o/p/" + p.id, style: "text-decoration:none;color:inherit" },
            h("h3", { text: p.name }), h("span", { class: "small muted", text: p.address || "" }),
            h("div", { class: "row" },
              bad ? h("span", { class: "pill bad", text: s.alerts + " " + ZJ.plural(s.alerts, "отклонение", "отклонения", "отклонений") }) : null,
              need ? h("span", { class: "pill todo", text: "есть незаполненное" }) : h("span", { class: "pill ok", text: "всё заполнено" })));
        })))]);
    }, function (e) { ZJ.mount([topbar(null), page(h("p", { text: e.message }))]); });
  });
  function needs(s) {
    var j = s.journals || [];
    var unitsMissing = (s.units || []).some(function (u) { return !u.done && j.indexOf(u.kind) >= 0; });
    return (j.indexOf("health") >= 0 && s.health_done < s.staff) || unitsMissing || s.health_wait > 0;
  }

  ZJ.route("/o/new", function () {
    if (!need()) return;
    var name = h("input", { required: true, placeholder: "Кафе «Ромашка»" }), addr = h("input", { placeholder: "Москва, ул. …" }), org = h("input", { placeholder: "ООО «Ромашка», ИНН …" });
    var err = h("p", { class: "form-err" }), btn = h("button", { class: "btn primary", type: "submit", text: "Создать точку" });
    ZJ.mount([topbar(null), page(h("form", { class: "card form", style: "max-width:560px", onsubmit: function (ev) {
      ev.preventDefault(); btn.disabled = true; err.textContent = "";
      call("zh_point_create", { p_name: name.value, p_address: addr.value, p_org: org.value }).then(function (r) {
        try { sessionStorage.setItem("zj_list", "1"); } catch (e) {}
        ZJ.go("/o/p/" + r.id);
      }, function (e) { err.textContent = e.message; btn.disabled = false; });
    } },
      h("h1", { text: "Новая точка" }),
      h("p", { class: "muted", text: "Название и юрлицо попадут в шапку печатных журналов." }),
      h("label", null, "Название заведения", name), h("label", null, "Адрес", addr), h("label", null, "Юрлицо или ИП", org), err, btn))]);
  });

  // ------------------------------------------------------------ сегодня
  ZJ.route("/o/p/:id", function (prm) {
    withPoint(prm.id, "today", function (p) {
      var s = p.status, j = p.journals, unitsById = {};
      p.units.forEach(function (u) { unitsById[u.id] = u; });
      var blocks = [];
      var started = p.units.length > 0 && p.staff.length > 0;
      if (!started) {
        blocks.push(h("div", { class: "card form" }, h("h2", { text: "Запуск за 10 минут" }),
          h("ol", { class: "steps" },
            h("li", { class: p.units.length ? "done" : null }, h("div", null, h("b", { text: "Добавьте холодильники и склады. " }), h("a", { href: "#/o/p/" + p.id + "/units", text: "Оборудование →" }))),
            h("li", null, h("div", null, h("b", { text: "Распечатайте QR-наклейки " }), "и приклейте на каждый холодильник — сотрудник сканирует и вводит температуру за 10 секунд.")),
            h("li", { class: p.staff.length ? "done" : null }, h("div", null, h("b", { text: "Подключите сотрудников " }), "по коду или QR-плакату. ", h("a", { href: "#/o/p/" + p.id + "/team", text: "Команда →" }))),
            h("li", null, h("div", null, h("b", { text: "Назначьте ответственного " }), "(су-шеф или администратор) — он допускает сотрудников к смене.")))));
      }
      if (p.today_alerts.length) {
        blocks.push(h("div", { class: "card alert-card" }, h("h2", { text: "Отклонения сегодня" }),
          h("ul", { class: "lines" }, p.today_alerts.map(function (e) {
            return h("li", null, h("span", null, h("b", { text: ZJ.J[e.journal].short + ": " }), ZJ.entryText(e, unitsById)), h("span", { class: "small muted", text: e.author + " · " + ZJ.timeFmt(e.created_at) }));
          }))));
      }
      if (p.pending.length) {
        blocks.push(h("div", { class: "card alert-card warn" }, h("h2", { text: "Ждут допуска к смене" }),
          h("ul", { class: "lines" }, p.pending.map(function (e) {
            var sick = !(e.data.no_infection && e.data.no_skin);
            return h("li", null,
              h("span", null, h("b", { text: e.author }), " · " + e.author_role + " · " + ZJ.timeFmt(e.created_at),
                sick ? h("span", { class: "pill bad", style: "margin-left:8px", text: "отметил признаки болезни" }) : h("span", { class: "pill ok", style: "margin-left:8px", text: "здоров" })),
              h("span", { class: "row" },
                h("button", { class: "btn small primary", text: "Допустить", onclick: function () { admit(p, e, true); } }),
                h("button", { class: "btn small danger", text: "Отстранить", onclick: function () { admit(p, e, false); } })));
          }))));
      }
      if (s.med_soon.length || s.med_missing) {
        blocks.push(h("div", { class: "notice" }, h("div", null,
          h("b", { text: "Медкнижки. " }),
          s.med_soon.map(function (m) { var n = ZJ.dayLeft(m.med_until); return m.name + (n < 0 ? " — просрочена" : " — до " + ZJ.dayFmt(m.med_until)); }).join("; "),
          s.med_missing ? (s.med_soon.length ? "; " : "") + "у " + s.med_missing + " " + ZJ.plural(s.med_missing, "сотрудника", "сотрудников", "сотрудников") + " не указан срок" : ""),
          h("a", { class: "btn small", href: "#/o/p/" + p.id + "/team", text: "Команда" })));
      }
      var cards = ZJ.J_ORDER.filter(function (k) { return j.indexOf(k) >= 0; }).map(function (k) { return journalCard(p, k, s); });
      return page(
        h("div", { class: "page-head" }, h("div", null, h("span", { class: "label", text: "Сегодня, " + ZJ.dayFmt(s.day) }), h("h1", { text: p.name }))),
        blocks, h("div", { class: "jgrid" }, cards));
    });
  });
  function admit(p, e, ok) {
    call("zh_admit", { p_point: p.id, p_entry: e.id, p_admitted: ok }).then(function () { ZJ.toast(ok ? "Допущен к работе" : "Отстранён от работы"); reload(); }, fail);
  }
  function journalCard(p, k, s) {
    var J = ZJ.J[k], n = (s.counts || {})[k] || 0, state = "ok", big, sub, units, act = null;
    if (k === "health") {
      big = s.health_done + " из " + s.staff; sub = "сотрудников отметились";
      state = s.staff === 0 ? "todo" : s.health_off > 0 ? "bad" : s.health_done < s.staff || s.health_wait > 0 ? "todo" : "ok";
    } else if (k === "fridge" || k === "store") {
      units = s.units.filter(function (u) { return u.kind === k; });
      var done = units.filter(function (u) { return u.done; }).length;
      big = done + " из " + units.length; sub = units.length ? "заполнено сегодня" : "оборудование не добавлено";
      state = units.some(function (u) { return u.alert; }) ? "bad" : done < units.length || !units.length ? "todo" : "ok";
      act = units.length ? h("button", { class: "btn small", text: "Заполнить", onclick: function () { pickUnit(p, k); } }) : h("a", { class: "btn small", href: "#/o/p/" + p.id + "/units", text: "Добавить" });
    } else {
      big = String(n); sub = n ? ZJ.plural(n, "запись", "записи", "записей") + " сегодня" : "записей сегодня нет";
      state = n ? "ok" : "";
      act = h("button", { class: "btn small", text: "Записать", onclick: function () {
        ZJ.openEntry(k, null, p.units, function (data, uid) { return call("zh_owner_entry", { p_point: p.id, p_journal: k, p_unit: uid, p_data: data }); }, reload);
      } });
    }
    return h("div", { class: "jcard " + state },
      h("h3", null, h("span", { text: J.short }), J.mandatory ? null : h("span", { class: "pill", text: "рекомендуемый" })),
      h("div", { class: "big", text: big }), h("div", { class: "small muted", text: sub }),
      units && units.length ? h("div", { class: "small" }, units.map(function (u) {
        return h("div", null, (u.done ? "✓ " : "· ") + u.name + (u.last ? ": " + ZJ.t(u.last.t) + (u.last.h != null ? ", " + u.last.h + " %" : "") : ""), u.alert ? h("b", { style: "color:var(--bad)", text: " — вне нормы" }) : null);
      })) : null,
      h("div", { class: "row" }, act, h("a", { class: "btn small ghost", href: "#/o/p/" + p.id + "/j/" + k, text: "Журнал" })));
  }
  function pickUnit(p, kind) {
    var list = p.units.filter(function (u) { return u.kind === kind; });
    var st = {}; p.status.units.forEach(function (u) { st[u.id] = u; });
    var close = ZJ.modal("Выберите " + ZJ.UNIT_KIND[kind].one, h("div", { class: "units-list" }, list.map(function (u) {
      var x = st[u.id] || {};
      return h("button", { class: "unit " + (x.done ? "done" : "need"), style: "text-align:left;font:inherit;color:inherit;cursor:pointer", onclick: function () {
        close();
        ZJ.openEntry(kind, u, p.units, function (data, uid) { return call("zh_owner_entry", { p_point: p.id, p_journal: kind, p_unit: uid, p_data: data }); }, reload);
      } }, h("span", { class: "u-main" }, h("b", { text: u.name }), h("span", { class: "small muted", text: [u.room, ZJ.range(u)].filter(Boolean).join(" · ") })),
        h("span", { class: "temp", text: x.last ? ZJ.t(x.last.t) : "—" }));
    })));
  }

  // ------------------------------------------------------------ журналы
  function journalView(prm) {
    var k = prm.journal, ym = prm.ym || ZJ.monthISO();
    if (!ZJ.J[k]) { ZJ.go("/o/p/" + prm.id); return; }
    withPoint(prm.id, "j", function (p) {
      var box = h("div", null, ZJ.loading());
      var r = ZJ.monthRange(ym);
      call("zh_entries", { p_point: p.id, p_journal: k, p_from: r.from, p_to: r.to }).then(function (d) {
        box.textContent = "";
        var unitsById = {}; d.units.forEach(function (u) { unitsById[u.id] = u; });
        if (!d.entries.length) { box.appendChild(h("div", { class: "card muted", text: "За " + ZJ.monthName(ym).toLowerCase() + " записей нет." })); return; }
        box.appendChild(h("div", { class: "table-box" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, ["Дата", "Время", "Запись", "Кто", ""].map(function (c) { return h("th", { text: c }); }))),
          h("tbody", null, d.entries.slice().reverse().map(function (e) {
            return h("tr", { class: e.voided ? "voided" : null },
              h("td", { text: ZJ.dayFmt(e.day) }), h("td", { text: ZJ.timeFmt(e.created_at) }),
              h("td", { class: e.voided ? "reason" : null }, e.alert && !e.voided ? h("span", { class: "pill bad", style: "margin-right:6px", text: "отклонение" }) : null,
                h("span", { style: e.voided ? "text-decoration:line-through" : null, text: ZJ.entryText(e, unitsById) }),
                e.voided ? h("div", { class: "small", text: "Аннулировано: " + e.void_reason }) : null),
              h("td", { text: e.author + (e.author_role ? ", " + e.author_role : "") }),
              h("td", { class: "actions" }, e.voided ? null : h("button", { class: "btn small ghost", text: "Аннулировать", onclick: function () { voidEntry(p, e); } })));
          })))));
      }, function (e) { box.textContent = e.message; });
      var months = []; for (var i = 0; i < 6; i++) months.push(ZJ.monthShift(ZJ.monthISO(), -i));
      return page(
        h("div", { class: "page-head" },
          h("div", null, h("span", { class: "label", text: "Журналы" }), h("h1", { text: ZJ.J[k].short })),
          h("div", { class: "row" },
            h("select", { class: "venue-select", "aria-label": "Месяц", onchange: function (ev) { ZJ.go("/o/p/" + p.id + "/j/" + k + "/" + ev.target.value); } },
              months.map(function (m) { return h("option", { value: m, text: ZJ.monthName(m), selected: m === ym ? true : null }); })),
            h("a", { class: "btn primary", href: "#/o/p/" + p.id + "/print/" + k + "/" + ym, text: "Печать / PDF" }))),
        h("div", { class: "seg", role: "tablist" }, ZJ.J_ORDER.filter(function (x) { return p.journals.indexOf(x) >= 0; }).map(function (x) {
          return h("button", { class: x === k ? "on" : null, onclick: function () { ZJ.go("/o/p/" + p.id + "/j/" + x + "/" + ym); }, text: ZJ.J[x].short });
        })),
        h("p", { class: "small muted", text: ZJ.J[k].title + ". " + ZJ.J[k].who + "." }),
        box);
    });
  }
  ZJ.route("/o/p/:id/j/:journal", journalView);
  ZJ.route("/o/p/:id/j/:journal/:ym", journalView);
  function voidEntry(p, e) {
    var reason = h("input", { placeholder: "Например: ошибся холодильником", maxlength: 200 });
    ZJ.modal("Аннулировать запись", h("div", { class: "form" },
      h("p", { class: "muted", text: "Запись не удаляется — она останется в журнале зачёркнутой с указанием причины, как исправление в бумажном журнале." }),
      h("label", null, "Причина", reason)), [
      { text: "Отмена", kind: "ghost" },
      { text: "Аннулировать", kind: "danger", keep: true, onclick: function (close) {
        if (!reason.value.trim()) { ZJ.toast("Укажите причину", "bad"); return false; }
        call("zh_entry_void", { p_point: p.id, p_entry: e.id, p_reason: reason.value }).then(function () { close(); ZJ.toast("Запись аннулирована"); reload(); }, fail);
        return false;
      } }]);
  }

  ZJ.route("/o/p/:id/print/:journal/:ym", function (prm) {
    if (!need()) return;
    ZJ.mount(ZJ.loading("Готовлю печатную форму…"));
    var r = ZJ.monthRange(prm.ym);
    Promise.all([call("zh_point_get", { p_point: prm.id }), call("zh_entries", { p_point: prm.id, p_journal: prm.journal, p_from: r.from, p_to: r.to })]).then(function (res) {
      var p = res[0];
      ZJ.mount([topbar(p, "j"), page(
        h("div", { class: "print-bar" },
          h("a", { class: "btn ghost", href: "#/o/p/" + p.id + "/j/" + prm.journal + "/" + prm.ym, text: "← Назад" }),
          h("button", { class: "btn primary", text: "Печать или сохранить в PDF", onclick: function () { window.print(); } }),
          h("span", { class: "small muted", text: "В окне печати выберите «Сохранить как PDF», ориентация — альбомная." })),
        ZJ.renderDoc(prm.journal, res[1], prm.ym))]);
    }, function (e) { ZJ.fatal(e); });
  });

  // ------------------------------------------------------------ оборудование
  ZJ.route("/o/p/:id/units", function (prm) {
    withPoint(prm.id, "units", function (p) {
      function unitRow(u) {
        return h("div", { class: "unit" },
          h("span", { class: "u-main" }, h("b", { text: u.name }), h("span", { class: "small muted", text: [u.room, ZJ.range(u), u.h_max != null ? "влажность до " + u.h_max + " %" : ""].filter(Boolean).join(" · ") })),
          h("span", { class: "row" },
            h("button", { class: "btn small ghost", text: "Изменить", onclick: function () { unitForm(p, u.kind, u); } }),
            h("button", { class: "btn small ghost", text: "Убрать", onclick: function () {
              ZJ.confirm("Убрать «" + u.name + "»?", "Старые записи по нему останутся в журналах.", "Убрать", function () {
                call("zh_unit_remove", { p_point: p.id, p_unit: u.id }).then(reload, fail);
              }, true);
            } })));
      }
      return page(
        h("div", { class: "page-head" }, h("div", null, h("span", { class: "label", text: "Оборудование" }), h("h1", { text: "Холодильники, склады, фритюр" })),
          p.units.length ? h("a", { class: "btn primary", href: "#/o/p/" + p.id + "/units/qr", text: "QR-наклейки" }) : null),
        ["fridge", "store", "fryer"].map(function (k) {
          var list = p.units.filter(function (u) { return u.kind === k; });
          return h("section", { class: "card form" },
            h("div", { class: "page-head" }, h("h2", { text: ZJ.UNIT_KIND[k].title }), h("button", { class: "btn small", text: "+ " + ZJ.UNIT_KIND[k].add, onclick: function () { unitForm(p, k); } })),
            list.length ? h("div", { class: "units-list" }, list.map(unitRow)) : h("p", { class: "muted small", text: "Пока ничего не добавлено." }));
        }));
    });
  });
  function unitForm(p, kind, u) {
    u = u || {};
    var name = h("input", { value: u.name || "" }), room = h("input", { value: u.room || "", placeholder: kind === "store" ? "" : "Горячий цех, бар…" });
    var tmin = h("input", { inputmode: "decimal", value: u.t_min != null ? u.t_min : "" }), tmax = h("input", { inputmode: "decimal", value: u.t_max != null ? u.t_max : "" });
    var hmax = h("input", { inputmode: "decimal", value: u.h_max != null ? u.h_max : "" });
    var presets = u.id ? null : h("div", { class: "row" }, ZJ.PRESETS.filter(function (x) { return x.kind === kind; }).map(function (x) {
      return h("button", { type: "button", class: "btn small ghost", text: x.name, onclick: function () {
        name.value = x.name; tmin.value = x.t_min != null ? x.t_min : ""; tmax.value = x.t_max != null ? x.t_max : ""; hmax.value = x.h_max != null ? x.h_max : "";
      } });
    }));
    var body = h("div", { class: "form" }, presets ? h("div", { class: "small muted", text: "Быстрый выбор:" }) : null, presets,
      h("label", null, "Название", name),
      kind !== "store" ? h("label", null, "Помещение", room) : null,
      kind !== "fryer" ? h("div", { class: "grid2" }, h("label", null, "Норма от, °C", tmin), h("label", null, "Норма до, °C", tmax)) : null,
      kind === "store" ? h("label", null, "Влажность не выше, %", hmax) : null);
    ZJ.modal(u.id ? "Изменить" : ZJ.UNIT_KIND[kind].add, body, [
      { text: "Отмена", kind: "ghost" },
      { text: "Сохранить", kind: "primary", keep: true, onclick: function (close) {
        var unit = { kind: kind, name: name.value, room: room.value, t_min: ZJ.parseNum(tmin.value), t_max: ZJ.parseNum(tmax.value), h_max: ZJ.parseNum(hmax.value) };
        if (u.id) unit.id = u.id;
        call("zh_unit_save", { p_point: p.id, p_unit: unit }).then(function () { close(); reload(); }, fail);
        return false;
      } }]);
  }
  ZJ.route("/o/p/:id/units/qr", function (prm) {
    withPoint(prm.id, "units", function (p) {
      var list = p.units.filter(function (u) { return u.kind !== "fryer"; });
      return page(
        h("div", { class: "print-bar" },
          h("a", { class: "btn ghost", href: "#/o/p/" + p.id + "/units", text: "← Назад" }),
          h("button", { class: "btn primary", text: "Печать", onclick: function () { window.print(); } }),
          h("span", { class: "small muted", text: "Вырежьте и приклейте на дверцу. Сотрудник сканирует камерой телефона и сразу вводит температуру." })),
        h("div", { class: "stickers" }, list.map(function (u) {
          return h("div", { class: "sticker" }, h("small", { text: "Журналка · " + p.name }), h("span", { class: "qr" }, ZJ.qrSvg(ZJ.appUrl("/u/" + u.qr), 150)),
            h("b", { text: u.name }), h("small", { text: "Отсканируйте и запишите " + (u.kind === "store" ? "температуру и влажность" : "температуру") + (u.t_min != null || u.t_max != null ? " · " + ZJ.range(u) : "") }));
        })));
    });
  });

  // ------------------------------------------------------------ команда
  ZJ.route("/o/p/:id/team", function (prm) {
    withPoint(prm.id, "team", function (p) {
      var link = ZJ.appUrl("/join/" + p.invite_code);
      var rows = p.staff.map(function (s) {
        var med = h("input", { type: "date", value: s.med_until || "", style: "min-height:36px;padding:4px 8px;width:auto", "aria-label": "Медкнижка действует до", onchange: function (ev) {
          call("zh_staff_update", { p_point: p.id, p_staff: s.id, p_patch: { med_until: ev.target.value || null } }).then(function () { ZJ.toast("Срок медкнижки сохранён"); }, fail);
        } });
        var left = ZJ.dayLeft(s.med_until);
        return h("tr", { class: s.active ? null : "off" },
          h("td", null, h("b", { text: s.name }), h("div", { class: "small muted", text: "был(а) " + ZJ.ago(s.last_seen) })),
          h("td", null, h("select", { style: "min-height:36px;padding:4px 8px;width:auto", onchange: function (ev) {
            call("zh_staff_update", { p_point: p.id, p_staff: s.id, p_patch: { role: ev.target.value } }).then(function () { ZJ.toast("Сохранено"); }, fail);
          } }, (ZJ.ROLES.indexOf(s.role) < 0 ? [s.role].concat(ZJ.ROLES) : ZJ.ROLES).map(function (r) { return h("option", { value: r, text: r, selected: r === s.role ? true : null }); }))),
          h("td", null, h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.is_resp, onchange: function (ev) {
            call("zh_staff_update", { p_point: p.id, p_staff: s.id, p_patch: { is_resp: ev.target.checked } }).then(function () { ZJ.toast(ev.target.checked ? "Теперь допускает к смене" : "Снято"); }, fail);
          } }), "допускает")),
          h("td", null, med, left != null && left < 0 ? h("div", { class: "small", style: "color:var(--bad)", text: "просрочена" }) : left != null && left <= 30 ? h("div", { class: "small warn-text", text: "осталось " + left + " дн." }) : null),
          h("td", { class: "actions" },
            h("button", { class: "btn small ghost", text: "Ссылка", onclick: function () {
              call("zh_staff_link", { p_point: p.id, p_staff: s.id }).then(function (r) {
                var url = ZJ.appUrl("/s/login/" + r.token);
                ZJ.modal("Личная ссылка: " + s.name, h("div", { class: "form" }, h("p", { class: "muted small", text: "Старая ссылка больше не работает. Отправьте новую сотруднику — по ней он войдёт без кода." }),
                  h("div", { class: "invite-link", text: url }), h("span", { class: "qr", style: "justify-self:start" }, ZJ.qrSvg(url, 160))),
                  [{ text: "Скопировать", kind: "primary", onclick: function () { ZJ.copy(url); } }]);
              }, fail);
            } }),
            h("button", { class: "btn small ghost", text: s.active ? "Отключить" : "Вернуть", onclick: function () {
              call("zh_staff_update", { p_point: p.id, p_staff: s.id, p_patch: { active: !s.active } }).then(reload, fail);
            } })));
      });
      return page(
        h("div", { class: "page-head" }, h("div", null, h("span", { class: "label", text: "Команда" }), h("h1", { text: "Сотрудники" })),
          h("a", { class: "btn", href: "#/o/p/" + p.id + "/team/poster", text: "Плакат с QR" })),
        h("div", { class: "card invite" },
          h("div", { class: "invite-main" },
            h("h2", { text: "Как подключить сотрудника" }),
            h("p", { class: "muted small", text: "Сотрудник открывает ссылку или сканирует QR, вводит фамилию и имя — и всё. Пароли не нужны." }),
            h("div", { class: "invite-link", text: link }),
            h("div", { class: "row" },
              h("span", null, "Код точки: ", h("b", { class: "code", text: p.invite_code })),
              h("button", { class: "btn small", text: "Скопировать ссылку", onclick: function () { ZJ.copy(link); } }),
              h("button", { class: "btn small ghost", text: "Новый код", onclick: function () {
                ZJ.confirm("Сменить код?", "Старый код и QR перестанут работать для новых сотрудников. Уже подключённые останутся.", "Сменить", function () {
                  call("zh_invite_new", { p_point: p.id }).then(reload, fail);
                });
              } }))),
          h("span", { class: "qr" }, ZJ.qrSvg(link, 150))),
        p.staff.length ? h("div", { class: "table-box" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, ["Сотрудник", "Должность", "Допуск к смене", "Медкнижка до", ""].map(function (c) { return h("th", { text: c }); }))),
          h("tbody", null, rows))) : h("p", { class: "muted", text: "Пока никто не подключился." }));
    });
  });
  ZJ.route("/o/p/:id/team/poster", function (prm) {
    withPoint(prm.id, "team", function (p) {
      var link = ZJ.appUrl("/join/" + p.invite_code);
      return page(h("div", { class: "print-bar" },
        h("a", { class: "btn ghost", href: "#/o/p/" + p.id + "/team", text: "← Назад" }),
        h("button", { class: "btn primary", text: "Печать", onclick: function () { window.print(); } })),
        h("div", { class: "poster" }, h("h1", { text: "Санитарные журналы — в телефоне" }),
          h("p", { text: "Отсканируйте камерой телефона, введите фамилию и имя. Каждую смену отмечайтесь здесь — бумажные журналы больше не нужны." }),
          h("span", { class: "qr" }, ZJ.qrSvg(link, 260)),
          h("div", null, "Или откройте ", h("b", { text: location.host + location.pathname }), " и введите код"), h("div", { class: "code", text: p.invite_code }),
          h("small", { text: p.name })));
    });
  });

  // ------------------------------------------------------------ настройки
  ZJ.route("/o/p/:id/settings", function (prm) {
    withPoint(prm.id, "settings", function (p) {
      var name = h("input", { value: p.name }), addr = h("input", { value: p.address }), org = h("input", { value: p.org });
      var checks = ZJ.J_ORDER.map(function (k) {
        return h("label", { class: "check" }, h("input", { type: "checkbox", name: "j", value: k, checked: p.journals.indexOf(k) >= 0 }),
          h("span", null, ZJ.J[k].title, ZJ.J[k].mandatory ? null : h("span", { class: "small muted", text: " — рекомендуемый" })));
      });
      return page(
        h("div", { class: "page-head" }, h("div", null, h("span", { class: "label", text: "Настройки" }), h("h1", { text: p.name }))),
        h("form", { class: "card form", style: "max-width:680px", onsubmit: function (ev) {
          ev.preventDefault();
          var j = checks.map(function (c) { return c.querySelector("input"); }).filter(function (i) { return i.checked; }).map(function (i) { return i.value; });
          if (!j.length) { ZJ.toast("Оставьте хотя бы один журнал", "bad"); return; }
          call("zh_point_update", { p_point: p.id, p_patch: { name: name.value, address: addr.value, org: org.value, journals: j } }).then(function () { ZJ.toast("Сохранено"); reload(); }, fail);
        } },
          h("label", null, "Название", name), h("label", null, "Адрес", addr), h("label", null, "Юрлицо или ИП (для шапки журналов)", org),
          h("fieldset", null, h("legend", { text: "Какие журналы ведём" }), checks),
          h("button", { class: "btn primary", type: "submit", text: "Сохранить" })),
        h("div", { class: "card form", style: "max-width:680px" }, h("h2", { text: "Тариф" }),
          h("p", { class: "muted small", text: "Сейчас пробный период — все функции открыты. Тарифы: «Точка» 1 990 ₽/мес (до 15 сотрудников), «Кухня» 2 990 ₽/мес (до 40 сотрудников и печать всех журналов), «Сеть» 4 990 ₽/мес (до 3 точек). Для подключения оплаты напишите нам." })),
        h("div", { class: "card form", style: "max-width:680px" }, h("h2", { text: "Закрыть точку" }),
          h("p", { class: "muted small", text: "Сотрудники потеряют доступ. Записи журналов сохранятся." }),
          h("button", { class: "btn danger", text: "Закрыть точку", onclick: function () {
            ZJ.confirm("Закрыть «" + p.name + "»?", "Сотрудники потеряют доступ к журналам этой точки.", "Закрыть", function () {
              call("zh_point_archive", { p_point: p.id }).then(function () { ZJ.go("/o"); }, fail);
            }, true);
          } })));
    });
  });
})();
