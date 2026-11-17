import { useWorkspace, workspace } from '../app/workspace';
import type { PointerEvent } from 'react';

export function ResizeHandle({ kind }: { kind: 'sidebar' | 'inspector' | 'split' }) {
  const key = kind === 'sidebar' ? 'sidebarWidth' : kind === 'inspector' ? 'inspectorWidth' : 'splitRatio';
  const value = useWorkspace(state => state.preferences[key]);
  const limits = kind === 'sidebar' ? [190, 420] : kind === 'inspector' ? [260, 480] : [.25, .75];
  const label = kind === 'sidebar' ? '左サイドバーの幅' : kind === 'inspector' ? '右サイドバーの幅' : '左右ペインの幅';
  const update = (next: number) => workspace.updatePreferences({ [key]: Math.max(limits[0], Math.min(limits[1], next)) });
  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
  }
  return <div className={`resize-handle resize-${kind}`} role="separator" title={`${label}：ドラッグ・矢印キーで調整、ダブルクリック・Homeで初期幅へ`} aria-label={label} aria-orientation="vertical" aria-valuemin={limits[0]} aria-valuemax={limits[1]} aria-valuenow={value} tabIndex={0}
    onPointerDown={start} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
      update(kind === 'sidebar' ? event.clientX - bounds.left : kind === 'inspector' ? bounds.right - event.clientX : (event.clientX - bounds.left) / bounds.width);
    }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const direction = event.key === 'ArrowRight' ? 1 : -1; update(value + direction * (kind === 'inspector' ? -1 : 1) * (kind === 'split' ? .02 : 10)); }
      if (event.key === 'Home') { event.preventDefault(); update(kind === 'sidebar' ? 230 : kind === 'inspector' ? 300 : .5); }
    }} onDoubleClick={() => update(kind === 'sidebar' ? 230 : kind === 'inspector' ? 300 : .5)} />;
}
