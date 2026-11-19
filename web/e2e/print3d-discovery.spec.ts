/*
 * Founder 2026-11-19: "I open 2bee.app 3d and automatically scans and find all printers/bridges".
 *
 * Runs against the PREVIEW (production) build, because the dev server proxies both bridges and
 * skips discovery. Every request to 127.0.0.1:87xx is answered here or aborted, so no run of this
 * file can reach a real bridge or a printer.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

/** The 3D tab, through the ONE expert link (as tabs.spec.ts toExpert). */
async function open3d(page: Page) {
  await page.goto('/');
  if (await page.getByTestId('make-flow').count()) await page.getByTestId('make-expert').click();
  await page.getByTestId('tab-print3d').click();
  await expect(page.getByTestId('print3d-tab')).toBeVisible();
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const hello = (route: Route, bridge: string, peers: { bridge: string; port: number }[] = []) =>
  route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, bridge, api: 1, needsToken: true, peers }) });

test('opening the 3D page with nothing stored finds both bridges, fills their addresses, and asks for the keys', async ({ page }) => {
  const probed: string[] = [];
  const authed: string[] = [];
  await page.route(/127\.0\.0\.1:87\d\d\//, (route) => {
    const u = new URL(route.request().url());
    if (route.request().headers()['authorization']) authed.push(u.href);
    if (u.pathname === '/v1/hello') probed.push(u.port);
    if (u.pathname === '/v1/hello' && u.port === '8789') return hello(route, '2bee.print3d-bridge');
    if (u.pathname === '/v1/hello' && u.port === '8788') return hello(route, '2bee.printer-bridge');
    return route.abort('connectionrefused');
  });
  await open3d(page);
  await expect(page.getByTestId('p3d-found')).toContainText('slicer bridge at http://127.0.0.1:8789 (key needed)');
  await expect(page.getByTestId('p3d-found')).toContainText('printer bridge at http://127.0.0.1:8788 (key needed)');
  await expect(page.getByTestId('p3d-conn-engine-url')).toHaveValue('http://127.0.0.1:8789');
  await expect(page.getByTestId('p3d-conn-printer-url')).toHaveValue('http://127.0.0.1:8788');
  await expect(page.getByTestId('p3d-conn-engine-token')).toHaveValue('');
  expect(new Set(probed)).toEqual(new Set(['8789', '8788'])); // no blind probing: each refused port is a red console line
  expect(authed, 'discovery never sends a key').toEqual([]);
  // The addresses are remembered; the keys are not invented.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.print3d.bridges') ?? 'null'));
  expect(stored.engine).toMatchObject({ url: 'http://127.0.0.1:8789' });
  expect(stored.engine.token).toBeUndefined();
});

test('a typed address is kept; a second printer bridge is offered, not chosen', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('2bee.app.print3d.bridges', JSON.stringify({ engine: { url: 'http://127.0.0.1:8781', remember: false }, printer: { url: '', remember: false } }));
  });
  await page.route(/127\.0\.0\.1:87\d\d\//, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/v1/hello' && u.port === '8789') return hello(route, '2bee.print3d-bridge');
    const peers = [{ bridge: '2bee.printer-bridge', port: 8788 }, { bridge: '2bee.printer-bridge', port: 8790 }];
    if (u.pathname === '/v1/hello' && (u.port === '8788' || u.port === '8790')) return hello(route, '2bee.printer-bridge', peers);
    return route.abort('connectionrefused');
  });
  await open3d(page);
  await expect(page.getByTestId('p3d-found')).toContainText('printer bridge at http://127.0.0.1:8790');
  await expect(page.getByTestId('p3d-conn-engine-url')).toHaveValue('http://127.0.0.1:8781');
  await expect(page.getByTestId('p3d-conn-printer-url')).toHaveValue('');
  await expect(page.getByTestId('p3d-discover-pick-printer')).toHaveCount(2);
  await page.getByRole('button', { name: 'Use http://127.0.0.1:8790' }).click();
  await expect(page.getByTestId('p3d-conn-printer-url')).toHaveValue('http://127.0.0.1:8790');
});
