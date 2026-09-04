import os
import uuid

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")


def convert_pdf_to_image(pdf_path: str) -> str:
    """
    Convert the first page of a PDF to PNG.
    Returns the path to the saved PNG file.
    Raises RuntimeError if pdf2image or poppler is unavailable.
    """
    try:
        from pdf2image import convert_from_path
        from pdf2image.exceptions import PDFInfoNotInstalledError, PDFPageCountError
    except ImportError:
        raise RuntimeError("pdf2image is not installed. Run: pip install pdf2image")

    try:
        pages = convert_from_path(pdf_path, dpi=150, first_page=1, last_page=1)
    except PDFInfoNotInstalledError:
        raise RuntimeError(
            "poppler is not installed or not in PATH. "
            "Install with: brew install poppler  (macOS) or apt-get install poppler-utils (Linux)"
        )
    except PDFPageCountError as exc:
        raise RuntimeError(f"Could not read PDF page count: {exc}")
    except Exception as exc:
        raise RuntimeError(f"PDF conversion failed: {exc}")

    if not pages:
        raise RuntimeError("PDF conversion produced no pages")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    out_filename = f"{uuid.uuid4()}.png"
    out_path = os.path.join(UPLOAD_DIR, out_filename)
    pages[0].save(out_path, "PNG")

    print(f"[PDF] Converted {os.path.basename(pdf_path)} → {out_filename}")
    return out_path
