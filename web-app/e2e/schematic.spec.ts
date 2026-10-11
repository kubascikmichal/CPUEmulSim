import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function openSimulator(page: Page) {
  const popupPromise = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Simulátor' }).click();
  const sim = await popupPromise;
  await sim.waitForLoadState();
  await expect(sim.getByTestId('sheet')).toBeVisible();
  await expect(sim).toHaveTitle('Simulátor - Schéma');
  return sim;
}

/** Drag a palette item onto the sheet at viewport coordinates (x, y). */
async function place(sim: Page, label: string, x: number, y: number) {
  const item = sim.locator(`[data-palette="${label}"]`);
  const box = (await item.boundingBox())!;
  await sim.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sim.mouse.down();
  await sim.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
  await sim.mouse.move(x, y, { steps: 10 });
  await sim.mouse.up();
}

async function pinCenter(sim: Page, gateIndex: number, pinIndex: number) {
  const pin = sim.locator('[data-gate]').nth(gateIndex).locator('[data-pin]').nth(pinIndex).locator('circle').last();
  const b = (await pin.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(sim: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await sim.mouse.move(from.x, from.y);
  await sim.mouse.down();
  await sim.mouse.move(from.x + 10, from.y, { steps: 3 });
  await sim.mouse.move(to.x, to.y, { steps: 10 });
  await sim.mouse.up();
}

test('build INP → LED, power on, toggle', async ({ page }) => {
  page.on('pageerror', (e) => console.log('CPU pageerror', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('CPU console', m.text()));
  await login(page);
  const sim = await openSimulator(page);
  sim.on('pageerror', (e) => console.log('SIM pageerror', e.message));
  sim.on('console', (m) => m.type() === 'error' && console.log('SIM console', m.text()));
  const sheetBox = (await sim.getByTestId('sheet').boundingBox())!;

  await place(sim, 'INP', sheetBox.x + 100, sheetBox.y + 100);
  await place(sim, 'LED', sheetBox.x + 300, sheetBox.y + 100);
  await expect(sim.locator('[data-gate]')).toHaveCount(2);

  await drag(sim, await pinCenter(sim, 0, 0), await pinCenter(sim, 1, 0));
  await expect(sim.locator('[data-wire]')).toHaveCount(1);

  await sim.getByLabel('On/Off').click();
  await expect(sim.getByText('Simulácia beží')).toBeVisible();

  const led = sim.locator('[data-part="led"]');
  await expect(led).toHaveAttribute('fill', '#A9A9A9');
  await sim.locator('[data-part="input"]').click();
  await expect(led).toHaveAttribute('fill', '#FF0000');
  await sim.screenshot({ path: 'e2e/.results/schematic.png' });

  // 0.9.4: an LED lit for >= 100 ms goes off as soon as its input falls
  await sim.locator('[data-part="input"]').click();
  await expect(led).toHaveAttribute('fill', '#A9A9A9');
});

test('0.9.4 wiring: an L between rows is two wires; a drop in empty space keeps a free end', async ({ page }) => {
  await login(page);
  const sim = await openSimulator(page);
  const sheetBox = (await sim.getByTestId('sheet').boundingBox())!;

  await place(sim, 'INP', sheetBox.x + 100, sheetBox.y + 100);
  await place(sim, 'LED', sheetBox.x + 300, sheetBox.y + 220);
  await expect(sim.locator('[data-gate]')).toHaveCount(2);

  // pin → pin on different rows: the L preview becomes two straight wires meeting at an invisible bend
  await drag(sim, await pinCenter(sim, 0, 0), await pinCenter(sim, 1, 0));
  await expect(sim.locator('[data-wire]')).toHaveCount(2);
  await expect(sim.locator('[data-junction]')).toHaveCount(0);

  // a wire released in empty space is kept with a free end (0.9.2 deleted it)
  await place(sim, 'INP', sheetBox.x + 100, sheetBox.y + 400);
  const from = await pinCenter(sim, 2, 0);
  await drag(sim, from, { x: from.x + 120, y: from.y });
  await expect(sim.locator('[data-wire]')).toHaveCount(3);
});
