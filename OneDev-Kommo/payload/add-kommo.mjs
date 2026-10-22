// Добавляет Kommo в уже установленный коннектор One Development. Одинаково на macOS и Windows.
// Что делает: обновляет программу коннектора, кладёт ключ интеграции Kommo в хранилище системы
// (macOS: связка ключей; Windows: шифрование DPAPI), включает Kommo в режиме «только чтение, только свои сделки».
// Чего не делает: не спрашивает и не меняет пароль почты, не трогает помощников в папке ai-office, ничего не отправляет.
// Логин и пароль Kommo вводятся потом на странице Kommo, сюда они не попадают. Повторный запуск безопасен.
// Ключ интеграции (строка «ID:секрет» из письма) спрашивается при запуске; для внутренних сборок может лежать рядом
// в kommo-integration.json. Проверка без изменений в системе: ONEDEV_TEST_HOME=<папка>.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HOME = process.env.ONEDEV_TEST_HOME || '';
const HOME = TEST_HOME || os.homedir();
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const SUFFIX = TEST_HOME ? '-test' : '';
const APP_DIR = path.join(HOME, '.onedev-connector');
const CLAUDE_DIR = TEST_HOME ? HOME
  : WIN ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude')
        : path.join(HOME, 'Library', 'Application Support', 'Claude');
const KOMMO_MODE = 'read';
const NAME = 'onedev-connector';

const KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([A-Za-z0-9]{20,200})$/i;

const bold = s => `\x1b[1m${s}\x1b[0m`;
const say = s => console.log('\n' + bold(s));
const fail = s => { console.log(`\n\x1b[31m✗ ${s}\x1b[0m`); process.exit(1); };

function askLine(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, a => { answered = true; rl.close(); resolve(a); });
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}

/** Ключ интеграции: из kommo-integration.json рядом (внутренняя сборка) или строкой «ID:секрет» из письма. */
async function integrationKey() {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(HERE, 'kommo-integration.json'), 'utf8'));
    if (k.client_id && k.client_secret) return { id: String(k.client_id), secret: String(k.client_secret), redirect: k.redirect_uri };
  } catch { /* файла нет — спросим */ }
  for (let i = 0; i < (process.stdin.isTTY ? 3 : 1); i++) {
    const a = (await askLine('\nВставьте ключ Kommo из письма Дмитрия и нажмите Enter:\n> ')).replace(/\s+/g, '');
    const m = a.match(KEY_RE);
    if (m) return { id: m[1].toLowerCase(), secret: m[2] };
    console.log('  ! Это не похоже на ключ: он выглядит как «xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:длинная строка». Скопируйте его из письма целиком.');
  }
  fail('Ключ не принят. Ничего не изменено. Запустите файл снова или напишите Дмитрию.');
}

// ---- хранилище секретов (как в основном установщике) ----------------------------------------------
function storeSecret(name, account, value) {
  if (MAC) {
    const service = `onedev-connector-${name}${SUFFIX}`;
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value], { stdio: 'ignore' });
    return `keychain:${service}:${account}`;
  }
  if (WIN) {
    const dir = path.join(APP_DIR, 'secrets');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.dat`);
    const ps = `$p = [Console]::In.ReadToEnd(); ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath '${file.replace(/'/g, "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { input: value, windowsHide: true });
    return `dpapi:${file}`;
  }
  fail('Поддерживаются только macOS и Windows.');
}

// ---- где записан коннектор ------------------------------------------------------------------------
function configFiles() {
  const files = [path.join(CLAUDE_DIR, 'claude_desktop_config.json')];
  // Claude из Microsoft Store / MSIX держит настройки в своей «виртуальной» папке.
  if (WIN && !TEST_HOME) {
    const pkgs = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Packages');
    try { for (const d of fs.readdirSync(pkgs).filter(d => /^(Anthropic\.)?Claude_/i.test(d))) files.push(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')); } catch { /* нет папки */ }
  }
  // Второй путь для вкладки Code — .mcp.json в папке ai-office.
  for (const d of [path.join(HOME, 'ai-office'), path.join(HOME, 'Documents', 'ai-office'), path.join(HOME, 'Desktop', 'ai-office')]) files.push(path.join(d, '.mcp.json'));
  return files.filter(f => {
    try { return Boolean(JSON.parse(fs.readFileSync(f, 'utf8'))?.mcpServers?.[NAME]); } catch { return false; }
  });
}

// ---- проверка через сам коннектор: какие инструменты видны и что говорит kommo_status --------------
function probe(connector, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [connector], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const out = {};
    let buf = '';
    const t = setTimeout(() => { p.kill(); resolve({ ...out, timeout: true }); }, 40000);
    p.stdout.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) out.version = m.result?.serverInfo?.version;
        if (m.id === 2) out.tools = (m.result?.tools || []).map(x => x.name);
        if (m.id === 3) out.status = m.result?.content?.[0]?.text || '';
        if (m.id === 4) { out.mail = m.result?.content?.[0]?.text || ''; clearTimeout(t); p.kill(); resolve(out); }
      }
    });
    const send = o => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'add-kommo', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kommo_status', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mail_status', arguments: {} } });
  });
}

async function main() {
  say('One Development: добавляю Kommo в коннектор');
  console.log(`Система: ${WIN ? 'Windows' : MAC ? 'macOS' : process.platform}, Node.js ${process.version}`);

  const files = configFiles();
  if (!files.length) {
    const ext = path.join(CLAUDE_DIR, 'Claude Extensions');
    let asExtension = false;
    try { asExtension = fs.readdirSync(ext).some(d => d.includes(NAME)); } catch { /* нет папки */ }
    fail(asExtension
      ? 'Коннектор стоит у вас как расширение Claude, а этот файл обновляет обычную установку. Ничего не изменено. Напишите Дмитрию.'
      : 'Коннектор One Development на этом компьютере не найден. Ничего не изменено. Напишите Дмитрию.');
  }
  const k = await integrationKey();

  // 1. Программа коннектора — туда же, где она стоит сейчас; старая версия — рядом, на всякий случай.
  say('1/3 · Обновляю программу коннектора');
  const first = JSON.parse(fs.readFileSync(files[0], 'utf8')).mcpServers[NAME];
  const connector = first.args?.[0] || path.join(APP_DIR, 'app', 'index.js');
  fs.mkdirSync(path.dirname(connector), { recursive: true });
  const keepFirst = f => { if (fs.existsSync(f) && !fs.existsSync(f + '.before-kommo')) fs.copyFileSync(f, f + '.before-kommo'); };
  keepFirst(connector);
  for (const f of ['index.js', 'THIRD_PARTY_LICENSES.txt']) fs.copyFileSync(path.join(HERE, 'connector', f), path.join(path.dirname(connector), f));
  console.log('  ✓ ' + connector);

  // 2. Ключ интеграции — в хранилище системы, в настройках — только ссылка на него.
  say('2/3 · Подключаю Kommo');
  const secretRef = storeSecret('kommo-integration', 'onedevelopment', k.secret);
  console.log(`  ✓ ключ интеграции — в ${MAC ? 'связке ключей macOS' : 'защищённом хранилище Windows'}`);
  for (const f of files) {
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    const entry = cfg.mcpServers[NAME];
    keepFirst(f);
    const env = { ...(entry.env || {}) };
    delete env.KOMMO_TOKEN;      // только личный вход: токен администратора здесь не нужен
    delete env.KOMMO_ONLY_OWN;   // по умолчанию — только свои сделки
    Object.assign(env, {
      KOMMO_SUBDOMAIN: 'onedevelopment',
      KOMMO_CLIENT_ID: k.id,
      KOMMO_CLIENT_SECRET: secretRef,
      KOMMO_REDIRECT_URI: k.redirect || 'https://onedev-kommo-login.vercel.app/kommo',
      ONEDEV_KOMMO_MODE: KOMMO_MODE,
    });
    entry.env = env;
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
    console.log('  ✓ ' + f);
  }

  // 3. Проверка: Kommo виден, записи нет, вход ещё не выполнен.
  say('3/3 · Проверяю');
  const env = JSON.parse(fs.readFileSync(files[0], 'utf8')).mcpServers[NAME].env;
  const r = await probe(connector, env);
  const tools = r.tools || [];
  const readOk = tools.includes('kommo_status') && tools.includes('kommo_leads') && tools.includes('kommo_login');
  const noWrite = !tools.some(t => /^kommo_(create|update)_/.test(t));
  console.log(readOk ? `  ✓ коннектор ${r.version || ''}: инструменты Kommo на месте` : '  ! инструменты Kommo не появились');
  console.log(noWrite ? '  ✓ запись в Kommo выключена — только чтение' : '  ! видны инструменты записи');
  console.log(/logged_in"?\s*:\s*(true|false)/.test(r.status || '') ? '  ✓ Kommo подключён: осталось войти своим логином' : `  ! Kommo: ${(r.status || 'нет ответа').slice(0, 200)}`);
  console.log(/"connected":\s*true/.test(r.mail || '') ? '  ✓ почта по-прежнему работает' : `  ! почта не ответила: ${(r.mail || 'нет ответа').slice(0, 200)} — если в Claude почта перестанет работать, напишите Дмитрию`);
  if (!readOk || !noWrite) fail('Что-то пошло не так. Пришлите Дмитрию снимок этого окна.');

  say('Готово.');
  console.log(`1. Закройте Claude полностью (Mac: ⌘Q; Windows: значок в трее → Quit) и откройте снова.
2. Напишите в Claude: «Войди в Kommo» — откроется страница Kommo, войдите своим логином и паролем.
3. Проверьте: «Покажи статус Kommo» — должно быть ваше имя и «только чтение».`);
}

main().catch(e => fail(e.message));
