/* «Журналка» — команда агентов санконтроля (экран на общем модуле AGUI из «Трио»). */
(function () {
  "use strict";
  var ZJ = window.ZJ, A = ZJ.app;
  function srv(action, args) {
    return fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ action: action, token: A.tok() }, args || {})) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || "Ошибка сервера"); e.hint = d.hint; throw e; } return d; }); },
        function () { throw new Error("Нет связи с сервером"); });
  }
  function pct(x) { return Math.round((Number(x) || 0) * 100) + "%"; }
  function dmy(iso) { return iso ? iso.slice(0, 10).split("-").reverse().join(".") : "—"; }
  var MED = { expired: "просрочена", week: "меньше недели", month: "меньше месяца", ok: "в порядке", none: "не указан срок" };
  function cfg(root) {
    return {
      title: "Санконтроль под присмотром", sub: "Пять агентов каждое утро проверяют журналы всех точек, по понедельникам — готовность к проверке.",
      lead: "chef", runText: "Проверить сейчас", emptyText: "Сначала создайте точку и пригласите сотрудников",
      agents: [
        { id: "chef", name: "Шеф-контроль", ico: "👨‍🍳", role: "План на неделю и ответы на вопросы по журналам и СанПиН" },
        { id: "sanitary", name: "Санинспектор", ico: "🧼", role: "Каждое утро: что не заполнено вчера, кто не отметился, отклонения без мер" },
        { id: "medbook", name: "Медкнижки", ico: "🩺", role: "Сроки медкнижек всех сотрудников, напоминания заранее" },
        { id: "equipment", name: "Оборудование", ico: "❄️", role: "Холодильники и склады: тревоги, тренды, что пора чинить" },
        { id: "inspection", name: "Готовность к проверке", ico: "🛡", role: "Оценка 0–100 и список, что исправить до визита Роспотребнадзора" }
      ],
      suggest: ["Что не заполнено вчера?", "У кого заканчивается медкнижка?", "Готовы ли мы к проверке?", "Какая температура должна быть в морозильнике?", "Как правильно вести бракераж?"],
      askTitle: "Спросить шеф-контроль", hello: "Здравствуйте! Спросите про журналы, температуру, медкнижки или нормы СанПиН — отвечу по вашим данным.", placeholder: "Например: что нужно для проверки Роспотребнадзора?",
      href: function (id) { return "#/o/agents" + (id ? "/" + id : ""); },
      home: function () { return A.call("zh_agent", { p_op: "home", p_args: {} }); },
      get: function (id) { return A.call("zh_agent", { p_op: "insight_get", p_args: { agent: id } }); },
      server: srv, reload: function () { ZJ.dispatch(); },
      detail: {
        sanitary: function (i, h) {
          var d = i.data || {};
          return (d.points || []).map(function (p) {
            return h("section", { class: "card" }, h("h2", { text: p.name + " · заполнено " + pct(p.score) + " (" + p.done + " из " + p.req + ")" }),
              p.missing.length ? AGUI.table(["Что не заполнено", "День"], p.missing.map(function (m) { return [m.what, dmy(m.day)]; })) : h("p", { class: "muted", text: "Всё заполнено." }));
          });
        },
        medbook: function (i, h) {
          var rows = (i.data && i.data.rows) || [];
          return rows.length ? h("section", { class: "card" }, h("h2", { text: "Сотрудники" }), AGUI.table(["Сотрудник", "Должность", "Точка", "Медкнижка до", "Статус"], rows.map(function (r) {
            return [r.name, r.role, r.point, dmy(r.med_until), h("span", { class: r.status === "ok" ? "ag-up" : r.status === "month" ? null : "ag-down", text: MED[r.status] + (r.left != null && r.left >= 0 && r.status !== "ok" ? " (" + r.left + " дн.)" : "") })];
          }))) : null;
        },
        equipment: function (i, h) {
          var u = (i.data && i.data.units) || [];
          return u.length ? h("section", { class: "card" }, h("h2", { text: "Замеры за неделю" }), AGUI.table(["Оборудование", "Норма", "Замеров", "Выходов за норму", "Средняя", "Мин…макс", "Прошлая неделя"], u.map(function (x) {
            return [x.name + (x.point ? " · " + x.point : ""), (x.t_min == null ? "…" : x.t_min) + "…" + (x.t_max == null ? "…" : x.t_max) + "°", String(x.entries), h("span", { class: x.alerts ? "ag-down" : null, text: String(x.alerts) }),
              x.avg == null ? "—" : x.avg + "°", x.min == null ? "—" : x.min + "…" + x.max + "°", x.prev_avg == null ? "—" : x.prev_avg + "°"];
          }), [2, 3, 4, 5, 6])) : null;
        },
        inspection: function (i, h) {
          var d = i.data || {};
          return [h("div", { class: "ag-kpis" }, h("div", { class: "ag-kpi" }, h("span", { text: "Готовность" }), h("b", { text: d.score == null ? "—" : d.score + " / 100" }), h("small", { text: d.verdict })),
              (d.points || []).map(function (p) { return h("div", { class: "ag-kpi" }, h("span", { text: p.name }), h("b", { text: String(p.score) }), h("small", { text: "журналы " + pct(p.fill) + " · пустых дней " + p.empty_days })); })),
            h("section", { class: "card" }, h("h2", { text: "Что проверит инспектор" }), h("ul", null, (d.checklist || []).map(function (c) { return h("li", { text: c }); })),
              h("p", { class: "small muted", text: "Оценка за последние 30 дней: заполненность журналов (70 баллов), медкнижки (20), отклонения с мерами (10), минус баллы за выключенные журналы." }))];
        }
      }
    };
  }
  function screen(render) {
    if (!A.need()) return;
    var root = ZJ.h("main", { class: "wrap page" });
    ZJ.mount([A.topbar(null, "agents"), root]);
    render(root);
  }
  ZJ.route("/o/agents", function () { screen(function (root) { AGUI.overview(root, cfg(root)); }); });
  ZJ.route("/o/agents/:agent", function (p) { screen(function (root) { AGUI.detail(root, cfg(root), p.agent); }); });
})();
