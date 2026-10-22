// Проверка «как у сотрудника»: уже стоит коннектор One Development с почтой → запуск Kommo-Windows.cmd
// (или Kommo-Mac.command) с ключом из письма → вход в Kommo по коду → чтение своих сделок.
// Kommo поддельный (локальный), ключ тестовый, почта и настоящий Kommo не трогаются.
// По умолчанию всё во временной папке. ONEDEV_E2E_REAL=1 — в настоящих папках пользователя:
// только на одноразовой машине (GitHub Actions).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = path.join(root, 'OneDev-Kommo');
const WIN = process.platform === 'win32';
const REAL = process.env.ONEDEV_E2E_REAL === '1';
const TEST_ID = '11111111-2222-3333-4444-555555555555';
const TEST_SECRET = 'TestSecret0123456789abcdefABCDEF';
const ME = 7, OTHER = 8;

let passed = 0;
const ok = (cond, msg, extra = '') => { if (!cond && extra) console.log(extra); assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

// ---- поддельный Kommo -----------------------------------------------------------------------------
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
    if (req.method === 'POST' && url.pathname === '/oauth2/access_token') {
      const d = JSON.parse(body || '{}');
      if (d.client_id !== TEST_ID || d.client_secret !== TEST_SECRET) return send(401, { hint: 'Client authentication failed' });
      if (d.grant_type === 'authorization_code' && d.code === 'CODE-OK') return send(200, { access_token: 'tok-me', refresh_token: 'ref-me', expires_in: 86400 });
      return send(400, { hint: 'bad grant' });
    }
    if (req.headers.authorization !== 'Bearer tok-me') return send(401, { title: 'Unauthorized' });
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

// ---- «компьютер сотрудника»: коннектор с почтой уже установлен ---------------------------------------
const HOME = REAL ? os.homedir() : fs.mkdtempSync(path.join(os.tmpdir(), 'onedev-kommo-e2e-'));
const CLAUDE_DIR = !REAL ? HOME : WIN ? path.join(process.env.APPDATA, 'Claude') : path.join(HOME, 'Library', 'Application Support', 'Claude');
const CONFIG = path.join(CLAUDE_DIR, 'claude_desktop_config.json');
const APP = path.join(HOME, '.onedev-connector', 'app', 'index.js');
const AI = path.join(HOME, 'Documents', 'ai-office');
const childEnv = { ...process.env, ...(REAL ? {} : { ONEDEV_TEST_HOME: HOME }) };
console.log(`${WIN ? 'Windows' : process.platform} ${os.release()}, Node.js ${process.version}, ${REAL ? 'настоящие папки' : 'временная папка'}: ${CONFIG}`);

fs.mkdirSync(path.dirname(APP), { recursive: true });
fs.writeFileSync(APP, '// старая версия коннектора\n');
const entryEnv = {
  MAIL_USER: 'test@example.com', MAIL_DISPLAY_NAME: 'Тест Сотрудник', MAIL_PASSWORD: 'not-a-real-password', MAIL_HOST: '127.0.0.1', MAIL_PORT: '1',
  KOMMO_SUBDOMAIN: 'onedevelopment', ONEDEV_KOMMO_MODE: 'test', KOMMO_TOKEN: 'old-admin-token',
  // только для теста: поддельный Kommo вместо настоящего, без браузера
  KOMMO_BASE_URL: BASE, KOMMO_AUTH_URL: `${BASE}/oauth`, ONEDEV_NO_BROWSER: '1', ONEDEV_JOURNAL: path.join(HOME, 'journal.jsonl'),
};
if (!REAL) entryEnv.ONEDEV_TOKEN_STORE = 'file:' + path.join(HOME, 'tokens.json'); // не трогать связку ключей разработчика
const entry = { command: process.execPath, args: [APP], env: entryEnv };
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({ mcpServers: { 'onedev-connector': entry, other: { command: 'x', args: ['y'] } }, preferences: { keep: true } }, null, 2));
fs.mkdirSync(path.join(AI, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(AI, '.claude', 'agents', 'my-report.md'), 'мой помощник\n');
fs.writeFileSync(path.join(AI, '.mcp.json'), JSON.stringify({ mcpServers: { 'onedev-connector': entry } }, null, 2));

function runLauncher(input) {
  const r = WIN
    ? spawnSync('cmd.exe', ['/d', '/c', 'Kommo-Windows.cmd'], { cwd: PKG, env: childEnv, input, encoding: 'utf8', timeout: 180000 })
    : spawnSync('/bin/bash', ['Kommo-Mac.command'], { cwd: PKG, env: childEnv, input, encoding: 'utf8', timeout: 180000 });
  return `${r.stdout || ''}${r.stderr || ''}`;
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
  console.log('добавлятор');
  const before = fs.readFileSync(CONFIG, 'utf8');
  const bad = runLauncher('это-не-ключ\n');
  ok(/Ключ не принят/.test(bad) && fs.readFileSync(CONFIG, 'utf8') === before && fs.readFileSync(APP, 'utf8').startsWith('// старая'), 'неверный ключ: ничего не изменено', bad);

  const out = runLauncher(`${TEST_ID}:${TEST_SECRET}\n`);
  ok(/Готово/.test(out), 'с правильным ключом дошёл до «Готово»', out);
  ok(/запись в Kommo выключена/.test(out) && /почта не ответила/.test(out), 'сам проверил: записи нет; почту проверил (в тесте сервера почты нет — так и сказал)', out);

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const env = cfg.mcpServers['onedev-connector'].env;
  ok(env.ONEDEV_KOMMO_MODE === 'read' && env.KOMMO_CLIENT_ID === TEST_ID && !('KOMMO_TOKEN' in env), 'режим «только чтение», ключ интеграции на месте, токена администратора нет');
  ok(env.KOMMO_CLIENT_SECRET.startsWith(WIN ? 'dpapi:' : 'keychain:'), `секрет — в хранилище системы (${WIN ? 'DPAPI' : 'связка ключей'})`);
  ok(env.MAIL_USER === 'test@example.com' && env.MAIL_PASSWORD === 'not-a-real-password' && env.MAIL_HOST === '127.0.0.1', 'настройки почты не тронуты');
  ok(cfg.mcpServers.other.command === 'x' && cfg.preferences.keep === true, 'чужие настройки Claude не тронуты');
  const texts = [CONFIG, path.join(AI, '.mcp.json')].map(f => fs.readFileSync(f, 'utf8')).join('');
  ok(!texts.includes(TEST_SECRET), 'секрета открытым текстом в настройках нет');
  if (WIN) {
    const dat = env.KOMMO_CLIENT_SECRET.slice('dpapi:'.length);
    ok(fs.existsSync(dat) && !fs.readFileSync(dat, 'utf8').includes(TEST_SECRET), 'файл DPAPI создан, внутри секрет зашифрован');
  }
  ok(fs.readFileSync(APP, 'utf8').includes('with=loss_reason') && fs.readFileSync(APP + '.before-kommo', 'utf8').startsWith('// старая'), 'программа обновлена, старая версия сохранена рядом');
  const aiEnv = JSON.parse(fs.readFileSync(path.join(AI, '.mcp.json'), 'utf8')).mcpServers['onedev-connector'].env;
  ok(fs.readFileSync(path.join(AI, '.claude', 'agents', 'my-report.md'), 'utf8') === 'мой помощник\n' && aiEnv.ONEDEV_KOMMO_MODE === 'read', 'ai-office: помощники не тронуты, вкладка Code тоже получила Kommo');

  console.log('Claude после перезапуска');
  const c = await connector(cfg.mcpServers['onedev-connector']);
  ok(c.tools.includes('kommo_leads') && !c.tools.some(t => /^kommo_(create|update)_/.test(t)), 'Claude видит Kommo только на чтение');
  const st0 = await c.call('kommo_status');
  ok(st0.json?.logged_in === false, 'до входа Kommo закрыт', st0.text);
  const login = await c.call('kommo_login', { code: 'CODE-OK' });
  ok(!login.error && login.json?.logged_in === true && login.json.me?.id === ME && login.json.mode === 'read', 'вход: секрет достан из хранилища системы, Kommo его принял, режим read', login.text);
  const ls = await c.call('kommo_leads', { short: true, responsible: 'all' });
  ok(!ls.error && ls.json.leads.length === 1 && ls.json.leads[0].stage === 'сделка проиграна' && ls.json.leads[0].loss_reason === 'Выбрали других', 'сделки: только свои, стадия и причина отказа названием', ls.text);
  const other = await c.call('kommo_get_lead', { id: 2 });
  ok(other.error, 'чужую сделку открыть нельзя', other.text);
  const write = await c.call('kommo_create_task', { text: 'x', due: '2026-10-30 10:00' });
  ok(write.error, 'поставить задачу нельзя', write.text);
  c.close();
  const c2 = await connector(cfg.mcpServers['onedev-connector']);
  const st2 = await c2.call('kommo_status');
  ok(st2.json?.logged_in === true && st2.json.me?.name === 'Тест Сотрудник', 'после ещё одного перезапуска вход сохранён', st2.text);
  c2.close();

  console.log('повторный запуск');
  const again = runLauncher(`${TEST_ID}:${TEST_SECRET}\n`);
  ok(/Готово/.test(again) && fs.readFileSync(APP + '.before-kommo', 'utf8').startsWith('// старая'), 'повторный запуск безопасен, резервная копия — по-прежнему старая версия', again);
} finally {
  fake.close();
  if (!REAL) {
    if (process.platform === 'darwin') try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', 'onedev-connector-kommo-integration-test', '-a', 'onedevelopment'], { stdio: 'ignore' }); } catch { /* нет записи */ }
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}
console.log(`\nУстановка: ${passed} проверок пройдено`);
