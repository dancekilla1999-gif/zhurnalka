/* «Журналка» — формы записей (общие для управляющего и сотрудника). */
(function () {
  "use strict";
  var ZJ = window.ZJ, h = ZJ.h;

  function field(label, input, hint) {
    return h("label", null, label, input, hint ? h("span", { class: "small muted", text: hint }) : null);
  }
  function gradeSelect(name, value) {
    return h("select", { name: name, required: true },
      h("option", { value: "", text: "Выберите…" }),
      ZJ.GRADES.map(function (g) { return h("option", { value: g, text: g, selected: g === value ? true : null }); }));
  }
  function nowHM() { return ZJ.timeFmt(new Date().toISOString()); }

  // форма: возвращает { node, read() } ; read() бросает Error с понятным текстом
  ZJ.buildForm = function (journal, unit, units) {
    var err = h("p", { class: "form-err", role: "alert" });
    var node, read;
    if (journal === "fridge" || journal === "store") {
      var tIn = h("input", { class: "big-input", inputmode: "decimal", autocomplete: "off", placeholder: unit.t_max != null && unit.t_max < 0 ? "−18" : "4", "aria-label": "Температура, °C" });
      var hIn = journal === "store" ? h("input", { inputmode: "decimal", autocomplete: "off", placeholder: "60", "aria-label": "Влажность, %" }) : null;
      var act = h("textarea", { rows: 2, placeholder: "Например: перенесли продукты в другой холодильник, вызвали мастера" });
      var actBox = h("label", { hidden: true }, "Температура вне нормы. Что сделали?", act);
      var sign = h("button", { type: "button", class: "btn ghost small", text: "−", "aria-label": "Сменить знак", onclick: function () {
        var v = tIn.value.trim(); tIn.value = v.charAt(0) === "-" || v.charAt(0) === "−" ? v.slice(1) : "-" + v; check(); tIn.focus();
      } });
      function check() { actBox.hidden = !ZJ.outOfRange(unit, ZJ.parseNum(tIn.value), hIn ? ZJ.parseNum(hIn.value) : null); }
      tIn.addEventListener("input", check); if (hIn) hIn.addEventListener("input", check);
      node = h("div", { class: "form" },
        h("div", { class: "card", style: "padding:12px 14px" }, h("b", { text: unit.name }), h("div", { class: "small muted", text: [unit.room, ZJ.range(unit)].filter(Boolean).join(" · ") })),
        h("label", null, "Температура, °C", h("div", { class: "row", style: "flex-wrap:nowrap" }, sign, tIn)),
        hIn ? field("Влажность, %", hIn, unit.h_max != null ? "не выше " + unit.h_max + " %" : "") : null,
        actBox, err);
      read = function () {
        var t = ZJ.parseNum(tIn.value);
        if (t === null) throw new Error("Введите температуру числом, например 4 или -18");
        var d = { t: t };
        if (hIn && hIn.value.trim() !== "") { var hv = ZJ.parseNum(hIn.value); if (hv === null || hv < 0 || hv > 100) throw new Error("Влажность — число от 0 до 100"); d.h = hv; }
        if (!actBox.hidden) { if (!act.value.trim()) throw new Error("Напишите, что сделали, раз температура вне нормы"); d.action = act.value.trim(); }
        return d;
      };
      setTimeout(function () { tIn.focus(); }, 60);
    } else if (journal === "fryer") {
      var fr = (units || []).filter(function (u) { return u.kind === "fryer"; });
      var uSel = h("select", { name: "unit" }, fr.map(function (u) { return h("option", { value: u.id, text: u.name, selected: unit && unit.id === u.id ? true : null }); }));
      var fat = h("input", { name: "fat", placeholder: "Например: подсолнечное рафинированное", autocomplete: "off" });
      var qs = gradeSelect("q_start"), prod = h("input", { name: "product", placeholder: "Картофель фри, наггетсы…", autocomplete: "off" });
      var endT = h("input", { name: "end_time", type: "time" }), qe = h("select", { name: "q_end" }, h("option", { value: "", text: "— жарка ещё идёт —" }), ZJ.GRADES.map(function (g) { return h("option", { value: g, text: g }); }));
      var left = h("input", { inputmode: "decimal", placeholder: "кг" }), util = h("input", { inputmode: "decimal", placeholder: "кг" });
      node = h("div", { class: "form" },
        fr.length ? field("Фритюрница", uSel) : h("p", { class: "notice", text: "Сначала добавьте фритюрницу в разделе «Оборудование»." }),
        field("Тип фритюрного жира", fat), field("Качество жира на начало жарки", qs), field("Вид продукции", prod),
        h("div", { class: "grid2" }, field("Время окончания жарки", endT), field("Качество жира по окончании", qe),
          field("Переходящий остаток", left), field("Утилизировано", util)), err);
      read = function () {
        if (!fr.length) throw new Error("Нет фритюрницы в оборудовании");
        if (!fat.value.trim()) throw new Error("Укажите тип жира");
        if (!qs.value) throw new Error("Оцените качество жира на начало жарки");
        return { _unit: uSel.value, fat: fat.value.trim(), q_start: qs.value, product: prod.value.trim(), end_time: endT.value, q_end: qe.value,
          left_kg: left.value.trim() ? ZJ.parseNum(left.value) : null, util_kg: util.value.trim() ? ZJ.parseNum(util.value) : null };
      };
    } else if (journal === "brak") {
      var dish = h("input", { placeholder: "Например: борщ, стейк из лосося", autocomplete: "off" });
      var made = h("input", { type: "time", value: nowHM() });
      var grade = gradeSelect("grade", "отлично");
      var allowed = h("select", null, h("option", { value: "1", text: "Разрешено к реализации" }), h("option", { value: "0", text: "Не разрешено" }));
      var weight = h("input", { placeholder: "Например: 250 г — норма", autocomplete: "off" }), note = h("input", { autocomplete: "off" });
      node = h("div", { class: "form" }, field("Блюдо", dish), h("div", { class: "grid2" }, field("Время изготовления", made), field("Органолептическая оценка", grade)),
        field("Решение", allowed), field("Взвешивание порции", weight, "необязательно"), field("Примечание", note), err);
      read = function () {
        if (!dish.value.trim()) throw new Error("Укажите блюдо");
        return { dish: dish.value.trim(), made: made.value, grade: grade.value, allowed: allowed.value === "1", weight: weight.value.trim(), note: note.value.trim() };
      };
      setTimeout(function () { dish.focus(); }, 60);
    } else if (journal === "clean") {
      var zone = h("input", { placeholder: "Горячий цех, зал, склад…", autocomplete: "off" });
      var agent = h("input", { placeholder: "Моющее и дезинфицирующее средство", autocomplete: "off" }), cn = h("input", { autocomplete: "off" });
      node = h("div", { class: "form" }, field("Помещение или зона", zone), field("Средства", agent), field("Примечание", cn), err);
      read = function () {
        if (!zone.value.trim()) throw new Error("Укажите помещение");
        return { zone: zone.value.trim(), agent: agent.value.trim(), note: cn.value.trim() };
      };
      setTimeout(function () { zone.focus(); }, 60);
    }
    return { node: node, read: read, err: err };
  };

  // открыть форму в модальном окне. send(data, unitId) → Promise
  ZJ.openEntry = function (journal, unit, units, send, done) {
    var f = ZJ.buildForm(journal, unit, units);
    var busy = false;
    ZJ.modal(ZJ.J[journal].short, f.node, [
      { text: "Отмена", kind: "ghost" },
      { text: "Записать", kind: "primary", keep: true, onclick: function (close) {
        if (busy) return false;
        var data;
        try { data = f.read(); } catch (e) { f.err.textContent = e.message; return false; }
        var uid = data._unit || (unit && unit.id) || null; delete data._unit;
        busy = true; f.err.textContent = "";
        send(data, uid).then(function (entry) {
          close();
          ZJ.toast(entry && entry.alert ? "Записано. Отметили отклонение — управляющий увидит" : "Записано в журнал", entry && entry.alert ? "bad" : "");
          if (done) done(entry);
        }, function (e) { busy = false; f.err.textContent = e.message; });
        return false;
      } }
    ]);
  };

  // строка истории записи для экрана
  ZJ.entryText = function (e, unitsById) {
    var d = e.data || {}, u = unitsById && e.unit_id ? unitsById[e.unit_id] : null;
    switch (e.journal) {
      case "health": return (d.no_infection && d.no_skin ? "Признаков заболеваний нет" : "Сотрудник отметил признаки заболевания") +
        (d.admitted === true ? " · допущен" : d.admitted === false ? " · отстранён" : " · ждёт допуска");
      case "fridge": case "store": return (u ? u.name + ": " : "") + ZJ.t(d.t) + (d.h != null ? ", " + d.h + " %" : "") + (d.action ? " · меры: " + d.action : "");
      case "fryer": return (u ? u.name + ": " : "") + d.fat + ", начало — " + d.q_start + (d.q_end ? ", окончание — " + d.q_end : "") + (d.product ? " · " + d.product : "");
      case "brak": return d.dish + " — " + d.grade + (d.allowed === false ? " · НЕ разрешено" : "");
      case "clean": return d.zone + (d.agent ? " · " + d.agent : "");
    }
    return "";
  };
})();
