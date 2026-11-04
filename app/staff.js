/* «Журналка» — экран сотрудника: отметка о здоровье, температуры по QR, фритюр, бракераж, уборки. */
(function () {
  "use strict";
  var ZJ = window.ZJ, h = ZJ.h;

  ZJ.staffSession = function () { try { return JSON.parse(ZJ.store.get("zj_staff") || "null"); } catch (e) { return null; } };
  function setStaff(s) { ZJ.store.set("zj_staff", s ? JSON.stringify(s) : null); }
  function tok() { var s = ZJ.staffSession(); return s && s.token; }
  function call(fn, args) {
    return ZJ.api(fn, Object.assign({ p_token: tok() }, args || {})).catch(function (e) {
      if (e.hint === "auth") { setStaff(null); ZJ.toast(e.message, "bad"); ZJ.go("/code"); }
      throw e;
    });
  }
  function shell(title, content) {
    return h("main", { class: "page narrow staff-page", style: "max-width:560px" },
      h("div", { class: "row", style: "justify-content:space-between" }, h("a", { class: "brand", href: "#/s", text: "Журналка" }), title ? h("span", { class: "small muted", text: title }) : null),
      content);
  }

  // ------------------------------------------------------------ подключение
  function joinPage(code) {
    var c = h("input", { value: code || "", autocomplete: "off", autocapitalize: "characters", placeholder: "Например: K7M2QX", class: "code", style: "text-transform:uppercase" });
    var name = h("input", { autocomplete: "name", placeholder: "Иванов Иван" });
    var role = h("select", null, ZJ.ROLES.map(function (r) { return h("option", { value: r, text: r }); }));
    var err = h("p", { class: "form-err", role: "alert" });
    var btn = h("button", { class: "btn primary wide", type: "submit", text: "Начать" });
    ZJ.mount(shell(null, h("form", { class: "card form", onsubmit: function (ev) {
      ev.preventDefault(); btn.disabled = true; err.textContent = "";
      ZJ.api("zh_join", { p_code: c.value, p_name: name.value, p_role: role.value }).then(function (r) {
        setStaff({ token: r.token, name: r.name, point: r.point });
        var back = sessionStorage.getItem("zj_after"); try { sessionStorage.removeItem("zj_after"); } catch (e) {}
        ZJ.go(back || "/s");
      }, function (e) { err.textContent = e.message; btn.disabled = false; });
    } },
      h("h1", { text: "Подключение к точке" }),
      h("p", { class: "muted small", text: "Фамилия и имя попадут в журналы — пишите как в паспорте." }),
      code ? null : h("label", null, "Код точки", c),
      h("label", null, "Фамилия и имя", name), h("label", null, "Должность", role), err, btn)));
    setTimeout(function () { (code ? name : c).focus(); }, 50);
  }
  ZJ.route("/code", function () { joinPage(""); });
  ZJ.route("/join/:code", function (p) {
    if (tok()) {
      ZJ.mount(shell(null, h("div", { class: "card form" }, h("h2", { text: "Вы уже подключены" }),
        h("p", { class: "muted", text: "На этом телефоне уже вошёл " + (ZJ.staffSession().name || "сотрудник") + "." }),
        h("a", { class: "btn primary", href: "#/s", text: "Продолжить" }),
        h("button", { class: "btn ghost", text: "Это не я — подключиться заново", onclick: function () { setStaff(null); joinPage(p.code); } }))));
      return;
    }
    joinPage(p.code);
  });
  ZJ.route("/s/login/:token", function (p) {
    setStaff({ token: p.token });
    ZJ.go("/s");
  });
  ZJ.route("/s/logout", function () { setStaff(null); ZJ.go("/"); });

  // ------------------------------------------------------------ главный экран смены
  ZJ.route("/s", function () {
    if (!tok()) { ZJ.go("/code"); return; }
    ZJ.mount(shell(null, ZJ.loading()));
    call("zh_home").then(function (d) {
      var s = ZJ.staffSession(); s.name = d.me.name; s.point = d.point.name; setStaff(s);
      ZJ.mount(shell(d.point.name, home(d)));
    }, function (e) { if (e.hint !== "auth") ZJ.mount(shell(null, h("div", { class: "card form" }, h("p", { text: e.message }), h("button", { class: "btn", text: "Повторить", onclick: function () { ZJ.dispatch(); } })))); });
  });

  function send(journal) { return function (data, uid) { return call("zh_staff_entry", { p_journal: journal, p_unit: uid, p_data: data }); }; }
  function refresh() { ZJ.dispatch(); }

  function home(d) {
    var j = d.point.journals, out = [];
    out.push(h("div", { class: "hello" }, h("span", { class: "label", text: "Смена · " + ZJ.dayFmt(ZJ.todayISO()) }), h("h1", { text: d.me.name.split(" ").slice(-1)[0] + ", привет!" })));
    if (j.indexOf("health") >= 0) out.push(healthCard(d));
    if (d.pending.length) {
      out.push(h("div", { class: "card shift" }, h("h2", { text: "Допуск к смене" }),
        h("p", { class: "small muted", text: "Вы ответственный: проверьте сотрудников и допустите к работе." }),
        h("ul", { class: "lines" }, d.pending.map(function (e) {
          var sick = !(e.data.no_infection && e.data.no_skin);
          return h("li", null, h("span", null, h("b", { text: e.author }), " · " + ZJ.timeFmt(e.created_at), sick ? h("div", { class: "small", style: "color:var(--bad)", text: "отметил(а) признаки болезни" }) : null),
            h("span", { class: "row" },
              h("button", { class: "btn small primary", text: "Допустить", onclick: function () { admit(e, true); } }),
              h("button", { class: "btn small danger", text: "Отстранить", onclick: function () { admit(e, false); } })));
        }))));
    }
    var tUnits = d.units.filter(function (u) { return (u.kind === "fridge" || u.kind === "store") && j.indexOf(u.kind) >= 0; });
    if (tUnits.length) {
      var left = tUnits.filter(function (u) { return !u.done; }).length;
      out.push(h("section", { class: "card form" },
        h("div", { class: "page-head" }, h("h2", { text: "Температура" }), h("span", { class: "pill " + (left ? "todo" : "ok"), text: left ? "осталось " + left : "всё записано" })),
        h("p", { class: "small muted", text: "Нажмите на холодильник или отсканируйте QR на его дверце." }),
        h("div", { class: "units-list" }, tUnits.map(function (u) {
          return h("button", { class: "unit " + (u.done ? "done" : "need"), style: "text-align:left;font:inherit;color:inherit;cursor:pointer;width:100%", onclick: function () {
            ZJ.openEntry(u.kind, u, d.units, send(u.kind), refresh);
          } }, h("span", { class: "u-main" }, h("b", { text: u.name }), h("span", { class: "small muted", text: [u.room, ZJ.range(u)].filter(Boolean).join(" · ") })),
            h("span", { class: "pill " + (u.done ? "ok" : "todo"), text: u.done ? "записано" : "записать" }));
        }))));
    }
    var other = ["fryer", "brak", "clean"].filter(function (k) { return j.indexOf(k) >= 0; });
    if (other.length) {
      out.push(h("div", { class: "tiles" }, other.map(function (k) {
        var n = (d.counts || {})[k] || 0;
        return h("button", { class: "tile", style: "text-align:left;font:inherit;cursor:pointer", onclick: function () {
          ZJ.openEntry(k, null, d.units, send(k), refresh);
        } }, h("b", { text: ZJ.J[k].short }), h("span", { class: "small muted", text: n ? "сегодня: " + n + " " + ZJ.plural(n, "запись", "записи", "записей") : ZJ.J[k].who }));
      })));
    }
    out.push(h("p", { class: "small muted center" }, "Вы вошли как ", h("b", { text: d.me.name }), ". ", h("a", { href: "#/s/logout", text: "Это не я" })));
    return out;
  }

  function healthCard(d) {
    var e = d.health_today;
    if (e) {
      var a = e.data.admitted;
      return h("div", { class: "card shift " + (a === false ? "off" : a === true ? "done" : "") },
        h("h2", { text: a === true ? "Вы допущены к смене" : a === false ? "Вы отстранены от смены" : "Отметка о здоровье принята" }),
        h("p", { class: "muted small", text: "Отметились в " + ZJ.timeFmt(e.created_at) + (a == null ? ". Ждём, когда ответственный допустит к работе." : e.data.admitted_by ? " · " + e.data.admitted_by : "") }));
    }
    var c1 = h("input", { type: "checkbox" }), c2 = h("input", { type: "checkbox" });
    var btn = h("button", { class: "btn primary wide", text: "Отметиться" });
    btn.addEventListener("click", function () {
      var ok = c1.checked && c2.checked;
      function go() {
        btn.disabled = true;
        call("zh_staff_entry", { p_journal: "health", p_unit: null, p_data: { no_infection: c1.checked, no_skin: c2.checked } }).then(function () {
          ZJ.toast("Отметка в гигиеническом журнале сделана"); refresh();
        }, function (er) { btn.disabled = false; ZJ.toast(er.message, "bad"); });
      }
      if (!ok) {
        ZJ.confirm("Отметить признаки болезни?", "Вы не подтвердили один из пунктов. Запись уйдёт ответственному — он решит, допускать ли вас к работе. Это честно и правильно.", "Отправить", go);
      } else go();
    });
    return h("div", { class: "card shift form" },
      h("h2", { text: "Начало смены: здоровье" }),
      h("label", { class: "statement" }, c1, h("span", { text: "У меня и членов моей семьи нет признаков инфекционных заболеваний (температура, рвота, диарея)" })),
      h("label", { class: "statement" }, c2, h("span", { text: "У меня нет простуды и гнойничков, порезов, ожогов на руках и открытых участках кожи" })),
      btn);
  }

  function admit(e, ok) {
    call("zh_staff_admit", { p_entry: e.id, p_admitted: ok }).then(function () { ZJ.toast(ok ? "Допущен" : "Отстранён"); refresh(); }, function (er) { ZJ.toast(er.message, "bad"); });
  }

  // ------------------------------------------------------------ QR с холодильника
  ZJ.route("/u/:qr", function (p) {
    if (!tok()) {
      try { sessionStorage.setItem("zj_after", "/u/" + p.qr); } catch (e) {}
      ZJ.mount(shell(null, h("div", { class: "card form" }, h("h2", { text: "Сначала подключитесь" }),
        h("p", { class: "muted", text: "Это QR холодильника. Чтобы записать температуру, подключитесь к точке по коду от управляющего — один раз." }),
        h("a", { class: "btn primary", href: "#/code", text: "Ввести код" }))));
      return;
    }
    ZJ.mount(shell(null, ZJ.loading()));
    Promise.all([call("zh_unit_by_qr", { p_qr: p.qr }), call("zh_home")]).then(function (r) {
      var u = r[0], d = r[1];
      ZJ.mount(shell(d.point.name, home(d)));
      if (u.kind === "fryer") ZJ.openEntry("fryer", u, d.units, send("fryer"), refresh);
      else ZJ.openEntry(u.kind, u, d.units, send(u.kind), function () { ZJ.go("/s"); });
    }, function (e) { if (e.hint !== "auth") ZJ.mount(shell(null, h("div", { class: "card form" }, h("p", { text: e.message }), h("a", { class: "btn", href: "#/s", text: "На главный экран" })))); });
  });
})();
