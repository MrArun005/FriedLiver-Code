"""Outline FriedLiver's stroke glyphs and pack them into a woff2 (called by scripts/build-icon-font.mjs).

stdin: {"grid": 16, "stroke": 1.5, "glyphs": [{"name", "codepoint", "d", "fill"?}]}; argv[1]: the woff2 to write.
Deps (hash-locked): scripts/icon-font-requirements.txt. Output is deterministic (fixed timestamps).
"""
import json
import sys

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path

UPM = 1024
EPOCH = 0x86A9_2000  # 2026-01-01 in seconds since 1904; never "now", so builds are byte-identical


def to_path(d, scale):
    path = pathops.Path()
    # SVG y points down, font y up; the 16 grid fills the em square.
    parse_path(d, TransformPen(path.getPen(), (scale, 0, 0, -scale, 0, UPM)))
    return path


def outline(glyph, grid, stroke):
    scale = UPM / grid
    path = to_path(glyph["d"], scale)
    path.stroke(stroke * scale, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
    path.convertConicsToQuads()  # round caps and joins come back as conics
    if glyph.get("fill"):
        path = pathops.op(path, to_path(glyph["fill"], scale), pathops.PathOp.UNION)
    return pathops.simplify(path, clockwise=False)


def main():
    spec = json.load(sys.stdin)
    names = [".notdef"] + [g["name"] for g in spec["glyphs"]]
    fb = FontBuilder(UPM, isTTF=False)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({g["codepoint"]: g["name"] for g in spec["glyphs"]})
    charstrings = {".notdef": T2CharStringPen(UPM, None).getCharString()}
    for g in spec["glyphs"]:
        pen = T2CharStringPen(UPM, None)
        outline(g, spec["grid"], spec["stroke"]).draw(pen)
        charstrings[g["name"]] = pen.getCharString()
    fb.setupCFF("FriedLiverIcons-Regular", {"FullName": "FriedLiver Icons"}, charstrings, {})
    fb.setupHorizontalMetrics({n: (UPM, 0) for n in names})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({"familyName": "FriedLiver Icons", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, usWinAscent=UPM, usWinDescent=0)
    fb.setupPost()
    fb.updateHead(created=EPOCH, modified=EPOCH)
    fb.font.recalcTimestamp = False
    fb.font.flavor = "woff2"
    fb.save(sys.argv[1])


if __name__ == "__main__":
    main()
