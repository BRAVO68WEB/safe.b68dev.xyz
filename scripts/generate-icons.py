#!/usr/bin/env python3
"""
Generate icon and image variants from a source PNG.

Icons get rounded corners (modern PWA/iOS style).
Logos are resized as-is (preserving source shape).

Usage:
    python3 scripts/generate-icons.py [source.png]

Defaults to e271acf52f0f376ebe5031088f23f4fe.png in the project root.
"""

import sys
import os
from PIL import Image, ImageDraw

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SOURCE = os.path.join(PROJECT_ROOT, "e271acf52f0f376ebe5031088f23f4fe.png")
ICONS_DIR = os.path.join(PROJECT_ROOT, "public", "icons")
IMAGES_DIR = os.path.join(PROJECT_ROOT, "public", "images")

BG_COLOR = (35, 38, 41)  # #232629 — matches theme_color


def add_rounded_corners(img: Image.Image, radius_pct: float = 0.22) -> Image.Image:
    """Apply rounded corners to an RGBA image. radius_pct = fraction of size."""
    size = img.size[0]
    radius = int(size * radius_pct)
    img = img.convert("RGBA")

    # Create a rounded rectangle mask
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (img.size[0] - 1, img.size[1] - 1)],
                           radius=radius, fill=255)

    # Apply mask to alpha channel
    r, g, b, a = img.split()
    a = Image.composite(a, Image.new("L", img.size, 0), mask)
    img = Image.merge("RGBA", (r, g, b, a))
    return img


def resize_icon_rounded(source: Image.Image, size: int, mode: str) -> Image.Image:
    """Resize source to a square icon with rounded corners."""
    img = source.copy()
    img = img.resize((size, size), Image.LANCZOS)
    img = add_rounded_corners(img)

    if mode == "RGB":
        bg = Image.new("RGB", (size, size), BG_COLOR)
        bg.paste(img, mask=img.split()[3])
        return bg
    return img


def resize_wide_rounded(source: Image.Image, w: int, h: int) -> Image.Image:
    """Center-crop to target aspect ratio, resize, add rounded corners."""
    src = source.copy()
    src_w, src_h = src.size
    target_ratio = w / h
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:
        new_w = int(src_h * target_ratio)
        left = (src_w - new_w) // 2
        src = src.crop((left, 0, left + new_w, src_h))
    else:
        new_h = int(src_w / target_ratio)
        top = (src_h - new_h) // 2
        src = src.crop((0, top, src_w, top + new_h))
    src = src.resize((w, h), Image.LANCZOS)
    src = add_rounded_corners(src, radius_pct=0.1)
    bg = Image.new("RGB", (w, h), BG_COLOR)
    bg.paste(src, mask=src.split()[3])
    return bg


def resize_logo(source: Image.Image, size: int, mode: str) -> Image.Image:
    """Resize source as a logo — fit within the size, preserving original shape."""
    img = source.copy()
    img.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = ((size - img.size[0]) // 2, (size - img.size[1]) // 2)
    canvas.paste(img, offset, img if img.mode == "RGBA" else None)
    if mode == "RGB":
        bg = Image.new("RGB", (size, size), BG_COLOR)
        bg.paste(canvas, mask=canvas.split()[3])
        return bg
    return canvas


def make_fb_share(source: Image.Image) -> Image.Image:
    """Create 1200x630 Facebook share image with logo centered on themed background."""
    w, h = 1200, 630
    bg = Image.new("RGB", (w, h), BG_COLOR)
    logo = source.copy()
    max_logo = int(min(w, h) * 0.6)
    logo.thumbnail((max_logo, max_logo), Image.LANCZOS)
    offset = ((w - logo.size[0]) // 2, (h - logo.size[1]) // 2)
    bg.paste(logo, offset, logo if logo.mode == "RGBA" else None)
    return bg


def main():
    source_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not os.path.exists(source_path):
        print(f"Error: Source image not found: {source_path}")
        sys.exit(1)

    source = Image.open(source_path).convert("RGBA")
    print(f"Source: {source.size[0]}x{source.size[1]} ({source.mode})")
    print()

    # --- ICONS (with rounded corners) ---
    icons = [
        ("32pxr.png",   32,  "RGBA"),
        ("70px.png",    70,  "RGB"),
        ("96pxr.png",   96,  "RGBA"),
        ("120px.png",  120,  "RGB"),
        ("152px.png",  152,  "RGB"),
        ("167px.png",  167,  "RGB"),
        ("180px.png",  180,  "RGB"),
        ("192pxr.png", 192,  "RGBA"),
        ("270px.png",  270,  "RGB"),
        ("310px.png",  310,  "RGB"),
        ("384pxr.png", 384,  "RGBA"),
        ("512pxr.png", 512,  "RGBA"),
        ("600px.png",  600,  "RGB"),
        ("600pxr.png", 600,  "RGBA"),
    ]

    print("Generating icons (rounded corners)...")
    for name, size, mode in icons:
        out = resize_icon_rounded(source, size, mode)
        path = os.path.join(ICONS_DIR, name)
        out.save(path, "PNG")
        print(f"  {name}: {size}x{size} {mode}")

    # Wide tile (rounded)
    out = resize_wide_rounded(source, 310, 150)
    out.save(os.path.join(ICONS_DIR, "310pxw.png"), "PNG")
    print(f"  310pxw.png: 310x150 RGB (rounded)")

    # --- LOGOS (preserve original shape, no forced rounding) ---
    logos = [
        ("logo.png",        425, "RGBA"),
        ("logo_big.png",    600, "RGBA"),
        ("logo_smol.png",   200, "RGBA"),
        ("logo_smol@2x.png", 400, "RGBA"),
        ("logo_square.png", 425, "RGB"),
    ]

    print()
    print("Generating logos (preserving shape)...")
    for name, size, mode in logos:
        out = resize_logo(source, size, mode)
        path = os.path.join(IMAGES_DIR, name)
        out.save(path, "PNG")
        print(f"  {name}: {size}x{size} {mode}")

    # Facebook share image
    out = make_fb_share(source)
    out.save(os.path.join(IMAGES_DIR, "fb_share.png"), "PNG")
    print(f"  fb_share.png: 1200x630 RGB")

    print()
    print("Done! Generated all icon and image variants.")
    print(f"Icons:  {len(icons) + 1} files in {ICONS_DIR}")
    print(f"Images: {len(logos) + 1} files in {IMAGES_DIR}")


if __name__ == "__main__":
    main()
