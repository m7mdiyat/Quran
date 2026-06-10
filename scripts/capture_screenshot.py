from playwright.sync_api import sync_playwright
import sys
import time

def capture(url, output_path, viewport_width=1920, viewport_height=1080, dark_mode=False, wait_ms=0):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        color_scheme = 'dark' if dark_mode else 'light'
        context = browser.new_context(
            viewport={'width': viewport_width, 'height': viewport_height},
            color_scheme=color_scheme,
        )
        page = context.new_page()
        page.goto(url, wait_until='networkidle', timeout=30000)
        if wait_ms:
            time.sleep(wait_ms / 1000.0)
        page.screenshot(path=output_path, full_page=False)
        browser.close()

if __name__ == '__main__':
    # Usage: python capture_screenshot.py <url> <output_path> [width] [height] [dark] [wait_ms]
    url = sys.argv[1]
    output_path = sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 1920
    height = int(sys.argv[4]) if len(sys.argv) > 4 else 1080
    dark = sys.argv[5].lower() == 'true' if len(sys.argv) > 5 else False
    wait_ms = int(sys.argv[6]) if len(sys.argv) > 6 else 0
    capture(url, output_path, width, height, dark, wait_ms)
    print(f"Saved: {output_path}")
