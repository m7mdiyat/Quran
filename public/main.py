import os
import re
from flask import Flask, jsonify, request

app = Flask(__name__)

CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")
BULLET = "\u2022"


def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Max-Age"] = "3600"
    return resp


@app.after_request
def after_request(resp):
    return add_cors_headers(resp)


def normalize_text(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def summarize_text(text, max_words=12, max_chars=120):
    cleaned = normalize_text(text)
    if not cleaned:
        return ""
    words = cleaned.split(" ")
    if len(words) > max_words:
        cleaned = " ".join(words[:max_words]).rstrip(" ,;:-")
    if len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars].rstrip(" ,;:-")
    return cleaned


@app.route("/compare", methods=["POST", "OPTIONS"])
def compare():
    if request.method == "OPTIONS":
        return ("", 204)

    try:
        payload = request.get_json(force=True, silent=False)
    except Exception:
        return jsonify(ok=False, error="Invalid JSON body."), 400

    if not isinstance(payload, dict):
        return jsonify(ok=False, error="Invalid JSON body."), 400

    tafsirs = payload.get("tafsirs")
    if not isinstance(tafsirs, list):
        return jsonify(ok=False, error="tafsirs must be a list."), 400
    if len(tafsirs) < 2:
        return jsonify(ok=False, error="At least two tafsirs are required for comparison."), 400

    verse = payload.get("verse") if isinstance(payload, dict) else None
    verse_info = {
        "surah": verse.get("surah") if isinstance(verse, dict) else None,
        "ayah": verse.get("ayah") if isinstance(verse, dict) else None,
    }

    bullets = []
    for item in tafsirs[:7]:
        if isinstance(item, dict):
            label = normalize_text(item.get("label") or item.get("key") or "Tafsir")
            summary = summarize_text(item.get("text") or "")
        else:
            label = "Tafsir"
            summary = ""
        if not summary:
            summary = "No summary available."
        bullets.append(f"{BULLET} {label}: {summary}")

    comparison = "\n".join(bullets)
    return jsonify(
        ok=True,
        comparison=comparison,
        meta={
            "received": len(tafsirs),
            "returned": len(bullets),
            **verse_info,
        },
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
