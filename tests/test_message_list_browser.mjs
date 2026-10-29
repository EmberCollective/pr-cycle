import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Install playwright into the ignored runtime; use an existing Chrome/Edge.
const require = createRequire(path.resolve('.pr-cycle-runtime/ui-tests/package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.MESSAGE_LIST_TEST_URL || 'http://127.0.0.1:13689/message-list-test.html');
  const scroller = page.locator('[data-virtuoso-scroller]');
  const bottom = async () => page.waitForFunction(() => {
    const el = document.querySelector('[data-virtuoso-scroller]');
    return el && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 5;
  });
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page.locator('[data-row="199"]').waitFor();
  await bottom();
  assert.ok(await page.locator('[data-row]').count() < 40, 'long history should be virtualized');
  await page.getByRole('button', { name: 'Append', exact: true }).click();
  await page.locator('[data-row="200"]').waitFor();
  await bottom();
  await page.getByRole('button', { name: 'Stream', exact: true }).click();
  await page.waitForTimeout(150);
  await bottom();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('[data-row="50"]').waitFor();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-row="50"]');
    const scroller = document.querySelector('[data-virtuoso-scroller]');
    return el && scroller && el.getBoundingClientRect().top >= scroller.getBoundingClientRect().top;
  });
  await page.waitForTimeout(150);
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.getByRole('button', { name: 'Append', exact: true }).click();
  await page.waitForTimeout(250);
  const after = await scroller.evaluate((el) => el.scrollTop);
  assert.ok(Math.abs(after - before) < 5, `appends must not pull a reader away from history (${before} -> ${after})`);
  await page.getByRole('button', { name: 'Visible', exact: true }).click();
  assert.match(await page.locator('output').innerText(), /50/);
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  assert.match(await page.locator('[data-row="50"]').innerText(), /search match/);
  await page.getByRole('button', { name: 'Bottom', exact: true }).click();
  await bottom();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-row]'));
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await page.locator('[data-row="199"]').waitFor();
  await bottom();
  assert.deepEqual(errors, []);
  console.log('PASS: virtualization, initial history, append, streaming height, search jump, reading position, visible items, context, reset.');
} finally {
  await browser.close();
}
