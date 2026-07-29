/* SAFA Inspector — перронная инспекция ВС (АГА РТ)
   Офлайн-first PWA. Данные: IndexedDB. Синхронизация: Google Apps Script.
   База находок: EASA RIM Appendix 1, Issue 6 (INST.RI.01/006). */
'use strict';

const APP_VER = '1.3.0';

/* ══════════════ справочные константы ══════════════ */

const TYPES = {
  SAFA: { ru: 'SAFA — ВС иностранных эксплуатантов',
          en: 'Safety Assessment of Foreign Aircraft' },
  SANA: { ru: 'SANA — ВС эксплуатантов Республики Таджикистан',
          en: 'Safety Assessment of National Aircraft' },
  SACA: { ru: 'SACA — ВС эксплуатантов государств-участников соглашения',
          en: 'Safety Assessment of Community Aircraft' },
};

const CATS = {
  1: { ru: 'Категория 1 — незначительное влияние на безопасность полётов', cls: 'cat1' },
  2: { ru: 'Категория 2 — существенное влияние на безопасность полётов',   cls: 'cat2' },
  3: { ru: 'Категория 3 — серьёзное влияние на безопасность полётов',      cls: 'cat3' },
  G: { ru: 'General — отклонение по форме документа, вне категорий',       cls: 'catG' },
};

// Классы принятых мер — дословно по форме ввода базы SAFA (v2, Release-129,
// вкладка Basic info → Actions). Порядок в базе обратный: от 3d к 1.
const ACTIONS = [
  ['1',  'Информирование командира воздушного судна',
         'Information to Captain'],
  ['2',  'Информирование полномочного органа и эксплуатанта',
         'Information to the Authority and the Operator'],
  ['3a', 'Ограничение эксплуатации воздушного судна',
         'Restriction on the aircraft flight operation'],
  ['3b', 'Корректирующие действия до вылета',
         'Corrective actions before flight'],
  ['3c', 'ВС запрещено к полёту инспектирующим полномочным органом',
         'Aircraft grounded by inspecting NAA'],
  ['3d', 'Немедленный запрет эксплуатации',
         'Immediate Operating ban'],
];

const ST = {                        // статус пункта чек-листа
  ni: { ru: 'не проверялся', ic: '–',  cls: 'pmut' },
  ok: { ru: 'соответствует', ic: '✓',  cls: 'pok'  },
  na: { ru: 'не применимо',  ic: 'N',  cls: 'pmut' },
  f:  { ru: 'несоответствие',ic: '!',  cls: 'cat3' },
};

const ITEMS = window.SAFA_ITEMS, SECTIONS = window.SAFA_SECTIONS, PDF = window.SAFA_PDF;
const ITEM_BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));
const PDF_BY_ITEM = PDF.reduce((a, f) => ((a[f.item] = a[f.item] || []).push(f), a), {});

/* ══════════════ хранилище ══════════════ */

const DB = (() => {
  let db = null;
  const NAME = 'safa-inspector', VER = 2;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VER);
      // хранилища создаются только если их нет — миграция идемпотентна
      // и не теряет уже накопленные инспекции при повышении версии
      r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('insp'))   d.createObjectStore('insp', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv'))     d.createObjectStore('kv', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('lib'))    d.createObjectStore('lib', { keyPath: 'id' });
      };
      r.onsuccess = e => { db = e.target.result; res(db); };
      r.onerror = () => rej(r.error);
    });
  }
  const tx = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const q = fn(s);
    if (q) q.onsuccess = e => { out = e.target.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  }));

  return {
    all:  ()   => tx('insp', 'readonly',  s => s.getAll()),
    get:  id   => tx('insp', 'readonly',  s => s.get(id)),
    put:  o    => tx('insp', 'readwrite', s => s.put(o)),
    del:  id   => tx('insp', 'readwrite', s => s.delete(id)),
    photoPut: (id, blob) => tx('photos', 'readwrite', s => s.put({ id, blob })),
    photoGet: id => tx('photos', 'readonly', s => s.get(id)).then(r => r && r.blob),
    photoDel: id => tx('photos', 'readwrite', s => s.delete(id)),
    kvGet: k => tx('kv', 'readonly', s => s.get(k)).then(r => r && r.v),
    kvPut: (k, v) => tx('kv', 'readwrite', s => s.put({ k, v })),
    libAll: () => tx('lib', 'readonly',  s => s.getAll()),
    libPut: o => tx('lib', 'readwrite', s => s.put(o)),
    libDel: id => tx('lib', 'readwrite', s => s.delete(id)),
  };
})();

// Справочные изображения из руководств (data/photos.js). Свои примеры — в хранилище lib.
const REF_PHOTOS = (window.SAFA_REF_PHOTOS || []).filter(p => p && p.file);

const CFG = {
  d: { inspector: '', inspPost: '', authority: 'Агентство гражданской авиации при Правительстве Республики Таджикистан',
       airport: '', gasUrl: '', autoSync: true, lang: 'ru' },
  load() { try { Object.assign(this.d, JSON.parse(localStorage.safaCfg || '{}')); } catch (e) {} return this.d; },
  save() { localStorage.safaCfg = JSON.stringify(this.d); },
};
CFG.load();

/* ══════════════ утилиты ══════════════ */

const $ = s => document.querySelector(s);
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const k in a) {
    if (k === 'cls') n.className = a[k];
    else if (k === 'html') n.innerHTML = a[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), a[k]);
    else if (a[k] !== false && a[k] != null) n.setAttribute(k, a[k]);
  }
  kids.flat().forEach(c => c != null && n.append(c.nodeType ? c : String(c)));
  return n;
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDate = s => s ? s.split('-').reverse().join('.') : '';

let toastT;
function toast(msg) {
  clearTimeout(toastT);
  let t = $('.toast');
  if (!t) { t = el('div', { cls: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  toastT = setTimeout(() => t.remove(), 2600);
}

function sheet(title, build) {
  const box = el('div');
  // ghost-click: на тач-экранах событие, открывшее лист, успевает «долететь»
  // до подложки и сразу его закрыть — гасим первые 350 мс
  const born = Date.now();
  const wrap = el('div', { cls: 'sheet', onclick: e => { if (e.target === wrap && Date.now() - born > 350) close(); } },
    el('div', {}, el('h3', {}, title), box,
      el('button', { cls: 'btn sec wide sp', onclick: () => close() }, 'Закрыть')));
  function close() { wrap.remove(); }
  build(box, close);
  document.body.append(wrap);
  return close;
}

/* ══════════════ модель инспекции ══════════════ */

function newInspection(type) {
  const now = new Date();
  const items = {};
  ITEMS.forEach(i => items[i.id] = { s: 'ni', rmk: '' });
  return {
    id: uid(), type, ver: APP_VER, status: 'draft',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    gen: {
      poi: '', date: isoDate(now), time: hhmm(now), airport: CFG.d.airport,
      operator: '', aocNo: '', aocState: '', aocContact: '', chartered: '',
      routeFrom: '', flightIn: '', routeTo: '', flightOut: '',
      regState: '', kind: 'pax', acType: '', acReg: '', msn: '',
      crewLic1: '', crewLic2: '',
      inspector: CFG.d.inspector, captain: '',
    },
    items, findings: [], actClass: '', comments: '',
    sig: { insp: '', cap: '' },
    sync: { state: 'local', at: '' },
  };
}

const maxCat = ins => {
  const nums = ins.findings.map(f => f.cat).filter(c => c !== 'G');
  return nums.length ? Math.max(...nums) : 0;
};
const suggestClass = ins => ({ 3: '3b', 2: '2', 1: '1', 0: '' })[maxCat(ins)];
const progress = ins => ITEMS.filter(i => ins.items[i.id].s !== 'ni').length;

function inspTitle(ins) {
  const g = ins.gen;
  return [g.acReg || 'б/н рег.', g.operator, g.flightIn || g.flightOut].filter(Boolean).join(' · ');
}

async function save(ins) {
  ins.updatedAt = new Date().toISOString();
  if (ins.sync.state === 'sent') ins.sync.state = 'local';
  await DB.put(ins);
}

/* ══════════════ роутер ══════════════ */

const S = { tab: 'list', screen: 'list', ins: null, back: null };

function setHeader(title, backFn, act) {
  $('#title').textContent = title;
  const b = $('#back');
  b.hidden = !backFn;
  b.onclick = backFn || null;
  const a = $('#hdrAct');
  if (act) { a.hidden = false; a.textContent = act[0]; a.onclick = act[1]; }
  else { a.hidden = true; a.onclick = null; }
}

function render(nodes) {
  const v = $('#view');
  v.innerHTML = '';
  [].concat(nodes).forEach(n => n && v.append(n));
  window.scrollTo(0, 0);
}

document.addEventListener('click', e => {
  const t = e.target.closest('nav.tabs button');
  if (!t) return;
  S.tab = t.dataset.t;
  [...document.querySelectorAll('nav.tabs button')].forEach(b => b.classList.toggle('on', b === t));
  ({ list: scrList, ref: scrRef, train: scrTrain, stats: scrStats, set: scrSet }[S.tab])();
});

/* ══════════════ экран: список инспекций ══════════════ */

async function scrList() {
  setHeader('Инспекции на перроне', null, ['+', pickType]);
  const all = (await DB.all()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!all.length) {
    return render(el('div', { cls: 'empty' },
      el('div', { cls: 'b', style: 'font-size:19px;margin-bottom:6px' }, 'Инспекций пока нет'),
      el('div', { cls: 'sm' }, 'Нажмите «+» вверху, чтобы начать проверку воздушного судна.'),
      el('button', { cls: 'btn sp', onclick: pickType }, 'Новая инспекция')));
  }
  const nodes = all.map(ins => {
    const done = progress(ins), mc = maxCat(ins);
    const badge = ins.status === 'completed'
      ? el('span', { cls: 'pill pok' }, 'завершена')
      : el('span', { cls: 'pill pmut' }, 'в работе');
    const syncPill = { local: ['pmut', 'не отправлена'], queued: ['cat1', 'в очереди'], sent: ['pok', 'отправлена'] }[ins.sync.state];
    return el('div', {
      cls: 'card', onclick: () => openInspection(ins.id),
      style: 'cursor:pointer',
    },
      el('div', { cls: 'row' },
        el('span', { cls: 'pill pmut' }, ins.type),
        badge,
        el('span', { cls: 'pill ' + syncPill[0] }, syncPill[1]),
        el('span', { cls: 'right xs mut' }, fmtDate(ins.gen.date) + ' ' + ins.gen.time)),
      el('div', { cls: 'b sp', style: 'margin-top:8px' }, inspTitle(ins)),
      el('div', { cls: 'sm mut' }, [ins.gen.acType, ins.gen.airport].filter(Boolean).join(' · ') || '—'),
      el('div', { cls: 'row sm', style: 'margin-top:8px' },
        el('span', { cls: 'grow' },
          el('div', { cls: 'bar' }, el('i', { style: `width:${done / ITEMS.length * 100}%` }))),
        el('span', { cls: 'xs mut' }, `${done}/${ITEMS.length}`),
        ins.findings.length
          ? el('span', { cls: 'pill ' + (mc ? CATS[mc].cls : 'catG') },
              `находок: ${ins.findings.length}${mc ? ' · макс. кат. ' + mc : ''}`)
          : el('span', { cls: 'pill pok' }, 'без находок')));
  });
  render(nodes);
}

function pickType() {
  sheet('Тип инспекции', (box, close) => {
    Object.entries(TYPES).forEach(([k, v]) => {
      box.append(el('button', {
        cls: 'opt', onclick: async () => {
          const ins = newInspection(k);
          await DB.put(ins);
          close();
          openInspection(ins.id);
        }
      }, el('div', { cls: 'b' }, v.ru), el('div', { cls: 'xs mut' }, v.en)));
    });
  });
}

/* ══════════════ экран: карточка инспекции ══════════════ */

async function openInspection(id) {
  S.ins = await DB.get(id);
  scrInsp();
}

function scrInsp() {
  const ins = S.ins;
  setHeader(inspTitle(ins) || 'Новая инспекция', scrList, ['⋯', () => inspMenu(ins)]);
  const done = progress(ins), mc = maxCat(ins);
  const nav = (icon, name, hint, fn, badge) => el('div', {
    cls: 'card row', style: 'cursor:pointer;gap:11px', onclick: fn
  },
    el('div', { style: 'font-size:23px;width:30px;text-align:center' }, icon),
    el('div', { cls: 'grow' }, el('div', { cls: 'b' }, name), el('div', { cls: 'xs mut' }, hint)),
    badge || null, el('div', { cls: 'mut' }, '›'));

  render([
    el('div', { cls: 'card' },
      el('div', { cls: 'row' },
        el('span', { cls: 'pill pmut' }, ins.type),
        el('span', { cls: 'right xs mut' }, TYPES[ins.type].en)),
      el('div', { cls: 'sm sp', style: 'margin-top:8px' }, TYPES[ins.type].ru)),

    nav('📝', 'Общие сведения', 'Рейс, эксплуатант, ВС, экипаж', () => scrGeneral(),
      ins.gen.acReg && ins.gen.operator ? el('span', { cls: 'pill pok' }, 'заполнено')
                                        : el('span', { cls: 'pill cat1' }, 'не заполнено')),

    nav('✅', 'Чек-лист (53 пункта)', `Проверено ${done} из ${ITEMS.length}`, () => scrChecklist(),
      el('span', { cls: 'pill ' + (done === ITEMS.length ? 'pok' : 'pmut') }, `${done}/${ITEMS.length}`)),

    nav('⚠️', 'Находки', ins.findings.length ? `Максимальная категория: ${mc || 'G'}` : 'Несоответствий не выявлено',
      () => scrFindings(),
      el('span', { cls: 'pill ' + (ins.findings.length ? (mc ? CATS[mc].cls : 'catG') : 'pok') },
        String(ins.findings.length))),

    nav('📄', 'Отчёт (Proof of Inspection)', 'Меры, подписи, печать и отправка', () => scrReport()),
  ]);
}

function inspMenu(ins) {
  sheet('Инспекция', (box, close) => {
    const act = (t, fn, cls) => box.append(el('button', { cls: 'btn ' + (cls || 'sec') + ' wide', style: 'margin-bottom:8px', onclick: fn }, t));
    act(ins.status === 'completed' ? 'Вернуть в работу' : 'Отметить завершённой', async () => {
      ins.status = ins.status === 'completed' ? 'draft' : 'completed';
      await save(ins); close(); scrInsp();
    });
    act('Выгрузить в файл (JSON)', () => { exportJSON(ins); close(); });
    act('Удалить инспекцию', async () => {
      if (!confirm('Удалить инспекцию безвозвратно?')) return;
      for (const f of ins.findings) for (const p of (f.photos || [])) await DB.photoDel(p);
      await DB.del(ins.id); close(); scrList();
    }, 'dan');
  });
}

/* ══════════════ экран: общие сведения ══════════════ */

function scrGeneral() {
  const ins = S.ins, g = ins.gen;
  setHeader('Общие сведения', scrInsp);
  const f = (key, lab, opts = {}) => el('label', { cls: 'f' },
    el('span', {}, lab),
    el(opts.tag || 'input', {
      type: opts.type || 'text', value: opts.tag ? false : g[key],
      placeholder: opts.ph || '', inputmode: opts.im || false,
      oninput: e => { g[key] = e.target.value; save(ins); },
    }, opts.tag === 'textarea' ? g[key] : null));

  const kind = el('div', { cls: 'row', style: 'gap:8px' },
    ...[['pax', 'Пассажирский'], ['cargo', 'Грузовой'], ['mixed', 'Смешанный']].map(([k, t]) =>
      el('button', {
        cls: 'btn ' + (g.kind === k ? '' : 'sec'), style: 'flex:1;font-size:14px;padding:0 6px',
        onclick: e => { g.kind = k; save(ins); scrGeneral(); }
      }, t)));

  render([
    el('div', { cls: 'card' },
      el('h3', {}, 'Инспекция'),
      el('div', { cls: 'grid2' },
        f('poi', 'POI No (номер акта)'),
        f('airport', 'Аэропорт (ICAO/IATA)'),
        f('date', 'Дата', { type: 'date' }),
        f('time', 'Время (UTC/местное)', { type: 'time' })),
      f('inspector', 'Инспектор АГА РТ')),

    el('div', { cls: 'card' },
      el('h3', {}, 'Эксплуатант'),
      f('operator', 'Наименование эксплуатанта'),
      el('div', { cls: 'grid2' },
        f('aocNo', 'Номер AOC'),
        f('aocState', 'Государство выдачи AOC')),
      f('aocContact', 'Контактные данные владельца AOC', { tag: 'textarea' }),
      f('chartered', 'Зафрахтовано (эксплуатант/государство)')),

    el('div', { cls: 'card' },
      el('h3', {}, 'Рейс'),
      el('div', { cls: 'grid2' },
        f('routeFrom', 'Прибыл из'), f('flightIn', 'Номер рейса (прилёт)'),
        f('routeTo', 'Убывает в'), f('flightOut', 'Номер рейса (вылет)')),
      el('label', { cls: 'f' }, el('span', {}, 'Вид перевозки'), kind)),

    el('div', { cls: 'card' },
      el('h3', {}, 'Воздушное судно'),
      f('acType', 'Тип / модель ВС'),
      el('div', { cls: 'grid2' },
        f('acReg', 'Регистрационный номер'),
        f('msn', 'Заводской номер (MSN)'),
        f('regState', 'Государство регистрации'), null)),

    el('div', { cls: 'card' },
      el('h3', {}, 'Экипаж'),
      el('div', { cls: 'grid2' },
        f('crewLic1', 'Государство выдачи свидетельства, 1-й пилот'),
        f('crewLic2', 'Государство выдачи свидетельства, 2-й пилот')),
      f('captain', 'КВС / представитель эксплуатанта')),

    el('button', { cls: 'btn wide sp', onclick: scrInsp }, 'Готово'),
  ]);
}

/* ══════════════ экран: чек-лист ══════════════ */

function scrChecklist() {
  const ins = S.ins;
  setHeader(`Чек-лист · ${progress(ins)}/${ITEMS.length}`, scrInsp);
  const nodes = [];

  nodes.push(el('div', { cls: 'card xs mut' },
    'Отметьте по каждому пункту: ',
    el('b', {}, '✓'), ' соответствует · ',
    el('b', {}, 'N'), ' не применимо · ',
    el('b', {}, '!'), ' несоответствие (откроется выбор находки). ',
    'Нажатие на название пункта открывает примечание и находки.'));

  SECTIONS.forEach(sec => {
    const list = ITEMS.filter(i => i.sec === sec.id);
    const okN = list.filter(i => ins.items[i.id].s !== 'ni').length;
    nodes.push(el('div', { cls: 'sec-h' },
      el('span', { cls: 'code' }, sec.id), el('span', { cls: 'grow' }, sec.ru),
      el('span', { cls: 'pill pmut' }, `${okN}/${list.length}`)));

    list.forEach(it => {
      const st = ins.items[it.id];
      const nf = ins.findings.filter(f => f.item === it.id).length;
      const sw = el('div', { cls: 'sw' },
        ...[['ok', '✓'], ['na', 'N'], ['f', '!']].map(([k, ic]) =>
          el('button', {
            cls: (st.s === k ? 'on' : '') + (k === 'f' ? ' bad' : ''),
            onclick: async e => {
              e.stopPropagation();
              st.s = st.s === k ? 'ni' : k;
              await save(ins);
              if (st.s === 'f') addFinding(it.id, () => scrChecklist());
              else scrChecklist();
            }
          }, ic)));
      nodes.push(el('div', { cls: 'item' + (nf ? ' hasf' : '') },
        el('button', { cls: 'lab', onclick: () => scrItem(it.id) },
          el('div', { cls: 'id' }, it.id + (nf ? ` · находок: ${nf}` : '') + (st.rmk ? ' · есть примечание' : '')),
          el('div', { cls: 'nm' }, it.ru)),
        sw));
    });
  });

  nodes.push(el('button', { cls: 'btn wide sp', onclick: scrInsp }, 'Готово'));
  render(nodes);
}

function scrItem(id) {
  const ins = S.ins, it = ITEM_BY_ID[id], st = ins.items[id];
  setHeader(id + ' — ' + it.ru, scrChecklist);
  const mine = ins.findings.filter(f => f.item === id);

  render([
    el('div', { cls: 'card' },
      el('div', { cls: 'row' }, el('span', { cls: 'pill pmut' }, id),
        el('span', { cls: 'right xs mut' }, `предописанных находок: ${it.n}`)),
      el('h3', { style: 'margin-top:8px' }, it.ru),
      el('div', { cls: 'sm mut' }, it.en)),

    el('div', { cls: 'card' },
      el('h3', {}, 'Статус пункта'),
      el('div', { cls: 'row wrap' }, ...Object.entries(ST).map(([k, v]) =>
        el('button', {
          cls: 'btn ' + (st.s === k ? '' : 'sec'), style: 'flex:1;font-size:13px;padding:0 8px',
          onclick: async () => { st.s = k; await save(ins); scrItem(id); }
        }, v.ru)))),

    el('div', { cls: 'card' },
      el('label', { cls: 'f' }, el('span', {}, 'Примечание (RMK)'),
        el('textarea', {
          placeholder: 'Свободный комментарий инспектора по пункту',
          oninput: e => { st.rmk = e.target.value; save(ins); }
        }, st.rmk))),

    el('div', { cls: 'card' },
      el('div', { cls: 'row' }, el('h3', { cls: 'grow' }, 'Находки по пункту'),
        el('button', { cls: 'btn', style: 'min-height:38px;font-size:14px', onclick: () => addFinding(id, () => scrItem(id)) }, '+ Добавить')),
      mine.length ? el('div', { cls: 'sp' }, ...mine.map(f => findingRow(f, () => scrItem(id))))
                  : el('div', { cls: 'sm mut sp' }, 'Находок по этому пункту нет.')),

    el('div', { cls: 'card', id: 'exBox' }, el('h3', {}, 'Примеры по пункту'),
      el('div', { cls: 'sm mut' }, 'Загрузка…')),

    el('button', { cls: 'btn sec wide sp', onclick: scrChecklist }, 'К чек-листу'),
  ]);

  // примеры подгружаются отдельно: чтение блобов не должно тормозить экран
  examplesFor(id).then(async ({ own, ref }) => {
    const box = $('#exBox');
    if (!box) return;
    box.innerHTML = '';
    box.append(el('h3', {}, `Примеры по пункту (${own.length + ref.length})`));
    if (!own.length && !ref.length) {
      box.append(el('div', { cls: 'sm mut' },
        'Для этого пункта примеров ещё нет. Сфотографируйте несоответствие в находке и нажмите ★ на снимке.'));
      return;
    }
    const tiles = [
      ...await ownTiles(own, () => scrItem(id)),
      ...ref.map(r => galleryTile({
        src: r.file, verdict: r.verdict, kind: r.kind, title: r.title_ru,
        note: r.caption_ru, item: r.item, source: r.source,
      })),
    ];
    box.append(el('div', { cls: 'gal' }, ...tiles));
  });
}

/* ══════════════ находки ══════════════ */

function addFinding(itemId, after) {
  const ins = S.ins;
  const pool = PDF_BY_ITEM[itemId] || [];
  sheet(`Находка · ${itemId} ${ITEM_BY_ID[itemId].ru}`, (box, close) => {
    const results = el('div');
    const q = el('input', {
      placeholder: 'Поиск по формулировке или коду…',
      oninput: e => draw(e.target.value.trim().toLowerCase()),
    });
    box.append(el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
      `Предописанные находки (PDF) по пункту ${itemId}: ${pool.length}. ` +
      'Формулировка на английском — в базу SAFA она вносится дословно.'));
    box.append(q, results);

    function pick(f) {
      const nf = {
        id: uid(), item: itemId, code: f.code, text: f.text, cat: f.cat,
        refs: f.refs || '', note: '', photos: [], custom: false,
      };
      ins.findings.push(nf);
      ins.items[itemId].s = 'f';
      ins.actClass = ins.actClass || suggestClass(ins);
      save(ins).then(() => { close(); editFinding(nf, after); });
    }
    function draw(term) {
      results.innerHTML = '';
      const list = pool.filter(f => !term ||
        f.text.toLowerCase().includes(term) || f.code.toLowerCase().includes(term));
      if (!list.length) results.append(el('div', { cls: 'sm mut', style: 'padding:8px 0' }, 'Ничего не найдено.'));
      list.forEach(f => results.append(el('button', { cls: 'opt', onclick: () => pick(f) },
        el('div', { cls: 'row' },
          el('span', { cls: 'pill ' + CATS[f.cat].cls }, 'кат. ' + f.cat),
          el('span', { cls: 'xs mut right' }, f.code)),
        el('div', { cls: 'sm', style: 'margin-top:5px' }, f.text))));
      results.append(el('button', {
        cls: 'opt', style: 'border-style:dashed;margin-top:10px', onclick: () => {
          const nf = { id: uid(), item: itemId, code: '', text: term || '', cat: 1, refs: '', note: '', photos: [], custom: true };
          ins.findings.push(nf); ins.items[itemId].s = 'f';
          save(ins).then(() => { close(); editFinding(nf, after); });
        }
      }, el('div', { cls: 'b' }, '＋ Своя формулировка'),
         el('div', { cls: 'xs mut' }, 'Если ни одна предописанная находка не подходит')));
    }
    draw('');
  });
}

function findingRow(f, after) {
  return el('div', { cls: 'fnd k' + f.cat, onclick: () => editFinding(f, after), style: 'cursor:pointer' },
    el('div', { cls: 'row' },
      el('span', { cls: 'pill ' + CATS[f.cat].cls }, 'кат. ' + f.cat),
      el('span', { cls: 'xs mut' }, f.code || 'своя формулировка'),
      el('span', { cls: 'right xs mut' }, f.item),
      (f.photos || []).length ? el('span', { cls: 'xs mut' }, `📷 ${f.photos.length}`) : null),
    el('div', { cls: 'sm', style: 'margin-top:4px' }, f.text),
    f.note ? el('div', { cls: 'xs mut', style: 'margin-top:3px' }, '↳ ' + f.note) : null);
}

function editFinding(f, after) {
  const ins = S.ins;
  sheet('Находка ' + (f.code || f.item), (box, close) => {
    const done = () => { save(ins).then(() => { close(); after && after(); }); };

    box.append(el('div', { cls: 'card' },
      el('div', { cls: 'xs mut' }, f.item + ' — ' + ITEM_BY_ID[f.item].ru),
      el('label', { cls: 'f sp' }, el('span', {}, 'Формулировка находки (английский, для базы SAFA)'),
        el('textarea', { oninput: e => f.text = e.target.value }, f.text)),
      el('label', { cls: 'f' }, el('span', {}, 'Пояснение инспектора (русский, в акт)'),
        el('textarea', { placeholder: 'Что конкретно выявлено, где, чем подтверждается', oninput: e => f.note = e.target.value }, f.note))));

    const catBox = el('div', { cls: 'row wrap' });
    const drawCats = () => {
      catBox.innerHTML = '';
      ['1', '2', '3', 'G'].forEach(k => {
        const kk = k === 'G' ? 'G' : +k;
        catBox.append(el('button', {
          cls: 'btn ' + (String(f.cat) === k ? '' : 'sec'), style: 'flex:1;min-width:64px;font-size:14px',
          onclick: () => { f.cat = kk; drawCats(); save(ins); }
        }, k === 'G' ? 'G' : 'Кат. ' + k));
      });
    };
    drawCats();
    box.append(el('div', { cls: 'card' },
      el('h3', {}, 'Категория'), catBox,
      el('div', { cls: 'xs mut sp' }, CATS[f.cat] ? CATS[f.cat].ru : ''),
      f.refs ? el('div', { cls: 'xs mut sp' }, 'Ссылки на нормы: ' + f.refs) : null));

    // фотографии
    const thumbs = el('div', { cls: 'thumbs' });
    const drawPhotos = async () => {
      thumbs.innerHTML = '';
      for (const pid of (f.photos || [])) {
        const blob = await DB.photoGet(pid);
        if (!blob) continue;
        const wrap = el('span', { cls: 'del' },
          el('img', { src: URL.createObjectURL(blob) }),
          el('button', {
            onclick: async () => {
              f.photos = f.photos.filter(x => x !== pid);
              await DB.photoDel(pid); await save(ins); drawPhotos();
            }
          }, '×'),
          el('button', {
            cls: 'star', title: 'В библиотеку примеров',
            onclick: () => addToLibrary(f, blob),
          }, '★'));
        thumbs.append(wrap);
      }
    };
    drawPhotos();
    const file = el('input', {
      type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none',
      onchange: async e => {
        for (const src of e.target.files) {
          const blob = await shrink(src);
          const pid = uid();
          await DB.photoPut(pid, blob);
          (f.photos = f.photos || []).push(pid);
        }
        await save(ins); e.target.value = ''; drawPhotos();
      }
    });
    box.append(el('div', { cls: 'card' },
      el('div', { cls: 'row' }, el('h3', { cls: 'grow' }, 'Фотофиксация'),
        el('button', { cls: 'btn', style: 'min-height:38px;font-size:14px', onclick: () => file.click() }, '📷 Снять')),
      file, thumbs));

    box.append(el('button', { cls: 'btn wide', onclick: done }, 'Сохранить находку'));
    box.append(el('button', {
      cls: 'btn dan wide sp', onclick: async () => {
        if (!confirm('Удалить находку?')) return;
        for (const p of (f.photos || [])) await DB.photoDel(p);
        ins.findings = ins.findings.filter(x => x.id !== f.id);
        if (!ins.findings.some(x => x.item === f.item)) ins.items[f.item].s = 'ok';
        await save(ins); close(); after && after();
      }
    }, 'Удалить находку'));
  });
}

// Сжатие снимка: перрон — снимков много, память планшета ограничена
function shrink(file, max = 1400, q = 0.72) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = el('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => res(b || file), 'image/jpeg', q);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => res(file);
    img.src = URL.createObjectURL(file);
  });
}

/* ══════════════ библиотека примеров ══════════════ */

// Свой снимок с инспекции → в библиотеку. Блоб копируем: удаление находки
// не должно уносить с собой учебный пример.
function addToLibrary(f, blob) {
  const rec = {
    id: uid(), item: f.item, cat: f.cat, verdict: 'bad', kind: 'photo',
    title: (f.text || '').slice(0, 80), note: f.note || '',
    source: 'Собственная инспекция', createdAt: new Date().toISOString(), photoId: '',
  };
  sheet('В библиотеку примеров', (box, close) => {
    const vBox = el('div', { cls: 'row', style: 'gap:8px' });
    const drawV = () => {
      vBox.innerHTML = '';
      [['bad', 'Как плохо (несоответствие)'], ['good', 'Как хорошо (норма)']].forEach(([k, t]) =>
        vBox.append(el('button', {
          cls: 'btn ' + (rec.verdict === k ? '' : 'sec'), style: 'flex:1;font-size:13px',
          onclick: () => { rec.verdict = k; drawV(); }
        }, t)));
    };
    drawV();
    box.append(
      el('div', { cls: 'card' },
        el('img', { src: URL.createObjectURL(blob), style: 'width:100%;max-height:230px;object-fit:contain;border-radius:9px' })),
      el('div', { cls: 'card' },
        el('label', { cls: 'f' }, el('span', {}, 'Что показывает пример'),
          el('input', { value: rec.title, oninput: e => rec.title = e.target.value })),
        el('label', { cls: 'f' }, el('span', {}, 'Пояснение — на что смотреть'),
          el('textarea', { oninput: e => rec.note = e.target.value }, rec.note)),
        el('div', { cls: 'xs mut', style: 'margin-bottom:6px' }, 'Тип примера'), vBox,
        el('div', { cls: 'xs mut sp' }, `Пункт ${rec.item} — ${ITEM_BY_ID[rec.item].ru}, категория ${rec.cat}`)),
      el('button', {
        cls: 'btn wide', onclick: async () => {
          rec.photoId = uid();
          await DB.photoPut(rec.photoId, blob);
          await DB.libPut(rec);
          close(); toast('Добавлено в библиотеку примеров');
        }
      }, 'Добавить'));
  });
}

// Свои примеры и справочные изображения по одному пункту (или все)
async function examplesFor(itemId) {
  const own = (await DB.libAll()).filter(r => !itemId || r.item === itemId);
  const ref = REF_PHOTOS.filter(r => !itemId || r.item === itemId);
  return { own, ref, total: own.length + ref.length };
}

function galleryTile(o) {
  // o: {src, verdict, kind, title, note, source}
  const vc = o.kind === 'scheme' ? 'sch' : (o.verdict === 'good' ? 'good' : 'bad');
  const vt = o.kind === 'scheme' ? 'схема' : (o.verdict === 'good' ? 'как хорошо' : 'как плохо');
  return el('figure', { style: 'cursor:pointer', onclick: () => lightbox(o) },
    el('img', { src: o.src, loading: 'lazy', alt: o.title || '' }),
    el('figcaption', {},
      el('span', { cls: 'v ' + vc }, vt),
      el('div', { cls: 'b', style: 'font-size:12px' }, o.title || '—'),
      o.item ? el('div', { cls: 'xs mut' }, o.item) : null));
}

function lightbox(o) {
  const wrap = el('div', { cls: 'lightbox', onclick: () => wrap.remove() },
    el('img', { src: o.src, alt: o.title || '' }),
    el('div', { cls: 'cap' },
      el('div', { cls: 'b' }, o.title || ''),
      o.note ? el('div', { style: 'margin-top:5px' }, o.note) : null,
      o.item ? el('div', { cls: 'xs', style: 'margin-top:5px;opacity:.7' },
        o.item + ' — ' + (ITEM_BY_ID[o.item] ? ITEM_BY_ID[o.item].ru : '')) : null,
      o.source ? el('div', { cls: 'xs', style: 'margin-top:4px;opacity:.55' }, 'Источник: ' + o.source) : null),
    el('button', { cls: 'btn sec' }, 'Закрыть'));
  document.body.append(wrap);
}

// Плитки из своих записей библиотеки — блобы читаются асинхронно
async function ownTiles(records, onDeleted) {
  const out = [];
  for (const r of records) {
    const blob = await DB.photoGet(r.photoId);
    if (!blob) continue;
    const tile = galleryTile({
      src: URL.createObjectURL(blob), verdict: r.verdict, kind: r.kind,
      title: r.title, note: r.note, item: r.item, source: r.source,
    });
    if (onDeleted) {
      tile.append(el('button', {
        cls: 'btn sec', style: 'width:100%;min-height:34px;font-size:12px;border-radius:0',
        onclick: async e => {
          e.stopPropagation();
          if (!confirm('Убрать пример из библиотеки?')) return;
          await DB.photoDel(r.photoId); await DB.libDel(r.id); onDeleted();
        }
      }, 'Убрать'));
    }
    out.push(tile);
  }
  return out;
}

let galState = { item: '', v: '' };

async function scrGallery() {
  setHeader('Примеры: как хорошо, как плохо', null);
  const { own, ref } = await examplesFor(galState.item || '');
  const pass = o => !galState.v || (galState.v === 'scheme' ? o.kind === 'scheme'
    : (o.kind !== 'scheme' && o.verdict === galState.v));

  const refTiles = ref.filter(pass).map(r => galleryTile({
    src: r.file, verdict: r.verdict, kind: r.kind, title: r.title_ru,
    note: r.caption_ru, item: r.item, source: r.source,
  }));
  const mine = await ownTiles(own.filter(pass), scrGallery);

  const filters = el('div', { cls: 'row', style: 'gap:6px' },
    ...[['', 'Все'], ['bad', 'Как плохо'], ['good', 'Как хорошо'], ['scheme', 'Схемы']].map(([k, t]) =>
      el('button', {
        cls: 'btn ' + (galState.v === k ? '' : 'sec'), style: 'flex:1;min-height:40px;font-size:13px',
        onclick: () => { galState.v = k; scrGallery(); }
      }, t)));

  const sel = el('select', { onchange: e => { galState.item = e.target.value; scrGallery(); } },
    el('option', { value: '' }, 'Все пункты'),
    ...ITEMS.map(i => el('option', { value: i.id, selected: galState.item === i.id ? 'selected' : false },
      `${i.id} — ${i.ru}`)));

  render([
    el('div', { cls: 'card' },
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        'Свои примеры добавляются прямо с инспекции: в находке нажмите ★ на снимке. ' +
        'Библиотека растёт от выезда к выезду и работает офлайн.'),
      filters, el('div', { cls: 'sp' }, sel)),
    mine.length ? el('div', { cls: 'sec-h' }, `Свои примеры (${mine.length})`) : null,
    mine.length ? el('div', { cls: 'gal' }, ...mine) : null,
    refTiles.length ? el('div', { cls: 'sec-h' }, `Из руководств (${refTiles.length})`) : null,
    refTiles.length ? el('div', { cls: 'gal' }, ...refTiles) : null,
    (!mine.length && !refTiles.length) ? el('div', { cls: 'empty' },
      el('div', { cls: 'b' }, 'Примеров пока нет'),
      el('div', { cls: 'sm sp' }, 'Сфотографируйте несоответствие на инспекции и нажмите ★ на снимке — он попадёт сюда.')) : null,
  ]);
}

function scrFindings() {
  const ins = S.ins;
  setHeader(`Находки · ${ins.findings.length}`, scrInsp);
  const nodes = [];
  const mc = maxCat(ins);

  nodes.push(el('div', { cls: 'card' },
    el('div', { cls: 'row wrap' },
      ...[3, 2, 1, 'G'].map(k => {
        const n = ins.findings.filter(f => String(f.cat) === String(k)).length;
        return el('span', { cls: 'pill ' + CATS[k].cls, style: n ? '' : 'opacity:.35' },
          (k === 'G' ? 'G' : 'кат. ' + k) + ': ' + n);
      })),
    mc === 3 ? el('div', { cls: 'sm sp', style: 'margin-top:9px' },
      '⚠️ Есть находка категории 3 — требуются корректирующие действия до вылета либо ограничение эксплуатации (класс 3a/3b/3c).') : null));

  if (!ins.findings.length) {
    nodes.push(el('div', { cls: 'empty' }, 'Несоответствий не выявлено. Находки добавляются из чек-листа кнопкой «!».'));
  } else {
    SECTIONS.forEach(sec => {
      const list = ins.findings.filter(f => f.item[0] === sec.id);
      if (!list.length) return;
      nodes.push(el('div', { cls: 'sec-h' }, el('span', { cls: 'code' }, sec.id), sec.ru));
      list.forEach(f => nodes.push(el('div', { cls: 'card' }, findingRow(f, scrFindings))));
    });
  }
  nodes.push(el('button', { cls: 'btn sec wide sp', onclick: scrInsp }, 'Назад'));
  render(nodes);
}

/* ══════════════ экран: отчёт ══════════════ */

function scrReport() {
  const ins = S.ins;
  setHeader('Отчёт (PI)', scrInsp);
  const sug = suggestClass(ins);

  const clsBox = el('div');
  const drawCls = () => {
    clsBox.innerHTML = '';
    ACTIONS.forEach(([k, t, en]) => clsBox.append(el('button', {
      cls: 'opt' + (ins.actClass === k ? ' on' : ''),
      onclick: () => { ins.actClass = ins.actClass === k ? '' : k; save(ins); drawCls(); }
    }, el('div', { cls: 'row' }, el('span', { cls: 'pill pmut' }, k),
      el('span', { cls: 'sm grow' }, t),
      k === sug ? el('span', { cls: 'pill pok xs' }, 'рекомендуется') : null),
      el('div', { cls: 'xs mut', style: 'margin-top:3px;margin-left:34px' }, en))));
  };
  drawCls();

  render([
    el('div', { cls: 'card' },
      el('h3', {}, 'Класс принятых мер'),
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        sug ? `По максимальной категории находок (${maxCat(ins)}) рекомендуется класс ${sug}.`
            : 'Находок нет — класс мер обычно не назначается.'),
      clsBox),

    el('div', { cls: 'card' },
      el('label', { cls: 'f' }, el('span', {}, 'Дополнительная информация / комментарии'),
        el('textarea', { style: 'min-height:110px', oninput: e => { ins.comments = e.target.value; save(ins); } }, ins.comments))),

    sigCard('insp', 'Подпись инспектора АГА РТ', ins.gen.inspector),
    sigCard('cap', 'Подпись КВС / представителя эксплуатанта', ins.gen.captain),

    el('div', { cls: 'card' },
      el('h3', {}, 'Выдача и отправка'),
      el('button', { cls: 'btn wide', onclick: () => printPI(ins) }, '🖨 Печать / сохранить PDF'),
      el('button', { cls: 'btn sec wide sp', onclick: () => exportJSON(ins) }, '⬇ Выгрузить JSON'),
      el('button', { cls: 'btn sec wide sp', onclick: () => syncOne(ins) },
        '☁ Отправить в управление' + (ins.sync.state === 'sent' ? ' (уже отправлена)' : '')),
      CFG.d.gasUrl ? null : el('div', { cls: 'xs mut sp' },
        'Адрес сервера синхронизации не задан — укажите его в «Настройки → Синхронизация».')),
  ]);
}

function sigCard(key, title, who) {
  const ins = S.ins;
  const c = el('canvas', { cls: 'sig' });
  const card = el('div', { cls: 'card' },
    el('h3', {}, title),
    el('div', { cls: 'xs mut', style: 'margin-bottom:6px' }, who || '—'),
    c,
    el('div', { cls: 'row sp' },
      el('button', { cls: 'btn sec grow', style: 'min-height:40px;font-size:14px', onclick: () => { clear(); ins.sig[key] = ''; save(ins); } }, 'Очистить'),
      el('button', { cls: 'btn grow', style: 'min-height:40px;font-size:14px', onclick: () => { ins.sig[key] = c.toDataURL('image/png'); save(ins); toast('Подпись сохранена'); } }, 'Сохранить')));

  requestAnimationFrame(() => {
    const r = c.getBoundingClientRect();
    c.width = r.width * 2; c.height = r.height * 2;
    const g = c.getContext('2d');
    g.scale(2, 2); g.lineWidth = 2; g.lineCap = 'round'; g.strokeStyle = '#12212f';
    if (ins.sig[key]) { const i = new Image(); i.onload = () => g.drawImage(i, 0, 0, r.width, r.height); i.src = ins.sig[key]; }
    let drawing = false;
    const pos = e => { const b = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - b.left, t.clientY - b.top]; };
    const start = e => { e.preventDefault(); drawing = true; g.beginPath(); g.moveTo(...pos(e)); };
    const move = e => { if (!drawing) return; e.preventDefault(); g.lineTo(...pos(e)); g.stroke(); };
    const end = () => drawing = false;
    c.addEventListener('pointerdown', start); c.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  });
  function clear() { const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); }
  return card;
}

/* ══════════════ печатная форма PI ══════════════ */

function printPI(ins) {
  const g = ins.gen;
  const cell = (l, v) => `<td style="border:1px solid #999;padding:3px 5px;vertical-align:top">
      <div style="font-size:8pt;color:#555">${esc(l)}</div><div>${esc(v) || '&nbsp;'}</div></td>`;
  const kindRu = { pax: 'Пассажирский', cargo: 'Грузовой', mixed: 'Смешанный' }[g.kind];

  const chk = SECTIONS.map(sec => {
    const rows = ITEMS.filter(i => i.sec === sec.id).map(i => {
      const s = ins.items[i.id];
      return `<tr>
        <td style="border:1px solid #999;padding:2px 4px;width:34px">${i.id}</td>
        <td style="border:1px solid #999;padding:2px 4px">${esc(i.ru)}</td>
        <td style="border:1px solid #999;padding:2px 4px;text-align:center;width:26px;font-weight:bold">${ST[s.s].ic}</td>
        <td style="border:1px solid #999;padding:2px 4px;font-size:8pt">${esc(s.rmk)}</td></tr>`;
    }).join('');
    return `<tr><td colspan="4" style="border:1px solid #999;padding:3px 5px;background:#e8eef6;font-weight:bold">
      ${sec.id}. ${esc(sec.ru)} — ${esc(sec.en)}</td></tr>` + rows;
  }).join('');

  const fnd = ins.findings.length ? ins.findings.map((f, n) => `<tr>
      <td style="border:1px solid #999;padding:3px 5px;width:22px">${n + 1}</td>
      <td style="border:1px solid #999;padding:3px 5px;width:60px">${esc(f.item)}${f.code ? '<br>' + esc(f.code) : ''}</td>
      <td style="border:1px solid #999;padding:3px 5px;text-align:center;width:34px;font-weight:bold">${esc(f.cat)}</td>
      <td style="border:1px solid #999;padding:3px 5px">${esc(f.text)}${f.note ? '<br><i>' + esc(f.note) + '</i>' : ''}
        ${f.refs ? '<br><span style="font-size:8pt;color:#555">' + esc(f.refs) + '</span>' : ''}</td></tr>`).join('')
    : `<tr><td colspan="4" style="border:1px solid #999;padding:5px">Несоответствий не выявлено / No findings</td></tr>`;

  const act = ACTIONS.map(([k, t, en]) =>
    `<div>${ins.actClass === k ? '☒' : '☐'} <b>${k})</b> ${esc(t)}
      <span style="color:#555"> / ${esc(en)}</span></div>`).join('');

  const sig = (d, cap) => `<td style="border:1px solid #999;padding:5px;width:50%;vertical-align:top">
      <div style="font-size:8pt;color:#555">${esc(cap)}</div>
      ${d ? `<img src="${d}" style="height:60px">` : '<div style="height:60px"></div>'}
      <div style="border-top:1px solid #333;font-size:8pt;padding-top:2px">подпись / signature</div></td>`;

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>PI ${esc(g.poi || ins.id)} ${esc(g.acReg)}</title>
<style>
 @page{size:A4;margin:12mm}
 body{font:10pt/1.35 "Segoe UI",Arial,sans-serif;color:#000}
 table{border-collapse:collapse;width:100%;margin-bottom:8px}
 h1{font-size:13pt;margin:0 0 2px;text-align:center}
 h2{font-size:11pt;margin:10px 0 4px;border-bottom:1px solid #333}
 .hd{text-align:center;margin-bottom:8px;font-size:9pt}
</style></head><body>
<div class="hd"><b>${esc(CFG.d.authority)}</b><br>
CIVIL AVIATION AGENCY UNDER THE GOVERNMENT OF THE REPUBLIC OF TAJIKISTAN</div>
<h1>${esc(ins.type)} — АКТ ПЕРРОННОЙ ИНСПЕКЦИИ / PROOF OF INSPECTION</h1>
<div class="hd">${esc(TYPES[ins.type].en)}</div>
<table>
 <tr>${cell('POI No', g.poi)}${cell('Дата / Date', fmtDate(g.date) + ' ' + g.time)}${cell('Аэропорт / Airport', g.airport)}${cell('Зафрахтовано / Chartered by', g.chartered)}</tr>
 <tr>${cell('Эксплуатант / Operator', g.operator)}${cell('AOC No', g.aocNo)}${cell('Государство AOC / State of AOC', g.aocState)}${cell('Контакты владельца AOC', g.aocContact)}</tr>
 <tr>${cell('Прибыл из / Route from', g.routeFrom)}${cell('Рейс / Flight no', g.flightIn)}${cell('Государство рег. / State of Reg.', g.regState)}${cell('Вид перевозки', kindRu)}</tr>
 <tr>${cell('Убывает в / Route to', g.routeTo)}${cell('Рейс / Flight no', g.flightOut)}${cell('Свид-во 1-го пилота', g.crewLic1)}${cell('Свид-во 2-го пилота', g.crewLic2)}</tr>
 <tr>${cell('Тип ВС / Aircraft make/model', g.acType)}${cell('Рег. номер / Aircraft Reg.', g.acReg)}${cell('MSN', g.msn)}${cell('Инспектор / Inspector', g.inspector)}</tr>
</table>
<h2>Чек-лист / Checklist &nbsp;<span style="font-weight:normal;font-size:9pt">(✓ соответствует · N не применимо · ! несоответствие · – не проверялся)</span></h2>
<table>${chk}</table>
<h2>Находки / Findings</h2>
<table><tr>
 <th style="border:1px solid #999;padding:3px">№</th>
 <th style="border:1px solid #999;padding:3px">Пункт / PDF</th>
 <th style="border:1px solid #999;padding:3px">Кат.</th>
 <th style="border:1px solid #999;padding:3px">Формулировка / Finding</th></tr>${fnd}</table>
<h2>Принятые меры / Class of actions taken</h2>
${act}
${ins.comments ? '<h2>Дополнительная информация / Comments</h2><div>' + esc(ins.comments).replace(/\n/g, '<br>') + '</div>' : ''}
<h2>Подписи</h2>
<table><tr>
${sig(ins.sig.insp, 'Инспектор АГА РТ / CAA Inspector: ' + esc(g.inspector))}
${sig(ins.sig.cap, 'КВС / представитель эксплуатанта: ' + esc(g.captain))}</tr></table>
<div style="font-size:8pt;color:#555;margin-top:6px">
 Категории находок и формулировки — по EASA Ramp Inspection Manual, Appendix 1 (Inspection instructions and pre-described findings), Issue 6.
 Сформировано SAFA Inspector v${APP_VER} · ${new Date().toLocaleString('ru-RU')}</div>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return toast('Разрешите всплывающие окна для печати');
  w.document.write(html); w.document.close();
  setTimeout(() => w.print(), 400);
}

function exportJSON(ins) {
  const blob = new Blob([JSON.stringify(ins, null, 1)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `PI_${ins.type}_${ins.gen.acReg || ins.id}_${ins.gen.date}.json` });
  document.body.append(a); a.click(); a.remove();
}

/* ══════════════ синхронизация ══════════════ */

function payload(ins) {
  return {
    id: ins.id, type: ins.type, status: ins.status, ver: ins.ver,
    createdAt: ins.createdAt, updatedAt: ins.updatedAt,
    gen: ins.gen, actClass: ins.actClass, comments: ins.comments,
    items: Object.fromEntries(Object.entries(ins.items).filter(([, v]) => v.s !== 'ni' || v.rmk)),
    findings: ins.findings.map(f => ({
      item: f.item, code: f.code, cat: f.cat, text: f.text, note: f.note,
      photos: (f.photos || []).length,
    })),
    counts: {
      checked: progress(ins), total: ITEMS.length, findings: ins.findings.length,
      cat1: ins.findings.filter(f => f.cat === 1).length,
      cat2: ins.findings.filter(f => f.cat === 2).length,
      cat3: ins.findings.filter(f => f.cat === 3).length,
      maxCat: maxCat(ins),
    },
  };
}

async function syncOne(ins) {
  if (!CFG.d.gasUrl) return toast('Задайте адрес сервера в настройках');
  ins.sync.state = 'queued'; await DB.put(ins);
  toast('Отправка…');
  try {
    // no-cors: Apps Script не отдаёт CORS-заголовки на /exec, ответ читать не нужно
    await fetch(CFG.d.gasUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'inspection', data: payload(ins) }),
    });
    ins.sync = { state: 'sent', at: new Date().toISOString() };
    await DB.put(ins);
    toast('Отправлено в управление');
  } catch (e) {
    ins.sync.state = 'local'; await DB.put(ins);
    toast('Нет связи — отправим позже');
  }
  if (S.ins && S.ins.id === ins.id) scrReport();
}

async function syncAll() {
  if (!CFG.d.gasUrl) return toast('Задайте адрес сервера в настройках');
  const all = await DB.all();
  const pend = all.filter(i => i.status === 'completed' && i.sync.state !== 'sent');
  if (!pend.length) return toast('Всё уже отправлено');
  for (const i of pend) await syncOne(i);
  scrSet();
}

/* ══════════════ экран: справочник находок ══════════════ */

let refState = { q: '', item: '', cat: '', tab: 'pdf' };

// Справочник — хаб из двух вкладок: формулировки находок и наглядные примеры
function scrRef() {
  if (refState.tab === 'gal') return scrGallery().then(() => {
    const v = $('#view');
    v.prepend(refHubStrip());
  });
  return scrRefFindings();
}

function refHubStrip() {
  return el('div', { cls: 'row', style: 'gap:6px;margin-bottom:10px' },
    ...[['pdf', 'Формулировки'], ['gal', 'Примеры']].map(([k, t]) =>
      el('button', {
        cls: 'btn ' + (refState.tab === k ? '' : 'sec'), style: 'flex:1;min-height:42px',
        onclick: () => { refState.tab = k; scrRef(); }
      }, t)));
}

function scrRefFindings() {
  setHeader('Справочник находок', null);
  const out = el('div');

  const q = el('input', { placeholder: 'Поиск по формулировке, коду или норме…', value: refState.q,
    oninput: e => { refState.q = e.target.value; draw(); } });

  const selItem = el('select', { onchange: e => { refState.item = e.target.value; draw(); } },
    el('option', { value: '' }, 'Все пункты'),
    ...ITEMS.map(i => el('option', { value: i.id, selected: refState.item === i.id ? 'selected' : false },
      `${i.id} — ${i.ru} (${i.n})`)));

  const cats = el('div', { cls: 'row', style: 'gap:6px' },
    ...['', '1', '2', '3', 'G'].map(k => el('button', {
      cls: 'btn ' + (refState.cat === k ? '' : 'sec'), style: 'flex:1;min-height:40px;font-size:13px',
      onclick: () => { refState.cat = k; scrRef(); }
    }, k === '' ? 'Все' : (k === 'G' ? 'G' : 'Кат. ' + k))));

  function draw() {
    const t = refState.q.trim().toLowerCase();
    const list = PDF.filter(f =>
      (!refState.item || f.item === refState.item) &&
      (!refState.cat || String(f.cat) === refState.cat) &&
      (!t || f.text.toLowerCase().includes(t) || f.code.toLowerCase().includes(t)
          || (f.refs || '').toLowerCase().includes(t)));
    out.innerHTML = '';
    out.append(el('div', { cls: 'xs mut', style: 'margin:8px 0' }, `Найдено: ${list.length} из ${PDF.length}`));
    list.slice(0, 300).forEach(f => out.append(el('div', { cls: 'card' },
      el('div', { cls: 'row' },
        el('span', { cls: 'pill ' + CATS[f.cat].cls }, 'кат. ' + f.cat),
        el('span', { cls: 'xs mut' }, f.code),
        el('span', { cls: 'right xs mut' }, ITEM_BY_ID[f.item] ? ITEM_BY_ID[f.item].ru : f.item)),
      el('div', { cls: 'sm', style: 'margin-top:6px' }, f.text),
      f.refs ? el('div', { cls: 'xs mut', style: 'margin-top:4px' }, f.refs) : null)));
    if (list.length > 300) out.append(el('div', { cls: 'xs mut' }, 'Показаны первые 300 — уточните запрос.'));
  }
  draw();

  render([
    refHubStrip(),
    el('div', { cls: 'card' },
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        `База предописанных находок (PDF): ${PDF.length} формулировок по ${ITEMS.length} пунктам. ` +
        'Источник — EASA RIM Appendix 1, Issue 6.'),
      q, el('div', { cls: 'sp' }, selItem), el('div', { cls: 'sp' }, cats)),
    out,
  ]);
}

/* ══════════════ экран: тренажёр ══════════════ */

let TR = null;

function scrTrain() {
  setHeader('Тренажёр инспектора', null);
  if (!TR) {
    return render([
      el('div', { cls: 'card' },
        el('h3', {}, 'Категорирование находок'),
        el('div', { cls: 'sm mut' },
          'Тренировка на реальной базе из ' + PDF.length + ' предописанных находок SAFA. ' +
          'Правильный ответ — тот, что закреплён в Appendix 1, Issue 6.'),
        el('div', { cls: 'sp' },
          el('button', { cls: 'btn wide', onclick: () => startTrain('cat', 15) }, 'Определить категорию (15 вопросов)'),
          el('button', { cls: 'btn sec wide sp', onclick: () => startTrain('item', 15) }, 'Определить пункт чек-листа (15)'),
          el('button', { cls: 'btn sec wide sp', onclick: () => startTrain('mix', 25) }, 'Смешанный режим (25)'))),
      el('div', { cls: 'card' },
        el('h3', {}, 'Как категорируются находки'),
        ...[1, 2, 3, 'G'].map(k => el('div', { cls: 'sp' },
          el('span', { cls: 'pill ' + CATS[k].cls }, k === 'G' ? 'G' : 'Категория ' + k),
          el('div', { cls: 'sm', style: 'margin-top:4px' }, CATS[k].ru)))),
      el('div', { cls: 'card' },
        el('h3', {}, 'Классы принятых мер'),
        ...ACTIONS.map(([k, t]) => el('div', { cls: 'row sp' },
          el('span', { cls: 'pill pmut' }, k), el('span', { cls: 'sm grow' }, t)))),
    ]);
  }
  drawQuestion();
}

function startTrain(mode, n) {
  const pool = [...PDF].sort(() => Math.random() - 0.5).slice(0, n);
  TR = { mode, qs: pool, i: 0, right: 0, answered: false, wrong: [] };
  drawQuestion();
}

function drawQuestion() {
  if (TR.i >= TR.qs.length) return drawResult();
  const f = TR.qs[TR.i];
  const kind = TR.mode === 'mix' ? (TR.i % 2 ? 'item' : 'cat') : TR.mode;
  setHeader(`Вопрос ${TR.i + 1} из ${TR.qs.length}`, () => { TR = null; scrTrain(); });

  const opts = el('div');
  let correct, choices;
  if (kind === 'cat') {
    correct = String(f.cat);
    choices = ['1', '2', '3', 'G'].map(k => [k, (k === 'G' ? 'General — вне категорий' : 'Категория ' + k + ' — ' + CATS[k].ru.split('— ')[1])]);
  } else {
    correct = f.item;
    const others = ITEMS.filter(i => i.id !== f.item).sort(() => Math.random() - 0.5).slice(0, 3);
    choices = [...others.map(i => [i.id, i.id + ' — ' + i.ru]), [f.item, f.item + ' — ' + ITEM_BY_ID[f.item].ru]]
      .sort(() => Math.random() - 0.5);
  }

  const buttons = choices.map(([k, label]) => el('button', {
    cls: 'opt', onclick: () => {
      if (TR.answered) return;
      TR.answered = true;
      const ok = k === correct;
      if (ok) TR.right++; else TR.wrong.push({ f, given: k, kind });
      buttons.forEach(b => {
        if (b.dataset.k === correct) b.classList.add('good');
        else if (b.dataset.k === k) b.classList.add('bad');
      });
      next.hidden = false;
      expl.hidden = false;
    }, 'data-k': k
  }, label));
  buttons.forEach(b => opts.append(b));

  const expl = el('div', { cls: 'card', hidden: 'hidden' },
    el('div', { cls: 'row' }, el('span', { cls: 'pill ' + CATS[f.cat].cls }, 'кат. ' + f.cat),
      el('span', { cls: 'xs mut' }, f.code)),
    el('div', { cls: 'sm sp' }, ITEM_BY_ID[f.item].id + ' — ' + ITEM_BY_ID[f.item].ru),
    f.refs ? el('div', { cls: 'xs mut sp' }, 'Нормы: ' + f.refs) : null);

  const next = el('button', {
    cls: 'btn wide sp', hidden: 'hidden',
    onclick: () => { TR.i++; TR.answered = false; drawQuestion(); }
  }, TR.i + 1 >= TR.qs.length ? 'Показать результат' : 'Следующий вопрос');

  render([
    el('div', { cls: 'card' },
      el('div', { cls: 'bar' }, el('i', { style: `width:${TR.i / TR.qs.length * 100}%` })),
      el('div', { cls: 'xs mut sp' }, kind === 'cat'
        ? 'Какую категорию имеет эта находка?'
        : 'К какому пункту чек-листа относится эта находка?'),
      el('div', { cls: 'b sp', style: 'margin-top:9px;font-size:16px' }, f.text)),
    opts, expl, next,
  ]);
}

function drawResult() {
  const pct = Math.round(TR.right / TR.qs.length * 100);
  setHeader('Результат', () => { TR = null; scrTrain(); });
  render([
    el('div', { cls: 'card', style: 'text-align:center' },
      el('div', { style: 'font-size:44px;font-weight:700' }, pct + '%'),
      el('div', { cls: 'mut' }, `${TR.right} из ${TR.qs.length} верно`),
      el('div', { cls: 'sm sp', style: 'margin-top:10px' },
        pct >= 80 ? 'Отличный результат — категорирование уверенное.'
      : pct >= 60 ? 'Неплохо, но разберите ошибки ниже.'
                  : 'Стоит повторить Appendix 1 по разобранным пунктам.')),
    ...(TR.wrong.length ? [el('div', { cls: 'sec-h' }, 'Разбор ошибок')] : []),
    ...TR.wrong.map(w => el('div', { cls: 'card' },
      el('div', { cls: 'sm b' }, w.f.text),
      el('div', { cls: 'row sp', style: 'margin-top:7px' },
        el('span', { cls: 'pill cat3' }, 'вы: ' + w.given),
        el('span', { cls: 'pill pok' }, 'верно: ' + (w.kind === 'cat' ? w.f.cat : w.f.item))),
      el('div', { cls: 'xs mut sp' }, w.f.code + ' · ' + ITEM_BY_ID[w.f.item].ru))),
    el('button', { cls: 'btn wide sp', onclick: () => { TR = null; scrTrain(); } }, 'В меню тренажёра'),
  ]);
}

/* ══════════════ экран: сводка ══════════════ */

async function scrStats() {
  setHeader('Сводка', null);
  const all = await DB.all();
  if (!all.length) return render(el('div', { cls: 'empty' }, 'Данных пока нет.'));

  const byType = {}, byOp = {}, byItem = {};
  let f1 = 0, f2 = 0, f3 = 0, grounded = 0;
  all.forEach(i => {
    byType[i.type] = (byType[i.type] || 0) + 1;
    if (i.gen.operator) byOp[i.gen.operator] = (byOp[i.gen.operator] || 0) + 1;
    if (i.actClass === '3c') grounded++;
    i.findings.forEach(f => {
      byItem[f.item] = (byItem[f.item] || 0) + 1;
      if (f.cat === 1) f1++; if (f.cat === 2) f2++; if (f.cat === 3) f3++;
    });
  });
  const totF = f1 + f2 + f3;
  const ratio = (totF / all.length).toFixed(2);
  const top = Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 10);

  render([
    el('div', { cls: 'card' },
      el('h3', {}, 'Всего'),
      el('div', { cls: 'row wrap' },
        el('span', { cls: 'pill pmut' }, 'инспекций: ' + all.length),
        el('span', { cls: 'pill pmut' }, 'завершено: ' + all.filter(i => i.status === 'completed').length),
        el('span', { cls: 'pill cat1' }, 'кат. 1: ' + f1),
        el('span', { cls: 'pill cat2' }, 'кат. 2: ' + f2),
        el('span', { cls: 'pill cat3' }, 'кат. 3: ' + f3)),
      el('div', { cls: 'sm sp', style: 'margin-top:9px' },
        `Среднее число находок на инспекцию (SAFA ratio): ${ratio}`),
      grounded ? el('div', { cls: 'sm' }, `ВС запрещено к полёту (3c): ${grounded}`) : null),

    el('div', { cls: 'card' },
      el('h3', {}, 'По типам инспекций'),
      ...Object.entries(byType).map(([k, v]) => el('div', { cls: 'row sp' },
        el('span', { cls: 'pill pmut' }, k), el('span', { cls: 'sm grow' }, TYPES[k].ru), el('b', {}, v)))),

    top.length ? el('div', { cls: 'card' },
      el('h3', {}, 'Наиболее частые пункты с находками'),
      ...top.map(([id, n]) => el('div', { cls: 'row sp' },
        el('span', { cls: 'pill pmut' }, id),
        el('span', { cls: 'sm grow' }, ITEM_BY_ID[id] ? ITEM_BY_ID[id].ru : id),
        el('b', {}, n)))) : null,

    Object.keys(byOp).length ? el('div', { cls: 'card' },
      el('h3', {}, 'По эксплуатантам'),
      ...Object.entries(byOp).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        el('div', { cls: 'row sp' }, el('span', { cls: 'sm grow' }, k), el('b', {}, v)))) : null,
  ]);
}

/* ══════════════ экран: настройки ══════════════ */

async function scrSet() {
  setHeader('Настройки', null);
  const all = await DB.all();
  const pend = all.filter(i => i.status === 'completed' && i.sync.state !== 'sent').length;
  const f = (key, lab, ph) => el('label', { cls: 'f' }, el('span', {}, lab),
    el('input', { value: CFG.d[key], placeholder: ph || '', oninput: e => { CFG.d[key] = e.target.value; CFG.save(); } }));

  render([
    el('div', { cls: 'card' },
      el('h3', {}, 'Инспектор'),
      f('inspector', 'Ф.И.О. инспектора'),
      f('inspPost', 'Должность'),
      f('airport', 'Аэропорт по умолчанию', 'напр. UTDD')),

    el('div', { cls: 'card' },
      el('h3', {}, 'Полномочный орган'),
      el('label', { cls: 'f' }, el('span', {}, 'Наименование в шапке акта'),
        el('textarea', { oninput: e => { CFG.d.authority = e.target.value; CFG.save(); } }, CFG.d.authority))),

    el('div', { cls: 'card' },
      el('h3', {}, 'Синхронизация'),
      f('gasUrl', 'Адрес веб-приложения Google Apps Script', 'https://script.google.com/macros/s/…/exec'),
      el('div', { cls: 'xs mut' }, `Завершённых и неотправленных инспекций: ${pend}`),
      el('button', { cls: 'btn wide sp', onclick: syncAll }, '☁ Отправить все завершённые'),
      el('div', { cls: 'xs mut sp' },
        'Развёртывание бэкенда — файл gas/Code.gs в папке проекта (README, раздел «Синхронизация»).')),

    el('div', { cls: 'card' },
      el('h3', {}, 'Офлайн-готовность'),
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        `Справочных изображений: ${REF_PHOTOS.length}. На перроне связи нет — они должны лежать в устройстве.`),
      el('div', { id: 'offlineState', cls: 'sm mut' }, 'Проверка…'),
      el('button', { cls: 'btn wide sp', onclick: cachePhotosNow }, '⬇ Загрузить примеры в устройство')),

    el('div', { cls: 'card' },
      el('h3', {}, 'Данные'),
      el('button', { cls: 'btn sec wide', onclick: exportAll }, '⬇ Выгрузить все инспекции (JSON)'),
      el('button', { cls: 'btn sec wide sp', onclick: () => location.reload(true) }, '↻ Обновить приложение')),

    el('div', { cls: 'card xs mut' },
      el('div', {}, 'SAFA Inspector v' + APP_VER),
      el('div', { cls: 'sp' }, `База предописанных находок: ${PDF.length} формулировок, ${ITEMS.length} пунктов.`),
      el('div', {}, 'Источник: EASA Ramp Inspection Manual, Appendix 1 — Inspection instructions and pre-described findings, Issue 6 (INST.RI.01/006, 28.10.2022).'),
      el('div', { cls: 'sp' }, 'Категорирование и классы мер — по RIM и бланку PI АГА РТ.')),
  ]);
  offlineStatus();
}

// Сколько справочных изображений уже лежит в кэше — на перроне связи нет
async function offlineStatus() {
  const box = $('#offlineState');
  if (!box) return;
  if (!('caches' in window) || !REF_PHOTOS.length) {
    box.textContent = REF_PHOTOS.length ? 'Кэш недоступен в этом браузере.' : 'Изображений нет.';
    return;
  }
  const keys = await caches.keys();
  const c = keys.length ? await caches.open(keys[0]) : null;
  if (!c) { box.textContent = 'Кэш пуст — нажмите «Загрузить примеры».'; return; }
  let have = 0;
  for (const p of REF_PHOTOS) if (await c.match('./' + p.file)) have++;
  box.innerHTML = '';
  box.append(
    el('div', { cls: 'bar' }, el('i', { style: `width:${have / REF_PHOTOS.length * 100}%` })),
    el('div', { cls: 'xs sp' }, have === REF_PHOTOS.length
      ? `✓ Все ${have} изображений в устройстве — офлайн готов.`
      : `В устройстве ${have} из ${REF_PHOTOS.length}. Загрузите остальные по Wi-Fi.`));
}

async function cachePhotosNow() {
  if (!REF_PHOTOS.length) return toast('Изображений нет');
  const keys = await caches.keys();
  const c = await caches.open(keys[0] || 'safa-inspector-manual');
  toast('Загрузка примеров…');
  const r = await Promise.allSettled(REF_PHOTOS.map(p => c.add('./' + p.file)));
  const bad = r.filter(x => x.status === 'rejected').length;
  toast(bad ? `Загружено с ошибками: не удалось ${bad}` : 'Примеры загружены в устройство');
  offlineStatus();
}

async function exportAll() {
  const all = await DB.all();
  const blob = new Blob([JSON.stringify(all.map(payload), null, 1)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `safa_inspections_${isoDate(new Date())}.json` });
  document.body.append(a); a.click(); a.remove();
}

/* ══════════════ старт ══════════════ */

(function boot() {
  document.querySelector('nav.tabs button').classList.add('on');
  scrList();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // догоняющая отправка, когда связь появилась
  window.addEventListener('online', async () => {
    if (!CFG.d.autoSync || !CFG.d.gasUrl) return;
    const all = await DB.all();
    for (const i of all.filter(x => x.status === 'completed' && x.sync.state === 'queued')) await syncOne(i);
  });
})();
