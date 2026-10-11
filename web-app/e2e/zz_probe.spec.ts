import { expect, test } from '@playwright/test';
import { login } from './helpers';
test('probe novy', async ({ page }) => {
  await login(page);
  const popupPromise = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Simulátor' }).click();
  const sim = await popupPromise;
  await sim.waitForLoadState();
  await expect(sim.getByTestId('sheet')).toBeVisible();
  console.log('count', await sim.getByRole('button', { name: 'Nový' }).count());
  await sim.getByRole('button', { name: 'Nový' }).click({ timeout: 5000 }).catch((e) => console.log('ERR', String(e).split('\n').slice(0, 12).join('\n')));
});
