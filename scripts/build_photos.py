# -*- coding: utf-8 -*-
"""Сборка data/photos.js — справочные изображения для галереи приложения.
Источники: data/photos-pdf.json и data/photos-pptx.json (готовят скрипты extract_photos_*).
Запуск из корня проекта:  python scripts/build_photos.py
"""
import json, os, io, collections, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = ['data/photos-pdf.json', 'data/photos-pptx.json']
OUT = os.path.join(ROOT, 'data', 'photos.js')

recs, missing = [], []
for rel in SRC:
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        continue
    for r in json.load(open(p, encoding='utf-8')):
        if not r.get('file'):
            continue
        if not os.path.exists(os.path.join(ROOT, r['file'].replace('/', os.sep))):
            missing.append(r['file'])
            continue
        recs.append({
            'id': r['id'],
            'file': r['file'],
            'item': r.get('item') or None,
            # verdict отсутствует у нейтральных иллюстраций — в галерее они
            # показываются как «как плохо» только если это явно указано
            'verdict': r.get('verdict') or None,
            'kind': r.get('kind') or 'photo',
            'title_ru': (r.get('title_ru') or '').strip(),
            'caption_ru': (r.get('caption_ru') or '').strip(),
            'source': (r.get('source') or '').strip(),
        })

recs.sort(key=lambda r: (r['item'] or 'zz', r['id']))

with io.open(OUT, 'w', encoding='utf-8') as f:
    f.write('// Сгенерировано scripts/build_photos.py — вручную не править.\n')
    f.write('// Справочные изображения из руководств и учебных курсов SAFA.\n')
    f.write('window.SAFA_REF_PHOTOS = %s;\n' % json.dumps(recs, ensure_ascii=False, indent=0))

# список файлов для предзагрузки service worker'ом
files = [r['file'] for r in recs]
with io.open(os.path.join(ROOT, 'data', 'photos-manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(files, f, ensure_ascii=False)

mb = sum(os.path.getsize(os.path.join(ROOT, x.replace('/', os.sep))) for x in files) / 1048576
print('записей      :', len(recs))
print('типы         :', dict(collections.Counter(r['kind'] for r in recs)))
print('с привязкой  :', sum(1 for r in recs if r['item']))
print('по разделам  :', dict(sorted(collections.Counter(
    (r['item'] or '—')[0] for r in recs).items())))
print('вес          : %.1f МБ' % mb)
if missing:
    print('НЕТ ФАЙЛА    :', len(missing), missing[:5])
