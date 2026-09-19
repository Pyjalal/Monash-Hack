import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ocr
from PIL import Image


class OcrEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def pdf(self, count=1, width=100):
        path = self.root / "source.pdf"
        with ocr.fitz.open() as document:
            for _ in range(count):
                document.new_page(width=width, height=width)
            document.save(path)
        return path

    def test_missing_tesseract_is_explicit(self):
        with patch.object(ocr, "configure_tesseract", return_value=None):
            result = ocr.run_ocr(str(self.pdf()))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "tesseract_missing")

    def test_pdf_limit_does_not_silently_truncate(self):
        with patch.object(ocr, "configure_tesseract", return_value="test"), patch.object(ocr, "ocr_image") as engine:
            result = ocr.run_ocr(str(self.pdf(2)), max_pages=1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "ocr_resource_limit")
        engine.assert_not_called()

    def test_large_page_is_blocked_before_rendering(self):
        with patch.object(ocr, "configure_tesseract", return_value="test"), patch.object(ocr, "ocr_image") as engine:
            result = ocr.run_ocr(str(self.pdf(width=20_000)))
        self.assertEqual(result["summary"]["unresolved_pages"], [1])
        self.assertEqual(result["pages"][0]["status"], "error")
        engine.assert_not_called()

    def test_missing_executable_during_page_processing_is_failure(self):
        with patch.object(ocr, "configure_tesseract", return_value="test"), patch.object(ocr, "ocr_image", side_effect=ocr.pytesseract.TesseractNotFoundError()):
            result = ocr.run_ocr(str(self.pdf()))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "tesseract_missing")

    def test_image_frames_and_source_hash_are_preserved(self):
        path = self.root / "scan.tiff"
        Image.new("RGB", (50, 50), "white").save(path, save_all=True, append_images=[Image.new("RGB", (50, 50), "white")])
        original = path.read_bytes()
        def recognize(_image, number):
            return {"page": number, "status": "unresolved", "text": "", "average_confidence": None, "words": [], "word_count": 0}
        with patch.object(ocr, "configure_tesseract", return_value="test"), patch.object(ocr, "ocr_image", side_effect=recognize):
            result = ocr.run_ocr(str(path))
            rejected = ocr.run_ocr(str(path), max_pages=1)
        self.assertEqual(result["input"]["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(result["summary"]["unresolved_pages"], [1, 2])
        self.assertFalse(rejected["ok"])

    def test_corrupt_pdf_is_explicit(self):
        path = self.root / "corrupt.pdf"
        path.write_bytes(b"not a pdf")
        with patch.object(ocr, "configure_tesseract", return_value="test"):
            result = ocr.run_ocr(str(path))
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
