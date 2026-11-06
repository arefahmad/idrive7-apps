#!/usr/bin/env python3
"""
bake_fonts.py - bakes a TrueType font into the kit's glyph-atlas format (kit/runtime/fonts.js), for an
app to register as its own font (fonts.register(name, json)).

    python3 tools/bake_fonts.py <font.ttf> <family name> <out.json> <size> [<size> ...]

The format, as the kit's own atlases: { family, source, cacheKey, sizes: [{ size, ascent, descent,
atlasW, atlasH, alpha (zlib, base64: one byte per pixel), glyphs: { codepoint: [x, y, w, h, ox, oy, adv] } }] }
with x, y, w, h the glyph's box in the atlas, ox, oy its offset from the pen on the baseline (oy < 0 is
above it) and adv the pen's advance. The text drawn needs no kerning (the kit draws glyph by glyph).

Characters: printable ASCII, Latin-1, and the quotes, dashes and dots lyrics use. Not installed on the car.
"""
import base64, hashlib, json, os, sys, zlib
from PIL import Image, ImageDraw, ImageFont

CHARS = [c for c in range(32, 127)] + [c for c in range(160, 256)] + [0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026, 0x2022, 0x00B7, 0x2122]
ATLAS_W = 1024
PAD = 1


def bake(ttf, size):
    font = ImageFont.truetype(ttf, size)
    asc, desc = font.getmetrics()
    boxes = []
    for cp in CHARS:
        ch = chr(cp)
        adv = round(font.getlength(ch), 2)
        l, t, r, b = font.getbbox(ch, anchor='ls')
        boxes.append((cp, ch, l, t, r - l, b - t, adv))
    # shelf packing, tallest first
    order = sorted(boxes, key=lambda g: -g[5])
    x = y = shelf = 0
    place = {}
    for cp, ch, l, t, w, h, adv in order:
        if w <= 0 or h <= 0:
            place[cp] = (0, 0, 0, 0)
            continue
        if x + w + PAD > ATLAS_W:
            x = 0; y += shelf + PAD; shelf = 0
        place[cp] = (x, y, w, h)
        x += w + PAD; shelf = max(shelf, h)
    H = y + shelf + PAD
    atlas = Image.new('L', (ATLAS_W, H), 0)
    d = ImageDraw.Draw(atlas)
    glyphs = {}
    for cp, ch, l, t, w, h, adv in boxes:
        gx, gy, gw, gh = place[cp]
        if gw:
            d.text((gx - l, gy - t), ch, font=font, fill=255, anchor='ls')
        glyphs[str(cp)] = [gx, gy, gw, gh, l if gw else 0, t if gw else 0, adv]
    alpha = base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode('ascii')
    return {'size': size, 'ascent': asc, 'descent': desc, 'atlasW': ATLAS_W, 'atlasH': H, 'alpha': alpha, 'glyphs': glyphs}


def main():
    if len(sys.argv) < 5:
        print(__doc__); sys.exit(2)
    ttf, family, out, sizes = sys.argv[1], sys.argv[2], sys.argv[3], [int(s) for s in sys.argv[4:]]
    j = {'family': family, 'source': os.path.basename(ttf), 'sizes': [bake(ttf, s) for s in sizes]}
    j['cacheKey'] = family + '-' + hashlib.sha1(json.dumps(j['sizes'], sort_keys=True).encode()).hexdigest()[:10]
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    with open(out, 'w') as f:
        json.dump(j, f, separators=(',', ':'))
    print('wrote %s: %s, sizes %s, %d KB' % (out, family, sizes, os.path.getsize(out) // 1024))


if __name__ == '__main__':
    main()
