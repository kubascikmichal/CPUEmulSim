/**
 * auth.mode local + LDAP: directory users log in only if their e-mail is on the allowlist.
 * Needs the dev stack in combined mode (`AUTH_MODE=local`, allowlist = alice's address); skipped
 * on servers without LDAP.
 */
import { expect, test } from '@playwright/test';

test('LDAP login: allowlisted e-mail gets in, others are refused', async ({ page, request }) => {
  const cfg = await (await request.get('/api/auth/config')).json().catch(() => ({}));
  test.skip(!(cfg.ldap && cfg.mode === 'local'), 'server has no local+LDAP mode');

  await page.goto('/login');
  await expect(page.locator('#username-label')).toHaveText('Používateľské meno alebo e-mail');

  // bob is a valid directory user, but his e-mail is not on the list
  await page.fill('#username', 'bob');
  await page.fill('#password', 'Heslo123!');
  await page.click('#submit');
  await expect(page.locator('#error')).toHaveText('Nemáte oprávnenie na použitie aplikácie.');

  // alice is on the list
  await page.fill('#username', 'alice');
  await page.fill('#password', 'Heslo123!');
  await page.click('#submit');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('status')).toHaveText('Nečinný');
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.user).toEqual({ username: 'alice.novakova@test.local', displayName: 'Alice Nováková', role: 'user' });
});
