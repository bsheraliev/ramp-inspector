# -*- coding: utf-8 -*-
"""Разбор отчёта SAFA «Findings of Inspection Items Report» (PDF) в таблицу."""
import pypdf, re, sys, json, collections

SRC = sys.argv[1]
r = pypdf.PdfReader(SRC)
pages = [(p.extract_text() or '') for p in r.pages]

NOISE = [
    r'^Findings of Inspection Items Report.*$',
    r'^Inspection Item:$',
    r'^No\. of times item Findings No\. of Findings Report Number Standard Reference Findings Descriptions Detailed Descriptions$',
    r'^Finding Status$',
    r'^Inspected \(III\)$',
]
NOISE_RE = re.compile('|'.join(NOISE), re.M)
ITEM_RE = re.compile(r'^([A-E]\d{2})\s+(.+)$', re.M)
# «SAFA-GCAA-2025-0040 2 Cat. 1 NR» — номер, счётчик, категория, статус слиты
ROW_RE = re.compile(
    r'((?:SAFA|AT|SACA)-[A-Z/]+(?:-[A-Z]+)?-\d{4}-\d{4})'   # номер отчёта
    r'\s*(\d*)\s*'                                          # счётчик (может отсутствовать)
    r'(?:Cat\.\s*([123G])\s*)?'                             # категория
    r'(OPEN|CLOSED|NR|NO RESPONSE|DISCARDED)?'              # статус
)

items = {}
cur = None
for t in pages:
    t = NOISE_RE.sub('', t)
    m = ITEM_RE.search(t)
    if m:
        cur = m.group(1)
        items.setdefault(cur, {'title': m.group(2).strip(), 'body': '', 'inspected': 0})
        t = t[m.end():]
    if cur:
        items[cur]['body'] += '\n' + t

def clean(s):
    return re.sub(r'\s+', ' ', s).strip()

out = []
for code, d in sorted(items.items()):
    body = d['body']
    rows, last = [], 0
    for m in ROW_RE.finditer(body):
        desc = clean(body[last:m.start()])
        desc = re.sub(r'^\d+\s*', '', desc)
        rows.append({'report': m.group(1), 'cat': m.group(3) or '?',
                     'status': m.group(4) or '?', 'text': desc[:300]})
        last = m.end()
    # число проверок пункта — последнее одиночное число в блоке
    nums = re.findall(r'^\s*(\d+)\s*$', body, re.M)
    out.append({'item': code, 'title': d['title'],
                'inspected': int(nums[-1]) if nums else None, 'findings': rows})

json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

tot = sum(len(x['findings']) for x in out)
print('пунктов в отчёте:', len(out), '| находок всего:', tot)
print('по категориям:', dict(sorted(collections.Counter(
    f['cat'] for x in out for f in x['findings']).items())))
print()
print('ПУНКТЫ С НАХОДКАМИ (по убыванию):')
for x in sorted(out, key=lambda x: -len(x['findings'])):
    if not x['findings']:
        continue
    cats = collections.Counter(f['cat'] for f in x['findings'])
    print('\n%s %s — находок %d %s (проверялся %s раз)' % (
        x['item'], x['title'], len(x['findings']),
        dict(sorted(cats.items())), x['inspected']))
    for f in x['findings']:
        print('   [кат.%s %s] %s' % (f['cat'], f['status'], f['text'][:150]))
