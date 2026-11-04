# Журналка

Санитарные журналы общепита в телефоне

Кабинет: https://zhurnalka.vercel.app/app/

Лендинг: https://zhurnalka.vercel.app

Часть пакета **Трио** (https://trio-resto.vercel.app)

## Структура

```
index.html      — лендинг
app/            — кабинет (SPA)
  index.html
  core.js, data.js, forms.js, print.js, owner.js, staff.js, team.js, agents-ui.js, guide.js, trio-bill.js
  app.css, trio-skin.css, agents.css
fonts/
css/
media/
```

## Локальный запуск

```bash
npx serve .
# кабинет: http://localhost:3000/app/
```

Backend: Supabase (`qozyihhlocvgpkchyqsp.supabase.co`).

## Статус (04.11.2026)

Весь статический код (HTML, CSS, JS, шрифты, медиа) скопирован с production: https://zhurnalka.vercel.app — файлы идентичны тому, что сейчас отдаёт сайт.

**Чего нет в репозитории:** серверных функций Vercel (api/agents). Их исходники не отдаются публично; их можно забрать только из деплоя через Vercel (Deployment → Source) и положить в `api/`.
