#!/usr/bin/env python3
"""
Normalizador de marcas para los 5 proveedores y extractor de marcas para Paternal SRL.
"""
import re
import html

BRAND_ALIASES = {
    "MH CONDUCTORES ELÉCTRICOS": "MH",
    "MH CONDUCTORES ELECTRICOS": "MH",
    "MH CONDUCTORES": "MH",
    "M.H. INDUSTRIAS": "MH",
    "M.H INDUSTRIAS": "MH",
    "MH INDUSTRIAS": "MH",
    "M.H.": "MH",
    "M.H": "MH",
    "CONDUCOM SA": "CONDUCOM",
    "CONDUCOM S.A.": "CONDUCOM",
    "GEN ROD": "GENROD",
    "GEN-ROD": "GENROD",
    "SCHNEIDER ELECTRIC": "SCHNEIDER",
    "SCHNEIDER M.G": "SCHNEIDER",
    "SCHNEIDER - TLM": "SCHNEIDER",
    "TELEMECANIQUE": "SCHNEIDER",
    "MERLIN GERIN": "SCHNEIDER",
    "DEXSON": "SCHNEIDER",
    "OSRAM - LEDVANCE": "LEDVANCE",
    "RADIUM BY LEDVANCE": "LEDVANCE",
    "OSRAM": "LEDVANCE",
    "X 28": "X-28",
    "X28": "X-28",
    "AG METALÚRGICA": "AG METALURGICA",
    "A.G. METALÚRGICA": "AG METALURGICA",
    "A.G METALURGICA": "AG METALURGICA",
    "EPUYÉN": "EPUYEN",
    "PERCAN‑PLAST": "PERCAN PLAST",
    "PERCAN-PLAST": "PERCAN PLAST",
    "HELLERMANNTYTON": "HELLERMANN",
    "HELLERMANN TYTON": "HELLERMANN",
    "DAZ CONDUCTORES": "DAZ",
    "SCAME ARGENTINA": "SCAME",
    "3M ARGENTINA": "3M",
    "WEIDMÜLLER": "WEIDMULLER",
    "SPOTSLINE": "SPOTS LINE",
    "GSG DESIGN": "GSG",
    "MARKAS ILUMINACIÓN": "MARKAS",
    "MARKAS ILUMINACION": "MARKAS",
    "J.A": "JA",
    "J.A.": "JA",
    "A.E": "AE",
    "A.E.": "AE",
}

KNOWN_BRANDS = [
    "MH CONDUCTORES ELÉCTRICOS", "MH CONDUCTORES ELECTRICOS", "MH CONDUCTORES",
    "M.H. INDUSTRIAS", "M.H INDUSTRIAS", "MH INDUSTRIAS", "CONDUCOM SA",
    "SCHNEIDER ELECTRIC", "SCHNEIDER M.G", "SCHNEIDER - TLM", "OSRAM - LEDVANCE",
    "RADIUM BY LEDVANCE", "HELLERMANN TYTON", "HELLERMANNTYTON", "AG METALÚRGICA",
    "AG METALURGICA", "DAZ CONDUCTORES", "PERCAN‑PLAST", "PERCAN-PLAST", "PERCAN PLAST",
    "MARKAS ILUMINACIÓN", "MARKAS ILUMINACION", "GSG DESIGN", "GEN ROD", "GAMA SONIC",
    "PLASTICOS INBI", "LIGHT HOUSE", "SPOTS LINE", "SPOTSLINE", "STAND BY",
    "SCHNEIDER", "SIEMENS", "ABB", "PRYSMIAN", "CAMBRE", "JELUZ", "KALOP", "TECLASTAR",
    "SICA", "BAW", "CHINT", "GENROD", "CONEXTUBE", "ZOLODA", "ROKER", "GABEXEL",
    "MACROLED", "LEDVANCE", "OSRAM", "PHILIPS", "CANDELA", "INTERELEC", "FERROLUX",
    "LUMENAC", "TBCIN", "SCAME", "STECK", "WEIDMULLER", "FINDER", "LOVATO", "WEG",
    "CIRCUTOR", "FLUKE", "UNI-T", "BAHCO", "STANLEY", "BULIT", "BREMEN", "3M",
    "TACSA", "FISCHER", "SUPRABOND", "POXIPOL", "HELLERMANN", "LCT", "PYL", "SAMET",
    "FORLI", "RICHI", "ELIBET", "TRV", "COMMAX", "X-28", "X 28", "FONSECA", "IMSA",
    "ARGENPLAS", "EPUYEN", "EPUYÉN", "SONOFF", "CONFLEX", "TREFILCON", "CONDUCOM", "DAISA",
    "TREFILIGHT", "DAZ", "LEYDEN", "SUYE", "UBEMO", "PORCELUZ", "TECNOCOM", "CANDIL",
    "WAGO", "ELENT", "VEFBEN", "PRACTILED", "INTECK", "MAGNOLUZ", "SIMALED", "FLEXITUB",
    "CODESIL", "CLIPSAL", "MILWAUKEE", "JADEVER", "DEWALT", "BOSCH", "MAKITA",
    "ENERGIZER", "DURACELL", "PAMPACO", "SASSIN", "FAMATEL", "TUBOFLEX", "MILANO",
    "VIYILANT", "ROLUX", "NIAN", "TOOLMEN", "TEKOX", "ABROND", "LEFKAS", "COPPERWELD",
    "ETELEC", "SISAGRIP", "AIRMAX", "AMPROBE", "BELLALUX", "ECOSPOTS", "TAAD",
    "PADILUM", "CEDIFE", "DILOC", "KRAFTEK", "BIOSEIF", "BLOOK", "MEGASION", "LIMERO",
    "ACERTUBO", "OVRA", "NECTRONICS", "GSG", "DABOR", "BAEL", "MARKAS", "MELTEC",
    "RONDA", "YARLUX", "ROMAX", "FAROLUZ", "ARTELUM", "PRONEXT", "M.H.", "M.H",
]

SEARCH_BRANDS = sorted(set(KNOWN_BRANDS) | set(BRAND_ALIASES.keys()), key=len, reverse=True)
BRAND_REGEX = re.compile(
    r"(?<![A-ZÁÉÍÓÚ0-9])(" + "|".join(re.escape(b) for b in SEARCH_BRANDS) + r")(?![A-ZÁÉÍÓÚ0-9])",
    re.I,
)


def canon_brand(b: str) -> str:
    b = re.sub(r"[\u200b-\u200d\ufeff]", "", b or "").strip(" .,;:-–—\"'()[]").upper()
    b = re.sub(r"\s+", " ", b)
    if b in ("VARIOS", "GENERICO", "GENÉRICO", "IMPORTADO", "NORMALIZADO", "SIN MARCA"):
        return b
    return BRAND_ALIASES.get(b, b)


def extract_brand_from_product(name: str, categories_text: str, short_desc: str = "", desc: str = "", existing_brand: str = "") -> str:
    if existing_brand and existing_brand.strip():
        cb = canon_brand(existing_brand)
        if cb not in ("", "VARIOS", "ELECTROCITY"):
            return cb

    # 1. Buscar en título + categorías
    head = html.unescape(f" {name or ''} | {categories_text or ''} ")
    m = BRAND_REGEX.search(head)
    if m:
        return canon_brand(m.group(1))

    # Caso especial: "Cable ... Mh " en título
    if re.search(r"\bMH\b", head, re.I):
        return "MH"

    # 2. Buscar en descripción ("de la marca X", "marca X", o marca conocida en descripción)
    raw_desc = html.unescape(f"{short_desc or ''} {desc or ''}")
    clean_desc = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw_desc)).strip()
    if clean_desc:
        m = BRAND_REGEX.search(clean_desc)
        if m:
            return canon_brand(m.group(1))
        m2 = re.search(
            r"\b(?:de la marca|marca)\s+([A-ZÁÉÍÓÚ0-9][A-Za-zÁÉÍÓÚáéíóú0-9\.\-\s]{1,28}?)(?:\s+(?:es|está|perteneciente|ofrece|se|permite|garantiza|combina|cuenta|diseñad|fabricad|ideal|para|con|en|que)\b|[,.;:])",
            clean_desc,
        )
        if m2:
            cand = canon_brand(m2.group(1))
            if 2 <= len(cand) <= 25:
                return cand

    return canon_brand(existing_brand) if existing_brand else ""
