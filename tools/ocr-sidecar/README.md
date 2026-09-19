# OCR Sidecar

Python OCR CLI for recovering readable text and source evidence from scanned PDFs and images.

The sidecar uses **PyMuPDF** to render PDF pages and **Tesseract OCR** through `pytesseract` to extract text. Results are returned as structured JSON containing page text, OCR confidence, and bounding-box coordinates.

## Requirements

- Python 3.10+
- Tesseract OCR
- Python packages listed in `requirements.txt`

## Setup

Install the Python dependencies:

```bash
python -m pip install -r tools/ocr-sidecar/requirements.txt
```

Install Tesseract OCR and ensure the `tesseract` executable is available on `PATH`.

On Windows, the sidecar also checks the common installation path:

```text
C:\Program Files\Tesseract-OCR\tesseract.exe
```

Verify the installation with:

```bash
tesseract --version
```

## Usage

From the repository root:

```bash
python tools/ocr-sidecar/ocr.py <input-file>
```

Example:

```bash
python tools/ocr-sidecar/ocr.py document.pdf
```

Optional arguments:

```bash
python tools/ocr-sidecar/ocr.py document.pdf --dpi 200 --max-pages 20
```

Supported inputs:

- PDF
- PNG
- JPG / JPEG
- TIFF
- BMP
- WEBP

## Output

The CLI writes JSON to stdout.

Each page includes:

- recovered page text
- OCR status
- average confidence
- word count
- individual recognized words
- confidence for each word when available
- bounding-box coordinates for each word

Example:

```json
{
  "text": "Container",
  "confidence": 96.0,
  "bbox": {
    "x": 158,
    "y": 1126,
    "width": 103,
    "height": 17
  }
}
```

Pages where OCR cannot recover text are marked as `unresolved`.

OCR execution failures are returned explicitly. In particular, a missing Tesseract installation returns `ok: false` rather than an empty successful OCR result.

## Resource Limits

OCR processing is intentionally bounded:

- Default PDF rendering resolution: 200 DPI
- Allowed rendering resolution: 72–400 DPI
- Maximum PDF pages per request: 20
- Maximum input file size: 25 MB
- Maximum rendered/decoded page size: 25 million pixels
- Tesseract timeout per page: 15 seconds

Documents exceeding the page/frame limit fail explicitly; they are never silently truncated. Multi-frame images are processed frame by frame. Every successful request includes `input.sha256` computed over the immutable bytes actually processed. Word bounding boxes use rendered-image pixels; page width/height and PDF rendering DPI supply the coordinate scale. `ok: true` means the request produced page outcomes, not that every page is readable: inspect each status and `summary.unresolved_pages`.

Run the deterministic regression tests with `python -m unittest discover -s tools/ocr-sidecar -p 'test_*.py'`. Native Tesseract is needed for real OCR, but not these unit tests.

These limits prevent unexpectedly large documents from consuming unbounded OCR resources.

## Exit Codes

- `0` — OCR request completed
- `1` — OCR request failed

Detailed failure information is included in the JSON `error` object.
