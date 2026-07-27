/**
 * SAFA Inspector — приём актов перронных инспекций с планшета инспектора.
 * Google Apps Script, привязанный к Google-таблице управления.
 *
 * Развёртывание:
 *   1. Создать Google-таблицу «Перронные инспекции SAFA — АГА РТ».
 *   2. Расширения → Apps Script, вставить этот файл.
 *   3. (опц.) Свойства скрипта: TG_TOKEN и TG_CHAT — уведомления о кат. 3.
 *   4. Развернуть → Новое развёртывание → Веб-приложение:
 *        Запуск от имени: Я
 *        Доступ:          Все (Anyone)
 *      Скопировать /exec-URL в приложение: Настройки → Синхронизация.
 */

var SH_INSP = 'Инспекции';
var SH_FIND = 'Находки';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action !== 'inspection') return out({ ok: false, error: 'unknown action' });
    var d = body.data;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    writeInspection_(sheet_(ss, SH_INSP, HEAD_INSP), d);
    writeFindings_(sheet_(ss, SH_FIND, HEAD_FIND), d);
    if (d.counts && d.counts.cat3 > 0) notify_(d);

    return out({ ok: true, id: d.id });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() {
  return out({ ok: true, service: 'SAFA Inspector', ts: new Date().toISOString() });
}

/* ── таблицы ───────────────────────────────────────────── */

var HEAD_INSP = ['ID', 'Тип', 'Статус', 'Создана', 'Обновлена', 'POI No', 'Дата', 'Время',
  'Аэропорт', 'Эксплуатант', 'AOC №', 'Гос-во AOC', 'Откуда', 'Рейс (прилёт)', 'Куда',
  'Рейс (вылет)', 'Гос-во рег.', 'Вид перевозки', 'Тип ВС', 'Рег. номер', 'MSN',
  'Инспектор', 'КВС', 'Проверено пунктов', 'Всего пунктов', 'Находок',
  'Кат.1', 'Кат.2', 'Кат.3', 'Макс. кат.', 'Класс мер', 'Комментарии', 'Принято'];

var HEAD_FIND = ['ID инспекции', 'Дата', 'Эксплуатант', 'Рег. номер', 'Пункт', 'Код PDF',
  'Категория', 'Формулировка (EN)', 'Пояснение инспектора', 'Фото', 'Принято'];

function sheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeInspection_(sh, d) {
  var g = d.gen || {}, c = d.counts || {};
  var row = [d.id, d.type, d.status, d.createdAt, d.updatedAt, g.poi, g.date, g.time,
    g.airport, g.operator, g.aocNo, g.aocState, g.routeFrom, g.flightIn, g.routeTo,
    g.flightOut, g.regState, g.kind, g.acType, g.acReg, g.msn, g.inspector, g.captain,
    c.checked, c.total, c.findings, c.cat1, c.cat2, c.cat3, c.maxCat,
    d.actClass, d.comments, new Date()];

  var r = findRow_(sh, d.id);                       // повторная отправка — обновляем строку
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

function writeFindings_(sh, d) {
  var ids = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (var i = ids.length; i >= 2; i--) {           // чистим прежние строки этой инспекции
    if (ids[i - 1][0] === d.id) sh.deleteRow(i);
  }
  var g = d.gen || {}, rows = (d.findings || []).map(function (f) {
    return [d.id, g.date, g.operator, g.acReg, f.item, f.code, f.cat, f.text, f.note,
      f.photos || 0, new Date()];
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var col = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) if (col[i][0] === id) return i + 2;
  return 0;
}

/* ── уведомление о находке категории 3 ─────────────────── */

function notify_(d) {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('TG_TOKEN'), chat = p.getProperty('TG_CHAT');
  if (!token || !chat) return;
  var g = d.gen || {};
  var cat3 = (d.findings || []).filter(function (f) { return f.cat === 3; });
  var txt = '⚠️ ' + d.type + ': находка категории 3\n' +
    'ВС: ' + (g.acReg || '—') + ' ' + (g.acType || '') + '\n' +
    'Эксплуатант: ' + (g.operator || '—') + '\n' +
    'Аэропорт: ' + (g.airport || '—') + ', ' + (g.date || '') + ' ' + (g.time || '') + '\n' +
    'Инспектор: ' + (g.inspector || '—') + '\n' +
    'Класс мер: ' + (d.actClass || 'не назначен') + '\n\n' +
    cat3.map(function (f) { return '• ' + f.item + ' ' + f.code + ' — ' + f.text; }).join('\n');
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', muteHttpExceptions: true,
      payload: { chat_id: chat, text: txt.slice(0, 4000) }
    });
  } catch (err) { /* уведомление не критично для приёма акта */ }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
