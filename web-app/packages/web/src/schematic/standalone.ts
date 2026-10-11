/**
 * Entry of schematic.html. The window is rendered by the CPU window that opened it; opened on its
 * own, it only tells the user how to open the simulator.
 */
const parentWindow = window.opener as (Window & { cpuEmulMountSchematic?: (w: Window) => void }) | null;
if (parentWindow && typeof parentWindow.cpuEmulMountSchematic === 'function') {
  parentWindow.cpuEmulMountSchematic(window);
} else {
  const root = document.getElementById('root')!;
  root.style.cssText = 'display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif';
  root.textContent = 'Simulátor otvorte tlačidlom „Simulátor“ v okne CPU emulátora.';
}
export {};
