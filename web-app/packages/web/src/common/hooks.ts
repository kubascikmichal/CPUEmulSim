import { useEffect, useReducer, useRef } from 'react';

/** Re-render when `subscribe` notifies (coalesced to one render per animation frame). */
export function useSubscription(subscribe: (listener: () => void) => () => void, win: Window = window): void {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const pending = useRef(false);
  useEffect(
    () =>
      subscribe(() => {
        if (pending.current) return;
        pending.current = true;
        win.requestAnimationFrame(() => {
          pending.current = false;
          force();
        });
      }),
    [subscribe, win],
  );
}

/** Forces a re-render every `ms` while `active`. */
export function useInterval(callback: () => void, ms: number, active: boolean): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
