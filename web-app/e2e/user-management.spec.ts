/**
 * User management (auth.mode: local): admin from the environment, teachers, students.
 * Needs the admin credentials of the server under test: E2E_ADMIN_USER / E2E_ADMIN_PASSWORD.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { solveCaptcha } from './helpers';

const ADMIN_USER = process.env.E2E_ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const stamp = Date.now().toString(36);

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#submit');
}

async function freshPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

const row = (page: Page, username: string) => page.getByTestId(`user-${username}`);

test('admin, teacher and student: roles, create, import, rename, password, disable, delete', async ({ browser, request }) => {
  const cfg = await (await request.get('/api/auth/config')).json().catch(() => ({}));
  test.skip(!cfg.registration || ADMIN_USER === '', 'needs auth.mode local with E2E_ADMIN_USER / E2E_ADMIN_PASSWORD');

  // ---- a student registers; no management for students
  const student = await freshPage(browser);
  const studentUser = 'st' + stamp;
  await student.goto('/login#register');
  await student.fill('#name', 'Šimon Študent');
  await student.fill('#username', studentUser);
  await student.fill('#password', 'heslo-studenta');
  await student.fill('#password2', 'heslo-studenta');
  await solveCaptcha(student);
  await student.click('#submit');
  await expect(student).toHaveURL(/\/$/);
  await student.getByRole('button', { name: 'Súbor' }).click();
  await expect(student.getByRole('menuitem', { name: /Správa používateľov/ })).toHaveCount(0);
  await student.keyboard.press('Escape');
  await student.goto('/admin');
  await expect(student).toHaveURL(/\/$/);

  // ---- the admin opens management from the Súbor menu and creates a teacher
  const adminPage = await freshPage(browser);
  await loginAs(adminPage, ADMIN_USER, ADMIN_PASSWORD);
  await expect(adminPage).toHaveURL(/\/$/);
  await adminPage.getByRole('button', { name: 'Súbor' }).click();
  const popup = adminPage.context().waitForEvent('page');
  await adminPage.getByRole('menuitem', { name: /Správa používateľov/ }).click();
  const admin = await popup;
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(admin.getByTestId('admin-whoami')).toContainText('Administrátor');
  const teacherUser = 'uc' + stamp;
  await admin.getByRole('button', { name: 'Nový používateľ...' }).click();
  await admin.getByLabel('Meno a priezvisko').fill('Učiteľka Tereza');
  await admin.getByLabel('Používateľské meno').fill(teacherUser);
  await admin.getByLabel('Heslo (aspoň 8 znakov)').fill('heslo-ucitela');
  await admin.getByLabel('Učiteľ').check();
  await admin.getByRole('button', { name: 'Vytvoriť' }).click();
  await expect(row(admin, teacherUser)).toContainText('Učiteľ');
  await expect(row(admin, studentUser)).toContainText('online');

  // ---- the teacher sees students only and imports a class
  const teacher = await freshPage(browser);
  await loginAs(teacher, teacherUser, 'heslo-ucitela');
  await expect(teacher).toHaveURL(/\/$/);
  await teacher.goto('/admin');
  await expect(row(teacher, studentUser)).toBeVisible();
  await expect(row(teacher, teacherUser)).toHaveCount(0);
  await expect(teacher.getByRole('columnheader', { name: 'Rola' })).toHaveCount(0);

  await teacher.getByRole('button', { name: 'Import študentov (CSV)...' }).click();
  const imported = 'im' + stamp;
  await teacher.getByLabel('Obsah CSV').fill(`meno;používateľské meno\nIvana Importovaná;${imported}\nZlý riadok;a b\nDuplikát;${studentUser}\n`);
  await teacher.getByRole('button', { name: 'Importovať' }).click();
  await expect(teacher.getByText('Vytvorených účtov: 1, preskočených riadkov: 2.')).toBeVisible();
  const download = teacher.waitForEvent('download');
  await teacher.getByRole('button', { name: 'Stiahnuť zoznam s heslami (CSV)' }).click();
  const csv = readFileSync((await (await download).path())!, 'utf8');
  const password = csv.split(/\r\n/).find((l) => l.includes(imported))!.split(';')[2];
  expect(password).toMatch(/^[a-zA-Z2-9]{10}$/);
  await teacher.getByRole('button', { name: 'Zavrieť' }).click();
  await expect(row(teacher, imported)).toContainText('Ivana Importovaná');
  const importedPage = await freshPage(browser);
  await loginAs(importedPage, imported, password);
  await expect(importedPage).toHaveURL(/\/$/);

  // ---- rename, disable (logged out, clear message), new password, enable
  await row(teacher, studentUser).getByRole('button', { name: 'Meno' }).click();
  await teacher.getByLabel('Meno a priezvisko').fill('Šimon Premenovaný');
  await teacher.getByRole('button', { name: 'Uložiť' }).click();
  await expect(row(teacher, studentUser)).toContainText('Šimon Premenovaný');

  await row(teacher, studentUser).getByRole('button', { name: 'Zablokovať' }).click();
  await expect(row(teacher, studentUser)).toContainText('Zablokovaný');
  await loginAs(student, studentUser, 'heslo-studenta');
  await expect(student.locator('#error')).toHaveText('Účet je zablokovaný. Obráťte sa na vyučujúceho.');

  await row(teacher, studentUser).getByRole('button', { name: 'Heslo' }).click();
  await teacher.getByLabel('Nové heslo (aspoň 8 znakov)').fill('nove-heslo-1');
  await teacher.getByLabel('Nové heslo znova').fill('nove-heslo-1');
  await teacher.getByRole('button', { name: 'Nastaviť heslo' }).click();
  await row(teacher, studentUser).getByRole('button', { name: 'Povoliť' }).click();
  await expect(row(teacher, studentUser)).toContainText('Aktívny');
  await loginAs(student, studentUser, 'nove-heslo-1');
  await expect(student).toHaveURL(/\/$/);

  // ---- the admin promotes the imported student; then the teacher no longer manages that account
  await admin.getByRole('button', { name: 'Obnoviť' }).click();
  await admin.getByLabel(`Rola ${imported}`).click();
  await admin.getByRole('option', { name: 'Učiteľ' }).click();
  await expect(admin.getByText(`Rola používateľa ${imported} zmenená.`)).toBeVisible();
  await teacher.getByRole('button', { name: 'Obnoviť' }).click();
  await expect(row(teacher, imported)).toHaveCount(0);

  // ---- delete: account and files gone, the student is logged out
  await row(teacher, studentUser).getByRole('button', { name: 'Zmazať' }).click();
  await teacher.getByRole('dialog').getByRole('button', { name: 'Zmazať' }).click();
  await expect(row(teacher, studentUser)).toHaveCount(0);
  await loginAs(student, studentUser, 'nove-heslo-1');
  await expect(student.locator('#error')).toHaveText('Nesprávne používateľské meno alebo heslo.');
});
