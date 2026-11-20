import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const db = new DatabaseSync(fileURLToPath(new URL('./tasks.db', import.meta.url)));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    login TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0
  );
`);

if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'note')) {
  db.exec("ALTER TABLE tasks ADD COLUMN note TEXT NOT NULL DEFAULT ''");
}

if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'display_name')) {
  db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
}

if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'focus_minutes')) {
  db.exec('ALTER TABLE users ADD COLUMN focus_minutes INTEGER NOT NULL DEFAULT 25');
}

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all();
if (!taskColumns.some(column => column.name === 'due_date')) {
  db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT NOT NULL DEFAULT ''");
}
const cssPath = new URL('./style.css', import.meta.url);
const sessionAge = 60 * 60 * 24 * 7;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function page(res, title, content, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Задачник</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body><main>${content}</main></body>
</html>`);
}

function settingsPage(res, user, error = '', saved = false) {
  page(res, 'Настройки', `
    <section class="settings-page">
      <a class="back" href="/">← К задачам</a>
      <h1>Настройки</h1>
      <p class="intro">Пусть задачник работает в твоём ритме.</p>
      ${error ? `<p class="notice error" role="alert">${error}</p>` : ''}
      ${saved ? '<p class="notice" role="status">Изменения сохранены.</p>' : ''}
      <div class="settings-grid">
        <section class="card"><h2>Профиль</h2>
          <p class="setting-description">Имя для тебя, логин — для входа.</p>
          <form method="post" action="/settings" class="stack">
            <label>Имя<input name="displayName" maxlength="60" autocomplete="nickname" value="${escapeHtml(user.display_name)}" placeholder="Как тебя зовут?"></label>
            <label>Логин<input name="login" required pattern="[A-Za-z0-9_]{3,32}" maxlength="32" autocomplete="username" value="${escapeHtml(user.login)}"></label>
            <label>Текущий пароль<input name="currentPassword" type="password" autocomplete="current-password" maxlength="128"></label>
            <small>Пароль нужен, только если меняешь логин.</small>
            <button>Сохранить профиль</button>
          </form>
        </section>
        <section class="card"><h2>Твой фокус</h2>
          <p class="setting-description">Одна сессия для одного дела. Выбери комфортную длительность.</p>
          ${focusSettings(user)}
        </section>
        <section class="card"><h2>Пароль</h2>
          <p class="setting-description">От 8 до 128 символов.</p>
          <form method="post" action="/settings" class="stack">
            <input type="hidden" name="login" value="${escapeHtml(user.login)}">
            <input type="hidden" name="displayName" value="${escapeHtml(user.display_name)}">
            <label>Текущий пароль<input name="currentPassword" type="password" required autocomplete="current-password" maxlength="128"></label>
            <label>Новый пароль<input name="newPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
            <button>Обновить пароль</button>
          </form>
        </section>
        <section class="card"><h2>Аккаунт</h2>
          <p class="setting-description">Выполнен вход как <strong>${escapeHtml(user.login)}</strong>.</p>
          <form method="post" action="/logout"><button class="danger">Выйти из аккаунта</button></form>
        </section>
      </div>
    </section>`, error ? 400 : 200);
}

function authPage(res, register, error = '', login = '') {
  const title = register ? 'Регистрация' : 'Вход';
  page(res, title, `
    <section class="auth">
      <span class="brand-mark" aria-hidden="true">${icon('leaf')}</span>
      <p class="brand">Задачник</p>
      <h1>${title}</h1>
      <p class="intro">${register ? 'Собери задачи и планы в одном месте.' : 'Войди, чтобы увидеть свой план.'}</p>
      ${error ? `<p class="error" role="alert">${error}</p>` : ''}
      <form method="post" class="stack">
        <label>Логин
          <input name="login" value="${escapeHtml(login)}" autocomplete="username"
            required minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}"
            title="От 3 до 32 латинских букв, цифр или подчёркиваний">
        </label>
        <label>Пароль
          <input name="password" type="password" required minlength="8" maxlength="128"
            autocomplete="${register ? 'new-password' : 'current-password'}">
        </label>
        ${register ? '<small>Логин латиницей, пароль от 8 символов.</small>' : ''}
        <button>${register ? 'Создать аккаунт' : 'Войти'}</button>
      </form>
      <p class="switch">${register ? 'Уже есть аккаунт? <a href="/login">Войти</a>'
        : 'Впервые здесь? <a href="/register">Зарегистрироваться</a>'}</p>
    </section>`, error ? 400 : 200);
}

const iconPaths = {
  leaf: 'M4 20c0-9 6-15 16-16-1 10-7 16-16 16Zm0 0 11-11',
  today: 'm3 10 9-7 9 7v10H3z M9 20v-6h6v6',
  calendar: 'M4 5h16v15H4z M8 3v4m8-4v4M4 10h16m-12 4h1m3 0h1m3 0h1m-9 3h1m3 0h1',
  focus: 'M10 3h4m-2 0v3m0 4v4l2 2 M20 14a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  stats: 'M5 20V12m5 8V5m5 15v-9m5 9V8',
  settings: 'M4 7h16M4 17h16M9 4v6m6 4v6',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;
}

const sections = {
  today: 'Сегодня', calendar: 'Календарь',
  focus: 'Фокус', stats: 'Статистика',
};

const fullDate = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' });

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function shiftDay(date, days) {
  const day = new Date(date);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

function weekOf(date) {
  const offset = (new Date(date).getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, day) => shiftDay(date, day - offset));
}

function taskFields(task = {}) {
  return `
    <label>Название<input name="title" maxlength="150" required value="${escapeHtml(task.title ?? '')}" placeholder="Например, купить продукты"></label>
    <label>Заметка<textarea name="note" rows="2" maxlength="500" placeholder="Детали задачи">${escapeHtml(task.note ?? '')}</textarea></label>
    <label>Дата<input name="date" type="date" value="${task.due_date ?? ''}"></label>`;
}

function taskList(tasks, current, editingId, draft, heading = '', allowAdd = true) {
  const back = encodeURIComponent(current);
  return `<section class="card task-card" aria-label="${escapeHtml(heading || 'Задачи')}">
    ${heading ? `<h2>${escapeHtml(heading)}</h2>` : ''}
    ${tasks.length ? `<ul class="task-list">${tasks.map(task => {
      const title = escapeHtml(task.title);
      return `<li>${task.id === editingId ? `
        <form method="post" action="/tasks/${task.id}/edit?back=${back}" class="stack edit">
          ${taskFields(task)}
          <div class="row"><button>Сохранить</button><a href="${escapeHtml(current)}">Отмена</a></div>
        </form>` : `
        <form method="post" action="/tasks/${task.id}/toggle?back=${back}">
          <button class="check" aria-pressed="${Boolean(task.done)}" aria-label="Выполнено: ${title}">${task.done ? '✓' : ''}</button>
        </form>
        <div class="title${task.done ? ' done' : ''}">
          <span>${title}</span>
          ${task.note ? `<p class="note">${escapeHtml(task.note)}</p>` : ''}
        </div>
        <details class="task-menu">
          <summary aria-label="Действия для задачи ${title}">⋯</summary>
          <div class="task-actions">
            <a href="${escapeHtml(current)}&amp;edit=${task.id}">Изменить</a>
            <form method="post" action="/tasks/${task.id}/delete?back=${back}"><button class="danger">Удалить</button></form>
          </div>
        </details>`}</li>`;
    }).join('')}</ul>` : '<div class="empty"><h3>Задач пока нет</h3><p>Запиши то, что хочется сделать.</p></div>'}
    ${allowAdd ? `<details class="add-task"${tasks.length ? '' : ' open'}>
      <summary><span aria-hidden="true">＋</span> Добавить задачу</summary>
      <form method="post" action="/tasks?back=${back}" class="stack">
        ${taskFields(draft)}
        <button>Добавить</button>
      </form>
    </details>` : ''}
  </section>`;
}

function focusSettings(user) {
  return `<form method="post" action="/focus-settings" class="stack">
    <label>Длительность, минуты<input name="minutes" type="number" min="1" max="180" step="1" required value="${user.focus_minutes}"></label>
    <small>От 1 до 180 минут. После изменения таймер начнётся заново.</small>
    <button>Сохранить длительность</button>
  </form>`;
}

function focusCard(user) {
  return `<section class="focus-card" aria-label="Фокус-таймер">
    <h2>Фокус</h2>
    <p id="focus-time" data-user-id="${user.id}" data-minutes="${user.focus_minutes}">${user.focus_minutes}:00</p>
    <div class="focus-actions">
      <button id="focus-toggle" type="button" aria-label="Начать фокус">▶</button>
      <button id="focus-reset" type="button" aria-label="Сбросить таймер">↻</button>
    </div>
    <details class="focus-options"><summary>Настроить фокус</summary>${focusSettings(user)}</details>
    <script src="/focus.js" defer></script>
  </section>`;
}

function tasksPage(res, user, query) {
  const requestedView = query.get('view');
  const view = Object.hasOwn(sections, requestedView) ? requestedView : 'today';
  const today = localDate.format(new Date());
  const requestedDate = query.get('date');
  const date = view !== 'today' && validDate(requestedDate ?? '') ? requestedDate : today;
  const all = db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC').all(user.id);
  const scheduled = day => all.filter(task => (task.due_date || today) === day);
  const dayTasks = scheduled(date);
  const done = dayTasks.filter(task => task.done).length;
  const current = '/?' + new URLSearchParams({
    view, date,
  });
  const editingId = Number(query.get('edit'));
  const week = weekOf(date);
  const overdue = all.filter(task => !task.done && task.due_date && task.due_date < today);
  const activeCount = scheduled(today).filter(task => !task.done).length + overdue.length;
  const datedTasks = () => `<div id="selected-tasks" class="stack">
    ${taskList(dayTasks, current, editingId, { due_date: date }, fullDate.format(new Date(date)))}
  </div>`;

  let content;
  switch (view) {
    case 'calendar': {
      const first = date.slice(0, 7) + '-01';
      const next = shiftDay(first, 32).slice(0, 7) + '-01';
      const previous = shiftDay(first, -1).slice(0, 7) + '-01';
      const start = weekOf(first)[0];
      const cells = Array.from({ length: 42 }, (_, index) => shiftDay(start, index));
      content = `<section class="card"><div class="date-nav">
        <a href="/?view=calendar&amp;date=${previous}" aria-label="Предыдущий месяц">‹</a>
        <span>${monthName.format(new Date(first))}</span>
        <a href="/?view=calendar&amp;date=${next}" aria-label="Следующий месяц">›</a>
      </div><div class="calendar-grid">
        ${week.map(day => `<span>${shortDay.format(new Date(day))}</span>`).join('')}
        ${cells.map(day => `<a href="/?view=calendar&amp;date=${day}#selected-tasks"${day === date ? ' aria-current="date"' : ''}
          class="${day.slice(0, 7) !== first.slice(0, 7) ? 'outside' : ''}"
          aria-label="${fullDate.format(new Date(day))}">${Number(day.slice(-2))}${scheduled(day).length ? '<i></i>' : ''}</a>`).join('')}
      </div></section>${datedTasks()}`;
      break;
    }
    case 'focus':
      content = focusCard(user);
      break;
    case 'stats': {
      const periods = { week: 'Неделя', month: 'Месяц', all: 'Всё время' };
      const period = Object.hasOwn(periods, query.get('period')) ? query.get('period') : 'week';
      const start = period === 'month' ? today.slice(0, 7) + '-01' : weekOf(today)[0];
      const end = period === 'month' ? shiftDay(shiftDay(start, 32).slice(0, 7) + '-01', -1) : shiftDay(start, 6);
      const tasks = period === 'all' ? all : all.filter(task => task.due_date && task.due_date >= start && task.due_date <= end);
      const completed = tasks.filter(task => task.done).length;
      const pending = tasks.length - completed;
      const late = tasks.filter(task => !task.done && task.due_date && task.due_date < today).length;
      const percent = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
      const days = period === 'week' ? weekOf(today) : Array.from({ length: period === 'month' ? Number(end.slice(-2)) : 7 }, (_, i) => shiftDay(period === 'all' ? weekOf(today)[0] : start, i));
      content = `
        <nav class="stat-periods" aria-label="Период статистики">
          ${Object.entries(periods).map(([key, label]) => `<a href="/?view=stats&amp;period=${key}" ${key === period ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
        </nav>
        <p class="stat-explanation">${period === 'all' ? 'Все задачи, включая задачи без даты.' : `Задачи с датой от ${start.split('-').reverse().join('.')} до ${end.split('-').reverse().join('.')}.`}
          Числа показывают текущий статус задач на выбранные даты.</p>
        <div class="stat-metrics">
          <section class="card"><span>Запланировано</span><strong>${tasks.length}</strong><small>в выбранном периоде</small></section>
          <section class="card"><span>Выполнено</span><strong>${completed}</strong><small>${percent}% от плана</small></section>
          <section class="card"><span>Осталось</span><strong>${pending}</strong><small>${late ? `Просрочено: ${late}` : 'Просроченных нет'}</small></section>
        </div>
        <section class="card stat-progress"><h2>Выполнение плана</h2>
          <p>${tasks.length ? `Выполнено ${completed} из ${tasks.length} задач` : 'В этом периоде задач пока нет'}</p>
          <progress value="${completed}" max="${tasks.length || 1}" aria-label="Выполнение плана"></progress>
        </section>
        <section class="card"><h2>${period === 'all' ? 'План текущей недели' : 'По датам задач'}</h2>
          <p class="stat-explanation">Фиолетовая часть — выполнено, светлая — осталось. Нажми на день, чтобы открыть задачи.</p>
          <div class="stat-days">${days.map(day => {
            const list = all.filter(task => task.due_date === day);
            const finished = list.filter(task => task.done).length;
            return `<a class="stat-day" href="/?view=calendar&amp;date=${day}#selected-tasks">
              <span>${Number(day.slice(-2))} ${shortDay.format(new Date(day))}</span>
              <div class="stat-track"><i style="width:${list.length ? finished / list.length * 100 : 0}%"></i></div>
              <small>${list.length ? `${finished} из ${list.length}` : 'Нет задач'}</small>
            </a>`;
          }).join('')}</div>
        </section>
        <p class="stat-explanation">${all.filter(task => !task.due_date).length} задач без даты — они учитываются во вкладке «Всё время».</p>`;
      break;
    }
    default:
      content = `<div class="today-layout"><div class="stack">
        ${overdue.length ? taskList(overdue, current, editingId, {}, 'Просрочено', false) : ''}
        ${taskList(scheduled(today), current, editingId, { due_date: today }, 'Сегодня')}</div>
        <aside>${focusCard(user)}<section class="card day-progress"><h2>Прогресс дня</h2>
          <p>${done} из ${dayTasks.length} задач <strong>${dayTasks.length ? Math.round(done / dayTasks.length * 100) : 0}%</strong></p>
          <progress aria-label="Прогресс дня" value="${done}" max="${dayTasks.length || 1}"></progress></section></aside></div>`;
  }

  page(res, sections[view], `
    <div class="planner">
      <aside class="sidebar">
        <a href="/" class="wordmark">${icon('leaf')} Задачник</a>
        <nav aria-label="Разделы">
          ${Object.entries(sections).map(([key, label]) => `<a href="/?view=${key}" class="${['focus', 'stats'].includes(key) ? 'desktop-only' : ''}" ${key === view ? 'aria-current="page"' : ''}>
            ${icon(key)}<span>${label}</span>${key === 'today' ? `<small>${activeCount}</small>` : ''}
          </a>`).join('')}
          <a class="desktop-only" href="/settings">${icon('settings')}<span>Настройки</span></a>
          <details class="mobile-more">
            <summary ${['focus', 'stats'].includes(view) ? 'aria-current="true"' : ''}>${icon('settings')}<span>Ещё</span></summary>
            <div>
              <a href="/?view=focus">${icon('focus')}Фокус</a>
              <a href="/?view=stats">${icon('stats')}Статистика</a>
              <a href="/settings">${icon('settings')}Настройки</a>
            </div>
          </details>
        </nav>
      </aside>
      <section class="planner-content">
        <header class="planner-header">
          <div><p>${fullDate.format(new Date(view === 'today' ? today : date))}</p>
          <h1>${escapeHtml(sections[view])}</h1>
          ${view === 'today' ? '<p class="intro">Один день. По одному делу за раз.</p>' : ''}</div>
          <a href="/settings" class="profile-link" aria-label="Настройки профиля">${icon('settings')}<span>Настройки</span></a>
        </header>
        <div class="view-content">${content}</div>
      </section>
    </div>`);
}

function redirect(res, location, cookie) {
  res.setHeader('Location', location);
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.writeHead(303).end();
}

function sessionCookie(token, age) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}

async function readForm(req) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 500000) return null;
  }
  return new URLSearchParams(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const post = req.method === 'POST';
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET' && path === '/style.css') {
      const css = readFileSync(cssPath);
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }).end(css);
      return;
    }

    if (req.method === 'GET' && path === '/focus.js') {
      const script = readFileSync(new URL('./focus.js', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(script);
      return;
    }

    if (req.method === 'GET' && path === '/landscape.svg') {
      const svg = readFileSync(new URL('./landscape.svg', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg);
      return;
    }

    if (post && req.headers.origin !== `http://${req.headers.host}`) {
      return page(res, 'Доступ запрещён', '<h1>Доступ запрещён</h1>', 403);
    }

    const token = req.headers.cookie?.match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const user = token && db.prepare(`
      SELECT users.id, users.login, users.display_name, users.focus_minutes FROM users JOIN sessions ON sessions.user_id = users.id
      WHERE sessions.token = ? AND sessions.expires > ?
    `).get(token, Date.now());

    if (path === '/login' || path === '/register') {
      if (user) return redirect(res, '/');
      const register = path === '/register';
      if (req.method === 'GET') return authPage(res, register);
      if (post) {
        const form = await readForm(req);
        const login = form?.get('login')?.trim().toLowerCase() ?? '';
        const password = form?.get('password') ?? '';
        if (!/^[a-z0-9_]{3,32}$/.test(login) || password.length < 8 || password.length > 128) {
          return authPage(res, register, 'Проверьте логин и длину пароля.', login);
        }
        let account = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
        if (register) {
          if (account) return authPage(res, true, 'Этот логин уже занят.', login);
          const salt = randomBytes(16).toString('hex');
          const hash = scryptSync(password, salt, 64).toString('hex');
          const result = db.prepare('INSERT INTO users (login, salt, password_hash) VALUES (?, ?, ?)')
            .run(login, salt, hash);
          account = { id: result.lastInsertRowid };
        } else if (!account || !timingSafeEqual(
          scryptSync(password, account.salt, 64), Buffer.from(account.password_hash, 'hex'),
        )) {
          return authPage(res, false, 'Неверный логин или пароль.', login);
        }
        const newToken = randomBytes(32).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(newToken, account.id, Date.now() + sessionAge * 1000);
        return redirect(res, '/', sessionCookie(newToken, sessionAge));
      }
    }

    if (!user) return redirect(res, '/login');

    if (path === '/welcome' && req.method === 'GET') return redirect(res, '/');

    if (path === '/focus-settings' && post) {
      const minutes = Number((await readForm(req))?.get('minutes'));
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
        return settingsPage(res, user, 'Длительность должна быть целым числом от 1 до 180.');
      }
      db.prepare('UPDATE users SET focus_minutes = ? WHERE id = ?').run(minutes, user.id);
      return redirect(res, '/?view=focus');
    }

    if (path === '/settings' && req.method === 'GET') {
      return settingsPage(res, user, '', url.searchParams.has('saved'));
    }
    if (path === '/settings' && post) {
      const form = await readForm(req);
      const login = form?.get('login')?.trim().toLowerCase() ?? '';
      const displayName = form?.get('displayName')?.trim() ?? '';
      const newPassword = form?.get('newPassword') ?? '';
      if (!/^[a-z0-9_]{3,32}$/.test(login) || displayName.length > 60) {
        return settingsPage(res, user, 'Проверь имя и логин.');
      }
      if (newPassword && (newPassword.length < 8 || newPassword.length > 128)) {
        return settingsPage(res, user, 'Новый пароль должен содержать от 8 до 128 символов.');
      }
      if (login !== user.login || newPassword) {
        const account = db.prepare('SELECT salt, password_hash FROM users WHERE id = ?').get(user.id);
        const currentPassword = form.get('currentPassword') ?? '';
        if (currentPassword.length > 128 || !timingSafeEqual(
          scryptSync(currentPassword, account.salt, 64), Buffer.from(account.password_hash, 'hex'),
        )) {
          return settingsPage(res, user, 'Проверь текущий пароль.');
        }
        if (db.prepare('SELECT id FROM users WHERE login = ? AND id != ?').get(login, user.id)) {
          return settingsPage(res, user, 'Этот логин уже занят.');
        }
        const salt = newPassword ? randomBytes(16).toString('hex') : account.salt;
        const hash = newPassword ? scryptSync(newPassword, salt, 64).toString('hex') : account.password_hash;
        db.prepare('UPDATE users SET login = ?, display_name = ?, salt = ?, password_hash = ? WHERE id = ?')
          .run(login, displayName, salt, hash, user.id);
      } else {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, user.id);
      }
      return redirect(res, '/settings?saved');
    }
    if (req.method === 'GET' && path === '/') return tasksPage(res, user, url.searchParams);
    if (post && path === '/logout') {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return redirect(res, '/login', sessionCookie('', 0));
    }

    const taskRoute = path.match(/^\/tasks\/(\d+)\/(edit|toggle|delete)$/);
    if (post && (path === '/tasks' || taskRoute)) {
      const id = Number(taskRoute?.[1]);
      const action = taskRoute?.[2];
      if (path === '/tasks' || action === 'edit') {
        const form = await readForm(req);
        const title = form?.get('title')?.trim();
        const note = form?.get('note')?.trim() ?? '';
        const date = form?.get('date') ?? '';
        if (date && !validDate(date)) {
          return page(res, 'Проверьте задачу', '<h1>Проверьте дату</h1><a href="/">К задачам</a>', 400);
        }
        if (note.length > 500) {
          return page(res, 'Проверьте заметку', '<h1>Заметка должна быть не длиннее 500 символов</h1><a href="/">К списку</a>', 400);
        }
        if (!title || title.length > 150) {
          return page(res, 'Проверьте название', '<h1>Введите название от 1 до 150 символов</h1><a href="/">К списку</a>', 400);
        }
        if (action === 'edit') {
          db.prepare('UPDATE tasks SET title = ?, note = ?, due_date = ? WHERE id = ? AND user_id = ?').run(title, note, date, id, user.id);
        } else {
          db.prepare('INSERT INTO tasks (title, note, due_date, user_id) VALUES (?, ?, ?, ?)').run(title, note, date, user.id);
        }
      } else if (action === 'toggle') {
        db.prepare('UPDATE tasks SET done = 1 - done WHERE id = ? AND user_id = ?').run(id, user.id);
      } else {
        db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, user.id);
      }
      const returnTo = url.searchParams.get('back');
      return redirect(res, /^\/\?[A-Za-z0-9%&=+-]+$/.test(returnTo ?? '') ? returnTo : '/');
    }
    page(res, 'Страница не найдена', '<h1>Страница не найдена</h1><a href="/">К списку</a>', 404);
  } catch (error) {
    console.error(error);
    page(res, 'Ошибка', '<h1>Ошибка сервера</h1><a href="/">На главную</a>', 500);
  }
});

server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {
  console.log(`Задачник открыт на http://localhost:${server.address().port}`);
});
