#!/usr/bin/env python3
"""Export the 2 fixed comparison texts to a readable HTML file."""
import sqlite3
import os

DB = os.path.expanduser("~/Projects/m7mdiyat-vite/compare_generator/comparisons.sqlite")
OUT = os.path.expanduser("~/Downloads/verify_comparisons.html")

conn = sqlite3.connect(DB)
cur = conn.cursor()

ayahs = [(77, 33), (2, 284)]
results = []

for s, a in ayahs:
    cur.execute("SELECT comparison_text, model, created_at FROM comparisons WHERE surah=? AND ayah=?", (s, a))
    row = cur.fetchone()
    if row:
        text, model, created = row
        # Convert markdown bold to HTML bold
        import re
        text_html = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
        text_html = text_html.replace('\n', '<br>')
        results.append((s, a, text_html, model or "unknown", created or "unknown"))
    else:
        results.append((s, a, "NOT FOUND", "", ""))

conn.close()

html = """<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>Verify Comparisons</title>
<style>
body {
    font-family: -apple-system, 'SF Pro', sans-serif;
    max-width: 800px;
    margin: 40px auto;
    padding: 20px;
    background: #fafafa;
    color: #1a1a1a;
    line-height: 2;
    font-size: 17px;
}
.card {
    background: white;
    border-radius: 16px;
    padding: 30px;
    margin-bottom: 30px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    border: 1px solid #e5e5e5;
}
.header {
    font-size: 22px;
    font-weight: 700;
    color: #1d8fff;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 2px solid #e5e5e5;
}
.meta {
    font-size: 12px;
    color: #888;
    margin-bottom: 16px;
}
strong { color: #0b6bcb; }
h1 {
    text-align: center;
    font-size: 28px;
    margin-bottom: 30px;
    color: #333;
}
</style>
</head>
<body>
<h1>مراجعة النصوص المُعاد توليدها</h1>
"""

for s, a, text_html, model, created in results:
    html += f"""
<div class="card">
    <div class="header">سورة {s} — آية {a}</div>
    <div class="meta">Model: {model} | Generated: {created}</div>
    <div class="content">{text_html}</div>
</div>
"""

html += """
</body>
</html>"""

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

print(f"Saved to: {OUT}")
print("Opening in browser...")
os.system(f"open '{OUT}'")
