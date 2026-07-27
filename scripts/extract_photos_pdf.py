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
import numpy as np
import cv2
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
    # --- дополнение (2-й заход). Дописывать ТОЛЬКО в конец списка: нумерация
    # кандидатов сквозная и зависит от порядка, иначе поедут ссылки в curation.
    r"SAFA 2026\SAFA PPP ACIC 2026\Сп Док\Manual of SAFA findings an.pdf",
    r"SAFA 2026\SAFA PPP ACIC 2026\Сп Док\2010_Posobie1.pdf",
    r"SAFA 2026\SAFA PPP ACIC 2026\Сп Док\Контрольный лист проверки ВС Методика SAFA_Изм.4 (4).docx",
    r"SAFA 2026\SAFA PPP ACIC 2026\Сп Док\avoiding-the-pain-of-a-ramp-check.pdf",
    r"SAFA 2026\SAFA PPP ACIC 2026\Сп Док\BP_1(5).pdf",
    r"SAFA 2026\SAFA PPP ACIC 2026\Сп Док\20210114150815_87393.pdf",
    "об инcпектировании экспл ВТ_13 SAFA.pdf",
    "Inspecting instructions and PDFs - Issue 3 - Corrigendum 1.pdf",
    "rim_appendix1-inspections_instructions_pdfs-issue_5.1.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\0.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\0-1.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\1.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\2.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\3.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\4.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\5.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\6.pdf",
    r"Ramp Inspection Programme Dubai Apr 2015\Ramp Inspection Programme Dubai Apr 2015\7.pdf",
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
            "md5": h,
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


"""--- Учебный курс Dubai Apr 2015 --------------------------------------------
Эти PDF — сканы раздаточного материала: страница = 2 слайда, текстового слоя нет.
Встроенных картинок-фотографий там нет вообще, фото «вплавлены» в скан страницы.
Поэтому вырезаем слайд целиком: слайд сам подписан кодом пункта (A01, C04, …)
и подписью, что даёт готовый наглядный пример без ручной привязки.
"""
DUBAI_DIR = os.path.join(
    ROOT,
    "Ramp Inspection Programme Dubai Apr 2015",
    "Ramp Inspection Programme Dubai Apr 2015",
)
DUBAI_FILES = ["0.pdf", "0-1.pdf", "1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf",
               "6.pdf", "7.pdf"]
SLIDE_STAGE = os.path.join(STAGE, "slides")


def find_slides(pil):
    """Рамки слайдов на скане страницы (обычно 2 на страницу)."""
    a = np.array(pil.convert("L"))
    H, W = a.shape
    dark = (a < 140).astype(np.uint8) * 255
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w * h < 0.06 * W * H or w < 0.4 * W:
            continue
        if not (1.05 < w / float(h) < 2.0):
            continue
        out.append((x, y, w, h))
    out.sort(key=lambda b: b[1])
    return out


def upside_down(pil):
    """Часть страниц раздатки отсканирована вверх ногами. Опознаём по синей плашке
    логотипа EASA: в правильной ориентации она в верхней полосе слайда."""
    a = np.array(pil.convert("RGB"))
    b = max(1, int(0.16 * a.shape[0]))

    def blueness(x):
        hsv = cv2.cvtColor(x, cv2.COLOR_RGB2HSV)
        return float(
            ((hsv[:, :, 0] > 95) & (hsv[:, :, 0] < 130)
             & (hsv[:, :, 1] > 90) & (hsv[:, :, 2] > 60)).mean()
        )

    return blueness(a[-b:]) > blueness(a[:b]) * 1.5 + 0.002


def slide_scores(pil):
    """blk — доля «плотных» блоков (фото/таблица) под заголовком, col — их цветность,
    std — разброс яркости внутри блоков (отличает фото от плоской серой плашки)."""
    a = np.array(pil.convert("RGB"))
    H, W = a.shape[:2]
    roi = a[int(0.26 * H) : int(0.97 * H), int(0.02 * W) : int(0.98 * W)]
    g = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY)
    er = cv2.erode((g < 235).astype(np.uint8), np.ones((13, 13), np.uint8))
    n = int(er.sum())
    blk = n / float(er.size)
    if n == 0:
        return blk, 0.0, 0.0
    sat = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV)[:, :, 1]
    col = float(((sat > 60) & (er > 0)).sum()) / n
    std = float(g[er > 0].std())
    return blk, col, std


def has_content(blk, col, std):
    if blk < 0.20:
        return False
    return col >= 0.02 or std >= 25.0


def slides():
    """Режет сканы курса Dubai на слайды и оставляет те, где есть фото/скан документа."""
    os.makedirs(SLIDE_STAGE, exist_ok=True)
    meta, seen, idx = [], set(), 0
    for fn in DUBAI_FILES:
        path = os.path.join(DUBAI_DIR, fn)
        if not os.path.exists(path):
            print("НЕТ ФАЙЛА:", fn)
            continue
        doc = fitz.open(path)
        kept = 0
        for pno in range(len(doc)):
            imgs = doc[pno].get_images(full=True)
            if not imgs:
                continue
            try:
                d = doc.extract_image(imgs[0][0])
                page_img = Image.open(io.BytesIO(d["image"]))
                page_img.load()
            except Exception:
                continue
            for si, (x, y, w, h) in enumerate(find_slides(page_img)):
                sl = page_img.crop((x, y, x + w, y + h))
                if upside_down(sl):
                    sl = sl.rotate(180, expand=True)
                blk, col, std = slide_scores(sl)
                if not has_content(blk, col, std):
                    continue
                im = sl.convert("RGB")
                if max(im.size) > MAX_SIDE:
                    k = MAX_SIDE / float(max(im.size))
                    im = im.resize((int(im.width * k), int(im.height * k)),
                                   Image.LANCZOS)
                b = io.BytesIO()
                im.save(b, "JPEG", quality=JPEG_Q, optimize=True)
                hh = hashlib.md5(b.getvalue()).hexdigest()
                if hh in seen:
                    continue
                seen.add(hh)
                idx += 1
                name = "slide-%04d.jpg" % idx
                open(os.path.join(SLIDE_STAGE, name), "wb").write(b.getvalue())
                meta.append({
                    "cand": name, "md5": hh,
                    "src_file": "Dubai Apr 2015/" + fn,
                    "page": pno + 1, "slot": si,
                    "w": im.width, "h": im.height,
                    "blk": round(blk, 3), "col": round(col, 3),
                    "std": round(std, 1),
                })
                kept += 1
        print("   %-8s страниц %-4d слайдов с содержимым %d" % (fn, len(doc), kept))
        doc.close()
    with open(os.path.join(SLIDE_STAGE, "slides.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print("итого слайдов отобрано:", len(meta))


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
        if "Dubai" in rel:  # файлы называются 0.pdf…7.pdf — без папки не опознать
            src = "Dubai Apr 2015/" + src
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
    """curation.json: [{"cand","item","verdict","kind","title_ru","caption_ru"}] —
    только отобранные вручную записи; остальное отбрасывается.
    "cand" ссылается либо на кандидата из candidates.json (растровые картинки,
    лежат в STAGE), либо на слайд курса Dubai из slides/slides.json.
    Необязательное поле "rotate" — доворот скана в градусах (сканы раздатки
    местами перевёрнуты, автоматика ловит не всё)."""
    # отбор человеком хранится рядом со скриптом (в репозитории), иначе — в STAGE
    cur_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "curation-pdf.json")
    if not os.path.exists(cur_path):
        cur_path = os.path.join(STAGE, "curation.json")
    cands, where = {}, {}
    for c in json.load(open(os.path.join(STAGE, "candidates.json"), encoding="utf-8")):
        cands[c["cand"]] = c
        where[c["cand"]] = STAGE
    sl = os.path.join(SLIDE_STAGE, "slides.json")
    if os.path.exists(sl):
        for c in json.load(open(sl, encoding="utf-8")):
            cands[c["cand"]] = c
            where[c["cand"]] = SLIDE_STAGE
    cur = json.load(open(cur_path, encoding="utf-8"))
    photos_dir = os.path.join(PROJ, "photos")
    os.makedirs(photos_dir, exist_ok=True)
    index = []
    for i, rec in enumerate(cur, 1):
        c = cands[rec["cand"]]
        im = Image.open(os.path.join(where[rec["cand"]], rec["cand"])).convert("RGB")
        if rec.get("rotate"):
            im = im.rotate(rec["rotate"], expand=True)
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
                "kind": rec.get("kind", "photo"),  # photo | scheme
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
    {"stage": stage, "slides": slides, "build": build}[mode]()
