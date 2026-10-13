#!/usr/bin/env node
/* SAFA Inspector — сборка закрытого набора примеров (реальные находки).

   Что делает: берёт папку с изображениями и файлом pack-index.json, спрашивает пароль
   и пишет data/private.enc — один зашифрованный файл. В репозиторий попадает только он.
   Исходные изображения, подписи и пароль в репозиторий не попадают.

   Запуск (пароль вводится в терминале, на экране не показывается):
     node scripts/build-private-pack.mjs "<папка с изображениями>" [--publish]

   --publish — после сборки закоммитить data/private.enc в текущую ветку claude/… и отправить.

   Шифрование: ключ PBKDF2-SHA256 (600 000 итераций) → AES-256-GCM.
   Формат файла: 'SIP1' | итерации uint32 | соль 16 | iv 12 | шифртекст+метка.
   Открытый текст: длина JSON uint32 | JSON-оглавление | изображения подряд.
   Соль берётся из прежнего data/private.enc, если он есть: при том же пароле ключ
   не меняется, и устройства инспекторов подхватят новый набор без повторного входа.
   Смена пароля = всем войти заново. */
import { webcrypto as wc, randomBytes } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ошибки — одной строкой, без трассировки
const die = e => { console.error('Ошибка: ' + (e && e.message || e)); process.exit(1); };
process.on('uncaughtException', die); process.on('unhandledRejection', die);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'data', 'private.enc');
const ITER = 600000, MIN_LEN = 10;

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const srcDir = args.find(a => !a.startsWith('--'));
if (!srcDir) { console.error('Укажите папку с изображениями и pack-index.json'); process.exit(2); }

// ввод пароля без показа на экране
function ask(label) {
  return new Promise((res, rej) => {
    const si = process.stdin;
    if (!si.isTTY) return rej(new Error('Нужен интерактивный терминал для ввода пароля'));
    process.stdout.write(label);
    si.setRawMode(true); si.resume(); si.setEncoding('utf8');
    let buf = '';
    const on = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { si.setRawMode(false); si.pause(); si.off('data', on); process.stdout.write('\n'); return res(buf); }
        if (c === '\u0003') { si.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    si.on('data', on);
  });
}
const norm = s => s.normalize('NFC').trim();

async function getPassword() {
  // SIP_PACK_PASSWORD — только для автоматических проверок на тестовых данных
  if (process.env.SIP_PACK_PASSWORD) return norm(process.env.SIP_PACK_PASSWORD);
  const a = norm(await ask('Пароль для инспекторов (не короче ' + MIN_LEN + ' знаков): '));
  if (a.length < MIN_LEN) throw new Error('Пароль короче ' + MIN_LEN + ' знаков — файл лежит в открытом доступе, короткий пароль подбирается');
  const b = norm(await ask('Ещё раз: '));
  if (a !== b) throw new Error('Пароли не совпали');
  return a;
}

async function deriveKey(password, salt) {
  const base = await wc.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return wc.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

const index = JSON.parse(await readFile(path.join(srcDir, 'pack-index.json'), 'utf8'));
const files = new Set(await readdir(srcDir));
const blobs = []; let off = 0; const items = [];
for (const r of index.items) {
  if (!files.has(r.file)) throw new Error('Нет файла: ' + r.file);
  const b = await readFile(path.join(srcDir, r.file));
  const { file, ...meta } = r;
  items.push({ ...meta, id: file.replace(/\.[a-z]+$/i, ''), off, len: b.length });
  blobs.push(b); off += b.length;
}
const build = new Date().toISOString();
const json = Buffer.from(JSON.stringify({ v: 1, build, title: index.title || '', source: index.source || '', items }), 'utf8');
const plain = Buffer.concat([u32(json.length), json, ...blobs]);

const password = await getPassword();
let salt = randomBytes(16);
if (existsSync(OUT)) {
  const old = await readFile(OUT);
  if (old.subarray(0, 4).toString() === 'SIP1') salt = Buffer.from(old.subarray(8, 24));
}
const iv = randomBytes(12);
const key = await deriveKey(password, salt);
const ct = Buffer.from(await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
const fileBuf = Buffer.concat([Buffer.from('SIP1'), u32(ITER), salt, iv, ct]);
await writeFile(OUT, fileBuf);

// самопроверка: читаем записанное с диска и расшифровываем заново выведенным ключом
const chk = await readFile(OUT);
const key2 = await deriveKey(password, chk.subarray(8, 24));
const back = Buffer.from(await wc.subtle.decrypt({ name: 'AES-GCM', iv: chk.subarray(24, 36) }, key2, chk.subarray(36)));
if (!back.equals(plain)) throw new Error('Самопроверка не прошла');

console.log(`Готово: ${path.relative(ROOT, OUT)} — изображений ${items.length}, ${(fileBuf.length / 1048576).toFixed(2)} МБ, самопроверка пройдена.`);

if (publish) {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const br = git('branch', '--show-current');
  if (!br.startsWith('claude/')) throw new Error('Текущая ветка «' + br + '» — отправка только из рабочей ветки claude/…');
  git('add', '--', 'data/private.enc');
  git('commit', '-m', 'Закрытый набор примеров: ' + items.length + ' изображений (зашифрован)');
  git('push', '-u', 'origin', br);
  console.log('Отправлено в ветку ' + br + '.');
}
