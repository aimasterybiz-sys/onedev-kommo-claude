// Установщик «One Development: Kommo для Claude» — только Kommo, без почты. Одинаково на macOS и Windows.
// Ничего не спрашивает, поэтому его может запустить сам Claude по просьбе пользователя.
// Что делает: кладёт программу коннектора в ~/.onedev-kommo и регистрирует её в настройках приложения Claude
// (чат и вкладка Code) в режиме «только чтение, только свои сделки».
// Ключей и паролей здесь нет: секрет интеграции хранится на странице входа, а логин и пароль Kommo
// каждый вводит сам на странице Kommo при первом «Войди в Kommo». Почтовый коннектор не трогает.
// Повторный запуск безопасен. Проверка без изменений в системе: ONEDEV_TEST_HOME=<папка>.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HOME = process.env.ONEDEV_TEST_HOME || '';
const HOME = TEST_HOME || os.homedir();
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const APP = path.join(HOME, '.onedev-kommo', 'app', 'index.js');
const CLAUDE_DIR = TEST_HOME ? HOME
  : WIN ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude')
        : path.join(HOME, 'Library', 'Application Support', 'Claude');
const NAME = 'onedev-kommo';
const LOGIN_PAGE = 'https://onedev-kommo-login.vercel.app';
// ID интеграции «Claude» в Kommo. Он не секретный — виден в ссылке входа; секрет — только на странице входа.
const CLIENT_ID = '7865bf22-ffd0-4e08-a007-e739adbac456';

const bold = s => `\x1b[1m${s}\x1b[0m`;
const say = s => console.log('\n' + bold(s));
const fail = s => { console.log(`\n\x1b[31m✗ ${s}\x1b[0m`); process.exit(1); };

const keepFirst = f => { if (fs.existsSync(f) && !fs.existsSync(f + '.before-kommo')) fs.copyFileSync(f, f + '.before-kommo'); };

function register(file, entry) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`Не могу прочитать ${file}: файл повреждён. Ничего не изменено.`); }
    keepFirst(file);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers[NAME] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log('  ✓ ' + file);
}

// ---- проверка через сам коннектор -------------------------------------------------------------------
function probe(env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [APP], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const out = {};
    let buf = '';
    const t = setTimeout(() => { p.kill(); resolve(out); }, 40000);
    p.stdout.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) out.version = m.result?.serverInfo?.version;
        if (m.id === 2) out.tools = (m.result?.tools || []).map(x => x.name);
        if (m.id === 3) { out.status = m.result?.content?.[0]?.text || ''; clearTimeout(t); p.kill(); resolve(out); }
      }
    });
    const send = o => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kommo_status', arguments: {} } });
  });
}

async function main() {
  say('One Development: Kommo для Claude — установка');
  console.log(`Система: ${WIN ? 'Windows' : MAC ? 'macOS' : process.platform}, Node.js ${process.version}`);
  if (!WIN && !MAC) fail('Поддерживаются только Windows и macOS.');
  if (Number(process.versions.node.split('.')[0]) < 20) fail('Нужен Node.js 20 или новее. Ничего не изменено.');

  say('1/3 · Ставлю программу коннектора');
  fs.mkdirSync(path.dirname(APP), { recursive: true });
  for (const f of ['index.js', 'THIRD_PARTY_LICENSES.txt']) fs.copyFileSync(path.join(HERE, 'connector', f), path.join(path.dirname(APP), f));
  console.log('  ✓ ' + APP);

  say('2/3 · Подключаю к Claude');
  const env = {
    ONEDEV_MAIL: 'off',
    KOMMO_SUBDOMAIN: 'onedevelopment',
    ONEDEV_KOMMO_MODE: 'read',
    KOMMO_CLIENT_ID: CLIENT_ID,
    KOMMO_TOKEN_PROXY: `${LOGIN_PAGE}/api/token`,
    KOMMO_REDIRECT_URI: `${LOGIN_PAGE}/kommo`,
    ONEDEV_JOURNAL: path.join(HOME, '.onedev-kommo', 'journal.jsonl'),
  };
  const entry = { command: process.execPath, args: [APP], env };
  register(path.join(CLAUDE_DIR, 'claude_desktop_config.json'), entry);
  // Claude из Microsoft Store / MSIX держит настройки в своей «виртуальной» папке — пишем и туда.
  if (WIN && !TEST_HOME) {
    const pkgs = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Packages');
    let dirs = [];
    try { dirs = fs.readdirSync(pkgs).filter(d => /^(Anthropic\.)?Claude_/i.test(d)); } catch { /* нет папки */ }
    for (const d of dirs) register(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'), entry);
  }

  say('3/3 · Проверяю');
  const r = await probe(env);
  const tools = r.tools || [];
  const readOk = tools.includes('kommo_status') && tools.includes('kommo_leads') && tools.includes('kommo_login');
  const noWrite = !tools.some(t => /^kommo_(create|update)_/.test(t));
  const noMail = !tools.some(t => t.startsWith('mail_'));
  console.log(readOk ? `  ✓ коннектор ${r.version || ''}: инструменты Kommo на месте` : '  ! инструменты Kommo не появились');
  console.log(noWrite ? '  ✓ запись в Kommo выключена — только чтение' : '  ! видны инструменты записи');
  console.log(noMail ? '  ✓ почты в этом коннекторе нет' : '  ! видны инструменты почты');
  if (!readOk || !noWrite || !noMail) fail('Что-то пошло не так. Пришлите Дмитрию снимок этого окна.');

  say('Готово.');
  console.log(`1. Закройте Claude полностью (Windows: значок в трее → Quit; Mac: ⌘Q) и откройте снова.
2. Напишите в Claude: «Войди в Kommo» — откроется страница Kommo, войдите своим логином и паролем Kommo.
3. Проверьте: «Покажи статус Kommo» — должно быть ваше имя и «только чтение».`);
}

main().catch(e => fail(e.message));
