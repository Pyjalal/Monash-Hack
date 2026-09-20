"""Independent raster SI/BL pair for operational OCR acceptance tests."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root = Path(__file__).resolve().parent
fields = ["Shipment reference: SHIP-1234", "Shipper: Orchard Exporters", "Consignee: Cedar Imports", "Notify party: Cedar Agent", "Port of loading: North Harbour", "Port of discharge: South Harbour", "Container count: 3", "Gross weight kg: 12500"]
for name, title in [("a", "SHIPPING INSTRUCTIONS"), ("b", "DRAFT BILL OF LADING")]:
    image = Image.new("RGB", (1800, 1000), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=44)
    for number, text in enumerate([title, *fields]):
        draw.text((60, 40 + number * 100), text, font=font, fill="black")
    image.save(root / f"{name}.png")
