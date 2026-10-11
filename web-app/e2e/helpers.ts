import { expect, type Page } from '@playwright/test';

export const USER = 'alice';
export const PASSWORD = 'Heslo123!';

export async function login(page: Page, user = USER, password = PASSWORD) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.fill('#username', user);
  await page.fill('#password', password);
  await page.click('#submit');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('status')).toHaveText('Nečinný');
}

/** Replace the editor content by typing (CodeMirror). */
export async function setCode(page: Page, code: string) {
  const editor = page.locator('[data-testid="code-editor"] .cm-content');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(code);
}

export async function register(page: Page, name: string) {
  return page.getByTestId(`reg-${name}`).inputValue();
}
