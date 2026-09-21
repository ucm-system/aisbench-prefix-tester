# -*- coding: utf-8 -*-
"""生成应用图标 desktop/build/icon.ico（与前端 AppIcon 同构：层叠块+命中闪电）。

层叠块 = 前缀缓存层（两道半透明白条），闪电 = 命中高亮（#fbbf24），
底为 #2f6ff0→#14b8a6 对角渐变圆角方块。输出 256/64/48/32/16 多尺寸 ICO。
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "desktop" / "build" / "icon.ico"
OUT.parent.mkdir(parents=True, exist_ok=True)


def make_256() -> Image.Image:
    img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    # 对角渐变底（纵向近似）+ 圆角遮罩
    grad = Image.new("RGBA", (256, 256))
    gd = ImageDraw.Draw(grad)
    for y in range(256):
        t = y / 255.0
        r = int(0x2F + (0x14 - 0x2F) * t)
        g = int(0x6F + (0xB8 - 0x6F) * t)
        b = int(0xF0 + (0xA6 - 0xF0) * t)
        gd.line([(0, y), (256, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (256, 256), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([6, 6, 250, 250], radius=58, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # 层叠块：两道半透明白条（上更实、下更虚 = 层叠纵深）
    d.rounded_rectangle([48, 104, 208, 136], radius=13, fill=(255, 255, 255, 210))
    d.rounded_rectangle([48, 152, 208, 184], radius=13, fill=(255, 255, 255, 132))
    # 命中闪电（与 AppIcon 32 视窗 M13 4l-4 8h4l-2 6 7-9h-4l3-5z 同形，×8）
    bolt = [(104, 30), (72, 96), (104, 96), (88, 146), (144, 70), (112, 70), (136, 30)]
    d.polygon(bolt, fill=(251, 191, 36, 255))
    return img


def main() -> None:
    base = make_256()
    base.save(OUT, format="ICO",
              sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
    print(f"written {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
