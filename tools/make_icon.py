# -*- coding: utf-8 -*-
"""生成应用图标 desktop/build/icon.ico —— 经典 PC 徽标。

与前端 logo-mark 同构：135° 渐变（#2b7fff → #13c2c2）圆角方块 + 白色粗体 PC。
输出 256/64/48/32/16 多尺寸 ICO，用于 exe / 安装器 / 任务栏 / 开始菜单。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "desktop" / "build" / "icon.ico"
OUT.parent.mkdir(parents=True, exist_ok=True)

C0 = (0x2B, 0x7F, 0xFF)   # 渐变起点（左上）
C1 = (0x13, 0xC2, 0xC2)   # 渐变终点（右下）
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",   # Segoe UI Bold
    r"C:\Windows\Fonts\arialbd.ttf",    # Arial Bold
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_256() -> Image.Image:
    n = 256
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    # 135° 对角渐变（左上 #2b7fff → 右下 #13c2c2）+ 圆角遮罩
    # （旧 .logo-mark：30px 盒 9px 圆角 ≈ 30%）
    grad = Image.new("RGBA", (n, n))
    px = grad.load()
    span = 2 * n - 2
    for y in range(n):
        for x in range(n):
            t = (x + y) / span
            px[x, y] = (int(C0[0] + (C1[0] - C0[0]) * t),
                        int(C0[1] + (C1[1] - C0[1]) * t),
                        int(C0[2] + (C1[2] - C0[2]) * t), 255)
    mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([4, 4, n - 4, n - 4], radius=76, fill=255)
    img.paste(grad, (0, 0), mask)
    # 白色粗体 PC（13px/30px 盒 ≈ 43% 字高）
    d = ImageDraw.Draw(img)
    font = load_font(112)
    bbox = d.textbbox((0, 0), "PC", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((n - w) / 2 - bbox[0], (n - h) / 2 - bbox[1] - 4), "PC",
           font=font, fill=(255, 255, 255, 255))
    return img


def main() -> None:
    base = make_256()
    base.save(OUT, format="ICO",
              sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
    print(f"written {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
