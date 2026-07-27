# -*- coding: utf-8 -*-
"""
Извлечение фотопримеров несоответствий для SAFA Inspector из PDF/DOCX-руководств
по перронным инспекциям.

Два режима:
  python extract_photos_pdf.py stage   — извлечь растровые изображения постранично,
                                         отсеять мусор, снять текст страницы,
                                         сложить кандидатов в staging-папку + candidates.json
  python extract_photos_pdf.py build   — по файлу curation.json (правки item/verdict/
                                         title_ru/caption_ru) собрать photos/pdf-NNN.jpg
                                         и data/photos-pdf.json

Требуется: pymupdf, pillow.
Кодировка вывода: PYTHONIOENCODING=utf-8
"""
import os, sys, io, json, re, hashlib, zipfile

import fitz  # pymupdf
from PIL import Image

ROOT = r"C:\Users\user\Desktop\SSD 2025\01 Работа\Надзор (Oversight)\7 SAFA"
PROJ = r"C:\Users\user\Claude\Projects\safa-inspector"
STAGE = os.path.join(
    os.environ.get("TEMP", os.path.join(PROJ, "scripts")), "safa_stage"
)

SOURCES = [
    "the_ramp_inspection_manual_-_issue_4.pdf",
    "RIM v3.pdf",
    "rim_appendix1-inspections_instructions_pdfs-issue_6.pdf",
    "SAFA Ramp inspections Guidance material v2.0.pdf",
    "Методическое пособие SAFA НАВ 2016.pdf",
    r"SAFA 2026\SAFA PPP ACIC 2026\PPSAFA\SAFA PPP ACIC 2024\2026 Справочник SAFA инспектора.pdf",
    r"SAFA 2026\SAFA PPP ACIC 2026\Сп Док\2024 Довідник SAFA інспектора.docx",
    r"SAFA 2026\SAFA PPP ACIC 2026\PPSAFA\SAFA PPP ACIC 2024\ICAO-SAFA-Ramp-Inspections-Part 1 RI ICAO NAU-страницы.pdf",
    r"SAFA 2026\SAFA PPP ACIC 2026\PPSAFA\SAFA PPP ACIC 2024\ICAO-SAFA-Ramp-Inspections-Part 2 RI ICAO NAU-страницы.pdf",
]

MIN_W = MIN_H = 300
MIN_BYTES = 25 * 1024
MAX_SIDE = 1200
JPEG_Q = 78


def norm_text(t):
    t = re.sub(r"[ \t\xa0]+", " ", t or "")
    t = re.sub(r"\n{2,}", "\n", t)
    return t.strip()


def is_flat(img):
    """Признак плоской графики (логотип, эмблема, заливка): мало уникальных цветов.
    Используется как МЯГКИЙ флаг — фото документа тоже почти белое, поэтому
    жёстко не отсекаем, окончательный отбор делает человек при кураторстве."""
    small = img.convert("RGB").resize((64, 64))
    cols = small.getcolors(64 * 64)
    if cols is None:
        return False
    return len(cols) < 120


def save_candidate(idx, pil, src, page, text, out, seen, raw=None):
    # дедупликация по содержимому — сквозная по всем файлам (RIM Issue 4 и RIM v3
    # это редакции одного руководства, эмблемы повторяются на каждой странице)
    if raw is None:
        buf = io.BytesIO()
        pil.convert("RGB").save(buf, "PNG")
        raw = buf.getvalue()
    h = hashlib.md5(raw).hexdigest()
    if h in seen:
        seen[h].append("%s p.%s" % (src, page))
        return None
    seen[h] = ["%s p.%s" % (src, page)]
    name = "cand-%04d.jpg" % idx
    im = pil.convert("RGB")
    if max(im.size) > MAX_SIDE:
        k = MAX_SIDE / float(max(im.size))
        im = im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS)
    im.save(os.path.join(STAGE, name), "JPEG", quality=JPEG_Q, optimize=True)
    out.append(
        {
            "cand": name,
            "src_file": src,
            "page": page,
            "w": im.width,
            "h": im.height,
            "text": text[:1800],
        }
    )
    return name


def extract_pdf(path, src, out, seen, counter):
    doc = fitz.open(path)
    for pno in range(len(doc)):
        page = doc[pno]
        try:
            text = norm_text(page.get_text())
        except Exception:
            text = ""
        for info in page.get_images(full=True):
            xref = info[0]
            try:
                d = doc.extract_image(xref)
            except Exception:
                continue
            raw = d["image"]
            if len(raw) < MIN_BYTES:
                continue
            try:
                pil = Image.open(io.BytesIO(raw))
                pil.load()
            except Exception:
                continue
            if pil.width < MIN_W or pil.height < MIN_H:
                continue
            ar = pil.width / float(pil.height)
            if ar > 4 or ar < 0.25:  # полосы/линейки
                continue
            if is_flat(pil):
                continue
            counter[0] += 1
            save_candidate(counter[0], pil, src, pno + 1, text, out, seen, raw)
    doc.close()


def extract_docx(path, src, out, seen, counter):
    """DOCX = zip; картинки в word/media/, контекст — весь текст документа
    привязан по порядку следования r:embed в document.xml."""
    z = zipfile.ZipFile(path)
    rels = {}
    rx = z.read("word/_rels/document.xml.rels").decode("utf-8", "ignore")
    for m in re.finditer(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rx):
        rels[m.group(1)] = m.group(2)
    xml = z.read("word/document.xml").decode("utf-8", "ignore")
    # разбиваем документ на параграфы, копим текст-контекст вокруг картинок
    paras = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
    ctx = []
    for i, p in enumerate(paras):
        txt = norm_text(" ".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S)))
        embeds = re.findall(r'r:embed="([^"]+)"', p)
        ctx.append((txt, embeds))
    for i, (txt, embeds) in enumerate(ctx):
        for rid in embeds:
            tgt = rels.get(rid)
            if not tgt:
                continue
            zn = "word/" + tgt.replace("\\", "/").lstrip("/")
            try:
                raw = z.read(zn)
            except KeyError:
                continue
            if len(raw) < MIN_BYTES:
                continue
            try:
                pil = Image.open(io.BytesIO(raw))
                pil.load()
            except Exception:
                continue
            if pil.width < MIN_W or pil.height < MIN_H:
                continue
            ar = pil.width / float(pil.height)
            if ar > 4 or ar < 0.25:
                continue
            if is_flat(pil):
                continue
            around = " ".join(
                t for t, _ in ctx[max(0, i - 6) : i + 7] if t
            )
            counter[0] += 1
            save_candidate(
                counter[0], pil, src, "п.%d" % (i + 1), around, out, seen, raw
            )
    z.close()


def stage():
    os.makedirs(STAGE, exist_ok=True)
    out, seen, counter = [], {}, [0]
    files = 0
    for rel in SOURCES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print("НЕТ ФАЙЛА:", rel)
            continue
        files += 1
        src = os.path.basename(rel)
        print("...", src)
        if path.lower().endswith(".docx"):
            extract_docx(path, src, out, seen, counter)
        else:
            extract_pdf(path, src, out, seen, counter)
    dup = {k: v for k, v in seen.items() if len(v) > 1}
    with open(os.path.join(STAGE, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("файлов обработано:", files)
    print("кандидатов после фильтра:", len(out))
    print("уникальных хэшей с повторами:", len(dup))


def build():
    """curation.json: [{"cand","item","verdict","title_ru","caption_ru"}] — только
    отобранные вручную записи; остальное отбрасывается."""
    # отбор человеком хранится рядом со скриптом (в репозитории), иначе — в STAGE
    cur_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "curation-pdf.json")
    if not os.path.exists(cur_path):
        cur_path = os.path.join(STAGE, "curation.json")
    cands = {
        c["cand"]: c
        for c in json.load(open(os.path.join(STAGE, "candidates.json"), encoding="utf-8"))
    }
    cur = json.load(open(cur_path, encoding="utf-8"))
    photos_dir = os.path.join(PROJ, "photos")
    os.makedirs(photos_dir, exist_ok=True)
    index = []
    for i, rec in enumerate(cur, 1):
        c = cands[rec["cand"]]
        im = Image.open(os.path.join(STAGE, rec["cand"])).convert("RGB")
        if max(im.size) > MAX_SIDE:
            k = MAX_SIDE / float(max(im.size))
            im = im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS)
        fname = "pdf-%03d.jpg" % i
        im.save(os.path.join(photos_dir, fname), "JPEG", quality=JPEG_Q, optimize=True)
        pg = c["page"]
        index.append(
            {
                "id": "pdf-%03d" % i,
                "file": "photos/" + fname,
                "item": rec.get("item"),
                "verdict": rec.get("verdict"),
                "title_ru": rec.get("title_ru", ""),
                "caption_ru": rec.get("caption_ru", ""),
                "source": "%s, с. %s" % (c["src_file"], pg)
                if str(pg).isdigit()
                else "%s, %s" % (c["src_file"], pg),
                "w": im.width,
                "h": im.height,
            }
        )
    with open(
        os.path.join(PROJ, "data", "photos-pdf.json"), "w", encoding="utf-8"
    ) as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print("записей в photos-pdf.json:", len(index))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "stage"
    {"stage": stage, "build": build}[mode]()
