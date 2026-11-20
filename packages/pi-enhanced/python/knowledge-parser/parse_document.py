"""Convert approved document bytes from stdin, without paths or model downloads."""

import io
import json
import sys
import zipfile


MAX_BYTES = 8 * 1024 * 1024
MAX_DERIVED_BYTES = 8 * 1024 * 1024
MAX_PAGES = 300


class DocumentError(Exception):
    pass


def clean_html(raw):
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(raw, "html.parser")
    if soup.find() is None:
        raise DocumentError("invalid-document")
    title = soup.title.get_text(" ", strip=True) if soup.title else None
    for element in soup.select("nav, aside, footer, script, style, noscript, [hidden], [role=navigation]"):
        element.decompose()
    body = soup.select_one("main, [role=main]") or soup.body or soup
    # Use a full document to keep format detection independent of the source filename.
    return f"<!doctype html><html><body>{''.join(map(str, body.contents))}</body></html>".encode(), title


def check_docx(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        if (
            len(members) > 2048
            or sum(item.file_size for item in members) > 32 * 1024 * 1024
        ):
            raise DocumentError("limit-exceeded")
        names = {item.filename for item in members}
        if len(names) != len(members) or not {"[Content_Types].xml", "word/document.xml"} <= names:
            raise DocumentError("invalid-document")


def convert_markup(kind, raw):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.document import InputDocument

    title = None
    options = None
    if kind == "docx":
        check_docx(raw)
        from docling.backend.msword_backend import MsWordDocumentBackend

        format_ = InputFormat.DOCX
        backend = MsWordDocumentBackend
    else:
        from docling.backend.html_backend import HTMLDocumentBackend
        from docling.datamodel.backend_options import HTMLBackendOptions

        raw, title = clean_html(raw)
        if len(raw) > MAX_DERIVED_BYTES:
            raise DocumentError("limit-exceeded")
        format_ = InputFormat.HTML
        backend = HTMLDocumentBackend
        options = HTMLBackendOptions(fetch_images=False, render_page=False, infer_furniture=False)

    # These two declarative backends already produce DoclingDocument.
    # Avoid importing the full dispatcher and its optional OCR and layout dependencies.
    source = InputDocument(
        path_or_stream=io.BytesIO(raw), format=format_, backend=backend,
        filename=f"document.{kind}", backend_options=options,
    )
    if not source.valid or not source._backend.is_valid():
        raise DocumentError("invalid-document")
    try:
        document = source._backend.convert()
        warnings = ["images-omitted"] if document.pictures else []
        return {"markdown": document.export_to_markdown(escape_underscores=False, image_placeholder=""), "title": title, "warnings": warnings}
    finally:
        source._backend.unload()


def convert_pdf(raw):
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.document import InputDocument
    from docling_core.types.doc import BoundingBox, CoordOrigin

    if b"%PDF-" not in raw[:1024]:
        raise DocumentError("invalid-document")
    doc = InputDocument(
        path_or_stream=io.BytesIO(raw), format=InputFormat.PDF,
        backend=PyPdfiumDocumentBackend, filename="document.pdf",
    )
    if not doc.valid or doc.page_count < 1:
        raise DocumentError("invalid-document")

    pages = []
    warnings = ["pdf-layout-not-reconstructed"]
    total = 0
    try:
        if doc.page_count > MAX_PAGES:
            raise DocumentError("limit-exceeded")
        for index in range(doc.page_count):
            page = doc._backend.load_page(index)
            try:
                if not page.is_valid():
                    warnings.append(f"page-unreadable:{index + 1}")
                    continue
                size = page.get_size()
                bounds = BoundingBox(l=0, t=size.height, r=size.width, b=0, coord_origin=CoordOrigin.BOTTOMLEFT)
                text = page.get_text_in_rect(bounds)
                if text.strip():
                    total += len(text.encode())
                    if total > MAX_DERIVED_BYTES:
                        raise DocumentError("limit-exceeded")
                    pages.append({"pageNumber": index + 1, "text": text})
                else:
                    warnings.append(f"page-has-no-text:{index + 1}")
            finally:
                page.unload()
    finally:
        doc._backend.unload()
    if not pages:
        code = "ocr-required" if any(
            warning.startswith("page-has-no-text:") for warning in warnings
        ) else "invalid-document"
        raise DocumentError(code)
    return {"pages": pages, "warnings": warnings}


def main():
    try:
        kind, = sys.argv[1:]
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise DocumentError("limit-exceeded")
        if kind == "pdf":
            result = convert_pdf(raw)
        elif kind in ("html", "docx"):
            result = convert_markup(kind, raw)
        else:
            raise DocumentError("unsupported-format")
        if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_DERIVED_BYTES:
            raise DocumentError("limit-exceeded")
        frame = {"result": result}
    except DocumentError as exc:
        frame = {"error": str(exc)}
    except ImportError:
        frame = {"error": "parser-unavailable"}
    except (ValueError, OSError, RuntimeError, zipfile.BadZipFile):
        frame = {"error": "invalid-document"}
    print(json.dumps(frame, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
