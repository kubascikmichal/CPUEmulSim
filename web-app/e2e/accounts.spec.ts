/**
 * Local accounts (auth.mode: local): register, save to the workspace, log out, log in again, see
 * and download the file. Skipped on servers without registration (e.g. the LDAP dev stack).
 */
import { expect, test } from '@playwright/test';
import { setCode, solveCaptcha } from './helpers';

test('register → save → Koniec → log in again → file is there → download', async ({ page, request }) => {
  const cfg = await (await request.get('/api/auth/config')).json().catch(() => ({}));
  test.skip(!cfg.registration, 'server has no self-registration');

  const user = 'e2e' + Date.now().toString(36);
  const password = 'heslo-' + Date.now();

  // register (the login page switches to the registration form)
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  // login asks for the password once; the repeat field belongs to registration only
  await expect(page.locator('#password')).toBeVisible();
  await expect(page.locator('#password2')).toBeHidden();
  await page.click('#switch-link');
  await expect(page.locator('#password2')).toBeVisible();
  await expect(page.locator('#heading')).toHaveText('CPU Emulator - registrácia');
  await page.fill('#name', 'E2E Študent');
  await page.fill('#username', user);
  await page.fill('#password', password);
  await page.fill('#password2', password + 'x');
  // the form can only be sent with a solved captcha
  if (cfg.captcha) await expect(page.locator('#submit')).toBeDisabled();
  await solveCaptcha(page);
  await page.click('#submit');
  await expect(page.locator('#error')).toHaveText('Heslá sa nezhodujú.');
  await page.fill('#password2', password);
  await page.click('#submit');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('status')).toHaveText('Nečinný');

  // save a program to the workspace
  await setCode(page, 'MVI A, 5\n');
  await page.getByRole('button', { name: 'Súbor' }).click();
  await page.getByRole('menuitem', { name: /Uložiť ako/ }).click();
  await page.getByLabel('Názov súboru').fill('moj');
  await page.getByRole('button', { name: 'Uložiť', exact: true }).click();
  await expect(page).toHaveTitle('CPU Emulator - moj.asm');

  // Koniec = log out
  await page.getByRole('button', { name: 'Súbor' }).click();
  await page.getByRole('menuitem', { name: 'Koniec' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // a duplicate registration is refused
  await page.click('#switch-link');
  await page.fill('#name', 'Iný Študent');
  await page.fill('#username', user.toUpperCase());
  await page.fill('#password', password);
  await page.fill('#password2', password);
  await solveCaptcha(page);
  await page.click('#submit');
  await expect(page.locator('#error')).toHaveText('Používateľské meno je už obsadené.');

  // log in again: the file is listed in the workspace and can be downloaded
  await page.click('#switch-link');
  await expect(page.locator('#password2')).toBeHidden();
  await page.fill('#username', user);
  await page.fill('#password', password);
  await page.click('#submit');
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('button', { name: 'Súbor' }).click();
  await page.getByRole('menuitem', { name: /Otvoriť/ }).click();
  const row = page.getByRole('row', { name: /moj\.asm/ });
  await expect(row).toBeVisible();
  await row.click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Stiahnuť do počítača' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('moj.asm');
  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(path!, 'utf8')).toBe('MVI A, 5\n');
});
