#!/usr/bin/env python3
"""Generate FriedLiver's branding for the VS Code fork from build/icon.png and build/liver-art.svg.

    python3 code/branding/make-branding.py      (needs Pillow)

Output mirrors the upstream tree under code/branding/overlay/; prepare.mjs copies it
over the upstream checkout, replacing VS Code's icons, installer pictures and the
empty-editor watermark. The generated files are committed, so builds need no Pillow.
"""

import re
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUT = HERE / 'overlay'
ICON = Image.open(REPO / 'build' / 'icon.png').convert('RGBA')

# Black Blue: ground behind the installer pictures, panel for the small header picture.
GROUND = (6, 10, 18)
WHITE = (255, 255, 255)


def save(img: Image.Image, rel: str, **kw) -> None:
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, **kw)
    print('wrote', rel)


def icon(size: int) -> Image.Image:
    return ICON.resize((size, size), Image.LANCZOS)


def on(background, size, icon_size, top=None) -> Image.Image:
    """The icon centered (or at `top`) on a solid background, flattened to RGB for BMP."""
    w, h = size
    canvas = Image.new('RGB', size, background)
    mark = icon(icon_size)
    y = (h - icon_size) // 2 if top is None else top
    canvas.paste(mark, ((w - icon_size) // 2, y), mark)
    return canvas


# Windows: the app and file icon, Start menu tiles.
save(ICON, 'resources/win32/code.ico', sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)])
save(icon(150), 'resources/win32/code_150x150.png')
save(icon(70), 'resources/win32/code_70x70.png')

# Windows installer (Inno Setup) pictures, one per display scale: a tall one on the
# welcome page and a small one in the header of the other pages.
BIG = {100: (164, 314), 125: (192, 386), 150: (246, 459), 175: (273, 556), 200: (328, 604), 225: (355, 700), 250: (410, 797)}
SMALL = {100: (55, 55), 125: (64, 68), 150: (83, 80), 175: (92, 97), 200: (110, 106), 225: (119, 123), 250: (138, 140)}
for scale, (w, h) in BIG.items():
    save(on(GROUND, (w, h), int(w * 0.78), top=int(h * 0.18)), f'resources/win32/inno-big-{scale}.bmp')
for scale, (w, h) in SMALL.items():
    save(on(WHITE, (w, h), int(min(w, h) * 0.9)), f'resources/win32/inno-small-{scale}.bmp')

# macOS app icon.
save(ICON, 'resources/darwin/code.icns', sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])

# Server and web builds.
save(icon(192), 'resources/server/code-192.png')
save(icon(512), 'resources/server/code-512.png')
save(ICON, 'resources/server/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])

# Empty-editor watermark: the liver's silhouette and steam, in upstream's letterpress style
# (black at 30 % on dark themes, 10 % on light, solid greys for high contrast).
art = (REPO / 'build' / 'liver-art.svg').read_text()
liver = re.search(r'<path id="fl-liver-path" d="([^"]+)"', art).group(1)
steam = re.findall(r'<path d="(M\d+ \d+ C[^"]+)"/>', art.split('<!-- Steam')[1].split('</g>')[0])
assert steam, 'steam paths not found in liver-art.svg'


def letterpress(fill: str, opacity: str | None) -> str:
    op = f' opacity="{opacity}"' if opacity else ''
    lines = ''.join(f'<path d="{d}"/>' for d in steam)
    return (
        f'<svg width="260" height="260" viewBox="170 60 760 700"{op} xmlns="http://www.w3.org/2000/svg">'
        f'<path d="{liver}" fill="{fill}"/>'
        f'<g fill="none" stroke="{fill}" stroke-width="22" stroke-linecap="round">{lines}</g>'
        '</svg>\n'
    )


media = 'src/vs/workbench/browser/parts/editor/media'
for name, fill, opacity in (('dark', '#000000', '0.3'), ('light', '#000000', '0.1'), ('hcDark', '#3C3C3C', None), ('hcLight', '#D9D9D9', None)):
    path = OUT / media / f'letterpress-{name}.svg'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(letterpress(fill, opacity))
    print('wrote', f'{media}/letterpress-{name}.svg')
