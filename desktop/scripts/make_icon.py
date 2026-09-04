#!/usr/bin/env python3
# 生成 build/icon.png：256x256 青色圆角方块（仅用标准库），供 tray 与 dmg 使用。
import struct, zlib, os

W = H = 512
BG = (32, 196, 184)      # 青绿主色
BORDER = (18, 140, 132)

def px(x, y):
    # 简单圆角：四角半径 48 透明
    r = 48
    if (x < r and y < r) and ((x - r) ** 2 + (y - r) ** 2 > r * r): return None
    if (x >= W - r and y < r) and ((x - (W - r)) ** 2 + (y - r) ** 2 > r * r): return None
    if (x < r and y >= H - r) and ((x - r) ** 2 + (y - (H - r)) ** 2 > r * r): return None
    if (x >= W - r and y >= H - r) and ((x - (W - r)) ** 2 + (y - (H - r)) ** 2 > r * r): return None
    return BORDER if (x < 6 or y < 6 or x >= W - 6 or y >= H - 6) else BG

raw = bytearray()
for y in range(H):
    raw.append(0)  # filter type 0
    for x in range(W):
        c = px(x, y)
        if c is None:
            raw += bytes((0, 0, 0, 0))
        else:
            raw += bytes((c[0], c[1], c[2], 255))

def chunk(typ, data):
    c = struct.pack('>I', len(data)) + typ + data
    c += struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
    return c

sig = b'\x89PNG\r\n\x1a\n'
ihdr = struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)  # 8-bit RGBA
idat = zlib.compress(bytes(raw), 9)
png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(__file__), '..', 'build', 'icon.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'wb') as f:
    f.write(png)
print('wrote', os.path.abspath(out), len(png), 'bytes')
