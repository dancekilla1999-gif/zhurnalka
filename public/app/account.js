/* Аккаунт: Telegram, устройства, пароль. Общий для сайта и Mini App. */
(function () {
  "use strict";
  var ZJ = window.ZJ, h = ZJ.h;

  function shell(node) {
    var bar = ZJ.app && ZJ.app.topbar ? ZJ.app.topbar(null, "account") : null;
    var page = ZJ.app && ZJ.app.page ? ZJ.app.page(node) : h("main", { class: "wrap page" }, node);
    ZJ.mount(bar ? [bar, page] : page);
  }

  function whenIn(render) {
    if (ZJ.app && ZJ.app.need && !ZJ.app.need()) return;
    ZJ.mount(ZJ.loading());
    render();
  }

  ZJ.route("/o/account", function () {
    whenIn(function () { draw(); });
  });

  function draw() {
    ZJ.apiAuth("/api/auth/devices", null, "GET").then(function (d) {
      shell(h("div", { class: "account" },
        h("div", { class: "page-head" }, h("div", null, h("span", { class: "label", text: "Аккаунт" }), h("h1", { text: "Устройства и вход" }))),
        telegramCard(d.tg),
        devicesCard(d),
        passwordCard(),
        inviteCard()));
    }, function (e) {
      shell(h("div", { class: "card" }, h("p", { text: e.message || "Не удалось загрузить устройства" })));
    });
  }

  function telegramCard(tg) {
    var box = h("div", { class: "card form", style: "max-width:680px" });
    box.appendChild(h("h2", { text: "Telegram" }));
    if (tg && (tg.username || tg.first_name || tg.bound_at)) {
      var who = tg.username ? "@" + tg.username : (tg.first_name || "Telegram");
      box.appendChild(h("p", { text: "Привязан Telegram " + who + " — это вы?" }));
      if (tg.bound_at && (Date.now() - new Date(tg.bound_at).getTime()) < 86400000) {
        box.appendChild(h("p", { class: "notice", text: "Если это были не вы, нажмите «Это не я». Привязка снимется." }));
      }
      box.appendChild(h("div", { class: "row" },
        h("button", { class: "btn danger", type: "button", text: "Это не я", onclick: function () { dispute(); } }),
        h("button", { class: "btn ghost", type: "button", text: "Отвязать", onclick: function () {
          ZJ.confirm("Отвязать Telegram?", "В Mini App понадобится новая привязка.", "Отвязать", function () {
            ZJ.apiAuth("/api/tg/unbind", {}).then(function () { ZJ.toast("Telegram отвязан"); draw(); }, function (e) { ZJ.toast(e.message, "bad"); });
          }, true);
        } })));
      return box;
    }
    box.appendChild(h("p", { class: "muted", text: "Привяжите Telegram один раз — дальше кабинет открывается из бота без пароля." }));
    box.appendChild(h("button", { class: "btn primary", type: "button", text: "Привязать Telegram", onclick: function () { issue(box); } }));
    return box;
  }

  function issue(box) {
    ZJ.apiAuth("/api/auth/link-code", {}).then(function (d) {
      var holder = h("div", { class: "form" });
      box.appendChild(holder);
      showCode(holder, d);
    }, function (e) { ZJ.toast(e.message, "bad"); });
  }

  function showCode(holder, d) {
    holder.textContent = "";
    var link = h("a", { href: d.url, text: "Открыть в Telegram" });
    link.addEventListener("click", function (ev) {
      if (ZJ.tg) { ev.preventDefault(); ZJ.openExternal(d.url); }
    });
    holder.appendChild(h("p", { class: "muted small", text: "Код действует 10 минут и только один раз. Не пересылайте его." }));
    holder.appendChild(h("div", { class: "invite-link", text: d.url }));
    holder.appendChild(h("div", { class: "row" }, link, h("button", { class: "btn small", type: "button", text: "Скопировать", onclick: function () { ZJ.copy(d.url); } })));
    if (ZJ.qrSvg) holder.appendChild(h("span", { class: "qr" }, ZJ.qrSvg(d.url, 180)));
    var timer = setInterval(function () {
      ZJ.apiAuth("/api/auth/link-status?code=" + encodeURIComponent(d.code), null, "GET").then(function (s) {
        if (s && s.status === "linked") {
          clearInterval(timer);
          holder.textContent = "";
          var who = s.username ? "@" + s.username : "Telegram";
          holder.appendChild(h("p", { text: "Привязан Telegram " + who + " — это вы?" }));
          holder.appendChild(h("button", { class: "btn danger", type: "button", text: "Это не я", onclick: function () { dispute(d.code); } }));
        }
      }, function () {});
    }, 2000);
  }

  function dispute(code) {
    ZJ.apiAuth("/api/auth/link-dispute", { code: code || "" }).then(function () {
      ZJ.toast("Telegram отвязан");
      draw();
    }, function (e) { ZJ.toast(e.message, "bad"); });
  }

  function devicesCard(d) {
    var rows = (d.devices || []).map(function (s) {
      return h("tr", null,
        h("td", { text: s.kind === "tg" ? "Telegram" : "Сайт" }),
        h("td", { text: s.label || "—" }),
        h("td", { text: ZJ.fmtDate(s.created_at, true) }),
        h("td", { text: ZJ.fmtDate(s.last_used_at, true) }),
        h("td", { text: s.current ? "Это устройство" : "" }),
        h("td", null, s.current ? null : h("button", { class: "btn small ghost", type: "button", text: "Завершить", onclick: function () { endDevice(s); } })));
    });
    return h("div", { class: "card form", style: "max-width:680px" },
      h("h2", { text: "Устройства" }),
      d.tg && d.tg.username ? h("p", { class: "small muted", text: "Telegram: @" + d.tg.username }) : null,
      rows.length ? h("div", { class: "table-box" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, ["Где", "Устройство", "Вход", "Был", "", ""].map(function (c) { return h("th", { text: c }); }))),
        h("tbody", null, rows))) : h("p", { class: "muted", text: "Активных сессий нет." }),
      h("button", { class: "btn danger", type: "button", text: "Выйти на всех устройствах", onclick: function () {
        ZJ.confirm("Выйти везде?", "Все сессии и привязка Telegram будут сняты.", "Выйти везде", function () {
          ZJ.apiAuth("/api/auth/logout-all", {}).then(function () { ZJ.clearAuth(); ZJ.go("/login"); }, function (e) { ZJ.toast(e.message, "bad"); });
        }, true);
      } }));
  }

  function endDevice(s) {
    ZJ.confirm("Завершить сессию?", s.kind === "tg" ? "Привязка Telegram тоже снимется." : "Это устройство попросит войти снова.", "Завершить", function () {
      ZJ.apiAuth("/api/auth/devices/" + s.id + "/end", {}).then(function () { ZJ.toast("Сессия завершена"); draw(); }, function (e) { ZJ.toast(e.message, "bad"); });
    }, true);
  }

  function passwordCard() {
    var cur = h("input", { type: "password", autocomplete: "current-password", required: true });
    var nxt = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 8 });
    var err = h("p", { class: "form-err", role: "alert" });
    return h("form", { class: "card form", style: "max-width:680px", onsubmit: function (ev) {
      ev.preventDefault();
      err.textContent = "";
      ZJ.apiAuth("/api/auth/password", { current: cur.value, new: nxt.value }).then(function () {
        cur.value = ""; nxt.value = "";
        ZJ.toast("Пароль изменён");
      }, function (e) { err.textContent = e.message; });
    } },
      h("h2", { text: "Сменить пароль" }),
      h("p", { class: "muted small", text: "Нужен текущий пароль. Остальные сессии закроются." }),
      h("label", null, "Текущий пароль", cur),
      h("label", null, "Новый пароль", nxt),
      err,
      h("button", { class: "btn primary", type: "submit", text: "Сменить пароль" }));
  }

  function inviteCard() {
    if (ZJ.tg) return null;
    var out = h("div", { class: "form" });
    return h("div", { class: "card form", style: "max-width:680px" },
      h("h2", { text: "Приглашение" }),
      h("p", { class: "muted small", text: "Регистрация закрыта. Одноразовая ссылка действует 7 дней." }),
      h("button", { class: "btn", type: "button", text: "Создать ссылку", onclick: function () {
        ZJ.apiAuth("/api/auth/invite", {}).then(function (d) {
          var url = location.origin + "/app/#/register?invite=" + d.code;
          out.textContent = "";
          out.appendChild(h("div", { class: "invite-link", text: url }));
          out.appendChild(h("button", { class: "btn small", type: "button", text: "Скопировать", onclick: function () { ZJ.copy(url); } }));
        }, function (e) { ZJ.toast(e.message, "bad"); });
      } }),
      out);
  }
})();
