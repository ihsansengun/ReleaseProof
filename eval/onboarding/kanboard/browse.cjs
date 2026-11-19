// Walk-through used in the Kanboard onboarding spike. No model, no ReleaseProof code.
// Usage: node browse.cjs <base address> [directory for screenshots]
// Signs in with Kanboard's public default account on a throwaway container,
// creates a project, a task and a second user through the interface, and
// checks persistence, a permission rule and that nothing is requested off-site.
const { chromium } = require('playwright');
const base = process.argv[2], out = process.argv[3];
(async () => {
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await browser.newPage();
  const failed = [], external = [], errors = [];
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('request', r => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) external.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  const log = (k, v) => console.log(k + ': ' + v);

  await page.goto(base + '/');
  log('login page title', await page.title());
  log('csrf field present', await page.locator('input[name=csrf_token]').count());
  // wrong password first
  await page.fill('input[name=username]', 'admin'); await page.fill('input[name=password]', 'wrong');
  await page.click('button[type=submit]');
  log('bad login message', (await page.locator('.alert, .form-errors').first().innerText().catch(() => 'none')).trim());
  await page.fill('input[name=username]', 'admin'); await page.fill('input[name=password]', 'admin');
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  log('after login url', page.url().replace(base, ''));
  log('after login title', await page.title());
  if (out) await page.screenshot({ path: out + '/dashboard.png' });

  // create a project through the UI
  await page.goto(base + '/?controller=ProjectCreationController&action=create');
  await page.fill('input[name=name]', 'Spike project');
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  log('project url', page.url().replace(base, ''));
  const pid = (page.url().match(/project_id=(\d+)/) || [])[1];
  log('project id', pid);

  // create a task through the UI (the form opens as a dialog on the board)
  await page.goto(base + `/?controller=BoardViewController&action=show&project_id=${pid}`);
  await page.locator('a[href*="TaskCreationController"][href*="column_id=1"]').first().click();
  await page.waitForSelector('#modal-content input[name=title]');
  await page.fill('#modal-content input[name=title]', 'Synthetic task one');
  log('modal buttons', (await page.locator('#modal-content button').allInnerTexts()).join(' | '));
  await page.locator('#modal-content button[type=submit], #modal-content button.btn-blue').first().click();
  await page.waitForLoadState('networkidle');
  log('board shows task', await page.getByText('Synthetic task one').count());
  log('board columns', (await page.locator('.board-column-title, th.board-column-header').allInnerTexts()).map(s => s.trim().split('\n')[0]).join(' | '));
  if (out) await page.screenshot({ path: out + '/board.png' });

  // create a second user through the UI (set-up via interface)
  await page.goto(base + '/?controller=UserListController&action=show');
  await page.getByRole('link', { name: 'New user' }).click();
  await page.waitForSelector('#modal-content input[name=username]');
  await page.fill('#modal-content input[name=username]', 'tester1');
  await page.fill('#modal-content input[name=password]', 'Synthetic-pass-1');
  await page.fill('#modal-content input[name=confirmation]', 'Synthetic-pass-1');
  await page.locator('#modal-content button[type=submit], #modal-content button.btn-blue').first().click();
  await page.waitForLoadState('networkidle');
  log('user created url', page.url().replace(base, ''));

  // sign out, sign in as the new user in a fresh context
  const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage();
  await p2.goto(base + '/');
  await p2.fill('input[name=username]', 'tester1'); await p2.fill('input[name=password]', 'Synthetic-pass-1');
  await p2.click('button[type=submit]'); await p2.waitForLoadState('networkidle');
  log('second user signed in', await p2.title());
  const r = await p2.goto(base + `/?controller=BoardViewController&action=show&project_id=${pid}`);
  log('second user opening admin private project', r.status());

  // persistence across a new browser session
  const ctx3 = await browser.newContext(); const p3 = await ctx3.newPage();
  await p3.goto(base + '/');
  await p3.fill('input[name=username]', 'admin'); await p3.fill('input[name=password]', 'admin');
  await p3.click('button[type=submit]'); await p3.waitForLoadState('networkidle');
  await p3.goto(base + `/?controller=BoardViewController&action=show&project_id=${pid}`);
  log('task persists in new session', await p3.getByText('Synthetic task one').count());

  log('external requests', JSON.stringify([...new Set(external)]));
  log('failed requests', JSON.stringify([...new Set(failed)]));
  log('page errors', JSON.stringify(errors));
  await browser.close();
})().catch(e => { console.error('SCRIPT ERROR', e.message.slice(0, 600)); process.exit(1); });
