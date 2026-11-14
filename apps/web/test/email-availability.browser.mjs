import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { chromium, expect } from '@playwright/test';

// UI contract tests only: every API request is intercepted. No accounts are
// created, no mail is delivered, and no live database is required.
const base = process.env.LIVE_TEST_WEB_URL || 'http://localhost:3000';
let browser;

before(async () => {
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});

after(async () => { await browser?.close(); });

async function fixture(emailEnabled) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (location.protocol.startsWith('http')) localStorage.setItem('livestar-locale', 'en');
  });
  const posted = [];
  await context.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') posted.push(path);
    if (path === '/api/v1/platform') {
      if (emailEnabled === 'unavailable') return route.abort('failed');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: 'LiveStar', mode: 'live-only', streamingEnabled: false, emailEnabled }),
      });
    }
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No account is used in these UI fixtures.' }),
    });
  });
  const page = await context.newPage();
  return { context, page, posted };
}

test('disabled email hides recovery links and prevents unavailable email request forms', { timeout: 45_000 }, async () => {
  const { context, page, posted } = await fixture(false);
  try {
    await page.goto(`${base}/login`);
    await expect(page.locator('.inline-links[data-email-state="disabled"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Forgot password?', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Create account', exact: true })).toBeVisible();

    await page.goto(`${base}/forgot-password`);
    const recoveryNotice = page.getByTestId('email-availability');
    await expect(recoveryNotice).toHaveAttribute('data-email-state', 'disabled');
    await expect(recoveryNotice).toContainText(/not available|unavailable/i);
    await expect(page.locator('input[name="email"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send reset link', exact: true })).toHaveCount(0);

    await page.goto(`${base}/verify-email`);
    await expect(page.getByTestId('email-availability')).toHaveAttribute('data-email-state', 'disabled');
    await expect(page.locator('input[name="email"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resend verification email', exact: true })).toHaveCount(0);
    assert.deepEqual(posted, [], 'Disabled email pages must not send hidden recovery or resend requests.');
  } finally { await context.close(); }
});

test('enabled email keeps the existing recovery link and form available', { timeout: 30_000 }, async () => {
  const { context, page, posted } = await fixture(true);
  try {
    await page.goto(`${base}/login`);
    await expect(page.getByRole('link', { name: 'Forgot password?', exact: true })).toBeVisible();
    await page.goto(`${base}/forgot-password`);
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send reset link', exact: true })).toBeEnabled();
    assert.deepEqual(posted, [], 'Rendering an enabled form must not itself request an email.');
  } finally { await context.close(); }
});

test('previously issued reset and verification links stay usable when new email delivery is disabled', { timeout: 30_000 }, async () => {
  const { context, page, posted } = await fixture(false);
  const token = 'A'.repeat(43); // Shape-valid UI fixture; it is never submitted.
  try {
    await page.goto(`${base}/reset-password#token=${token}`);
    await expect(page.getByRole('button', { name: 'Save password', exact: true })).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');

    await page.goto(`${base}/verify-email#token=${token}`);
    await expect(page.getByRole('button', { name: 'Verify my email', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    assert.deepEqual(posted, [], 'Showing an old link must not consume its token automatically.');
  } finally { await context.close(); }
});

test('unreachable platform metadata fails closed and offers a retry without an email form', { timeout: 30_000 }, async () => {
  const { context, page, posted } = await fixture('unavailable');
  try {
    await page.goto(`${base}/forgot-password`);
    await expect(page.getByTestId('email-availability')).toHaveAttribute('data-email-state', 'unavailable');
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(page.locator('input[name="email"]')).toHaveCount(0);
    assert.deepEqual(posted, []);
  } finally { await context.close(); }
});
