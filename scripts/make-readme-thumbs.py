#!/usr/bin/env python3
"""Center/left-bias square-crop README screenshots into docs/images/thumbs/."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / 'docs' / 'images'
OUT = ROOT / 'thumbs'
SIZE = 128
LEFT_BIAS = {
  'file-edit-toolbar.png',
  'token-usage-meter.png',
  'select-to-quote.png',
  'session-delete.png',
  'skills-mcp-left-nav.png',
}

# Wide short chrome (icon rows): pad to square so the whole strip stays visible.
PAD_SQUARE = {
  'soft-pause-action.png',
}


def square_crop(im: Image.Image, name: str) -> Image.Image:
  w, h = im.size
  if name in PAD_SQUARE:
    side = max(w, h)
    canvas = Image.new('RGBA', (side, side), (255, 255, 255, 255))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im if im.mode == 'RGBA' else None)
    return canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
  side = min(w, h)
  if w == h:
    box = (0, 0, w, h)
  elif w > h:
    left = max(0, min(w - side, (w - side) // 3)) if name in LEFT_BIAS else (w - side) // 2
    box = (left, 0, left + side, h)
  else:
    top = (h - side) // 2
    box = (0, top, w, top + side)
  return im.crop(box).resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main() -> None:
  OUT.mkdir(exist_ok=True)
  for path in sorted(ROOT.glob('*.png')):
    rgba = Image.open(path).convert('RGBA')
    thumb = square_crop(rgba, path.name)
    bg = Image.new('RGB', thumb.size, (255, 255, 255))
    bg.paste(thumb, mask=thumb.split()[-1])
    dest = OUT / path.name
    bg.save(dest, 'PNG', optimize=True)
    print(f'{path.name}: {rgba.size} -> thumbs/{path.name}')


if __name__ == '__main__':
  main()
