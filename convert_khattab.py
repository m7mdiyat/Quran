import json
from pathlib import Path

source_dir = Path.home() / "Downloads" / "khattab-en"
output_path = Path("public/en.sahih.json")

result = []
index = 1

for surah in range(1, 115):
    with open(source_dir / f"{surah}.json", encoding="utf-8") as f:
        data = json.load(f)
    for entry in data[1:]:
        result.append({"index": index, "text": entry[1]})
        index += 1

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"Processed {len(result)} ayahs → {output_path}")
