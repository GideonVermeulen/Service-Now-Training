/* run-tests.js — opens tests/tests.html in headless Chromium and fails if any test fails.
 * Test tooling only; the app itself has no build step.
 * Usage: node scripts/run-tests.js   (PW_CHANNEL=msedge or chrome uses an installed browser instead)
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const TIMEOUT_MS = 60000;

(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'tests', 'tests.html')).href;
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  let code = 1;
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => {
      const s = document.getElementById('summary');
      return s && s.textContent.trim() !== 'Running…';
    }, null, { timeout: TIMEOUT_MS }).catch(() => {});

    const result = await page.evaluate(() => {
      const s = document.getElementById('summary');
      return {
        text: s ? s.textContent.trim() : '(no #summary)',
        cls: s ? s.className : '',
        failures: Array.from(document.querySelectorAll('li.fail')).map((li) => {
          const group = li.parentElement && li.parentElement.previousElementSibling;
          return (group ? group.textContent + ' › ' : '') + li.textContent;
        })
      };
    });

    result.failures.forEach((f) => console.log('FAIL ' + f));
    pageErrors.forEach((e) => console.log('Page error: ' + e));
    console.log(result.text);
    code = result.cls === 'pass' && !pageErrors.length ? 0 : 1;
  } finally {
    await browser.close();
  }
  process.exit(code);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
