"""Independent source fixtures; no dataset, email, labels or references are read.

Run with the sidecar's Pillow dependency. The generated PNGs have only pixels,
not an embedded text layer. Literal text below is source content, not OCR input
metadata or a prompt. Tests may assert it only after recognition.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
(root / "a.txt").write_bytes(b"")
(root / "b.pdf").write_bytes(b"%PDF-1.7\nindependently truncated: no objects or trailer\n")
(root / "e.txt").write_bytes(b"\xff\xfe\x00\x01\x02" * 20)
Image.new("RGB", (1400, 600), "white").save(root / "c.png")
page = Image.new("RGB", (1400, 600), "white")
draw = ImageDraw.Draw(page)
font = ImageFont.load_default(size=44)
for number, line in enumerate([
    "SHIPPING INSTRUCTION",
    "Shipper: Independent Orchard Exporters",
    "Port of loading: Cedar Harbour",
    "Container count: 3",
    "Gross weight: 12500 KG",
]):
    draw.text((60, 60 + number * 90), line, font=font, fill="black")
page.save(root / "d.png")
