#!/usr/bin/env python3
"""
Harmony OCR — Native platform OCR via Python.

Platform routing:
  - Windows:   Windows.Media.OCR  (winrt)   — fast, built-in, offline
  - macOS:     Vision framework   (pyobjc)  — fast, built-in, offline
  - Linux:     Not available natively → prints "unsupported" → Tesseract.js fallback

Output: JSON to stdout with keys: ok, text, confidence, line_count, word_count, language, engine, hint
Exit code: 0 on any non-error output; non-zero on crash/unexpected failure
"""

import sys
import json
import os
import platform


def output_json(data: dict) -> None:
    """Print JSON to stdout and exit 0."""
    print(json.dumps(data))
    sys.exit(0)


def fail(message: str) -> None:
    """Print error JSON and exit 1."""
    print(json.dumps({"ok": False, "text": "", "error": message, "engine": "none"}))
    sys.exit(1)


# ── Platform detection ──────────────────────────────────────────────────────

SYSTEM = platform.system()  # "Windows", "Darwin", "Linux"


# ── Windows: Windows.Media.OCR via winrt ────────────────────────────────────

def ocr_windows(image_path: str) -> None:
    """Use Windows.Media.OCR via the winrt package."""
    try:
        import winrt.windows.media.ocr as wocr
        import winrt.windows.storage.streams as wss
        import winrt.windows.graphics.imaging as wbitmap
        import winrt.windows.globalization as wglob
    except ImportError:
        fail("Windows OCR requires 'pip install winrt'. Run: pip install winrt")
        return

    if not os.path.isfile(image_path):
        fail(f"File not found: {image_path}")
        return

    try:
        # Open file as random-access stream
        file_bytes = None
        with open(image_path, "rb") as fh:
            file_bytes = fh.read()

        # Create in-memory random access stream
        stream = wss.InMemoryRandomAccessStream()
        writer = wss.DataWriter(stream.get_output_stream_at(0))
        writer.write_bytes(file_bytes)
        writer.store_async().get()
        writer.flush_async().get()
        writer.detach_stream()
        stream.seek(0)

        # Decode to bitmap
        decoder = wbitmap.BitmapDecoder.create_async(stream).get()
        bitmap = decoder.get_software_bitmap_async().get()

        if bitmap is None:
            output_json({
                "ok": True,
                "text": "",
                "confidence": "none",
                "line_count": 0,
                "word_count": 0,
                "language": "?",
                "engine": "windows-ocr",
                "hint": "Image decoded but no bitmap produced. May be an unsupported format."
            })
            return

        # Run OCR
        engine = wocr.OcrEngine.try_create_from_user_profile_languages()
        if engine is None:
            engine = wocr.OcrEngine.try_create_from_language(
                wglob.Language("en-US")
            )
        if engine is None:
            fail("Could not create Windows OCR engine. Install an OCR language pack in Windows Settings.")

        result = engine.recognize_async(bitmap).get()

        if result is None or result.lines is None:
            output_json({
                "ok": True,
                "text": "",
                "confidence": "none",
                "line_count": 0,
                "word_count": 0,
                "language": str(engine.recognizer_language.display_name) if engine and engine.recognizer_language else "?",
                "engine": "windows-ocr",
                "hint": "OCR ran but returned no text."
            })
            return

        # Gather results
        lines = []
        word_count = 0
        for line in result.lines:
            line_text = line.text or ""
            lines.append(line_text)
            if line.words:
                word_count += len(line.words)

        full_text = "\n".join(lines)

        # Confidence heuristic: based on text density, line count, and word recognition
        # Windows.Media.OCR doesn't expose per-word confidence, so we derive it from:
        #   - Word density (words per line): high density = likely real text
        #   - Line count: multi-line text is more likely real
        #   - Character variety: mixed alphanumeric suggests real text
        if full_text and len(full_text.strip()) > 0:
            words_per_line = word_count / max(len(lines), 1)
            char_variety = len(set(full_text)) / max(len(full_text), 1)

            # Multi-line text with good word density and character variety → high confidence
            if len(lines) >= 3 and words_per_line >= 2.0 and char_variety >= 0.3:
                confidence = "high"
                raw_confidence = 90
            elif len(lines) >= 1 and words_per_line >= 1.0:
                confidence = "medium"
                raw_confidence = 65
            else:
                confidence = "low"
                raw_confidence = 35
        else:
            confidence = "none"
            raw_confidence = 0

        output_json({
            "ok": True,
            "text": full_text,
            "confidence": confidence,
            "raw_confidence": raw_confidence,
            "line_count": len(lines),
            "word_count": word_count,
            "language": str(engine.recognizer_language.display_name) if engine and engine.recognizer_language else "?",
            "engine": "windows-ocr"
        })

    except Exception as exc:
        fail(f"Windows OCR error: {exc}")


# ── macOS: Vision framework via pyobjc ──────────────────────────────────────

def ocr_macos(image_path: str) -> None:
    """Use Apple Vision framework via pyobjc."""
    try:
        import Quartz
        import Vision
        from Foundation import NSURL
    except ImportError:
        fail("macOS OCR requires pyobjc. Run: pip install pyobjc-framework-Vision pyobjc-framework-Quartz")
        return

    if not os.path.isfile(image_path):
        fail(f"File not found: {image_path}")
        return

    try:
        # Load image
        ns_url = NSURL.fileURLWithPath_(image_path)
        ci_image = Quartz.CIImage.imageWithContentsOfURL_(ns_url)
        if ci_image is None:
            fail(f"Could not load image: {image_path}")

        # Create text recognition request
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setRecognitionLanguages_(["en-US"])
        request.setUsesLanguageCorrection_(True)

        # Create handler and perform request
        handler = Vision.VNImageRequestHandler.alloc().initWithCIImage_options_(ci_image, None)
        success = handler.performRequests_error_([request], None)

        if not success or request.results() is None or len(request.results()) == 0:
            output_json({
                "ok": True,
                "text": "",
                "confidence": "none",
                "line_count": 0,
                "word_count": 0,
                "language": "en-US",
                "engine": "macos-vision",
                "hint": "Vision OCR ran but found no text in the image."
            })
            return

        # Gather results
        results = request.results()
        lines = []
        word_count = 0
        for observation in results:
            top_candidate = observation.topCandidates_(1)
            if top_candidate and len(top_candidate) > 0:
                text = str(top_candidate[0].string())
                confidence = float(top_candidate[0].confidence())
                lines.append(text)
                word_count += len(text.split())

        full_text = "\n".join(lines)

        # Aggregate confidence
        confidences = []
        for observation in results:
            top_candidate = observation.topCandidates_(1)
            if top_candidate and len(top_candidate) > 0:
                confidences.append(float(top_candidate[0].confidence()))

        avg_conf = sum(confidences) / len(confidences) if confidences else 0
        if avg_conf >= 0.8:
            conf_label = "high"
        elif avg_conf >= 0.5:
            conf_label = "medium"
        else:
            conf_label = "low"

        output_json({
            "ok": True,
            "text": full_text,
            "confidence": conf_label,
            "line_count": len(lines),
            "word_count": word_count,
            "language": "en-US",
            "engine": "macos-vision"
        })

    except Exception as exc:
        fail(f"macOS Vision OCR error: {exc}")


# ── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        fail("Usage: python ocr_text.py <image_path>")
        sys.exit(1)

    image_path = sys.argv[1]

    if SYSTEM == "Windows":
        ocr_windows(image_path)
    elif SYSTEM == "Darwin":
        ocr_macos(image_path)
    else:
        # Linux / unknown: no native OCR available
        output_json({
            "ok": False,
            "text": "",
            "engine": "none",
            "hint": f"Native OCR is not available on {SYSTEM}. The extension will use Tesseract.js instead.",
            "confidence": "none",
            "line_count": 0,
            "word_count": 0,
            "language": "?"
        })
