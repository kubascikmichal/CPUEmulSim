import { expect, test } from '@playwright/test';
import { login, register, setCode } from './helpers';

test('login, run a program, registers update', async ({ page }) => {
  await login(page);
  await expect(page).toHaveTitle('CPU Emulator v. 0.9.4');
  await page.screenshot({ path: 'e2e/.results/cpu-initial.png' });

  await setCode(page, 'MVI A, 5\nloop: DEC A\nJNZ loop\nMVI B, 7\n');
  await expect(page.locator('[data-testid="code-editor"]').locator('..').locator('..')).toContainText('Kód*');
  await page.keyboard.press('F5');
  await expect(page.getByTestId('status')).toHaveText('Nečinný');
  await expect.poll(() => register(page, 'B')).toBe('7');
  await expect(page.getByTestId('console')).toContainText('Program úspešne zavedený!');
  await page.screenshot({ path: 'e2e/.results/cpu-after-run.png' });
});
