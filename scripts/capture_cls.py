from playwright.sync_api import sync_playwright

def capture_early(url, output_path, viewport_width=375, viewport_height=667):
    """Capture immediately after domcontentloaded (before fonts/networkidle) to see CLS."""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': viewport_width, 'height': viewport_height})
        page = context.new_page()
        # Only wait for DOM — not network (fonts not yet loaded)
        page.goto(url, wait_until='domcontentloaded', timeout=30000)
        page.screenshot(path=output_path, full_page=False)
        browser.close()

capture("https://www.m7mdiyat.com/2/255/",
        "/Users/mohammed/Projects/m7mdiyat-vite/screenshots/ayah_cls_early_375.png",
        375, 667)
capture = capture_early  # rename for clarity below
capture("https://www.m7mdiyat.com/2/255/",
        "/Users/mohammed/Projects/m7mdiyat-vite/screenshots/ayah_cls_early_375.png",
        375, 667)
print("CLS early screenshot saved")
