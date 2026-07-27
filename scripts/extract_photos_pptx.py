# -*- coding: utf-8 -*-
"""
Извлечение фотопримеров из презентаций курса ICAO NAU «SAFA Ramp Inspections».

Что делает:
  1. Обходит все *.pptx в исходных папках (файлы «~$...» пропускаются).
  2. .pptx = zip: берёт ppt/media/*, текст слайдов (ppt/slides/slideN.xml, теги <a:t>)
     и связи ppt/slides/_rels/slideN.xml.rels, чтобы понять, на каком слайде картинка.
  3. Механический отсев: <300x300 px, <25 КБ, не-растр (svg), дубликаты по SHA1.
  4. Ручной отбор (CURATED): в презентациях этого курса подавляющее большинство
     картинок — иконки, логотипы, фоны и клипарт. Реальным наглядным материалом
     считаются только изображения из белого списка ниже; остальное отбраковано
     после визуального просмотра контактного листа.
  5. Пережимает отобранное (длинная сторона <=1200 px, JPEG q=78) в photos/
     и пишет индекс data/photos-pptx.json.

Запуск:  PYTHONIOENCODING=utf-8 python scripts/extract_photos_pptx.py
"""
import glob
import hashlib
import io
import json
import os
import re
import zipfile
from xml.etree import ElementTree as ET

from PIL import Image

A_NS = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
R_NS = '{http://schemas.openxmlformats.org/package/2006/relationships}'

BASE = r"C:\Users\user\Desktop\SSD 2025\01 Работа\Надзор (Oversight)\7 SAFA\SAFA 2026"
SOURCE_DIRS = [
    os.path.join(BASE, "20260725-30 CAA GRT"),
    os.path.join(BASE, r"SAFA PPP ACIC 2026\PPSAFA\SAFA PPP ACIC 2024"),
    os.path.join(BASE, r"SAFA PPP ACIC 2026\PPSAFA\Проекты"),
    os.path.join(BASE, r"SAFA PPP ACIC 2026\Сп Док"),
]

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS_DIR = os.path.join(PROJECT, "photos")
INDEX_PATH = os.path.join(PROJECT, "data", "photos-pptx.json")

MIN_SIDE = 300          # px
MIN_BYTES = 25 * 1024   # 25 КБ
MAX_LONG_SIDE = 1200    # px на выходе
JPEG_QUALITY = 78

RASTER_RE = re.compile(r"\.(png|jpe?g|jfif|bmp|tiff?|gif|emf|wmf)$", re.I)

# Белый список: SHA1[:8] изображения -> аннотация.
# Проверено визуально: только эти файлы в курсе являются наглядным материалом
# (снимки документов SAFA). Фотографий воздушных судов, узлов, кабины, салона
# и повреждений в этих .pptx нет — они остались в PDF-версиях курса.
CURATED = {
    "94e68a52": {
        "item": None,
        "verdict": None,
        "title_ru": "Бланк Proof of Inspection: 53 пункта A–E",
        "caption_ru": (
            "Структура отчёта перронной проверки: разделы A (лётная кабина, 24 пункта), "
            "B (безопасность/салон, 14), C (состояние ВС, 11), D (груз, 3), E (общее, 1), "
            "колонки Check/Remark и блок принятых мер Action taken."
        ),
    },
    "f30b627d": {
        "item": None,
        "verdict": None,
        "title_ru": "Форма 136 — отчёт SAFA/SACA для заполнения",
        "caption_ru": (
            "Рабочий бланк EU RI Checklist (Form 136), который вручается экипажу: шапка с данными "
            "рейса и ВС, 53 пункта проверки, раздел Action Taken от «no remarks» до запрета "
            "эксплуатации и поле комментариев экипажа."
        ),
    },
}


def slide_text(xml_bytes):
    root = ET.fromstring(xml_bytes)
    parts = [t.text.strip() for t in root.iter(A_NS + 't') if t.text and t.text.strip()]
    return " ".join(parts)


def collect():
    """Возвращает (records, stats). records — уникальные изображения, прошедшие механический отсев."""
    stats = {"decks": 0, "images_total": 0, "rejected_small": 0, "rejected_light": 0,
             "rejected_vector": 0, "rejected_unreadable": 0, "duplicates": 0, "unique_kept": 0}
    seen = {}
    records = []

    for d in SOURCE_DIRS:
        for path in sorted(glob.glob(os.path.join(d, "*.pptx"))):
            name = os.path.basename(path)
            if name.startswith("~$"):
                continue
            stats["decks"] += 1
            z = zipfile.ZipFile(path)
            names = z.namelist()
            media = [n for n in names if n.startswith("ppt/media/")]
            stats["images_total"] += len(media)

            media_to_slides, texts = {}, {}
            for n in names:
                m = re.match(r"ppt/slides/slide(\d+)\.xml$", n)
                if not m:
                    continue
                sn = int(m.group(1))
                try:
                    texts[sn] = slide_text(z.read(n))
                except Exception:
                    texts[sn] = ""
                rels = "ppt/slides/_rels/slide%d.xml.rels" % sn
                if rels in names:
                    for rel in ET.fromstring(z.read(rels)).iter(R_NS + "Relationship"):
                        tgt = rel.get("Target", "")
                        if "../media/" in tgt:
                            mn = "ppt/media/" + tgt.split("../media/")[-1]
                            media_to_slides.setdefault(mn, []).append(sn)

            for mn in media:
                data = z.read(mn)
                if not RASTER_RE.search(mn):
                    stats["rejected_vector"] += 1
                    continue
                if len(data) < MIN_BYTES:
                    stats["rejected_light"] += 1
                    continue
                try:
                    im = Image.open(io.BytesIO(data))
                    im.load()
                except Exception:
                    stats["rejected_unreadable"] += 1
                    continue
                w, h = im.size
                if w < MIN_SIDE or h < MIN_SIDE:
                    stats["rejected_small"] += 1
                    continue
                digest = hashlib.sha1(data).hexdigest()[:8]
                slides = sorted(set(media_to_slides.get(mn, [])))
                if digest in seen:
                    stats["duplicates"] += 1
                    seen[digest]["also_in"].append("%s, слайд %s" % (name, slides or "-"))
                    continue
                rec = {
                    "hash": digest,
                    "bytes": data,
                    "w": w,
                    "h": h,
                    "deck": name,
                    "slides": slides,
                    "text": " | ".join(texts.get(s, "")[:400] for s in slides),
                    "also_in": [],
                }
                seen[digest] = rec
                records.append(rec)
                stats["unique_kept"] += 1
    return records, stats


def main():
    os.makedirs(PHOTOS_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(INDEX_PATH), exist_ok=True)

    records, stats = collect()
    chosen = [r for r in records if r["hash"] in CURATED]
    chosen.sort(key=lambda r: (r["deck"], r["slides"][0] if r["slides"] else 0))

    index = []
    for i, rec in enumerate(chosen, start=1):
        ann = CURATED[rec["hash"]]
        im = Image.open(io.BytesIO(rec["bytes"]))
        im.load()
        im = im.convert("RGB")
        if max(im.size) > MAX_LONG_SIDE:
            k = MAX_LONG_SIDE / float(max(im.size))
            im = im.resize((max(1, int(im.size[0] * k)), max(1, int(im.size[1] * k))), Image.LANCZOS)
        fname = "pptx-%03d.jpg" % i
        im.save(os.path.join(PHOTOS_DIR, fname), "JPEG", quality=JPEG_QUALITY, optimize=True)
        src = "%s, слайд %s" % (rec["deck"], ", ".join(str(s) for s in rec["slides"]) or "-")
        index.append({
            "id": "pptx-%03d" % i,
            "file": "photos/" + fname,
            "item": ann["item"],
            "verdict": ann["verdict"],
            "title_ru": ann["title_ru"],
            "caption_ru": ann["caption_ru"],
            "source": src,
            "w": im.size[0],
            "h": im.size[1],
        })

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    stats["selected"] = len(index)
    print(json.dumps(stats, ensure_ascii=False))
    for row in index:
        print(row["id"], "|", row["item"], "|", row["verdict"], "|", row["title_ru"], "|", row["source"])


if __name__ == "__main__":
    main()
