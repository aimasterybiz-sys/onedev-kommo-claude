// Проверка «как у сотрудника»: запуск Kommo-Windows.cmd auto (или Kommo-Mac.command auto), как это делает Claude
// по промту → перезапуск Claude → «Войди в Kommo» → чтение своих сделок.
// У сотрудника может уже стоять почтовый коннектор One Development — он должен остаться нетронутым.
// Kommo и страница входа поддельные (локальные), настоящий Kommo и почта не трогаются.
// По умолчанию всё во временной папке. ONEDEV_E2E_REAL=1 — в настоящих папках пользователя (только одноразовая
// машина GitHub Actions). ONEDEV_E2E_NO_NODE=1 (Windows) — Node.js убран из PATH: установщик должен скачать свой.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = path.join(root, 'OneDev-Kommo');
const WIN = process.platform === 'win32';
const REAL = process.env.ONEDEV_E2E_REAL === '1';
const NO_NODE = WIN && REAL && process.env.ONEDEV_E2E_NO_NODE === '1';
const ME = 7, OTHER = 8;

let passed = 0;
const ok = (cond, msg, extra = '') => { if (!cond && extra) console.log(extra); assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

// ---- поддельные Kommo и страница входа ----------------------------------------------------------------
const tokens = {};
const proxyCalls = [];
const leads = [
  { id: 1, name: 'Мой клиент', price: 250000, status_id: 143, pipeline_id: 4036309, responsible_user_id: ME, created_at: 1_790_000_000, updated_at: 1_790_086_400, closed_at: 1_790_086_400, loss_reason_id: 5, custom_fields_values: [] },
  { id: 2, name: 'Чужой клиент', price: 1, status_id: 38312416, pipeline_id: 4036309, responsible_user_id: OTHER, created_at: 1_790_000_000, updated_at: 1_790_000_000 },
];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.method === 'POST' && url.pathname === '/api/token') { // как onedev-kommo-login.vercel.app/api/token
      const d = JSON.parse(body || '{}');
      proxyCalls.push(d);
      if (d.grant_type === 'authorization_code' && d.code === 'CODE-OK') { tokens['tok-me'] = ME; return send(200, { access_token: 'tok-me', refresh_token: 'ref-me', expires_in: 86400 }); }
      return send(400, { hint: 'bad grant' });
    }
    const who = tokens[(req.headers.authorization || '').replace('Bearer ', '')];
    if (!who) return send(401, { title: 'Unauthorized' });
    if (url.pathname === '/api/v4/account') return send(200, { name: 'Fake Kommo', current_user_id: ME });
    if (url.pathname === `/api/v4/users/${ME}`) return send(200, { id: ME, name: 'Тест Сотрудник', email: 'test@example.com', rights: { is_admin: false } });
    if (url.pathname === '/api/v4/users') return send(200, { _embedded: { users: [{ id: ME, name: 'Тест Сотрудник' }, { id: OTHER, name: 'Коллега' }] } });
    if (url.pathname === '/api/v4/leads/pipelines') return send(200, { _embedded: { pipelines: [{ id: 4036309, _embedded: { statuses: [{ id: 143, name: 'сделка проиграна' }, { id: 38312416, name: 'Попытка связи' }] } }] } });
    if (url.pathname === '/api/v4/leads') {
      const r = url.searchParams.get('filter[responsible_user_id]');
      const list = leads.filter(l => !r || l.responsible_user_id === +r)
        .map(l => ({ ...l, _embedded: { loss_reason: l.loss_reason_id ? [{ id: l.loss_reason_id, name: 'Выбрали других' }] : [] } }));
      return send(200, { _links: {}, _embedded: { leads: list } });
    }
    const m = url.pathname.match(/^\/api\/v4\/leads\/(\d+)$/);
    if (m) { const l = leads.find(x => x.id === +m[1]); return l ? send(200, l) : send(404, {}); }
    send(404, { title: 'no route ' + url.pathname });
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${fake.address().port}`;

// ---- «компьютер сотрудника»: почтовый коннектор уже стоит ----------------------------------------------
const HOME = REAL ? os.homedir() : fs.mkdtempSync(path.join(os.tmpdir(), 'onedev-kommo-e2e-'));
const CLAUDE_DIR = !REAL ? HOME : WIN ? path.join(process.env.APPDATA, 'Claude') : path.join(HOME, 'Library', 'Application Support', 'Claude');
const CONFIG = path.join(CLAUDE_DIR, 'claude_desktop_config.json');
const APP = path.join(HOME, '.onedev-kommo', 'app', 'index.js');
console.log(`${WIN ? 'Windows' : process.platform} ${os.release()}, Node.js ${process.version}, ${REAL ? 'настоящие папки' : 'временная папка'}${NO_NODE ? ', без Node.js в PATH' : ''}: ${CONFIG}`);

const mailEntry = { command: 'C:\\node\\node.exe', args: ['C:\\Users\\x\\.onedev-connector\\app\\index.js'], env: { MAIL_USER: 'test@example.com', MAIL_PASSWORD: 'dpapi:C:\\x\\mail.dat', ONEDEV_KOMMO_MODE: 'test' } };
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({ mcpServers: { 'onedev-connector': mailEntry, other: { command: 'x', args: ['y'] } }, preferences: { keep: true } }, null, 2));

let childEnv = { ...process.env, ...(REAL ? {} : { ONEDEV_TEST_HOME: HOME }) };
if (NO_NODE) {
  const key = Object.keys(childEnv).find(k => k.toUpperCase() === 'PATH');
  const dirs = childEnv[key].split(';').filter(d => d && !fs.existsSync(path.join(d, 'node.exe')));
  for (const k of Object.keys(childEnv)) if (k.toUpperCase() === 'PATH') delete childEnv[k];
  childEnv.Path = dirs.join(';');
}

function runLauncher() {
  const r = WIN
    ? spawnSync('cmd.exe', ['/d', '/c', 'Kommo-Windows.cmd', 'auto'], { cwd: PKG, env: childEnv, encoding: 'utf8', timeout: 300000 })
    : spawnSync('/bin/bash', ['Kommo-Mac.command', 'auto'], { cwd: PKG, env: childEnv, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, text: `${r.stdout || ''}${r.stderr || ''}` };
}

// ---- коннектор так, как его запускает Claude: команда и настройки из claude_desktop_config.json ---------
async function connector(e) {
  const p = spawn(e.command, e.args, { env: { ...process.env, ...e.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const wait = new Map();
  let buf = '', id = 0;
  p.stdout.on('data', c => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); wait.get(m.id)?.(m); } catch { /* не JSON */ }
    }
  });
  const rpc = (method, params) => new Promise(r => { const n = ++id; wait.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-e2e', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text || r.error?.message || '';
    let json = null; try { json = JSON.parse(text); } catch { /* текст */ }
    return { error: Boolean(r.error || r.result?.isError), text, json };
  };
  return { tools, call, close: () => p.kill() };
}

try {
  console.log('установка по промту (без вопросов)');
  const out = runLauncher();
  ok(out.code === 0 && /Готово/.test(out.text), 'установщик дошёл до «Готово» без единого вопроса', out.text);
  ok(/запись в Kommo выключена/.test(out.text) && /почты в этом коннекторе нет/.test(out.text), 'сам проверил: только чтение, почты нет', out.text);
  if (NO_NODE) ok(/Скачиваю Node\.js/.test(out.text), 'Node.js не было — скачан официальный, контрольная сумма сошлась', out.text);

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const entry = cfg.mcpServers['onedev-kommo'];
  const env = entry?.env || {};
  ok(entry && entry.args[0] === APP && fs.readFileSync(APP, 'utf8').includes('KOMMO_TOKEN_PROXY'), 'коннектор Kommo поставлен в ~/.onedev-kommo и записан в настройки Claude');
  ok(env.ONEDEV_KOMMO_MODE === 'read' && env.ONEDEV_MAIL === 'off' && /^[0-9a-f-]{36}$/.test(env.KOMMO_CLIENT_ID) && env.KOMMO_TOKEN_PROXY === 'https://onedev-kommo-login.vercel.app/api/token', 'режим «только чтение», почта выключена, вход через страницу входа');
  ok(!('KOMMO_CLIENT_SECRET' in env) && !('KOMMO_TOKEN' in env) && !/secret/i.test(JSON.stringify(entry)), 'на компьютере нет ни секрета интеграции, ни токена администратора');
  ok(JSON.stringify(cfg.mcpServers['onedev-connector']) === JSON.stringify(mailEntry), 'почтовый коннектор не тронут');
  ok(cfg.mcpServers.other.command === 'x' && cfg.preferences.keep === true, 'чужие настройки Claude не тронуты');
  if (NO_NODE) ok(/\.onedev-kommo[\\/]node[\\/]node\.exe$/.test(entry.command), 'Claude будет запускать коннектор скачанным Node.js');

  console.log('Claude после перезапуска');
  // В тесте коннектор ходит в поддельный Kommo и на поддельную страницу входа; браузер не открывается.
  const testEnv = { ...env, KOMMO_BASE_URL: BASE, KOMMO_AUTH_URL: `${BASE}/oauth`, KOMMO_TOKEN_PROXY: `${BASE}/api/token`, ONEDEV_NO_BROWSER: '1',
    ...(REAL ? {} : { ONEDEV_TOKEN_STORE: 'file:' + path.join(HOME, 'tokens.json') }) };
  const c = await connector({ ...entry, env: testEnv });
  ok(c.tools.includes('kommo_leads') && !c.tools.some(t => t.startsWith('mail_')) && !c.tools.some(t => /^kommo_(create|update)_/.test(t)), 'Claude видит только Kommo и только чтение');
  ok((await c.call('kommo_status')).json?.logged_in === false, 'до входа Kommo закрыт');
  const login = await c.call('kommo_login', { code: 'CODE-OK' });
  ok(!login.error && login.json?.logged_in === true && login.json.me?.id === ME && login.json.mode === 'read', 'вход: Kommo принял, вошедший — сам сотрудник, режим read', login.text);
  ok(proxyCalls.length === 1 && !('client_secret' in proxyCalls[0]) && !('client_id' in proxyCalls[0]), 'с компьютера ушёл только код входа — без ключей');
  const ls = await c.call('kommo_leads', { short: true, responsible: 'all' });
  ok(!ls.error && ls.json.leads.length === 1 && ls.json.leads[0].stage === 'сделка проиграна' && ls.json.leads[0].loss_reason === 'Выбрали других', 'сделки: только свои, стадия и причина отказа названием', ls.text);
  ok((await c.call('kommo_get_lead', { id: 2 })).error, 'чужую сделку открыть нельзя');
  ok((await c.call('kommo_create_task', { text: 'x', due: '2026-10-30 10:00' })).error, 'поставить задачу нельзя');
  c.close();
  const c2 = await connector({ ...entry, env: testEnv });
  const st2 = await c2.call('kommo_status');
  ok(st2.json?.logged_in === true && st2.json.me?.name === 'Тест Сотрудник', `после ещё одного перезапуска вход сохранён${WIN && REAL ? ' (DPAPI)' : ''}`, st2.text);
  c2.close();

  console.log('повторный запуск');
  const again = runLauncher();
  const cfg2 = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const backup = JSON.parse(fs.readFileSync(CONFIG + '.before-kommo', 'utf8'));
  ok(again.code === 0 && /Готово/.test(again.text) && JSON.stringify(cfg2.mcpServers['onedev-connector']) === JSON.stringify(mailEntry) && !backup.mcpServers['onedev-kommo'], 'повторный запуск безопасен, резервная копия — настройки до установки', again.text);
} finally {
  fake.close();
  if (!REAL) fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(`\nУстановка: ${passed} проверок пройдено`);
