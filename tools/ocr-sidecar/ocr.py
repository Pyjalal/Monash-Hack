"""OCR sidecar CLI for scanned PDFs and images.

Uses PyMuPDF to render PDF pages and Tesseract (via pytesseract)
to return structured OCR text, confidence, and coordinate evidence.

Example:
    python tools/ocr-sidecar/ocr.py document.pdf
"""

import argparse
import hashlib
import io
import json
import math
import shutil
import sys
from pathlib import Path
from typing import Any

import pymupdf as fitz  # PyMuPDF
import pytesseract
from PIL import Image
from pytesseract import Output


# Keep OCR work bounded for the hackathon pipeline.
DEFAULT_DPI = 200
DEFAULT_MAX_PAGES = 20
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB
MAX_PAGE_PIXELS = 25_000_000
PAGE_TIMEOUT_SECONDS = 15


class OcrLimitError(ValueError):
    pass

SUPPORTED_IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".tif",
    ".tiff",
    ".bmp",
    ".webp",
}


def find_tesseract() -> str | None:
    """Find the Tesseract executable."""
    executable = shutil.which("tesseract")

    if executable:
        return executable

    # Common Windows installation location.
    windows_path = Path(
        r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    )

    if windows_path.exists():
        return str(windows_path)

    return None


def error_result(code: str, message: str) -> dict[str, Any]:
    """Return an explicit structured OCR failure."""
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
        },
        "pages": [],
    }


def configure_tesseract() -> str | None:
    """Locate Tesseract and configure pytesseract."""
    executable = find_tesseract()

    if executable is None:
        return None

    pytesseract.pytesseract.tesseract_cmd = executable
    return executable


def ocr_image(
    image: Image.Image,
    page_number: int,
) -> dict[str, Any]:
    """OCR one image and return text with confidence/coordinates."""

    # RGB gives Tesseract a predictable image format.
    if image.width * image.height > MAX_PAGE_PIXELS:
        raise OcrLimitError("Page exceeds the 25 million pixel limit.")
    image = image.convert("RGB")

    data = pytesseract.image_to_data(
        image,
        output_type=Output.DICT,
        config="--oem 3 --psm 6",
        timeout=PAGE_TIMEOUT_SECONDS,
    )

    words: list[dict[str, Any]] = []
    text_parts: list[str] = []
    confidences: list[float] = []

    total_items = len(data["text"])

    for index in range(total_items):
        text = str(data["text"][index]).strip()

        try:
            confidence = float(data["conf"][index])
        except (TypeError, ValueError):
            confidence = -1.0

        # Tesseract may return empty entries for layout regions.
        if not text:
            continue

        word = {
            "text": text,
            "confidence": (
                round(confidence, 2)
                if confidence >= 0
                else None
            ),
            "bbox": {
                "x": int(data["left"][index]),
                "y": int(data["top"][index]),
                "width": int(data["width"][index]),
                "height": int(data["height"][index]),
            },
        }

        words.append(word)
        text_parts.append(text)

        if confidence >= 0:
            confidences.append(confidence)

    average_confidence = (
        round(sum(confidences) / len(confidences), 2)
        if confidences
        else None
    )

    text = " ".join(text_parts).strip()

    return {
        "page": page_number,
        "status": "ok" if text else "unresolved",
        "text": text,
        "average_confidence": average_confidence,
        "word_count": len(words),
        "width": image.width,
        "height": image.height,
        "words": words,
    }


def render_pdf_page(
    page: fitz.Page,
    dpi: int,
) -> Image.Image:
    """Render a PDF page into a Pillow image."""

    scale = dpi / 72.0
    if math.ceil(page.rect.width * scale) * math.ceil(page.rect.height * scale) > MAX_PAGE_PIXELS:
        raise OcrLimitError("Rendered page exceeds the 25 million pixel limit.")
    matrix = fitz.Matrix(scale, scale)

    pixmap = page.get_pixmap(
        matrix=matrix,
        alpha=False,
    )

    return Image.open(
        io.BytesIO(pixmap.tobytes("png"))
    )


def process_pdf(
    source: bytes,
    dpi: int,
    max_pages: int,
) -> list[dict[str, Any]]:
    """Render and OCR a bounded number of PDF pages."""

    pages: list[dict[str, Any]] = []

    with fitz.open(stream=source, filetype="pdf") as document:
        if not len(document):
            raise ValueError("PDF has no pages.")
        if len(document) > max_pages:
            raise OcrLimitError("PDF exceeds max-pages; no pages were silently omitted.")
        page_limit = len(document)

        for index in range(page_limit):
            try:
                page = document.load_page(index)
                image = render_pdf_page(page, dpi)
                result = ocr_image(image, index + 1)
                pages.append(result)

            except pytesseract.TesseractNotFoundError:
                raise
            except Exception as exc:
                # A failed page must remain visible rather than disappearing.
                pages.append(
                    {
                        "page": index + 1,
                        "status": "error",
                        "text": "",
                        "average_confidence": None,
                        "word_count": 0,
                        "words": [],
                        "error": str(exc),
                    }
                )

    return pages


def process_image(source: bytes, max_pages: int) -> list[dict[str, Any]]:
    """OCR a standalone image."""

    with Image.open(io.BytesIO(source)) as image:
        frames = getattr(image, "n_frames", 1)
        if frames > max_pages:
            raise OcrLimitError("Image exceeds max-pages; no frames were silently omitted.")
        pages = []
        for index in range(frames):
            image.seek(index)
            pages.append(ocr_image(image, index + 1))
        return pages


def run_ocr(
    input_path: str,
    dpi: int = DEFAULT_DPI,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> dict[str, Any]:
    """Run bounded OCR on a PDF or image."""

    path = Path(input_path)

    if not path.exists():
        return error_result(
            "input_not_found",
            f"Input file does not exist: {path}",
        )

    if not path.is_file():
        return error_result(
            "invalid_input",
            f"Input path is not a file: {path}",
        )

    try:
        file_size = path.stat().st_size
    except OSError as exc:
        return error_result(
            "input_read_error",
            str(exc),
        )

    if file_size > MAX_FILE_SIZE_BYTES:
        return error_result(
            "file_too_large",
            (
                f"Input exceeds the {MAX_FILE_SIZE_BYTES // (1024 * 1024)} MB "
                "OCR limit."
            ),
        )

    if dpi < 72 or dpi > 400:
        return error_result(
            "invalid_dpi",
            "DPI must be between 72 and 400.",
        )

    if max_pages < 1 or max_pages > DEFAULT_MAX_PAGES:
        return error_result(
            "invalid_max_pages",
            f"max-pages must be between 1 and {DEFAULT_MAX_PAGES}.",
        )

    tesseract_path = configure_tesseract()

    if tesseract_path is None:
        return error_result(
            "tesseract_missing",
            (
                "Tesseract OCR is not installed or could not be found. "
                "Install Tesseract and ensure it is available on PATH."
            ),
        )

    suffix = path.suffix.lower()

    try:
        with path.open("rb") as source_file:
            source = source_file.read(MAX_FILE_SIZE_BYTES + 1)
        if len(source) > MAX_FILE_SIZE_BYTES:
            raise OcrLimitError("Input exceeds the file size limit.")
        if suffix == ".pdf":
            pages = process_pdf(source, dpi, max_pages)

        elif suffix in SUPPORTED_IMAGE_EXTENSIONS:
            pages = process_image(source, max_pages)

        else:
            return error_result(
                "unsupported_file_type",
                (
                    f"Unsupported file type: {suffix or 'unknown'}. "
                    "Use PDF, PNG, JPG, JPEG, TIFF, BMP, or WEBP."
                ),
            )

    except OcrLimitError as exc:
        return error_result("ocr_resource_limit", str(exc))
    except pytesseract.TesseractNotFoundError:
        return error_result(
            "tesseract_missing",
            "Tesseract OCR could not be executed.",
        )

    except Exception as exc:
        return error_result(
            "ocr_failed",
            str(exc),
        )

    successful_pages = sum(
        1 for page in pages if page["status"] == "ok"
    )

    unresolved_pages = [
        page["page"]
        for page in pages
        if page["status"] != "ok"
    ]

    return {
        "ok": True,
        "input": {
            "path": str(path),
            "type": suffix.lstrip("."),
            "size_bytes": len(source),
            "sha256": hashlib.sha256(source).hexdigest(),
        },
        "engine": {
            "name": "tesseract",
            "executable": tesseract_path,
        },
        "limits": {
            "dpi": dpi,
            "max_pages": max_pages,
            "max_file_size_bytes": MAX_FILE_SIZE_BYTES,
            "max_page_pixels": MAX_PAGE_PIXELS,
            "page_timeout_seconds": PAGE_TIMEOUT_SECONDS,
        },
        "summary": {
            "pages_processed": len(pages),
            "pages_with_text": successful_pages,
            "unresolved_pages": unresolved_pages,
        },
        "pages": pages,
    }


def main() -> int:
    """CLI entry point."""

    sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description=(
            "Extract OCR text and evidence from scanned PDFs and images."
        )
    )

    parser.add_argument(
        "input",
        help="Path to a PDF or image file.",
    )

    parser.add_argument(
        "--dpi",
        type=int,
        default=DEFAULT_DPI,
        help=f"PDF rendering DPI (default: {DEFAULT_DPI}).",
    )

    parser.add_argument(
        "--max-pages",
        type=int,
        default=DEFAULT_MAX_PAGES,
        help=(
            "Maximum number of PDF pages to OCR "
            f"(default/max: {DEFAULT_MAX_PAGES})."
        ),
    )

    args = parser.parse_args()

    result = run_ocr(
        args.input,
        dpi=args.dpi,
        max_pages=args.max_pages,
    )

    # stdout is deliberately JSON-only so the Node wrapper in #41
    # can parse it reliably.
    print(
        json.dumps(
            result,
            ensure_ascii=False,
            indent=2,
        )
    )

    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
