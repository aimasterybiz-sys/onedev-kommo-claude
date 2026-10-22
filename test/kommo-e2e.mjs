// Kommo end-to-end test: runs the bundled connector over MCP stdio against a fake Kommo API.
// Checks modes (read/test/full), "only own records", the journal and undo. Never touches real Kommo.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntry = path.join(root, 'OneDev-Kommo', 'payload', 'connector', 'index.js');
const ME = 101, OTHER = 202;

// ---- fake Kommo -------------------------------------------------------------------------------
let clock = 1_790_000_000;
const db = {
  users: [{ id: ME, name: 'Test Me', email: 'me@onedevelopment.lv' }, { id: OTHER, name: 'Other', email: 'other@onedevelopment.lv' }],
  leads: { 500: { id: 500, name: 'Old lead (mine)', price: 1000, status_id: 38312413, pipeline_id: 4036309, responsible_user_id: ME, updated_at: clock, custom_fields_values: [{ field_id: 7, values: [{ value: 'old' }] }], tags: [] },
           600: { id: 600, name: 'Old lead (other)', price: 5, status_id: 38312413, pipeline_id: 4036309, responsible_user_id: OTHER, updated_at: clock, tags: [] } },
  tasks: { 900: { id: 900, text: 'Old task', complete_till: clock + 100, responsible_user_id: ME, is_completed: false, updated_at: clock } },
  contacts: {}, notes: {},
};
const LOSS_REASONS = { 55: 'Выбрали других' };
let nextId = 1000;
const requests = [];
const tokens = { 'good-token': ME };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const data = body ? JSON.parse(body) : undefined;
    requests.push({ method: req.method, path: p, query: decodeURIComponent(url.search), data });
    let m;
    if (req.method === 'POST' && p === '/oauth2/access_token') {
      if (data.client_id !== 'cid' || data.client_secret !== 'sec') return send(res, 401, { hint: 'bad client' });
      if (data.redirect_uri !== 'https://relay.example/kommo') return send(res, 400, { hint: 'redirect_uri mismatch' });
      if (data.grant_type === 'authorization_code' && data.code === 'CODE2') { tokens['oauth-C'] = ME; return send(res, 200, { access_token: 'oauth-C', refresh_token: 'r3', expires_in: 86400 }); }
      if (data.grant_type === 'authorization_code' && data.code === 'CODE1') { tokens['oauth-A'] = OTHER; return send(res, 200, { access_token: 'oauth-A', refresh_token: 'r1', expires_in: 86400 }); }
      if (data.grant_type === 'refresh_token' && data.refresh_token === 'r1') { tokens['oauth-B'] = OTHER; delete tokens['oauth-A']; return send(res, 200, { access_token: 'oauth-B', refresh_token: 'r2', expires_in: 86400 }); }
      return send(res, 400, { hint: 'bad grant' });
    }
    if (req.method === 'GET' && p === '/oauth') return send(res, 200, { page: 'login' });
    // страница входа с секретом на сервере: коннектор присылает только код, без client_id и секрета
    if (req.method === 'POST' && p === '/proxy/token') {
      if (data.client_secret || data.client_id) return send(res, 400, { hint: 'секрет не должен приходить с компьютера' });
      if (data.grant_type === 'authorization_code' && data.code === 'CODE-P') { tokens['oauth-P'] = ME; return send(res, 200, { access_token: 'oauth-P', refresh_token: 'rP', expires_in: 86400 }); }
      return send(res, 400, { hint: 'bad grant' });
    }
    const who = tokens[(req.headers.authorization || '').replace('Bearer ', '')];
    if (!who) return send(res, 401, { title: 'Unauthorized' });
    if (req.method === 'GET' && p === '/api/v4/account') return send(res, 200, { name: 'Fake Kommo', current_user_id: who });
    if (req.method === 'GET' && p === '/api/v4/users') return send(res, 200, { _embedded: { users: db.users } });
    if (req.method === 'GET' && (m = p.match(/^\/api\/v4\/users\/(\d+)$/))) return send(res, 200, db.users.find(u => u.id === +m[1]));
    if (req.method === 'GET' && p === '/api/v4/tasks') {
      const r = url.searchParams.get('filter[responsible_user_id]');
      return send(res, 200, { _embedded: { tasks: Object.values(db.tasks).filter(t => !r || t.responsible_user_id === +r) } });
    }
    if (req.method === 'GET' && p === '/api/v4/leads') {
      const ids = url.searchParams.getAll('filter[id][]').map(Number);
      const r = url.searchParams.get('filter[responsible_user_id]');
      const list = Object.values(db.leads).filter(l => (!ids.length || ids.includes(l.id)) && (!r || l.responsible_user_id === +r));
      const lim = +url.searchParams.get('limit') || 50, pg = +url.searchParams.get('page') || 1;
      const slice = list.slice((pg - 1) * lim, pg * lim);
      if (!slice.length && pg > 1) return send(res, 204);
      const withLoss = (url.searchParams.get('with') || '').includes('loss_reason');
      const out = slice.map(l => (withLoss ? { ...l, _embedded: { loss_reason: l.loss_reason_id ? [{ id: l.loss_reason_id, name: LOSS_REASONS[l.loss_reason_id] }] : [] } } : l));
      return send(res, 200, { _links: list.length > pg * lim ? { next: { href: 'next' } } : {}, _embedded: { leads: out } });
    }
    if (req.method === 'GET' && p === '/api/v4/contacts') return send(res, 200, { _embedded: { contacts: Object.values(db.contacts) } });
    if (req.method === 'GET' && p === '/api/v4/leads/custom_fields') return send(res, 200, { _embedded: { custom_fields: [
      { id: 11, name: 'Объект интереса', type: 'multiselect', is_api_only: false, enums: [{ id: 111, value: 'Signature House by Wolfschmidt' }], required_statuses: [{ pipeline_id: 4036309, status_id: 38312419 }] },
      { id: 12, name: 'Комментарий', type: 'textarea', is_api_only: false, enums: null, required_statuses: [] },
      { id: 13, name: 'utm_source', type: 'tracking_data', is_api_only: true, enums: null, required_statuses: [] },
      { id: 14, name: 'n_gtexport_md5', type: 'text', is_api_only: true, enums: null, required_statuses: [] },
    ] } });
    if (req.method === 'GET' && p === '/api/v4/contacts/custom_fields') return send(res, 200, { _embedded: { custom_fields: [{ id: 21, name: 'Phone', type: 'multitext', is_api_only: false, enums: [{ id: 1, value: 'MOB' }], required_statuses: [] }] } });
    if (req.method === 'GET' && p === '/api/v4/leads/pipelines') return send(res, 200, { _embedded: { pipelines: [{ id: 4036309, name: 'Pipeline', _embedded: { statuses: [{ id: 38312416, name: 'Попытка связи' }, { id: 38312419, name: 'Назначить встречу/показ' }, { id: 143, name: 'lost' }] } }] } });
    if ((m = p.match(/^\/api\/v4\/leads\/(\d+)\/notes$/)) && req.method === 'GET') return send(res, 200, { _embedded: { notes: Object.values(db.notes).filter(n => n.entity_id === +m[1]) } });
    if ((m = p.match(/^\/api\/v4\/(leads|tasks|contacts)\/(\d+)$/))) {
      const rec = db[m[1]][m[2]];
      if (!rec) return send(res, 404, { title: 'Not found' });
      if (req.method === 'GET') return send(res, 200, rec);
      if (req.method === 'PATCH') {
        const { tags_to_add, ...rest } = data;
        Object.assign(rec, rest, { updated_at: ++clock });
        if (tags_to_add) rec.tags = [...(rec.tags || []), ...tags_to_add.map(t => t.name)];
        return send(res, 200, { id: rec.id, updated_at: rec.updated_at });
      }
    }
    if (req.method === 'POST' && p === '/api/v4/tasks') {
      const t = { ...data[0], id: ++nextId, is_completed: false, updated_at: ++clock };
      db.tasks[t.id] = t;
      return send(res, 200, { _embedded: { tasks: [{ id: t.id }] } });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/v4\/leads\/(\d+)\/notes$/))) {
      const n = { ...data[0], id: ++nextId, entity_id: +m[1] };
      db.notes[n.id] = n;
      return send(res, 200, { _embedded: { notes: [{ id: n.id }] } });
    }
    if (req.method === 'PATCH' && (m = p.match(/^\/api\/v4\/leads\/notes\/(\d+)$/))) {
      Object.assign(db.notes[m[1]], data);
      return send(res, 200, { id: +m[1] });
    }
    if (req.method === 'POST' && p === '/api/v4/leads/complex') {
      const l = { ...data[0], id: ++nextId, updated_at: ++clock, tags: data[0]._embedded.tags.map(t => t.name) };
      delete l._embedded;
      db.leads[l.id] = l;
      let contact_id;
      if (data[0]._embedded.contacts) {
        contact_id = ++nextId;
        db.contacts[contact_id] = { id: contact_id, ...data[0]._embedded.contacts[0], responsible_user_id: l.responsible_user_id, updated_at: clock, tags: ['Claude'] };
      }
      return send(res, 200, [{ id: l.id, contact_id }]);
    }
    if (req.method === 'POST' && p === '/api/v4/contacts') {
      const c = { ...data[0], id: ++nextId, updated_at: ++clock, tags: ['Claude'] };
      db.contacts[c.id] = c;
      return send(res, 200, { _embedded: { contacts: [{ id: c.id }] } });
    }
    send(res, 404, { title: `no route ${req.method} ${p}` });
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${fake.address().port}`;

// ---- helpers ------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onedev-connector-test-'));
const journalFile = path.join(tmp, 'journal.jsonl');

async function connect(mode, token = 'good-token', extra = {}) {
  const client = new Client({ name: 'kommo-e2e', version: '1' });
  const env = { ...process.env, KOMMO_TOKEN: token, KOMMO_BASE_URL: BASE, ONEDEV_KOMMO_MODE: mode, ONEDEV_JOURNAL: journalFile, MAIL_USER: '', MAIL_PASSWORD: '', ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text || '';
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { error: Boolean(r.isError), text, json };
  };
  const names = (await client.listTools()).tools.map(t => t.name);
  return { client, call, names };
}

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

// ---- read mode ------------------------------------------------------------------------------------
{
  console.log('read mode');
  const { client, call, names } = await connect('read');
  ok(names.includes('kommo_tasks') && !names.includes('kommo_create_task') && !names.includes('kommo_update_lead'), 'в режиме read нет инструментов записи');
  ok(names.includes('changes_list') && names.includes('changes_undo'), 'журнал доступен');
  ok(names.includes('mail_status'), 'инструменты почты на месте (без настроек объясняют, что делать)');
  const st = await call('kommo_status');
  ok(!st.error && st.json.mode === 'read' && st.json.me.id === ME && st.json.can.delete === false, 'kommo_status: режим, пользователь, удаления нет');
  const bad = await call('kommo_create_task', { text: 'x', due: '2026-09-25 11:00' });
  ok(bad.error && /недоступен/.test(bad.text), 'вызов создания в read отклонён');
  await client.close();
}

// ---- test mode ------------------------------------------------------------------------------------
let taskJ, leadJ;
{
  console.log('test mode');
  const { client, call, names } = await connect('test');
  ok(names.includes('kommo_create_task') && names.includes('kommo_create_lead') && !names.includes('kommo_update_lead') && !names.includes('kommo_update_task'), 'в режиме test есть создание и нет изменения');
  const noDue = await call('kommo_create_task', { text: 'Позвонить', lead_id: 500 });
  ok(noDue.error, 'задача без срока не ставится');
  const t = await call('kommo_create_task', { text: 'Позвонить Ирине', due: '2026-09-25 11:00', lead_id: 500 });
  ok(!t.error && db.tasks[t.json.id].responsible_user_id === ME && db.tasks[t.json.id].entity_id === 500, 'задача создана на сделке, ответственный — я');
  taskJ = t.json.journal_id;
  const n = await call('kommo_create_note', { lead_id: 500, text: 'Клиент просил показ в четверг' });
  ok(!n.error && db.notes[n.json.id].params.text.includes('четверг'), 'заметка создана');
  const l = await call('kommo_create_lead', { name: 'Тест Claude', contact_name: 'Ирина', phone: '+37120000000' });
  ok(!l.error && db.leads[l.json.id].tags.includes('Claude') && l.json.contact_id, 'сделка и контакт созданы с тегом Claude');
  leadJ = l.json.journal_id;
  const before = JSON.stringify(db.leads[500]);
  const upd = await call('kommo_update_lead', { id: 500, price: 1 });
  ok(upd.error && JSON.stringify(db.leads[500]) === before, 'старая сделка не изменилась');
  const patches = requests.filter(r => r.method === 'PATCH');
  ok(patches.length === 0, 'в режиме test не было ни одного PATCH');
  const list = await call('changes_list');
  ok(list.json.count === 4, 'в журнале 4 изменения (задача, заметка, сделка, контакт)');
  await client.close();
}

// ---- full mode ------------------------------------------------------------------------------------
{
  console.log('full mode');
  const { client, call, names } = await connect('full');
  ok(names.includes('kommo_update_lead'), 'в режиме full есть изменение');
  const other = await call('kommo_update_lead', { id: 600, price: 1 });
  ok(other.error && /другим сотрудником/.test(other.text) && db.leads[600].price === 5, 'чужую сделку менять нельзя');
  const u = await call('kommo_update_lead', { id: 500, price: 2000, status_id: 38312416, custom_fields: [{ field_id: 7, values: [{ value: 'new' }] }, { field_id: 8, values: [{ value: 'added' }] }] });
  ok(!u.error && db.leads[500].price === 2000 && db.leads[500].status_id === 38312416, 'своя сделка изменена');
  const ut = await call('kommo_update_task', { id: 900, text: 'Old task changed' });
  ok(!ut.error && db.tasks[900].text === 'Old task changed', 'своя задача изменена');

  const noConfirm = await call('changes_undo', { all: true, confirm: 'да' });
  ok(noConfirm.error && db.leads[500].price === 2000, 'без «ОТКАТИТЬ» откат не выполняется');

  // человек поменял задачу 900 после Claude
  db.tasks[900].updated_at = ++clock; db.tasks[900].text = 'Human edit';
  const undo = await call('changes_undo', { all: true, confirm: 'ОТКАТИТЬ' });
  ok(!undo.error, 'откат выполнен');
  const L = db.leads[500];
  ok(L.price === 1000 && L.status_id === 38312413, 'сделка: цена и стадия вернулись');
  const cf7 = L.custom_fields_values.find(f => f.field_id === 7);
  const cf8 = L.custom_fields_values.find(f => f.field_id === 8);
  ok(cf7.values[0].value === 'old' && cf8.values === null, 'сделка: поля вернулись, новое поле очищено');
  ok(db.tasks[900].text === 'Human edit', 'задачу, которую потом менял человек, откат не тронул');
  const created = Object.values(db.tasks).find(t => t.text === 'Позвонить Ирине');
  ok(created.is_completed === true && /Отменено/.test(created.result.text), 'созданная задача закрыта с пометкой «Отменено»');
  const newLead = Object.values(db.leads).find(x => x.name === 'Тест Claude');
  ok(newLead.status_id === 143 && newLead.tags.includes('Claude-откат'), 'созданная сделка закрыта и помечена тегом Claude-откат');
  const contact = Object.values(db.contacts)[0];
  ok(contact.tags.includes('Claude-откат'), 'созданный контакт помечен тегом Claude-откат');
  const note = Object.values(db.notes)[0];
  ok(/отменена/.test(note.params.text), 'текст заметки заменён пометкой');
  ok(undo.json.skipped === 1 && undo.json.done === 5, 'итог: 5 откачено, 1 пропущено');

  const again = await call('changes_undo', { all: true, confirm: 'ОТКАТИТЬ' });
  ok(again.json.total === 1, 'повторный откат берёт только непрошедшее');
  const forced = await call('changes_undo', { all: true, force: true, confirm: 'ОТКАТИТЬ' });
  ok(forced.json.done === 1 && db.tasks[900].text === 'Old task', 'force возвращает и запись, изменённую человеком');
  const list = await call('changes_list');
  ok(list.json.changes.every(c => c.undone_at), 'в журнале все изменения отмечены как отменённые');
  await client.close();
}

// ---- только свои записи --------------------------------------------------------------------------
{
  console.log('only own records');
  const { client, call, names } = await connect('test');
  const fl = await call('kommo_find_leads', { query: 'lead' });
  ok(!fl.error && fl.json.leads.every(l => l.responsible_user_id === ME) && fl.json.found_at_other_managers?.[0]?.belongs_to === 'Other', 'поиск: свои сделки целиком, чужие — только «есть у Other»');
  ok(!fl.text.includes('Old lead (other)'), 'данные чужой сделки в ответ не попали');
  const g = await call('kommo_get_lead', { id: 600 });
  ok(g.error && /другого сотрудника/.test(g.text), 'чужую сделку открыть нельзя');
  const n = await call('kommo_get_notes', { lead_id: 600 });
  ok(n.error, 'заметки чужой сделки прочитать нельзя');
  const before = requests.filter(r => r.method === 'POST').length;
  const t = await call('kommo_create_task', { text: 'x', due: '2026-09-25 11:00', lead_id: 600 });
  ok(t.error && requests.filter(r => r.method === 'POST').length === before, 'задачу на чужую сделку поставить нельзя, запроса в Kommo не было');
  const any = await call('kommo_get', { path: '/api/v4/leads' });
  ok(any.error && /закрыты/.test(any.text), 'произвольные запросы закрыты');
  await call('kommo_tasks', { responsible: 'all' });
  const lastTasks = requests.filter(r => r.path === '/api/v4/tasks').pop();
  ok(lastTasks && lastTasks.query.includes(`filter[responsible_user_id]=${ME}`), 'просьба «все задачи» всё равно даёт только свои');
  await client.close();
}

// ---- сделки для отчёта: коротко, по страницам, с причиной отказа ---------------------------------
{
  console.log('leads for reports');
  db.leads[700] = { id: 700, name: 'Lost lead (mine)', price: 300000, status_id: 143, pipeline_id: 4036309, responsible_user_id: ME, created_at: 1_790_000_000, updated_at: 1_790_086_400, closed_at: 1_790_086_400, loss_reason_id: 55, custom_fields_values: [{ field_id: 7, values: [{ value: 'x' }] }], tags: [] };
  const { client, call } = await connect('read');
  const p1 = await call('kommo_leads', { short: true, limit: 1, responsible: 'all' });
  const q = requests.filter(r => r.path === '/api/v4/leads').pop().query;
  ok(!p1.error && q.includes(`filter[responsible_user_id]=${ME}`) && q.includes('with=loss_reason'), 'список сделок: только свои даже при «all», с причиной отказа');
  ok(p1.json.leads.length === 1 && p1.json.next_page === 2 && !('custom_fields_values' in p1.json.leads[0]), 'коротко и по страницам: есть следующая страница, лишних полей нет');
  const lost = (await call('kommo_leads', { short: true, limit: 1, page: 2 })).json.leads[0];
  ok(lost.id === 700 && lost.stage === 'lost' && lost.loss_reason === 'Выбрали других' && lost.created === '2026-09-21' && lost.closed === '2026-09-22', 'стадия и причина отказа названием, даты по-человечески');
  const end = await call('kommo_leads', { short: true, limit: 250, page: 9 });
  ok(!end.error && end.json.leads.length === 0 && end.json.next_page === null, 'за последней страницей — пустой список, без ошибки');
  await client.close();
  delete db.leads[700];
}

// ---- карточка и создание сделки с полями ---------------------------------------------------------
{
  console.log('card and lead with fields');
  const { client, call } = await connect('test');
  const card = await call('kommo_card');
  const names = card.json.lead_fields.map(f => f.name);
  ok(names.includes('Объект интереса') && !names.includes('utm_source') && !names.includes('n_gtexport_md5'), 'карточка: служебные поля убраны');
  ok(card.json.lead_fields.find(f => f.id === 11).required_from_stage[0] === 'Назначить встречу/показ', 'карточка: обязательность по стадии названа словами');
  ok(card.json.pipelines[0].stages.every(s => s.id !== 143), 'карточка: закрытые стадии не предлагаются');
  const l = await call('kommo_create_lead', { name: 'Ирина — SH 3к', status_id: 38312416, contact_name: 'Ирина', phone: '+37120000001', custom_fields: [{ field_id: 11, values: [{ enum_id: 111 }] }], tags: ['Signature House'], comment: 'Хочет вид на парк' });
  const body = requests.filter(r => r.path === '/api/v4/leads/complex').pop().data[0];
  ok(!l.error && body.custom_fields_values.some(f => f.field_id === 11 && f.values[0].enum_id === 111), 'сделка: поле из списка передано по enum_id');
  ok(body.custom_fields_values.some(f => f.field_id === 12 && f.values[0].value === 'Хочет вид на парк'), 'сделка: комментарий лёг в поле «Комментарий»');
  ok(body._embedded.tags.map(t => t.name).join(',') === 'Claude,Signature House', 'сделка: теги Claude + дополнительный');
  ok(body._embedded.contacts[0].custom_fields_values[0].values[0].enum_code === 'MOB' && body.responsible_user_id === ME, 'контакт: мобильный телефон, ответственный — вошедший');
  ok(/leads\/detail\//.test(l.json.link), 'ответ содержит ссылку на сделку');
  await client.close();
}

// ---- личный вход (OAuth) ------------------------------------------------------------------------------
{
  console.log('personal login');
  const port = await new Promise(r => { const srv = http.createServer(); srv.listen(0, '127.0.0.1', () => { const pt = srv.address().port; srv.close(() => r(pt)); }); });
  const store = path.join(tmp, 'tokens.json');
  const oauthEnv = { KOMMO_TOKEN: undefined, KOMMO_CLIENT_ID: 'cid', KOMMO_CLIENT_SECRET: 'sec', KOMMO_REDIRECT_URI: 'https://relay.example/kommo', KOMMO_LOCAL_CALLBACK: `http://127.0.0.1:${port}/kommo`, KOMMO_AUTH_URL: `${BASE}/oauth`, ONEDEV_NO_BROWSER: '1', ONEDEV_TOKEN_STORE: `file:${store}` };
  let c = await connect('test', undefined, oauthEnv);
  const st0 = await c.call('kommo_status');
  ok(!st0.error && st0.json.logged_in === false && /kommo_login/.test(st0.json.how), 'без входа: статус просит войти');
  const t0 = await c.call('kommo_tasks');
  ok(t0.error && /Нужно войти/.test(t0.text), 'без входа: данные Kommo недоступны');
  const lg = await c.call('kommo_login');
  const state = new URL(lg.json.login_url).searchParams.get('state');
  ok(!lg.error && lg.json.login_url.startsWith(`${BASE}/oauth?client_id=cid`) && state, 'kommo_login даёт ссылку на страницу входа Kommo');
  const bad = await fetch(`http://127.0.0.1:${port}/kommo?code=CODE1&state=wrong&referer=onedevelopment.kommo.com`);
  ok(bad.status === 400 && !fs.existsSync(store), 'чужой state отклонён, токен не сохранён');
  const good = await fetch(`http://127.0.0.1:${port}/kommo?code=CODE1&state=${state}&referer=onedevelopment.kommo.com`);
  ok(good.status === 200 && /Готово/.test(await good.text()), 'возврат из Kommo принят, страница «Готово»');
  const st1 = await c.call('kommo_status');
  ok(st1.json.logged_in === true && st1.json.me.id === OTHER && st1.json.login.method === 'личный вход', 'после входа: Claude работает от имени вошедшего (Other)');
  // Права файла в стиле Unix на Windows не применяются; там токены шифрует DPAPI, а файловое хранилище — только для тестов.
  if (process.platform !== 'win32') ok((fs.statSync(store).mode & 0o077) === 0, 'хранилище токенов закрыто для других пользователей');
  const own = await c.call('kommo_find_leads', { query: 'x' });
  ok(own.json.leads.every(l => l.responsible_user_id === OTHER), 'после входа: видны только сделки вошедшего');
  await c.client.close();

  // истёк доступ → обновление без повторного входа
  const all = JSON.parse(fs.readFileSync(store, 'utf8'));
  const key = Object.keys(all)[0];
  const tok = JSON.parse(all[key]); tok.expires_at = 0; all[key] = JSON.stringify(tok);
  fs.writeFileSync(store, JSON.stringify(all), { mode: 0o600 });
  c = await connect('test', undefined, oauthEnv);
  const st2 = await c.call('kommo_status');
  const refreshed = JSON.parse(JSON.parse(fs.readFileSync(store, 'utf8'))[key]);
  ok(st2.json.logged_in && refreshed.access_token === 'oauth-B' && refreshed.refresh_token === 'r2', 'истёкший доступ обновлён сам, без пароля');

  // доступ отозван в Kommo → просит войти заново и забывает токен
  delete tokens['oauth-B'];
  const t3 = await c.call('kommo_tasks');
  ok(t3.error && /Нужно войти/.test(t3.text) && !JSON.parse(fs.readFileSync(store, 'utf8'))[key], 'отозванный доступ: вход забыт, просит войти заново');
  const lo = await c.call('kommo_logout');
  ok(!lo.error && lo.json.logged_in === false, 'выход работает');
  const byCode = await c.call('kommo_login', { code: 'CODE2' });
  ok(!byCode.error && byCode.json.logged_in === true && byCode.json.me.id === ME, 'запасной путь: вход по коду, вставленному в чат');
  await c.client.close();
}

// ---- коннектор «только Kommo»: без почты, без секрета на компьютере ---------------------------------
{
  console.log('Kommo only, secret on the login page');
  const store = path.join(tmp, 'tokens-only.json');
  const env = { KOMMO_TOKEN: undefined, ONEDEV_MAIL: 'off', KOMMO_CLIENT_ID: 'cid', KOMMO_CLIENT_SECRET: undefined, KOMMO_TOKEN_PROXY: `${BASE}/proxy/token`, KOMMO_REDIRECT_URI: 'https://relay.example/kommo', KOMMO_AUTH_URL: `${BASE}/oauth`, ONEDEV_NO_BROWSER: '1', ONEDEV_TOKEN_STORE: `file:${store}` };
  const { client, call, names } = await connect('read', undefined, env);
  ok(!names.some(n => n.startsWith('mail_')) && names.includes('kommo_leads') && names.includes('kommo_login'), 'только Kommo: инструментов почты нет, Kommo есть');
  ok((await call('kommo_status')).json.logged_in === false, 'без секрета на компьютере Kommo всё равно подключён и ждёт входа');
  const lg = await call('kommo_login', { code: 'CODE-P' });
  const sent = requests.filter(r => r.path === '/proxy/token').pop();
  ok(!lg.error && lg.json.logged_in && lg.json.me.id === ME && sent && !('client_secret' in sent.data), 'вход через страницу входа: Kommo принял, секрет с компьютера не уходил');
  await client.close();
}

// ---- bad token --------------------------------------------------------------------------------------
{
  console.log('bad token');
  const { client, call } = await connect('test', 'wrong');
  const r = await call('kommo_status');
  ok(r.error && /не принял токен/.test(r.text), 'неверный токен — понятная ошибка');
  await client.close();
}

fake.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nKommo e2e: ${passed} проверок пройдено`);
