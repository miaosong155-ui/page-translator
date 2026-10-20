#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
整页翻译 —— 构建脚本（零第三方依赖）

做三件事：
  1. 生成图标（纯 Python 画 PNG，不需要 Pillow）
  2. 把 src 组装成 dist/chrome 与 dist/firefox 两个可直接加载的目录
  3. 打包成 dist/page-translator-chrome-v<版本>.zip 与 ...-firefox-v<版本>.xpi

用法： python build.py
"""
import math
import os
import shutil
import struct
import zipfile
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")
VERSION = "1.0.1"

COPY_FILES = ["shared.js", "background.js", "content.js", "popup.html", "popup.css", "popup.js"]

# ---------------------------------------------------------------- PNG 写入
def write_png(path, w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0
        raw += rgba[y * w * 4:(y + 1) * w * 4]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


# ---------------------------------------------------------------- 距离场（SDF）
def sd_round_rect(x, y, cx, cy, hw, hh, r):
    dx = abs(x - cx) - hw + r
    dy = abs(y - cy) - hh + r
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def ring(cx, cy, rx, ry, hw, x, y):
    """椭圆环的有符号距离近似"""
    dx = (x - cx) / rx
    dy = (y - cy) / ry
    r = math.hypot(dx, dy)
    if r == 0:
        return -hw
    return abs(r - 1.0) * min(rx, ry) - hw


def clamp01(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def coverage(d):
    """距离 -> 抗锯齿覆盖度（1px 过渡）"""
    return clamp01(0.5 - d)


def make_icon(size):
    S = float(size)
    # 背景：圆角方块 + 斜向渐变
    pad = S * 0.045
    hw = S / 2 - pad
    radius = S * 0.225
    c1 = (0x3B, 0x82, 0xF6)   # 亮蓝
    c2 = (0x4F, 0x46, 0xE5)   # 靛蓝

    cx = cy = S / 2
    # 地球比例
    R = S * 0.30
    stroke = max(1.15, S * 0.052) / 2.0

    buf = bytearray(size * size * 4)

    for py in range(size):
        y = py + 0.5
        for px in range(size):
            x = px + 0.5
            i = (py * size + px) * 4

            a_bg = coverage(sd_round_rect(x, y, cx, cy, hw, hw, radius))
            if a_bg <= 0:
                continue

            t = clamp01(((x / S) * 0.55 + (1 - y / S) * 0.45))
            r0 = c1[0] + (c2[0] - c1[0]) * t
            g0 = c1[1] + (c2[1] - c1[1]) * t
            b0 = c1[2] + (c2[2] - c1[2]) * t

            # 白色地球：外圈 + 横纬线 + 竖经线（裁到球体内部，避免溢出）
            inside = 1.0 if math.hypot(x - cx, y - cy) <= R + stroke * 0.55 else 0.0
            a_fg = coverage(abs(math.hypot(x - cx, y - cy) - R) - stroke)
            a_fg = max(a_fg, coverage(ring(cx, cy, R * 0.995, R * 0.40, stroke * 0.92, x, y)))
            a_fg = max(a_fg, coverage(ring(cx, cy, R * 0.40, R * 0.995, stroke * 0.92, x, y)))
            # 赤道线
            a_fg = max(a_fg, coverage(abs(y - cy) - stroke * 0.9) if abs(x - cx) <= R - stroke else 0.0)
            a_fg *= inside

            if a_fg > 0:
                k = clamp01(a_fg)
                r0 = r0 * (1 - k) + 255 * k
                g0 = g0 * (1 - k) + 255 * k
                b0 = b0 * (1 - k) + 255 * k

            buf[i] = int(r0 + 0.5)
            buf[i + 1] = int(g0 + 0.5)
            buf[i + 2] = int(b0 + 0.5)
            buf[i + 3] = int(a_bg * 255 + 0.5)

    return buf


def build_icons():
    out = os.path.join(SRC, "icons")
    os.makedirs(out, exist_ok=True)
    for s in (16, 32, 48, 128):
        p = os.path.join(out, "icon%d.png" % s)
        write_png(p, s, s, make_icon(s))
        print("  icon %-4d -> %s (%d bytes)" % (s, os.path.relpath(p, ROOT), os.path.getsize(p)))


# ---------------------------------------------------------------- 组装目录
def assemble(target, manifest_name):
    out = os.path.join(DIST, target)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    for f in COPY_FILES:
        shutil.copy2(os.path.join(SRC, f), os.path.join(out, f))
    shutil.copytree(os.path.join(SRC, "icons"), os.path.join(out, "icons"))
    shutil.copy2(os.path.join(SRC, manifest_name), os.path.join(out, "manifest.json"))
    print("  %-8s -> %s" % (target, os.path.relpath(out, ROOT)))
    return out


def zip_dir(folder, zip_path):
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(folder):
            for f in files:
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, folder).replace("\\", "/"))
    print("  %-8s -> %s (%.1f KB)" % ("zip", os.path.relpath(zip_path, ROOT), os.path.getsize(zip_path) / 1024))


if __name__ == "__main__":
    print("[1/3] 生成图标")
    build_icons()
    print("[2/3] 组装扩展目录")
    chrome_dir = assemble("chrome", "manifest.chrome.json")
    ff_dir = assemble("firefox", "manifest.firefox.json")
    print("[3/3] 打包")
    zip_dir(chrome_dir, os.path.join(DIST, "page-translator-chrome-v%s.zip" % VERSION))
    zip_dir(ff_dir, os.path.join(DIST, "page-translator-firefox-v%s.xpi" % VERSION))
    print("完成。")
