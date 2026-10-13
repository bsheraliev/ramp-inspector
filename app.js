/* SAFA Inspector — перронная инспекция ВС (АГА РТ)
   Офлайн-first PWA. Данные: IndexedDB. Синхронизация: Google Apps Script.
   База находок: EASA RIM Appendix 1, Issue 6 (INST.RI.01/006). */
'use strict';

/* ══════════════ локализация ru/en ══════════════ */
const I18N = window.SAFA_I18N || {};
// перевод UI-строки: при en берём из словаря, иначе — исходная русская
function t(s) { return CFG.d.lang === 'en' && I18N[s] ? I18N[s] : s; }
// перевод поля структуры данных {ru,en}: при en берём en, если он есть
const L = o => (o && CFG.d.lang === 'en' && o.en) ? o.en : (o ? o.ru : '');

const APP_VER = '1.7.1';

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
  1: { ru: 'Категория 1 — незначительное влияние на безопасность полётов', en: 'Category 1 — minor influence on flight safety',       cls: 'cat1' },
  2: { ru: 'Категория 2 — существенное влияние на безопасность полётов',   en: 'Category 2 — significant influence on flight safety', cls: 'cat2' },
  3: { ru: 'Категория 3 — серьёзное влияние на безопасность полётов',      en: 'Category 3 — major influence on flight safety',       cls: 'cat3' },
  G: { ru: 'General — отклонение по форме документа, вне категорий',       en: 'General — documentary deviation, outside categories', cls: 'catG' },
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

const ST = {                        // статус пункта чек-листа (ru — ключ словаря, перевод через t() при показе)
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
    const trn = d.transaction(store, mode), s = trn.objectStore(store);
    let out; const q = fn(s);
    if (q) q.onsuccess = e => { out = e.target.result; };
    trn.oncomplete = () => res(out);
    trn.onerror = () => rej(trn.error);
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
    kvDel: k => tx('kv', 'readwrite', s => s.delete(k)),
    libAll: () => tx('lib', 'readonly',  s => s.getAll()),
    libPut: o => tx('lib', 'readwrite', s => s.put(o)),
    libDel: id => tx('lib', 'readwrite', s => s.delete(id)),
  };
})();

// Справочные изображения из руководств (data/photos.js). Свои примеры — в хранилище lib.
const REF_PHOTOS = (window.SAFA_REF_PHOTOS || []).filter(p => p && p.file);
// Подсказки «что проверять» и отметка приоритетных пунктов (data/hints.js)
const HINTS = window.SAFA_HINTS || {};
const isHP = id => !!(HINTS[id] && HINTS[id].hp);

const CFG = {
  d: { inspector: '', inspPost: '', authority: 'Агентство гражданской авиации при Правительстве Республики Таджикистан',
       airport: '', gasUrl: '', autoSync: true, lang: 'ru' },
  load() { try { Object.assign(this.d, JSON.parse(localStorage.safaCfg || '{}')); } catch (e) {} return this.d; },
  save() { localStorage.safaCfg = JSON.stringify(this.d); },
};
CFG.load();

/* ══════════════ утилиты ══════════════ */

const $ = s => document.querySelector(s);
const el = (tag, a = {}, ...kids) => {
  const n = document.createElement(tag);
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
  let box = $('.toast');
  if (!box) { box = el('div', { cls: 'toast' }); document.body.append(box); }
  box.textContent = msg;
  toastT = setTimeout(() => box.remove(), 2600);
}

function sheet(title, build) {
  const box = el('div');
  // ghost-click: на тач-экранах событие, открывшее лист, успевает «долететь»
  // до подложки и сразу его закрыть — гасим первые 350 мс
  const born = Date.now();
  const wrap = el('div', { cls: 'sheet', onclick: e => { if (e.target === wrap && Date.now() - born > 350) close(); } },
    el('div', {}, el('h3', {}, title), box,
      el('button', { cls: 'btn sec wide sp', onclick: () => close() }, t('Закрыть'))));
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
  return [g.acReg || t('б/н рег.'), g.operator, g.flightIn || g.flightOut].filter(Boolean).join(' · ');
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

const ROUTER = { list: scrList, ref: scrRef, train: scrTrain, stats: scrStats, set: scrSet };
// подписи вкладок: иконка + переводимая метка
const NAV = { list: ['📋', 'Инспекции'], ref: ['📖', 'Справочник'], train: ['🎓', 'Тренажёр'],
              stats: ['📊', 'Сводка'], set: ['⚙️', 'Настройки'] };
function applyNav() {
  document.querySelectorAll('nav.tabs button').forEach(b => {
    const nv = NAV[b.dataset.t]; if (!nv) return;
    b.innerHTML = '';
    b.append(el('b', {}, nv[0]), document.createTextNode(t(nv[1])));
  });
}
// смена языка: сохранить, обновить навигацию и перерисовать активную вкладку
function setLang(l) {
  CFG.d.lang = l; CFG.save();
  document.documentElement.lang = l;
  applyNav();
  (ROUTER[S.tab] || scrList)();
}

document.addEventListener('click', e => {
  const b = e.target.closest('nav.tabs button');
  if (!b) return;
  S.tab = b.dataset.t;
  [...document.querySelectorAll('nav.tabs button')].forEach(x => x.classList.toggle('on', x === b));
  (ROUTER[S.tab] || scrList)();
});

/* ══════════════ экран: список инспекций ══════════════ */

async function scrList() {
  setHeader(t('Инспекции на перроне'), null, ['+', pickType]);
  const all = (await DB.all()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!all.length) {
    return render(el('div', { cls: 'empty' },
      el('div', { cls: 'b', style: 'font-size:19px;margin-bottom:6px' }, t('Инспекций пока нет')),
      el('div', { cls: 'sm' }, t('Нажмите «+» вверху, чтобы начать проверку воздушного судна.')),
      el('button', { cls: 'btn sp', onclick: pickType }, t('Новая инспекция'))));
  }
  const nodes = all.map(ins => {
    const done = progress(ins), mc = maxCat(ins);
    const badge = ins.status === 'completed'
      ? el('span', { cls: 'pill pok' }, t('завершена'))
      : el('span', { cls: 'pill pmut' }, t('в работе'));
    const syncPill = { local: ['pmut', t('не отправлена')], queued: ['cat1', t('в очереди')], sent: ['pok', t('отправлена')] }[ins.sync.state];
    return el('div', {
      cls: 'card', onclick: () => openInspection(ins.id),
      style: 'cursor:pointer',
    },
      el('div', { cls: 'row wrap' },
        el('span', { cls: 'pill pmut' }, ins.type),
        ins.demo ? el('span', { cls: 'pill demo' }, t('ДЕМО')) : null,
        badge,
        el('span', { cls: 'pill ' + syncPill[0] }, syncPill[1]),
        el('span', { cls: 'right xs mut' }, fmtDate(ins.gen.date) + ' ' + ins.gen.time)),
      el('div', { cls: 'b sp', style: 'margin-top:8px' }, inspTitle(ins)),
      el('div', { cls: 'sm mut' }, [ins.gen.acType, ins.gen.airport].filter(Boolean).join(' · ') || '—'),
      ins.demo ? el('div', { cls: 'xs mut', style: 'margin-top:4px' },
        t('Учебный пример. Эксплуатант вымышлен. Можно удалить — не вернётся.')) : null,
      el('div', { cls: 'row sm', style: 'margin-top:8px' },
        el('span', { cls: 'grow' },
          el('div', { cls: 'bar' }, el('i', { style: `width:${done / ITEMS.length * 100}%` }))),
        el('span', { cls: 'xs mut' }, `${done}/${ITEMS.length}`),
        ins.findings.length
          ? el('span', { cls: 'pill ' + (mc ? CATS[mc].cls : 'catG') },
              t('находок: ') + ins.findings.length + (mc ? t(' · макс. кат. ') + mc : ''))
          : el('span', { cls: 'pill pok' }, t('без находок'))));
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
      }, el('div', { cls: 'b' }, L(v)), el('div', { cls: 'xs mut' }, CFG.d.lang === 'en' ? v.ru : v.en)));
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
  setHeader(inspTitle(ins) || t('Новая инспекция'), scrList, ['⋯', () => inspMenu(ins)]);
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
      el('div', { cls: 'sm sp', style: 'margin-top:8px' }, L(TYPES[ins.type]))),

    nav('📝', t('Общие сведения'), t('Рейс, эксплуатант, ВС, экипаж'), () => scrGeneral(),
      ins.gen.acReg && ins.gen.operator ? el('span', { cls: 'pill pok' }, t('заполнено'))
                                        : el('span', { cls: 'pill cat1' }, t('не заполнено'))),

    nav('✅', t('Чек-лист (53 пункта)'), t('Проверено') + ' ' + done + ' ' + t('из') + ' ' + ITEMS.length, () => scrChecklist(),
      el('span', { cls: 'pill ' + (done === ITEMS.length ? 'pok' : 'pmut') }, `${done}/${ITEMS.length}`)),

    nav('⚠️', t('Находки'), ins.findings.length ? t('Максимальная категория: ') + (mc || 'G') : t('Несоответствий не выявлено'),
      () => scrFindings(),
      el('span', { cls: 'pill ' + (ins.findings.length ? (mc ? CATS[mc].cls : 'catG') : 'pok') },
        String(ins.findings.length))),

    nav('📄', t('Отчёт (Proof of Inspection)'), t('Меры, подписи, печать и отправка'), () => scrReport()),
  ]);
}

function inspMenu(ins) {
  sheet('Инспекция', (box, close) => {
    const act = (lbl, fn, cls) => box.append(el('button', { cls: 'btn ' + (cls || 'sec') + ' wide', style: 'margin-bottom:8px', onclick: fn }, lbl));
    act(ins.status === 'completed' ? t('Вернуть в работу') : t('Отметить завершённой'), async () => {
      ins.status = ins.status === 'completed' ? 'draft' : 'completed';
      await save(ins); close(); scrInsp();
    });
    act('Выгрузить в файл (JSON)', () => { exportJSON(ins); close(); });
    act(ins.demo ? t('Удалить учебный пример') : t('Удалить инспекцию'), async () => {
      if (!confirm(ins.demo ? t('Удалить учебный пример? Он больше не появится.')
                            : t('Удалить инспекцию безвозвратно?'))) return;
      for (const f of ins.findings) for (const p of (f.photos || [])) await DB.photoDel(p);
      await DB.del(ins.id); close(); scrList();
    }, 'dan');
  });
}

/* ══════════════ экран: общие сведения ══════════════ */

function scrGeneral() {
  const ins = S.ins, g = ins.gen;
  setHeader(t('Общие сведения'), scrInsp);
  const f = (key, lab, opts = {}) => el('label', { cls: 'f' },
    el('span', {}, lab),
    el(opts.tag || 'input', {
      type: opts.type || 'text', value: opts.tag ? false : g[key],
      placeholder: opts.ph || '', inputmode: opts.im || false,
      oninput: e => { g[key] = e.target.value; save(ins); },
    }, opts.tag === 'textarea' ? g[key] : null));

  const kind = el('div', { cls: 'row', style: 'gap:8px' },
    ...[['pax', t('Пассажирский')], ['cargo', t('Грузовой')], ['mixed', t('Смешанный')]].map(([k, lbl]) =>
      el('button', {
        cls: 'btn ' + (g.kind === k ? '' : 'sec'), style: 'flex:1;font-size:14px;padding:0 6px',
        onclick: e => { g.kind = k; save(ins); scrGeneral(); }
      }, lbl)));

  render([
    el('div', { cls: 'card' },
      el('h3', {}, t('Инспекция')),
      el('div', { cls: 'grid2' },
        f('poi', t('POI No (номер акта)')),
        f('airport', t('Аэропорт (ICAO/IATA)')),
        f('date', 'Дата', { type: 'date' }),
        f('time', t('Время (UTC/местное)'), { type: 'time' })),
      f('inspector', 'Инспектор АГА РТ')),

    el('div', { cls: 'card' },
      el('h3', {}, 'Эксплуатант'),
      f('operator', t('Наименование эксплуатанта')),
      el('div', { cls: 'grid2' },
        f('aocNo', t('Номер AOC')),
        f('aocState', t('Государство выдачи AOC'))),
      f('aocContact', t('Контактные данные владельца AOC'), { tag: 'textarea' }),
      f('chartered', t('Зафрахтовано (эксплуатант/государство)'))),

    el('div', { cls: 'card' },
      el('h3', {}, t('Рейс')),
      el('div', { cls: 'grid2' },
        f('routeFrom', t('Прибыл из')), f('flightIn', t('Номер рейса (прилёт)')),
        f('routeTo', t('Убывает в')), f('flightOut', t('Номер рейса (вылет)'))),
      el('label', { cls: 'f' }, el('span', {}, t('Вид перевозки')), kind)),

    el('div', { cls: 'card' },
      el('h3', {}, t('Воздушное судно')),
      f('acType', t('Тип / модель ВС')),
      el('div', { cls: 'grid2' },
        f('acReg', t('Регистрационный номер')),
        f('msn', t('Заводской номер (MSN)')),
        f('regState', t('Государство регистрации')), null)),

    el('div', { cls: 'card' },
      el('h3', {}, t('Экипаж')),
      el('div', { cls: 'grid2' },
        f('crewLic1', t('Государство выдачи свидетельства, 1-й пилот')),
        f('crewLic2', t('Государство выдачи свидетельства, 2-й пилот'))),
      f('captain', t('КВС / представитель эксплуатанта'))),

    el('button', { cls: 'btn wide sp', onclick: scrInsp }, t('Готово')),
  ]);
}

/* ══════════════ экран: чек-лист ══════════════ */

function scrChecklist() {
  const ins = S.ins;
  setHeader(t('Чек-лист') + ' · ' + progress(ins) + '/' + ITEMS.length, scrInsp);
  const nodes = [];

  nodes.push(el('div', { cls: 'card xs mut' },
    t('Отметьте по каждому пункту: '),
    el('b', {}, '✓'), ' ' + t('соответствует · '),
    el('b', {}, 'N'), ' ' + t('не применимо · '),
    el('b', {}, '!'), ' ' + t('несоответствие (откроется выбор находки). '),
    t('Нажатие на название пункта открывает примечание и находки.'),
    ' ', el('b', { cls: 'hpm' }, '★'), ' ' + t('— приоритетный пункт.')));

  SECTIONS.forEach(sec => {
    const list = ITEMS.filter(i => i.sec === sec.id);
    const okN = list.filter(i => ins.items[i.id].s !== 'ni').length;
    nodes.push(el('div', { cls: 'sec-h' },
      el('span', { cls: 'code' }, sec.id), el('span', { cls: 'grow' }, L(sec)),
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
          el('div', { cls: 'id' }, it.id, isHP(it.id) ? el('span', { cls: 'hpm' }, ' ★') : null,
            (nf ? ' · ' + t('находок: ') + nf : '') + (st.rmk ? t(' · есть примечание') : '')),
          el('div', { cls: 'nm' }, L(it))),
        sw));
    });
  });

  nodes.push(el('button', { cls: 'btn wide sp', onclick: scrInsp }, t('Готово')));
  render(nodes);
}

// Подсказка инспектору: что смотреть по пункту и на чём обычно ошибаются
function hintCard(id) {
  const h = HINTS[id];
  if (!h) return null;
  const en = CFG.d.lang === 'en';
  const list = (en ? h.en : h.ru) || [], note = en ? h.nen : h.nru;
  return el('div', { cls: 'card' },
    el('h3', {}, t('Что проверять')),
    el('ul', { cls: 'hint' }, ...list.map(x => el('li', {}, x))),
    note ? el('div', { cls: 'hint-n' }, el('b', {}, t('Важно: ')), note) : null,
    el('div', { cls: 'xs mut', style: 'margin-top:8px' },
      t('По материалам курса GCAA «SAFA Awareness». Категорию находки определяйте по базе предописанных находок.')));
}

function scrItem(id) {
  const ins = S.ins, it = ITEM_BY_ID[id], st = ins.items[id];
  setHeader(id + ' — ' + L(it), scrChecklist);
  const mine = ins.findings.filter(f => f.item === id);

  render([
    el('div', { cls: 'card' },
      el('div', { cls: 'row' }, el('span', { cls: 'pill pmut' }, id),
        isHP(id) ? el('span', { cls: 'pill hp' }, '★ ' + t('приоритет')) : null,
        el('span', { cls: 'right xs mut' }, t('предописанных находок: ') + it.n)),
      el('h3', { style: 'margin-top:8px' }, L(it)),
      el('div', { cls: 'sm mut' }, CFG.d.lang === 'en' ? it.ru : it.en)),

    hintCard(id),

    el('div', { cls: 'card' },
      el('h3', {}, t('Статус пункта')),
      el('div', { cls: 'row wrap' }, ...Object.entries(ST).map(([k, v]) =>
        el('button', {
          cls: 'btn ' + (st.s === k ? '' : 'sec'), style: 'flex:1;font-size:13px;padding:0 8px',
          onclick: async () => { st.s = k; await save(ins); scrItem(id); }
        }, L(v))))),

    el('div', { cls: 'card' },
      el('label', { cls: 'f' }, el('span', {}, t('Примечание (RMK)')),
        el('textarea', {
          placeholder: t('Свободный комментарий инспектора по пункту'),
          oninput: e => { st.rmk = e.target.value; save(ins); }
        }, st.rmk))),

    el('div', { cls: 'card' },
      el('div', { cls: 'row' }, el('h3', { cls: 'grow' }, t('Находки по пункту')),
        el('button', { cls: 'btn', style: 'min-height:38px;font-size:14px', onclick: () => addFinding(id, () => scrItem(id)) }, '+ Добавить')),
      mine.length ? el('div', { cls: 'sp' }, ...mine.map(f => findingRow(f, () => scrItem(id))))
                  : el('div', { cls: 'sm mut sp' }, t('Находок по этому пункту нет.'))),

    el('div', { cls: 'card', id: 'exBox' }, el('h3', {}, t('Примеры по пункту')),
      el('div', { cls: 'sm mut' }, t('Загрузка…'))),

    el('button', { cls: 'btn sec wide sp', onclick: scrChecklist }, t('К чек-листу')),
  ]);

  // примеры подгружаются отдельно: чтение блобов не должно тормозить экран
  examplesFor(id).then(async ({ own, ref, priv, total }) => {
    const box = $('#exBox');
    if (!box) return;
    box.innerHTML = '';
    box.append(el('h3', {}, t('Примеры по пункту') + ' (' + total + ')'));
    if (!total) {
      box.append(el('div', { cls: 'sm mut' },
        t('Для этого пункта примеров ещё нет. Сфотографируйте несоответствие в находке и нажмите ★ на снимке.')));
      return;
    }
    const tiles = [
      ...await privTiles(priv),
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
  sheet(`${t('Находка')} · ${itemId} ${L(ITEM_BY_ID[itemId])}`, (box, close) => {
    const results = el('div');
    const q = el('input', {
      placeholder: t('Поиск по формулировке или коду…'),
      oninput: e => draw(e.target.value.trim().toLowerCase()),
    });
    box.append(el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
      t('Предописанные находки (PDF) по пункту ') + itemId + ': ' + pool.length + '. ' +
      t('Формулировка на английском — в базу SAFA она вносится дословно.')));
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
      if (!list.length) results.append(el('div', { cls: 'sm mut', style: 'padding:8px 0' }, t('Ничего не найдено.')));
      list.forEach(f => results.append(el('button', { cls: 'opt', onclick: () => pick(f) },
        el('div', { cls: 'row' },
          el('span', { cls: 'pill ' + CATS[f.cat].cls }, t('кат. ') + f.cat),
          el('span', { cls: 'xs mut right' }, f.code)),
        el('div', { cls: 'sm', style: 'margin-top:5px' }, f.text))));
      results.append(el('button', {
        cls: 'opt', style: 'border-style:dashed;margin-top:10px', onclick: () => {
          const nf = { id: uid(), item: itemId, code: '', text: term || '', cat: 1, refs: '', note: '', photos: [], custom: true };
          ins.findings.push(nf); ins.items[itemId].s = 'f';
          save(ins).then(() => { close(); editFinding(nf, after); });
        }
      }, el('div', { cls: 'b' }, t('＋ Своя формулировка')),
         el('div', { cls: 'xs mut' }, t('Если ни одна предописанная находка не подходит'))));
    }
    draw('');
  });
}

function findingRow(f, after) {
  return el('div', { cls: 'fnd k' + f.cat, onclick: () => editFinding(f, after), style: 'cursor:pointer' },
    el('div', { cls: 'row' },
      el('span', { cls: 'pill ' + CATS[f.cat].cls }, t('кат. ') + f.cat),
      el('span', { cls: 'xs mut' }, f.code || t('своя формулировка')),
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
      el('div', { cls: 'xs mut' }, f.item + ' — ' + L(ITEM_BY_ID[f.item])),
      el('label', { cls: 'f sp' }, el('span', {}, t('Формулировка находки (английский, для базы SAFA)')),
        el('textarea', { oninput: e => f.text = e.target.value }, f.text)),
      el('label', { cls: 'f' }, el('span', {}, t('Пояснение инспектора (русский, в акт)')),
        el('textarea', { placeholder: t('Что конкретно выявлено, где, чем подтверждается'), oninput: e => f.note = e.target.value }, f.note))));

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
      el('h3', {}, t('Категория')), catBox,
      el('div', { cls: 'xs mut sp' }, CATS[f.cat] ? L(CATS[f.cat]) : ''),
      f.refs ? el('div', { cls: 'xs mut sp' }, t('Ссылки на нормы: ') + f.refs) : null));

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
            cls: 'star', title: t('В библиотеку примеров'),
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
        el('button', { cls: 'btn', style: 'min-height:38px;font-size:14px', onclick: () => file.click() }, t('📷 Снять'))),
      file, thumbs));

    box.append(el('button', { cls: 'btn wide', onclick: done }, t('Сохранить находку')));
    box.append(el('button', {
      cls: 'btn dan wide sp', onclick: async () => {
        if (!confirm(t('Удалить находку?'))) return;
        for (const p of (f.photos || [])) await DB.photoDel(p);
        ins.findings = ins.findings.filter(x => x.id !== f.id);
        if (!ins.findings.some(x => x.item === f.item)) ins.items[f.item].s = 'ok';
        await save(ins); close(); after && after();
      }
    }, t('Удалить находку')));
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
    source: t('Собственная инспекция'), createdAt: new Date().toISOString(), photoId: '',
  };
  sheet('В библиотеку примеров', (box, close) => {
    const vBox = el('div', { cls: 'row', style: 'gap:8px' });
    const drawV = () => {
      vBox.innerHTML = '';
      [['bad', t('Как плохо (несоответствие)')], ['good', t('Как хорошо (норма)')]].forEach(([k, lbl]) =>
        vBox.append(el('button', {
          cls: 'btn ' + (rec.verdict === k ? '' : 'sec'), style: 'flex:1;font-size:13px',
          onclick: () => { rec.verdict = k; drawV(); }
        }, lbl)));
    };
    drawV();
    box.append(
      el('div', { cls: 'card' },
        el('img', { src: URL.createObjectURL(blob), style: 'width:100%;max-height:230px;object-fit:contain;border-radius:9px' })),
      el('div', { cls: 'card' },
        el('label', { cls: 'f' }, el('span', {}, t('Что показывает пример')),
          el('input', { value: rec.title, oninput: e => rec.title = e.target.value })),
        el('label', { cls: 'f' }, el('span', {}, t('Пояснение — на что смотреть')),
          el('textarea', { oninput: e => rec.note = e.target.value }, rec.note)),
        el('div', { cls: 'xs mut', style: 'margin-bottom:6px' }, t('Тип примера')), vBox,
        el('div', { cls: 'xs mut sp' }, `${t('Пункт')} ${rec.item} — ${L(ITEM_BY_ID[rec.item])}, ${t('категория')} ${rec.cat}`)),
      el('button', {
        cls: 'btn wide', onclick: async () => {
          rec.photoId = uid();
          await DB.photoPut(rec.photoId, blob);
          await DB.libPut(rec);
          close(); toast('Добавлено в библиотеку примеров');
        }
      }, t('Добавить')));
  });
}

// Свои примеры и справочные изображения по одному пункту (или все)
async function examplesFor(itemId) {
  const own = (await DB.libAll()).filter(r => !itemId || r.item === itemId);
  const ref = REF_PHOTOS.filter(r => !itemId || r.item === itemId);
  const priv = PRIV.filter(r => !itemId || r.item === itemId);
  return { own, ref, priv, total: own.length + ref.length + priv.length };
}

function galleryTile(o) {
  // o: {src, verdict, kind, title, note, source}
  const vc = o.kind === 'scheme' ? 'sch' : (o.verdict === 'good' ? 'good' : 'bad');
  const vt = o.kind === 'scheme' ? t('схема') : (o.verdict === 'good' ? t('как хорошо') : t('как плохо'));
  return el('figure', { style: 'cursor:pointer', onclick: () => lightbox(o) },
    el('img', { src: o.src, loading: 'lazy', alt: o.title || '' }),
    el('figcaption', {},
      el('span', { cls: 'v ' + vc }, vt),
      o.cat != null ? el('span', { cls: 'v pc' + o.cat }, o.cat === 'G' ? 'G' : t('кат. ') + o.cat) : null,
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
        o.item + ' — ' + (ITEM_BY_ID[o.item] ? L(ITEM_BY_ID[o.item]) : '')) : null,
      o.source ? el('div', { cls: 'xs', style: 'margin-top:4px;opacity:.55' }, 'Источник: ' + o.source) : null),
    el('button', { cls: 'btn sec' }, t('Закрыть')));
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
          if (!confirm(t('Убрать пример из библиотеки?'))) return;
          await DB.photoDel(r.photoId); await DB.libDel(r.id); onDeleted();
        }
      }, t('Убрать')));
    }
    out.push(tile);
  }
  return out;
}

let galState = { item: '', v: '' };

async function scrGallery() {
  setHeader(t('Примеры: как хорошо, как плохо'), null);
  const { own, ref, priv } = await examplesFor(galState.item || '');
  const pass = o => !galState.v || (galState.v === 'scheme' ? o.kind === 'scheme'
    : (o.kind !== 'scheme' && o.verdict === galState.v));

  const refTiles = ref.filter(pass).map(r => galleryTile({
    src: r.file, verdict: r.verdict, kind: r.kind, title: r.title_ru,
    note: r.caption_ru, item: r.item, source: r.source,
  }));
  const mine = await ownTiles(own.filter(pass), scrGallery);
  const real = await privTiles(priv.filter(() => !galState.v || galState.v === 'bad'));

  const filters = el('div', { cls: 'row', style: 'gap:6px' },
    ...[['', t('Все')], ['bad', t('Как плохо')], ['good', t('Как хорошо')], ['scheme', t('Схемы')]].map(([k, lbl]) =>
      el('button', {
        cls: 'btn ' + (galState.v === k ? '' : 'sec'), style: 'flex:1;min-height:40px;font-size:13px',
        onclick: () => { galState.v = k; scrGallery(); }
      }, lbl)));

  const sel = el('select', { onchange: e => { galState.item = e.target.value; scrGallery(); } },
    el('option', { value: '' }, t('Все пункты')),
    ...ITEMS.map(i => el('option', { value: i.id, selected: galState.item === i.id ? 'selected' : false },
      `${i.id} — ${L(i)}`)));

  render([
    el('div', { cls: 'card' },
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        t('Свои примеры добавляются прямо с инспекции: в находке нажмите ★ на снимке. ') +
        t('Библиотека растёт от выезда к выезду и работает офлайн.')),
      filters, el('div', { cls: 'sp' }, sel)),
    ACCESS === 'demo' ? el('div', { cls: 'card xs mut' }, t('Реальные находки из базы SAFA доступны после входа по паролю (Настройки → Доступ).')) : null,
    real.length ? el('div', { cls: 'sec-h' }, t('Реальные находки') + ' (' + real.length + ')') : null,
    real.length ? el('div', { cls: 'gal' }, ...real) : null,
    mine.length ? el('div', { cls: 'sec-h' }, t('Свои примеры') + ' (' + mine.length + ')') : null,
    mine.length ? el('div', { cls: 'gal' }, ...mine) : null,
    refTiles.length ? el('div', { cls: 'sec-h' }, t('Из руководств') + ' (' + refTiles.length + ')') : null,
    refTiles.length ? el('div', { cls: 'gal' }, ...refTiles) : null,
    (!mine.length && !refTiles.length && !real.length) ? el('div', { cls: 'empty' },
      el('div', { cls: 'b' }, t('Примеров пока нет')),
      el('div', { cls: 'sm sp' }, t('Сфотографируйте несоответствие на инспекции и нажмите ★ на снимке — он попадёт сюда.'))) : null,
  ]);
}

function scrFindings() {
  const ins = S.ins;
  setHeader(t('Находки') + ' · ' + ins.findings.length, scrInsp);
  const nodes = [];
  const mc = maxCat(ins);

  nodes.push(el('div', { cls: 'card' },
    el('div', { cls: 'row wrap' },
      ...[3, 2, 1, 'G'].map(k => {
        const n = ins.findings.filter(f => String(f.cat) === String(k)).length;
        return el('span', { cls: 'pill ' + CATS[k].cls, style: n ? '' : 'opacity:.35' },
          (k === 'G' ? 'G' : t('кат. ') + k) + ': ' + n);
      })),
    mc === 3 ? el('div', { cls: 'sm sp', style: 'margin-top:9px' },
      t('⚠️ Есть находка категории 3 — требуются корректирующие действия до вылета либо ограничение эксплуатации (класс 3a/3b/3c).')) : null));

  if (!ins.findings.length) {
    nodes.push(el('div', { cls: 'empty' }, t('Несоответствий не выявлено. Находки добавляются из чек-листа кнопкой «!».')));
  } else {
    SECTIONS.forEach(sec => {
      const list = ins.findings.filter(f => f.item[0] === sec.id);
      if (!list.length) return;
      nodes.push(el('div', { cls: 'sec-h' }, el('span', { cls: 'code' }, sec.id), L(sec)));
      list.forEach(f => nodes.push(el('div', { cls: 'card' }, findingRow(f, scrFindings))));
    });
  }
  nodes.push(el('button', { cls: 'btn sec wide sp', onclick: scrInsp }, t('Назад')));
  render(nodes);
}

/* ══════════════ экран: отчёт ══════════════ */

function scrReport() {
  const ins = S.ins;
  setHeader(t('Отчёт (PI)'), scrInsp);
  const sug = suggestClass(ins);

  const clsBox = el('div');
  const drawCls = () => {
    clsBox.innerHTML = '';
    ACTIONS.forEach(([k, ru, en]) => clsBox.append(el('button', {
      cls: 'opt' + (ins.actClass === k ? ' on' : ''),
      onclick: () => { ins.actClass = ins.actClass === k ? '' : k; save(ins); drawCls(); }
    }, el('div', { cls: 'row' }, el('span', { cls: 'pill pmut' }, k),
      el('span', { cls: 'sm grow' }, CFG.d.lang === 'en' ? en : ru),
      k === sug ? el('span', { cls: 'pill pok xs' }, t('рекомендуется')) : null),
      el('div', { cls: 'xs mut', style: 'margin-top:3px;margin-left:34px' }, CFG.d.lang === 'en' ? ru : en))));
  };
  drawCls();

  render([
    el('div', { cls: 'card' },
      el('h3', {}, t('Класс принятых мер')),
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        sug ? t('По максимальной категории находок (') + maxCat(ins) + t(') рекомендуется класс ') + sug + '.'
            : t('Находок нет — класс мер обычно не назначается.')),
      clsBox),

    el('div', { cls: 'card' },
      el('label', { cls: 'f' }, el('span', {}, t('Дополнительная информация / комментарии')),
        el('textarea', { style: 'min-height:110px', oninput: e => { ins.comments = e.target.value; save(ins); } }, ins.comments))),

    sigCard('insp', t('Подпись инспектора АГА РТ'), ins.gen.inspector),
    sigCard('cap', t('Подпись КВС / представителя эксплуатанта'), ins.gen.captain),

    el('div', { cls: 'card' },
      el('h3', {}, 'Выдача и отправка'),
      el('button', { cls: 'btn wide', onclick: () => printPI(ins) }, t('🖨 Печать / сохранить PDF')),
      el('button', { cls: 'btn sec wide sp', onclick: () => exportJSON(ins) }, t('⬇ Выгрузить JSON')),
      el('button', { cls: 'btn sec wide sp', onclick: () => syncOne(ins) },
        t('☁ Отправить в управление') + (ins.sync.state === 'sent' ? t(' (уже отправлена)') : '')),
      CFG.d.gasUrl ? null : el('div', { cls: 'xs mut sp' },
        t('Адрес сервера синхронизации не задан — укажите его в «Настройки → Синхронизация».'))),
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
      el('button', { cls: 'btn sec grow', style: 'min-height:40px;font-size:14px', onclick: () => { clear(); ins.sig[key] = ''; save(ins); } }, t('Очистить')),
      el('button', { cls: 'btn grow', style: 'min-height:40px;font-size:14px', onclick: () => { ins.sig[key] = c.toDataURL('image/png'); save(ins); toast('Подпись сохранена'); } }, t('Сохранить'))));

  requestAnimationFrame(() => {
    const r = c.getBoundingClientRect();
    c.width = r.width * 2; c.height = r.height * 2;
    const g = c.getContext('2d');
    g.scale(2, 2); g.lineWidth = 2; g.lineCap = 'round'; g.strokeStyle = '#12212f';
    if (ins.sig[key]) { const i = new Image(); i.onload = () => g.drawImage(i, 0, 0, r.width, r.height); i.src = ins.sig[key]; }
    let drawing = false;
    const pos = e => { const b = c.getBoundingClientRect(); const pt = e.touches ? e.touches[0] : e; return [pt.clientX - b.left, pt.clientY - b.top]; };
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

  const act = ACTIONS.map(([k, ru, en]) =>
    `<div>${ins.actClass === k ? '☒' : '☐'} <b>${k})</b> ${esc(ru)}
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
    ...[['pdf', t('Формулировки')], ['gal', t('Примеры')]].map(([k, lbl]) =>
      el('button', {
        cls: 'btn ' + (refState.tab === k ? '' : 'sec'), style: 'flex:1;min-height:42px',
        onclick: () => { refState.tab = k; scrRef(); }
      }, lbl)));
}

function scrRefFindings() {
  setHeader(t('Справочник находок'), null);
  const out = el('div');

  const q = el('input', { placeholder: t('Поиск по формулировке, коду или норме…'), value: refState.q,
    oninput: e => { refState.q = e.target.value; draw(); } });

  const selItem = el('select', { onchange: e => { refState.item = e.target.value; draw(); } },
    el('option', { value: '' }, t('Все пункты')),
    ...ITEMS.map(i => el('option', { value: i.id, selected: refState.item === i.id ? 'selected' : false },
      `${i.id} — ${L(i)} (${i.n})`)));

  const cats = el('div', { cls: 'row', style: 'gap:6px' },
    ...['', '1', '2', '3', 'G'].map(k => el('button', {
      cls: 'btn ' + (refState.cat === k ? '' : 'sec'), style: 'flex:1;min-height:40px;font-size:13px',
      onclick: () => { refState.cat = k; scrRef(); }
    }, k === '' ? t('Все') : (k === 'G' ? 'G' : 'Кат. ' + k))));

  function draw() {
    const needle = refState.q.trim().toLowerCase();
    const list = PDF.filter(f =>
      (!refState.item || f.item === refState.item) &&
      (!refState.cat || String(f.cat) === refState.cat) &&
      (!needle || f.text.toLowerCase().includes(needle) || f.code.toLowerCase().includes(needle)
          || (f.refs || '').toLowerCase().includes(needle)));
    out.innerHTML = '';
    out.append(el('div', { cls: 'xs mut', style: 'margin:8px 0' }, t('Найдено: ') + list.length + ' ' + t('из') + ' ' + PDF.length));
    list.slice(0, 300).forEach(f => out.append(el('div', { cls: 'card' },
      el('div', { cls: 'row' },
        el('span', { cls: 'pill ' + CATS[f.cat].cls }, t('кат. ') + f.cat),
        el('span', { cls: 'xs mut' }, f.code),
        el('span', { cls: 'right xs mut' }, ITEM_BY_ID[f.item] ? L(ITEM_BY_ID[f.item]) : f.item)),
      el('div', { cls: 'sm', style: 'margin-top:6px' }, f.text),
      f.refs ? el('div', { cls: 'xs mut', style: 'margin-top:4px' }, f.refs) : null)));
    if (list.length > 300) out.append(el('div', { cls: 'xs mut' }, t('Показаны первые 300 — уточните запрос.')));
  }
  draw();

  render([
    refHubStrip(),
    el('div', { cls: 'card' },
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        t('База предописанных находок (PDF): ') + PDF.length + t(' формулировок по ') + ITEMS.length + t(' пунктам.') + ' ' +
        t('Источник — EASA RIM Appendix 1, Issue 6.')),
      q, el('div', { cls: 'sp' }, selItem), el('div', { cls: 'sp' }, cats)),
    out,
  ]);
}

/* ══════════════ экран: тренажёр ══════════════ */

let TR = null;

function scrTrain() {
  setHeader(t('Тренажёр инспектора'), null);
  if (!TR) {
    return render([
      el('div', { cls: 'card' },
        el('h3', {}, t('Категорирование находок')),
        el('div', { cls: 'sm mut' },
          t('Тренировка на реальной базе из ') + PDF.length + ' предописанных находок SAFA. ' +
          t('Правильный ответ — тот, что закреплён в Appendix 1, Issue 6.')),
        el('div', { cls: 'sp' },
          el('button', { cls: 'btn wide', onclick: () => startTrain('cat', 15) }, t('Определить категорию (15 вопросов)')),
          el('button', { cls: 'btn sec wide sp', onclick: () => startTrain('item', 15) }, t('Определить пункт чек-листа (15)')),
          el('button', { cls: 'btn sec wide sp', onclick: () => startTrain('mix', 25) }, t('Смешанный режим (25)')))),
      el('div', { cls: 'card' },
        el('h3', {}, t('Как категорируются находки')),
        ...[1, 2, 3, 'G'].map(k => el('div', { cls: 'sp' },
          el('span', { cls: 'pill ' + CATS[k].cls }, k === 'G' ? 'G' : 'Категория ' + k),
          el('div', { cls: 'sm', style: 'margin-top:4px' }, L(CATS[k]))))),
      el('div', { cls: 'card' },
        el('h3', {}, t('Классы принятых мер')),
        ...ACTIONS.map(([k, ru, en]) => el('div', { cls: 'row sp' },
          el('span', { cls: 'pill pmut' }, k), el('span', { cls: 'sm grow' }, CFG.d.lang === 'en' ? en : ru)))),
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
  setHeader(t('Вопрос') + ' ' + (TR.i + 1) + ' ' + t('из') + ' ' + TR.qs.length, () => { TR = null; scrTrain(); });

  const opts = el('div');
  let correct, choices;
  if (kind === 'cat') {
    correct = String(f.cat);
    choices = ['1', '2', '3', 'G'].map(k => [k, (k === 'G' ? t('General — вне категорий') : L(CATS[k]))]);
  } else {
    correct = f.item;
    const others = ITEMS.filter(i => i.id !== f.item).sort(() => Math.random() - 0.5).slice(0, 3);
    choices = [...others.map(i => [i.id, i.id + ' — ' + L(i)]), [f.item, f.item + ' — ' + L(ITEM_BY_ID[f.item])]]
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
    el('div', { cls: 'row' }, el('span', { cls: 'pill ' + CATS[f.cat].cls }, t('кат. ') + f.cat),
      el('span', { cls: 'xs mut' }, f.code)),
    el('div', { cls: 'sm sp' }, ITEM_BY_ID[f.item].id + ' — ' + L(ITEM_BY_ID[f.item])),
    f.refs ? el('div', { cls: 'xs mut sp' }, t('Нормы: ') + f.refs) : null);

  const next = el('button', {
    cls: 'btn wide sp', hidden: 'hidden',
    onclick: () => { TR.i++; TR.answered = false; drawQuestion(); }
  }, TR.i + 1 >= TR.qs.length ? t('Показать результат') : t('Следующий вопрос'));

  render([
    el('div', { cls: 'card' },
      el('div', { cls: 'bar' }, el('i', { style: `width:${TR.i / TR.qs.length * 100}%` })),
      el('div', { cls: 'xs mut sp' }, kind === 'cat'
        ? t('Какую категорию имеет эта находка?')
        : t('К какому пункту чек-листа относится эта находка?')),
      el('div', { cls: 'b sp', style: 'margin-top:9px;font-size:16px' }, f.text)),
    opts, expl, next,
  ]);
}

function drawResult() {
  const pct = Math.round(TR.right / TR.qs.length * 100);
  setHeader(t('Результат'), () => { TR = null; scrTrain(); });
  render([
    el('div', { cls: 'card', style: 'text-align:center' },
      el('div', { style: 'font-size:44px;font-weight:700' }, pct + '%'),
      el('div', { cls: 'mut' }, TR.right + ' ' + t('из') + ' ' + TR.qs.length + t(' верно')),
      el('div', { cls: 'sm sp', style: 'margin-top:10px' },
        pct >= 80 ? t('Отличный результат — категорирование уверенное.')
      : pct >= 60 ? t('Неплохо, но разберите ошибки ниже.')
                  : t('Стоит повторить Appendix 1 по разобранным пунктам.'))),
    ...(TR.wrong.length ? [el('div', { cls: 'sec-h' }, t('Разбор ошибок'))] : []),
    ...TR.wrong.map(w => el('div', { cls: 'card' },
      el('div', { cls: 'sm b' }, w.f.text),
      el('div', { cls: 'row sp', style: 'margin-top:7px' },
        el('span', { cls: 'pill cat3' }, t('вы: ') + w.given),
        el('span', { cls: 'pill pok' }, t('верно: ') + (w.kind === 'cat' ? w.f.cat : w.f.item))),
      el('div', { cls: 'xs mut sp' }, w.f.code + ' · ' + L(ITEM_BY_ID[w.f.item])))),
    el('button', { cls: 'btn wide sp', onclick: () => { TR = null; scrTrain(); } }, t('В меню тренажёра')),
  ]);
}

/* ══════════════ экран: сводка ══════════════ */

async function scrStats() {
  setHeader(t('Сводка'), null);
  const all = await DB.all();
  if (!all.length) return render(el('div', { cls: 'empty' }, t('Данных пока нет.')));

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

  // ── KPI эффекта: измеримая польза внедрения ──
  let durSum = 0, durN = 0, covSum = 0, fPhoto = 0, fTot = 0, compl = 0, sent = 0;
  all.forEach(i => {
    const mins = (new Date(i.updatedAt) - new Date(i.createdAt)) / 60000;
    if (mins > 0.5) { durSum += mins; durN++; }
    covSum += progress(i) / ITEMS.length;
    i.findings.forEach(f => { fTot++; if ((f.photos || []).length) fPhoto++; });
    if (i.status === 'completed') { compl++; if (i.sync.state === 'sent') sent++; }
  });
  const avgMin = durN ? Math.round(durSum / durN) : null;
  const covPct = Math.round(covSum / all.length * 100);
  const photoPct = fTot ? Math.round(fPhoto / fTot * 100) : null;
  const digPct = compl ? Math.round(sent / compl * 100) : null;
  const kpi = (val, cap, sub) => el('div', { cls: 'kpi' },
    el('div', { cls: 'kpi-v' }, val),
    el('div', { cls: 'kpi-c' }, cap),
    el('div', { cls: 'kpi-s' }, sub));

  render([
    el('div', { cls: 'card' },
      el('h3', {}, t('KPI эффекта')),
      el('div', { cls: 'xs mut', style: 'margin-bottom:10px' }, t('Измеримый эффект внедрения — для заявки и презентации.')),
      el('div', { cls: 'kpis' },
        kpi(avgMin != null ? avgMin + t(' мин') : t('нет данных'), t('Ср. время инспекции'), t('от начала до завершения')),
        kpi(covPct + '%', t('Полнота чек-листа'), t('ср. охват 53 пунктов')),
        kpi(photoPct != null ? photoPct + '%' : '—', t('Находки с фотодоказательством'), t('доказательная база')),
        kpi(digPct != null ? digPct + '%' : '—', t('Цифровая сдача в управление'), t('безбумажный оборот')))),

    el('div', { cls: 'card' },
      el('h3', {}, t('Всего')),
      el('div', { cls: 'row wrap' },
        el('span', { cls: 'pill pmut' }, t('инспекций: ') + all.length),
        el('span', { cls: 'pill pmut' }, t('завершено: ') + all.filter(i => i.status === 'completed').length),
        el('span', { cls: 'pill cat1' }, 'кат. 1: ' + f1),
        el('span', { cls: 'pill cat2' }, 'кат. 2: ' + f2),
        el('span', { cls: 'pill cat3' }, 'кат. 3: ' + f3)),
      el('div', { cls: 'sm sp', style: 'margin-top:9px' },
        t('Среднее число находок на инспекцию (SAFA ratio): ') + ratio),
      grounded ? el('div', { cls: 'sm' }, t('ВС запрещено к полёту (3c): ') + grounded) : null),

    el('div', { cls: 'card' },
      el('h3', {}, t('По типам инспекций')),
      ...Object.entries(byType).map(([k, v]) => el('div', { cls: 'row sp' },
        el('span', { cls: 'pill pmut' }, k), el('span', { cls: 'sm grow' }, L(TYPES[k])), el('b', {}, v)))),

    top.length ? el('div', { cls: 'card' },
      el('h3', {}, t('Наиболее частые пункты с находками')),
      ...top.map(([id, n]) => el('div', { cls: 'row sp' },
        el('span', { cls: 'pill pmut' }, id),
        el('span', { cls: 'sm grow' }, ITEM_BY_ID[id] ? L(ITEM_BY_ID[id]) : id),
        el('b', {}, n)))) : null,

    Object.keys(byOp).length ? el('div', { cls: 'card' },
      el('h3', {}, t('По эксплуатантам')),
      ...Object.entries(byOp).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        el('div', { cls: 'row sp' }, el('span', { cls: 'sm grow' }, k), el('b', {}, v)))) : null,
  ]);
}

/* ══════════════ экран: настройки ══════════════ */

async function scrSet() {
  setHeader(t('Настройки'), null);
  const all = await DB.all();
  const pend = all.filter(i => i.status === 'completed' && i.sync.state !== 'sent').length;
  const f = (key, lab, ph) => el('label', { cls: 'f' }, el('span', {}, lab),
    el('input', { value: CFG.d[key], placeholder: ph || '', oninput: e => { CFG.d[key] = e.target.value; CFG.save(); } }));

  render([
    accessCard(),

    el('div', { cls: 'card' },
      el('h3', {}, t('Язык интерфейса')),
      el('div', { cls: 'row', style: 'gap:8px' },
        ...[['ru', 'Русский'], ['en', 'English']].map(([code, name]) =>
          el('button', {
            cls: 'btn ' + (CFG.d.lang === code ? '' : 'sec'), style: 'flex:1',
            onclick: () => setLang(code)
          }, name)))),

    el('div', { cls: 'card' },
      el('h3', {}, t('Инспектор')),
      f('inspector', t('Ф.И.О. инспектора')),
      f('inspPost', t('Должность')),
      f('airport', t('Аэропорт по умолчанию'), t('напр. UTDD'))),

    el('div', { cls: 'card' },
      el('h3', {}, t('Полномочный орган')),
      el('label', { cls: 'f' }, el('span', {}, t('Наименование в шапке акта')),
        el('textarea', { oninput: e => { CFG.d.authority = e.target.value; CFG.save(); } }, CFG.d.authority))),

    el('div', { cls: 'card' },
      el('h3', {}, t('Синхронизация')),
      f('gasUrl', t('Адрес веб-приложения Google Apps Script'), 'https://script.google.com/macros/s/…/exec'),
      el('div', { cls: 'xs mut' }, t('Завершённых и неотправленных инспекций: ') + pend),
      el('button', { cls: 'btn wide sp', onclick: syncAll }, t('☁ Отправить все завершённые')),
      el('div', { cls: 'xs mut sp' },
        t('Развёртывание бэкенда — файл gas/Code.gs в папке проекта (README, раздел «Синхронизация»).'))),

    el('div', { cls: 'card' },
      el('h3', {}, t('Офлайн-готовность')),
      el('div', { cls: 'xs mut', style: 'margin-bottom:8px' },
        t('Справочных изображений: ') + REF_PHOTOS.length + t('. На перроне связи нет — они должны лежать в устройстве.')),
      el('div', { id: 'offlineState', cls: 'sm mut' }, t('Проверка…')),
      el('button', { cls: 'btn wide sp', onclick: cachePhotosNow }, t('⬇ Загрузить примеры в устройство'))),

    el('div', { cls: 'card' },
      el('h3', {}, t('Данные')),
      el('button', { cls: 'btn sec wide', onclick: exportAll }, t('⬇ Выгрузить все инспекции (JSON)')),
      el('button', { cls: 'btn sec wide sp', onclick: () => location.reload(true) }, t('↻ Обновить приложение'))),

    el('div', { cls: 'card xs mut' },
      el('div', {}, 'SAFA Inspector v' + APP_VER),
      el('div', { cls: 'sp' }, t('База предописанных находок: ') + PDF.length + t(' формулировок, ') + ITEMS.length + t(' пунктов.')),
      el('div', {}, t('Источник: EASA Ramp Inspection Manual, Appendix 1 — Inspection instructions and pre-described findings, Issue 6 (INST.RI.01/006, 28.10.2022).')),
      el('div', { cls: 'sp' }, t('Категорирование и классы мер — по RIM и бланку PI АГА РТ.'))),
  ]);
  offlineStatus();
}

// Сколько справочных изображений уже лежит в кэше — на перроне связи нет
async function offlineStatus() {
  const box = $('#offlineState');
  if (!box) return;
  if (!('caches' in window) || !REF_PHOTOS.length) {
    box.textContent = REF_PHOTOS.length ? t('Кэш недоступен в этом браузере.') : t('Изображений нет.');
    return;
  }
  const keys = await caches.keys();
  const c = keys.length ? await caches.open(keys[0]) : null;
  if (!c) { box.textContent = t('Кэш пуст — нажмите «Загрузить примеры».'); return; }
  let have = 0;
  for (const p of REF_PHOTOS) if (await c.match('./' + p.file)) have++;
  box.innerHTML = '';
  box.append(
    el('div', { cls: 'bar' }, el('i', { style: `width:${have / REF_PHOTOS.length * 100}%` })),
    el('div', { cls: 'xs sp' }, have === REF_PHOTOS.length
      ? t('✓ Все ') + have + t(' изображений в устройстве — офлайн готов.')
      : t('В устройстве ') + have + ' ' + t('из') + ' ' + REF_PHOTOS.length + t('. Загрузите остальные по Wi-Fi.')));
}

async function cachePhotosNow() {
  if (!REF_PHOTOS.length) return toast('Изображений нет');
  const keys = await caches.keys();
  const c = await caches.open(keys[0] || 'safa-inspector-manual');
  toast('Загрузка примеров…');
  const r = await Promise.allSettled(REF_PHOTOS.map(p => c.add('./' + p.file)));
  const bad = r.filter(x => x.status === 'rejected').length;
  toast(bad ? t('Загружено с ошибками: не удалось ') + bad : t('Примеры загружены в устройство'));
  offlineStatus();
}

async function exportAll() {
  const all = await DB.all();
  const blob = new Blob([JSON.stringify(all.map(payload), null, 1)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `safa_inspections_${isoDate(new Date())}.json` });
  document.body.append(a); a.click(); a.remove();
}

/* ══════════════ вход по паролю и закрытый набор примеров ══════════════
   Сайт статический, репозиторий открытый: окно с паролем само по себе файлы не
   защищает. Поэтому реальные находки лежат в data/private.enc в зашифрованном виде
   (AES-256-GCM, ключ из пароля через PBKDF2), а пароль их расшифровывает на устройстве.
   Проверка пароля = удачная расшифровка; сам пароль нигде не хранится.
   Нет файла набора — нет и замка: приложение работает как раньше. */

const PACK_URL = 'data/private.enc';
const DEMO_DOOR = true;      // ссылка «Демо без пароля» на экране входа (для показа продукта)
let PRIV = [];               // оглавление расшифрованного набора
let PRIV_META = null;        // {build, title, source, tag, salt}
let ACCESS = 'open';         // open — набора нет · full — вошёл по паролю · demo — без пароля

const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');

async function fetchPack() {
  try {
    const r = await fetch(PACK_URL, { cache: 'no-cache' });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    // офлайн сервис-воркер может подсунуть index.html — отличаем по сигнатуре
    if (buf.length < 52 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'SIP1') return null;
    return {
      iter: new DataView(buf.buffer).getUint32(4), salt: buf.subarray(8, 24),
      iv: buf.subarray(24, 36), ct: buf.subarray(36),
      tag: hex(buf.subarray(24, 36)),          // iv свой у каждой сборки — её отпечаток
    };
  } catch (e) { return null; }
}

async function packKey(password, pack) {
  const raw = new TextEncoder().encode(password.normalize('NFC').trim());
  const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: pack.salt, iterations: pack.iter, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

// Расшифровать набор и разложить по хранилищу устройства. Неверный ключ — исключение
// OperationError до любой записи, так что прежние данные не портятся.
async function openPack(key, pack) {
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: pack.iv }, key, pack.ct));
  const n = new DataView(plain.buffer).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n)));
  const base = 4 + n;
  for (const o of ((await DB.kvGet('privIndex')) || [])) await DB.photoDel('priv:' + o.id);
  for (const it of meta.items) {
    await DB.photoPut('priv:' + it.id,
      new Blob([plain.subarray(base + it.off, base + it.off + it.len)], { type: 'image/jpeg' }));
  }
  PRIV = meta.items.map(({ off, len, ...m }) => m);
  PRIV_META = { build: meta.build, title: meta.title, source: meta.source, tag: pack.tag, salt: hex(pack.salt) };
  await DB.kvPut('privIndex', PRIV);
  await DB.kvPut('privMeta', PRIV_META);
}

// Выход: убрать с устройства ключ и расшифрованные изображения
async function lockOut() {
  for (const o of ((await DB.kvGet('privIndex')) || [])) await DB.photoDel('priv:' + o.id);
  await DB.kvDel('privKey'); await DB.kvDel('privIndex'); await DB.kvDel('privMeta');
  PRIV = []; PRIV_META = null; ACCESS = 'open';
}

async function gate() {
  const meta = await DB.kvGet('privMeta'), key = await DB.kvGet('privKey');
  const pack = await fetchPack();
  if (meta && key) {                               // на этом устройстве уже входили
    PRIV = (await DB.kvGet('privIndex')) || []; PRIV_META = meta; ACCESS = 'full';
    if (!pack || pack.tag === meta.tag) return;    // набор тот же либо нет связи
    if (hex(pack.salt) === meta.salt) {            // вышел новый набор, пароль прежний
      try { await openPack(key, pack); return; } catch (e) { /* ключ не подошёл */ }
    }
    await lockOut();                               // пароль сменили — войти заново
  }
  if (!pack) { ACCESS = 'open'; return; }          // набор не опубликован — замка нет
  if (DEMO_DOOR && (localStorage.safaMode === 'demo' || /[?&]demo=1/.test(location.search))) {
    ACCESS = 'demo'; return;
  }
  await lockScreen(pack);
}

function lockScreen(pack) {
  return new Promise(resolve => {
    const msg = el('div', { cls: 'lock-msg' });
    const inp = el('input', { type: 'password', autocomplete: 'current-password', placeholder: t('Пароль') });
    const btn = el('button', { cls: 'btn wide' }, t('Войти'));
    const done = mode => { ACCESS = mode; wrap.remove(); resolve(); };
    const go = async () => {
      if (!inp.value.trim()) return;
      btn.disabled = true; msg.textContent = t('Проверка…');
      try {
        const key = await packKey(inp.value, pack);
        await openPack(key, pack);
        await DB.kvPut('privKey', key);            // ключ неизвлекаемый, хранится для обновлений набора
        localStorage.removeItem('safaMode');
        done('full');
      } catch (e) {
        btn.disabled = false;
        msg.textContent = e && e.name === 'OperationError' ? t('Неверный пароль') : t('Не удалось войти: ') + (e && e.message || e);
        inp.select();
      }
    };
    btn.addEventListener('click', go);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    const wrap = el('div', { cls: 'lock' }, el('div', { cls: 'lock-box' },
      el('div', { cls: 'lock-t' }, 'SAFA Inspector'),
      el('div', { cls: 'sm mut', style: 'margin-bottom:14px' }, t('Вход для инспекторов')),
      inp, el('div', { cls: 'sp' }, btn), msg,
      DEMO_DOOR ? el('button', {
        cls: 'lock-demo', onclick: () => { localStorage.safaMode = 'demo'; done('demo'); }
      }, t('Демо без пароля')) : null,
      el('div', { cls: 'xs mut', style: 'margin-top:14px' }, 'v' + APP_VER)));
    document.body.append(wrap);
    inp.focus();
  });
}

// Плитки закрытого набора: изображения читаются из хранилища устройства
async function privTiles(records) {
  const en = CFG.d.lang === 'en', out = [];
  for (const r of records) {
    const blob = await DB.photoGet('priv:' + r.id);
    if (!blob) continue;
    out.push(galleryTile({
      src: URL.createObjectURL(blob), verdict: 'bad', kind: 'photo', cat: r.cat,
      title: en ? r.title_en : r.title_ru, note: en ? r.note_en : r.note_ru,
      item: r.item, source: PRIV_META ? PRIV_META.source : '',
    }));
  }
  return out;
}

// Карточка «Доступ» в настройках
function accessCard() {
  if (ACCESS === 'open') return null;
  const reload = () => { location.href = location.pathname; };
  if (ACCESS === 'full') {
    return el('div', { cls: 'card' },
      el('h3', {}, t('Доступ')),
      el('div', { cls: 'sm' }, t('Вход выполнен. Реальных находок в устройстве: ') + PRIV.length),
      PRIV_META ? el('div', { cls: 'xs mut' }, t('Набор от ') + fmtDate((PRIV_META.build || '').slice(0, 10))) : null,
      el('button', {
        cls: 'btn sec wide sp', onclick: async () => {
          if (!confirm(t('Выйти? Реальные находки будут убраны с этого устройства. Ваши инспекции останутся.'))) return;
          await lockOut(); reload();
        }
      }, t('Выйти на этом устройстве')));
  }
  return el('div', { cls: 'card' },
    el('h3', {}, t('Доступ')),
    el('div', { cls: 'sm' }, t('Демо-режим: реальные находки недоступны.')),
    el('button', {
      cls: 'btn wide sp', onclick: () => { localStorage.removeItem('safaMode'); reload(); }
    }, t('Войти по паролю')));
}

/* ══════════════ демо-инспекция для показа ══════════════
   Заполненный пример, чтобы приложение не открывалось пустым экраном.
   Правило: демо НИКОГДА не вмешивается в работу инспектора.
   Засевается только на чистом устройстве (ни одной своей инспекции) и только
   один раз; удалил — больше не появится. Принудительно вернуть: ?demo=1 */

const DEMO_ID = 'demo-example-safa';

function demoInspection() {
  const items = {};
  ITEMS.forEach(i => items[i.id] = { s: 'ni', rmk: '' });
  // правдоподобный частичный обход: документы и кабина пройдены, дошли до шасси
  ['A01', 'A04', 'A05', 'A07', 'A08', 'A10', 'A11', 'A12', 'A20', 'A21', 'A22',
   'B04', 'B05', 'B12'].forEach(id => items[id].s = 'ok');
  items['A09'] = { s: 'na', rmk: 'Сертификат по шуму не применим для данного типа' };
  items['C04'] = { s: 'f',  rmk: 'Левая основная опора, колесо № 2' };
  items['A23'] = { s: 'f',  rmk: '' };

  const tyre = SAFA_PDF.find(f => f.code === 'C04-09');
  const tech = SAFA_PDF.find(f => f.item === 'A23' && f.cat === 1);

  return {
    id: DEMO_ID, type: 'SAFA', ver: APP_VER, status: 'draft', demo: true,
    createdAt: '2026-08-15T10:20:00.000Z', updatedAt: '2026-08-15T11:05:00.000Z',
    gen: {
      poi: 'ДЕМО-2026-001', date: '2026-08-15', time: '10:20', airport: 'UTDD',
      operator: 'DEMO AIRLINES — учебный пример', aocNo: 'DEMO-001', aocState: 'XX',
      aocContact: '', chartered: '',
      routeFrom: 'UTDD', flightIn: 'DM-101', routeTo: 'UTTT', flightOut: 'DM-102',
      regState: 'XX', kind: 'pax', acType: 'B738', acReg: 'EX-DEMO', msn: '30000',
      crewLic1: 'XX', crewLic2: 'XX',
      inspector: 'Инспектор АГА РТ (пример)', captain: 'КВС (пример)',
    },
    items,
    findings: [
      { id: 'demo-f1', item: 'C04', code: 'C04-09',
        text: tyre ? tyre.text : 'Tyre(s) unserviceable (worn or damaged) and not recorded',
        cat: 3, refs: tyre ? tyre.refs : '',
        note: 'Левая основная опора, колесо № 2: износ протектора до силового слоя. '
            + 'Запись в бортовом журнале и в перечне отложенных дефектов отсутствует.',
        photos: ['demo-photo-1'] },
      { id: 'demo-f2', item: 'A23', code: tech ? tech.code : 'A23-01',
        text: tech ? tech.text : 'Known defect not reported/assessed',
        cat: tech ? tech.cat : 1, refs: tech ? tech.refs : '',
        note: 'Дефект колеса не внесён в бортовой журнал — связано с находкой по C04.',
        photos: [] },
    ],
    actClass: '3b',
    comments: 'Учебный пример для демонстрации возможностей приложения. '
            + 'Эксплуатант и регистрационный номер вымышлены.',
    sig: { insp: '', cap: '' },
    sync: { state: 'local', at: '' },
  };
}

// Кладём в хранилище фото копию справочного изображения EASA по этой же находке
async function demoPhoto() {
  if (await DB.photoGet('demo-photo-1')) return;
  const ref = REF_PHOTOS.find(p => p.id === 'pdf-104')
           || REF_PHOTOS.find(p => p.item === 'C04' && p.verdict === 'bad');
  if (!ref) return;
  try {
    const blob = await fetch(ref.file).then(r => r.ok ? r.blob() : null);
    if (blob) await DB.photoPut('demo-photo-1', blob);
  } catch (e) { /* офлайн на первом запуске — пример останется без фото */ }
}

async function seedDemo(force) {
  if (!force) {
    if (await DB.kvGet('demoSeeded')) return false;      // уже был, даже если удалён
    if ((await DB.all()).length) return false;           // на устройстве есть своя работа
  }
  await demoPhoto();
  await DB.put(demoInspection());
  await DB.kvPut('demoSeeded', 1);
  return true;
}

/* ══════════════ старт ══════════════ */

(async function boot() {
  document.documentElement.lang = CFG.d.lang;
  $('#ver').textContent = 'v' + APP_VER;        // номер версии всегда на виду, в шапке
  applyNav();
  document.querySelector('nav.tabs button').classList.add('on');
  try { await gate(); } catch (e) { ACCESS = 'open'; }   // сбой проверки не должен запирать инспектора
  // ?demo=1 — принудительно вернуть учебный пример (для показа)
  const force = /[?&]demo=1/.test(location.search);
  try { await seedDemo(force); } catch (e) {}
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
