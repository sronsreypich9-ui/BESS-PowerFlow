import { chromium } from 'playwright';

async function main() {
  console.log("Launching headless browser...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE - ${msg.type()}]: ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.error(`[BROWSER EXCEPTION]: ${err.message}`);
    if (err.stack) console.error(err.stack);
  });

  console.log("Navigating to http://localhost:3001/ ...");
  try {
    await page.goto('http://localhost:3001/', { timeout: 15000 });
    console.log("Page loaded. Waiting 5 seconds to capture initial logs...");
    await page.waitForTimeout(5000);
  } catch (e) {
    console.error("Navigation failed:", e);
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

main().catch(console.error);
