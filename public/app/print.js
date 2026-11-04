/* «Журналка» — печатные формы журналов по образцам СанПиН 2.3/2.4.3590-20. */
(function () {
  "use strict";
  var ZJ = window.ZJ, h = ZJ.h;

  function sign(e) { return e.author + (e.author_role ? ", " + e.author_role : "") + " · ЭО " + ZJ.timeFmt(e.created_at); }
  function voidRow(tr, e, cols) {
    if (!e.voided) return [tr];
    tr.className = "voided";
    return [tr, h("tr", { class: "voided" }, h("td", { class: "l reason", colspan: cols, text: "↑ Запись аннулирована: " + e.void_reason }))];
  }

  function header(J, d, ym) {
    var p = d.point;
    return [
      h("div", { class: "doc-meta" }, p.org ? h("div", { text: p.org }) : null, h("div", { text: p.name + (p.address ? ", " + p.address : "") })),
      h("h1", { text: J.title }),
      h("div", { class: "doc-meta", text: "Период: " + ZJ.monthName(ym) })
    ];
  }

  // сетка «помещение × дни месяца» для холодильников и складов
  function gridDoc(journal, d, ym) {
    var r = ZJ.monthRange(ym), units = d.units.filter(function (u) { return u.kind === journal; });
    var byUD = {};
    d.entries.forEach(function (e) {
      if (e.voided || !e.unit_id) return;
      byUD[e.unit_id + "|" + e.day] = e; // последняя запись за день
    });
    var days = []; for (var i = 1; i <= r.days; i++) days.push(i);
    var head1 = h("tr", null, h("th", { rowspan: 2, text: journal === "store" ? "Наименование складского помещения" : "Наименование производственного помещения" }),
      journal === "fridge" ? h("th", { rowspan: 2, text: "Наименование холодильного оборудования" }) : null,
      h("th", { colspan: r.days, text: journal === "store" ? "Месяц/дни: температура, °C / относительная влажность, %" : "Температура в градусах Цельсия — дни месяца" }));
    var head2 = h("tr", null, days.map(function (x) { return h("th", { text: String(x) }); }));
    var rows = units.map(function (u) {
      return h("tr", null,
        h("td", { class: "l", text: journal === "store" ? u.name : (u.room || "—") }),
        journal === "fridge" ? h("td", { class: "l", text: u.name + (u.t_min != null || u.t_max != null ? " (" + ZJ.range(u) + ")" : "") }) : null,
        days.map(function (x) {
          var e = byUD[u.id + "|" + ym + "-" + String(x).padStart(2, "0")];
          if (!e) return h("td");
          var t = String(e.data.t).replace(".", ",");
          var txt = journal === "store" && e.data.h != null ? t + "/" + String(e.data.h).replace(".", ",") : t;
          return h("td", { class: e.alert ? "alarm" : null, title: sign(e), text: txt });
        }));
    });
    var notes = d.entries.filter(function (e) { return !e.voided && e.alert; }).map(function (e) {
      var u = units.filter(function (x) { return x.id === e.unit_id; })[0];
      return h("li", { text: ZJ.dayFmt(e.day) + ", " + (u ? u.name : "") + ": " + ZJ.t(e.data.t) + (e.data.h != null ? ", " + e.data.h + " %" : "") + " — " + (e.data.action || "меры не указаны") + " (" + e.author + ")" });
    });
    var voided = d.entries.filter(function (e) { return e.voided; }).map(function (e) {
      return h("li", { text: ZJ.dayFmt(e.day) + ": запись " + ZJ.t(e.data.t) + " аннулирована — " + e.void_reason });
    });
    return [
      h("table", { class: "grid-t" }, h("thead", null, head1, head2), h("tbody", null, rows.length ? rows : h("tr", null, h("td", { colspan: r.days + 2, text: "Оборудование не добавлено" })))),
      notes.length ? h("div", { class: "doc-foot" }, h("b", { text: "Отклонения от нормы и принятые меры:" }), h("ul", null, notes)) : null,
      voided.length ? h("div", { class: "doc-foot" }, h("b", { text: "Аннулированные записи:" }), h("ul", null, voided)) : null
    ];
  }

  function listDoc(journal, d) {
    var unitsById = {}; d.units.forEach(function (u) { unitsById[u.id] = u; });
    var cols, rowFn;
    if (journal === "health") {
      cols = ["№ п/п", "Дата", "Ф. И. О. работника", "Должность",
        "Подпись сотрудника об отсутствии признаков инфекционных заболеваний у сотрудника и членов семьи",
        "Подпись сотрудника об отсутствии заболеваний верхних дыхательных путей и гнойничковых заболеваний кожи рук и открытых поверхностей тела",
        "Результат осмотра ответственным лицом (допущен / отстранён)", "Подпись ответственного лица"];
      rowFn = function (e, i) {
        var dd = e.data;
        return [i, ZJ.dayFmt(e.day), h("span", { text: e.author }), e.author_role,
          dd.no_infection ? "Подтверждаю · ЭО " + ZJ.timeFmt(e.created_at) : "Не подтверждено",
          dd.no_skin ? "Подтверждаю · ЭО " + ZJ.timeFmt(e.created_at) : "Не подтверждено",
          dd.admitted === true ? "допущен" : dd.admitted === false ? "отстранён" : "—",
          dd.admitted_by ? dd.admitted_by + " · ЭО " + ZJ.timeFmt(dd.admitted_at) : "—"];
      };
    } else if (journal === "fryer") {
      cols = ["Дата, час начала использования жира", "Тип фритюрного жира", "Оценка качества жира на начало жарки", "Тип жарочного оборудования", "Вид продукции",
        "Время окончания фритюрной жарки", "Оценка качества жира по окончании жарки", "Переходящий остаток, кг", "Утилизированный жир, кг", "Должность, Ф. И. О. контролёра"];
      rowFn = function (e) {
        var dd = e.data, u = unitsById[e.unit_id];
        return [ZJ.dayFmt(e.day) + " " + ZJ.timeFmt(e.created_at), dd.fat, dd.q_start, u ? u.name : "—", dd.product || "—", dd.end_time || "—", dd.q_end || "—",
          dd.left_kg != null ? String(dd.left_kg).replace(".", ",") : "—", dd.util_kg != null ? String(dd.util_kg).replace(".", ",") : "—", sign(e)];
      };
    } else if (journal === "brak") {
      cols = ["Дата и час изготовления блюда", "Время снятия бракеража", "Наименование готового блюда", "Результаты органолептической оценки качества",
        "Разрешение к реализации", "Подписи членов бракеражной комиссии", "Результаты взвешивания порционных блюд", "Примечание"];
      rowFn = function (e) {
        var dd = e.data;
        return [ZJ.dayFmt(e.day) + (dd.made ? " " + dd.made : ""), ZJ.timeFmt(e.created_at), dd.dish, dd.grade, dd.allowed === false ? "не разрешено" : "разрешено", sign(e), dd.weight || "", dd.note || ""];
      };
    } else {
      cols = ["Дата", "Помещение / зона", "Моющие и дезинфицирующие средства", "Ответственный", "Примечание"];
      rowFn = function (e) { var dd = e.data; return [ZJ.dayFmt(e.day), dd.zone, dd.agent || "—", sign(e), dd.note || ""]; };
    }
    var n = 0, body = [];
    d.entries.forEach(function (e) {
      n++;
      var cells = rowFn(e, n).map(function (c, k) { return h("td", { class: k >= 1 ? "l" : null }, c == null ? "" : c); });
      var tr = h("tr", { class: e.alert && !e.voided ? "alarm" : null }, cells);
      body = body.concat(voidRow(tr, e, cols.length));
    });
    return [h("table", null, h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { text: c }); }))),
      h("tbody", null, body.length ? body : h("tr", null, h("td", { colspan: cols.length, text: "Записей за период нет" }))))];
  }

  ZJ.renderDoc = function (journal, d, ym) {
    var J = ZJ.J[journal];
    var content = journal === "fridge" || journal === "store" ? gridDoc(journal, d, ym) : listDoc(journal, d);
    return h("div", { class: "doc" }, header(J, d, ym), content,
      h("div", { class: "doc-foot", text: "Журнал ведётся в электронном виде. " +
        "«ЭО» — электронная отметка сотрудника: Ф. И. О., должность и время записи фиксируются сервисом автоматически, записи не редактируются; ошибочные записи аннулируются с указанием причины. " +
        "Сформировано " + ZJ.dayFmt(ZJ.todayISO()) + " в сервисе «Журналка»." }));
  };
})();
