/* SAFA Inspector — сквозная проверка экранов («ворота»).
   Открывает каждый экран приложения на русском и английском и ловит любые ошибки,
   в том числе асинхронные. Запускать в превью до слова «готово» и до запроса на слияние:

     в консоли браузера на http://localhost:8180 :
       await (await fetch('scripts/smoke.js')).text().then(eval); await SAFA_SMOKE()

   Проверка создаёт учебную демо-инспекцию — на рабочем устройстве инспектора не запускать.
   Появилась потому, что вкладка «Справочник → Формулировки» месяц не открывалась
   (локальная переменная перекрыла функцию перевода), а точечные проверки её не задевали. */
window.SAFA_SMOKE = async function () {
  const w = ms => new Promise(r => setTimeout(r, ms));
  const errs = [], rows = [];
  const onErr = e => errs.push(e.message || String(e));
  const onRej = e => errs.push('promise: ' + (e.reason && e.reason.message || e.reason));
  window.addEventListener('error', onErr); window.addEventListener('unhandledrejection', onRej);
  const view = () => document.querySelector('#view');
  const title = () => document.querySelector('#title').textContent;
  const closeSheets = () => document.querySelectorAll('.sheet, .lightbox').forEach(n => n.remove());

  // шаг: выполнить, подождать, убедиться, что нет ошибок и экран не пустой
  async function step(name, fn, opts = {}) {
    const before = errs.length;
    let thrown = '';
    try { await fn(); } catch (e) { thrown = e.message || String(e); }
    await w(opts.wait || 250);
    const problems = [];
    if (thrown) problems.push('исключение: ' + thrown);
    errs.slice(before).forEach(e => problems.push('ошибка: ' + e));
    if (!opts.sheet && !view().children.length) problems.push('пустой экран');
    if (opts.sheet && !document.querySelector('.sheet')) problems.push('окно не открылось');
    if (opts.title && title() !== opts.title) problems.push('заголовок «' + title() + '», ожидался «' + opts.title + '»');
    if (opts.has && !opts.has()) problems.push('нет ожидаемого содержимого');
    rows.push({ name, ok: !problems.length, problems });
    closeSheets();
  }

  const startLang = CFG.d.lang;
  await seedDemo(true);
  const demo = (await DB.all()).find(x => x.demo);

  for (const lang of ['ru', 'en']) {
    const P = '[' + lang + '] ';
    await step(P + 'смена языка', async () => { setLang(lang); }, { wait: 500 });

    // вкладки нижней панели: заголовок обязан соответствовать вкладке
    const tabs = { list: 'Инспекции на перроне', ref: null, train: 'Тренажёр инспектора', stats: 'Сводка', set: 'Настройки' };
    refState.tab = 'pdf';
    for (const k of Object.keys(tabs)) {
      await step(P + 'вкладка ' + k, async () => { document.querySelector('nav.tabs button[data-t="' + k + '"]').click(); },
        { wait: 600, title: t(tabs[k] || 'Справочник находок') });
    }

    // инспекция
    await step(P + 'выбор типа инспекции', async () => { pickType(); }, { sheet: true });
    await step(P + 'карточка инспекции', async () => { await openInspection(demo.id); });
    await step(P + 'меню инспекции', async () => { inspMenu(S.ins); }, { sheet: true });
    await step(P + 'общие сведения', async () => { scrGeneral(); });
    await step(P + 'чек-лист', async () => { scrChecklist(); }, { has: () => view().querySelectorAll('.item').length === ITEMS.length });
    for (const id of ['A01', 'A23', 'B09', 'C04', 'D02', 'E01']) {
      await step(P + 'пункт ' + id, async () => { scrItem(id); }, { wait: 500, has: () => !!view().querySelector('ul.hint') });
    }
    await step(P + 'добавление находки', async () => { addFinding('C04', () => {}); }, { sheet: true });
    await step(P + 'правка находки', async () => { editFinding(S.ins.findings[0], () => {}); }, { sheet: true, wait: 500 });
    await step(P + 'список находок', async () => { scrFindings(); });
    await step(P + 'отчёт', async () => { scrReport(); }, { has: () => view().querySelectorAll('.opt').length === ACTIONS.length });

    // справочник: формулировки с поиском и фильтрами, примеры с фильтрами
    S.tab = 'ref';
    await step(P + 'справочник: формулировки', async () => { refState = { q: '', item: '', cat: '', tab: 'pdf' }; scrRef(); },
      { has: () => view().querySelectorAll('.card').length > 100 });
    await step(P + 'справочник: поиск', async () => { refState.q = 'tyre'; scrRef(); },
      { has: () => view().querySelectorAll('.card').length > 2 });
    await step(P + 'справочник: фильтр категории и пункта', async () => { refState.q = ''; refState.cat = '3'; refState.item = 'C04'; scrRef(); },
      { has: () => view().querySelectorAll('.card').length > 2 });
    refState.cat = ''; refState.item = '';
    for (const v of ['', 'bad', 'good', 'scheme']) {
      await step(P + 'примеры: фильтр «' + (v || 'все') + '»', async () => { refState.tab = 'gal'; galState = { item: '', v }; await scrRef(); }, { wait: 500 });
    }
    await step(P + 'примеры: по пункту', async () => { galState = { item: 'C04', v: '' }; await scrRef(); }, { wait: 500 });
    galState = { item: '', v: '' }; refState.tab = 'pdf';

    // тренажёр: все режимы до экрана результата
    for (const mode of ['cat', 'item', 'mix']) {
      await step(P + 'тренажёр: ' + mode, async () => {
        TR = null; scrTrain(); startTrain(mode, 3);
        for (let i = 0; i < 6 && TR && TR.i < TR.qs.length; i++) {
          const ans = view().querySelector('button[data-k]'); if (!ans) break;
          ans.click(); await w(80);
          const next = [...view().querySelectorAll('button.btn')].pop(); if (next) next.click(); await w(80);
        }
      }, { wait: 300 });
    }
    TR = null;

    await step(P + 'сводка', async () => { await scrStats(); }, { has: () => view().querySelectorAll('.kpi').length === 4 });
    await step(P + 'настройки', async () => { await scrSet(); }, { wait: 400, has: () => !!view().querySelector('a[href^="guide.html"]') });
  }

  // возврат в исходное состояние не должен ронять саму проверку
  S.tab = 'list';
  try { setLang(startLang); } catch (e) { rows.push({ name: 'возврат языка', ok: false, problems: ['исключение: ' + e.message] }); }
  await w(400);
  window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onRej);
  const bad = rows.filter(r => !r.ok);
  return {
    version: APP_VER, access: ACCESS, steps: rows.length, failed: bad.length,
    report: bad.length ? bad.map(r => '✗ ' + r.name + ' — ' + r.problems.join('; ')).join('\n') : 'все шаги пройдены',
  };
};
