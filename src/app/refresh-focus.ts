// An asynchronous focus request expires if another control receives focus
// before it runs. Merely checking activeElement misses an intervening inert
// refresh, which can turn that newly focused control back into document.body.
export function trackPendingFocus(): () => boolean {
  const owner = document.activeElement;
  let changed = false;
  const track = (event: FocusEvent) => { if (event.target !== owner) changed = true; };
  document.addEventListener('focusin', track, true);
  return () => { document.removeEventListener('focusin', track, true); return !changed; };
}

// Refresh temporarily makes the app inert. Restore only the control that owned
// focus, and only if the user has not moved to another window or control.
export function preserveRefreshFocus(): () => void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.closest('.app-shell')) return () => {};
  return () => {
    requestAnimationFrame(() => {
      const modal = document.querySelector('dialog[open]');
      if (!document.hasFocus() || !focused.isConnected || focused.closest('[inert]') || modal && !modal.contains(focused)) return;
      if (document.activeElement === document.body || document.activeElement === null) focused.focus({ preventScroll: true });
    });
  };
}
