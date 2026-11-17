import { useWorkspace, workspace } from './workspace';
import { trackPendingFocus } from './refresh-focus';

export function focusActiveEditor() {
  const owner = document.activeElement;
  const stillRequested = trackPendingFocus();
  requestAnimationFrame(() => {
    if (!stillRequested() || !document.hasFocus() || document.querySelector('dialog[open]')) return;
    if (document.activeElement !== owner && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>('.active-pane .cm-content, .active-pane .material-search input')?.focus({ preventScroll: true });
  });
}

export async function tabShortcut(event: KeyboardEvent, newNote: () => void) {
  if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  const handled = key === 'tab' || key === 'pageup' || key === 'pagedown' || key === 'w' && !event.shiftKey || key === 't' && event.shiftKey || key === 'n' && !event.shiftKey || !event.shiftKey && /^[1-9]$/.test(key);
  if (!handled) return;
  event.preventDefault(); event.stopPropagation();
  const state = useWorkspace.getState();
  if (!state.vault || state.busy || state.closing || state.annotationOpen || state.materialOpen || document.querySelector('dialog[open]')) return;
  // React unmounting a database tab does not dispatch blur on its editor. Commit
  // the active cell first, and keep the tab open if that save fails.
  const input = document.activeElement;
  if (input instanceof HTMLElement && input.closest('.material-table')) {
    input.blur();
    const saving = useWorkspace.getState().busy;
    if (saving) await new Promise<void>(resolve => {
      const stop = useWorkspace.subscribe(value => { if (!value.busy) { stop(); resolve(); } });
    });
    const latest = useWorkspace.getState();
    if (latest.vault?.root !== state.vault.root || latest.closing || saving && latest.error !== null || latest.panes[state.activePane].active !== state.panes[state.activePane].active) return;
  }
  if (key === 'tab' || key === 'pageup' || key === 'pagedown') workspace.cycleTab(key === 'pageup' || key === 'tab' && event.shiftKey);
  else if (key === 'w') { const id = state.panes[state.activePane].active; if (id) void workspace.closeTab(state.activePane, id).then(focusActiveEditor); }
  else if (key === 't') workspace.restoreClosedTab();
  else if (key === 'n') newNote();
  else workspace.selectTab(Number(key));
  if (key !== 'n' && key !== 'w') focusActiveEditor();
}
