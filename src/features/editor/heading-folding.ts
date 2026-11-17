import { EditorState, Prec, StateField, type Extension, type StateEffect } from '@codemirror/state';
import { codeFolding, foldEffect, foldedRanges, foldKeymap, foldService, unfoldEffect } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { compose } from '../../domain/documents';
import { outlineHeadings } from '../../domain/outline';
import { sourceFilesEffect, sourceFilesField } from './source-model';

export interface HeadingFold { heading: number; from: number; to: number; title: string }
export function headingFolds(state: EditorState): HeadingFold[] {
  const files = state.field(sourceFilesField), { segments } = compose(files), headings = outlineHeadings(files);
  const stacks = new Map<string, typeof headings>(), nextHeadings = new Map<number, number>();
  for (let i = headings.length - 1; i >= 0; i--) { const heading = headings[i], stack = stacks.get(heading.path) ?? []; while (stack.length && stack.at(-1)!.level > heading.level) stack.pop(); if (stack.length) nextHeadings.set(heading.from, stack.at(-1)!.from); stack.push(heading); stacks.set(heading.path, stack); }
  return headings.flatMap(heading => {
    const line = state.doc.lineAt(heading.from), segment = segments.find(segment => segment.path === heading.path)!;
    let from = line.to;
    if (!/^ {0,3}#{1,6}\s/.test(line.text) && line.number < state.doc.lines) from = state.doc.line(line.number + 1).to;
    const next = nextHeadings.get(heading.from);
    const to = next !== undefined ? state.doc.lineAt(next).from - 1 : segment.to;
    return to > from && state.doc.sliceString(from, to).trim() ? [{ heading: line.from, from, to, title: heading.title }] : [];
  });
}

export const headingFoldField = StateField.define<HeadingFold[]>({
  create: headingFolds,
  update: (value, tr) => tr.docChanged || tr.effects.some(effect => effect.is(sourceFilesEffect)) ? headingFolds(tr.state) : value,
});

function collapsed(state: EditorState, range: HeadingFold) {
  let result = false;
  foldedRanges(state).between(range.from, range.from, (from, to) => { if (from === range.from && to === range.to) result = true; });
  return result;
}
class HeadingToggle extends WidgetType {
  constructor(readonly range: HeadingFold, readonly closed: boolean) { super(); }
  eq(other: HeadingToggle) { return this.closed === other.closed && this.range.from === other.range.from && this.range.to === other.range.to && this.range.title === other.range.title; }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span'); wrap.className = 'cm-heading-toggle';
    const button = document.createElement('button'); button.type = 'button';
    const label = `${this.range.title}を${this.closed ? '展開' : '折り畳む'}`;
    button.setAttribute('aria-label', label); button.setAttribute('aria-expanded', String(!this.closed)); button.title = label;
    button.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      view.dispatch({ effects: (this.closed ? unfoldEffect : foldEffect).of(this.range), ...(!this.closed && view.state.selection.main.head > this.range.from && view.state.selection.main.head <= this.range.to ? { selection: { anchor: this.range.from } } : {}) });
      view.focus();
    });
    wrap.append(button); return wrap;
  }
  ignoreEvent() { return true; }
}
const headingToggles = StateField.define<DecorationSet>({
  create: toggles,
  update: (value, tr) => tr.state.field(headingFoldField) !== tr.startState.field(headingFoldField) || foldedRanges(tr.state) !== foldedRanges(tr.startState) ? toggles(tr.state) : value,
  provide: field => EditorView.decorations.from(field),
});
function toggles(state: EditorState) {
  return Decoration.set(state.field(headingFoldField).map(range => Decoration.widget({ widget: new HeadingToggle(range, collapsed(state, range)), side: -1 }).range(range.heading)), true);
}

export const headingFolding: Extension = [
  headingFoldField,
  Prec.highest(foldService.of((state, start) => state.field(headingFoldField).find(range => range.heading === start) ?? null)),
  codeFolding({ placeholderDOM(_view, onclick) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'cm-heading-fold-placeholder';
    button.textContent = '…'; button.setAttribute('aria-label', '折り畳んだ本文を展開'); button.title = '折り畳んだ本文を展開';
    button.addEventListener('click', onclick); return button;
  } }),
  // Editing a heading can remove it or change the extent of its section. Never
  // leave an invisible body behind without a corresponding heading control.
  EditorState.transactionExtender.of(tr => {
    if (!tr.docChanged) return null;
    const effects: StateEffect<{ from: number; to: number }>[] = [], ranges = tr.state.field(headingFoldField);
    foldedRanges(tr.state).between(0, tr.state.doc.length, (from, to) => {
      const valid = ranges.find(range => range.from === from);
      if (valid?.to === to) return;
      effects.push(unfoldEffect.of({ from, to }));
      if (valid && !(tr.state.selection.main.head > valid.from && tr.state.selection.main.head < valid.to)) effects.push(foldEffect.of(valid));
    });
    return effects.length ? { effects } : null;
  }),
  headingToggles, keymap.of(foldKeymap),
];
