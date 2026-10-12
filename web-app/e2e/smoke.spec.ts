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

test('register fields are read-only; quotes, labels and F register', async ({ page }) => {
  await login(page);
  for (const id of ['reg-A', 'reg-PC', 'flag-CY', 'flag-Z', 'flag-IE']) {
    await expect(page.getByTestId(id)).toHaveAttribute('readonly', '');
  }

  // ';' in quotes is a character, not a comment; a label with '_' is highlighted; PUS F / POP F run
  await setCode(page, "MVI A, ';' ; comment\nmy_loop: MVI B, 0xFF\nADI B, 1\nPUS F\nPOP C\n");
  await expect(page.locator('.cm-asm-label')).toHaveText('my_loop:');
  await expect(page.locator('.cm-asm-comment')).toHaveText('; comment');
  await page.keyboard.press('F5');
  await expect(page.getByTestId('status')).toHaveText('Nečinný');
  await expect.poll(() => register(page, 'A')).toBe('59');
  await expect.poll(() => register(page, 'C')).toBe('3'); // CY + Z

  // JMP to a number is not a jump to an instruction
  await setCode(page, 'MVI A, 1\nJMP 0\n');
  await page.keyboard.press('F5');
  await expect(page.getByTestId('console')).toContainText("[2] Neplatné návestie '0'");
});
