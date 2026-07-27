# -*- coding: utf-8 -*-
"""Извлечение базы предописанных находок (Pre-Described Findings, PDF)
из EASA RIM Appendix 1, Issue 6 (INST.RI.01/006, 28/10/2022) в JSON.

Формат таблицы в источнике:
  PDF Code | Pre-Described Finding | Cat | SAFA CAT Std.ref | SACA CAT Std.ref |
  SAFA GA Std.ref | SACA NCC Std.ref
Строки переносятся произвольно, поэтому блок ищем «от кода до следующего кода»,
а категорию — как отдельно стоящую цифру 1/2/3 перед первой ссылкой на норму.
"""
import re, json, sys, collections

SRC, OUT = sys.argv[1], sys.argv[2]
txt = open(SRC, encoding='utf-8').read()

BOILER_RE = re.compile('|'.join([
    r'^European Union Aviation Safety Agency\s*$',
    r'^\s*INSPECTION INSTRUCTIONS AND PRE-DESCRIBED FINDINGS\s*$',
    r'^Doc # INST\.RI\.\d+/\d+\s*$',
    r'^Approval Date .*$',
    r'^© European Union Aviation Safety Agency.*$',
    r'^Proprietary document\..*$',
    r'^An agency of the European Union\s*$',
    r'^PDF Code Pre-Described Finding Cat.*$',
    r'^\s*$',
]), re.M)

lines = [l.rstrip() for l in txt.split('\n')]
lines = [l for l in lines if not BOILER_RE.match(l)]

CODE = re.compile(r'^([A-E]\d{2}-\d{2})\s+(.*)$')

# Начало ссылки на норму — граница между описанием+категорией и колонками ссылок
REF = (r'(?:A\d{1,2}-|ORO\.|CAT\.|NCC\.|NCO\.|SPO\.|SPA\.|ARO\.|CAMO\.|M\.A\.|'
       r'MED\.|FCL\.|CC\.|CC-\d|SERA\.|Part-|Appendices|145\.|\d+\.B\.|21\.|'
       r'AUR\.|TCO\.|\(E\)TSO-|SAE\s|EUROCAE\s|'
       r'Not applicable|N/A\b|M(?:\s|$)|Doc\s|Annex|Chicago|Regulation|Reg\.|'
       r'\(EU\)|EU\s)')
# Категория: 1/2/3 либо G (general — отклонение по форме документа, вне категорий)
CATSPLIT = re.compile(r'(?<!\S)([123G])\s+(?=' + REF + r')')

def clean(s):
    s = re.sub(r'\s+', ' ', s).strip()
    for a, b in (('’', "'"), ('“', '"'), ('”', '"'), ('–', '-')):
        s = s.replace(a, b)
    return s

blocks, cur = [], None
for l in lines:
    m = CODE.match(l)
    if m:
        if cur:
            blocks.append(cur)
        cur = {'code': m.group(1), 'buf': [m.group(2)]}
    elif cur is not None:
        cur['buf'].append(l)
if cur:
    blocks.append(cur)

findings, skipped = {}, []
for b in blocks:
    body = ' '.join(b['buf'])
    m = CATSPLIT.search(body)
    if not m or m.start() < 8:          # описание не может быть пустым
        skipped.append(b['code'])
        continue
    desc = clean(body[:m.start()])
    cat = m.group(1)
    cat = int(cat) if cat.isdigit() else 'G'
    refs = clean(body[m.end():])
    code = b['code']
    if code in findings and len(findings[code]['text']) >= len(desc):
        continue
    findings[code] = {'code': code, 'item': code.split('-')[0],
                      'text': desc, 'cat': cat, 'refs': refs[:300]}

out = sorted(findings.values(), key=lambda f: f['code'])
json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

print('извлечено находок:', len(out))
print('пропущено блоков :', len(skipped), skipped[:20])
print('пунктов          :', len(set(f['item'] for f in out)))
print('по категориям    :', dict(sorted(collections.Counter(str(f['cat']) for f in out).items())))
long = [f for f in out if len(f['text']) > 220]
print('подозрительно длинные:', [(f['code'], len(f['text'])) for f in long])
print('длина описания   : min %d / avg %d / max %d' % (
    min(len(f['text']) for f in out),
    sum(len(f['text']) for f in out) // len(out),
    max(len(f['text']) for f in out)))
