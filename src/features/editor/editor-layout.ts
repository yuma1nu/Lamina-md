import { StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { listPrefixField } from './list-navigation';

interface Metrics { font: string; spacing: string; height: number; lineHeight: number }
const measured = StateEffect.define<Metrics>();

/** Keep real source characters in flow; only wrapped lines receive a hanging indent. */
export const editorLayout = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private context = document.createElement('canvas').getContext('2d')!;
  private widths = new Map<string, number>();
  private metrics?: Metrics;
  private destroyed = false;
  private quoted = false;
  constructor(view: EditorView) {
    this.context.font = '16px "Segoe UI"';
    this.decorations = this.build(view); this.measure(view);
  }
  update(update: ViewUpdate) {
    const metrics = update.transactions.flatMap(tr => tr.effects.filter(effect => effect.is(measured)).map(effect => effect.value as Metrics)).at(-1);
    if (metrics) {
      this.metrics = metrics; this.context.font = metrics.font;
      this.context.letterSpacing = metrics.spacing === 'normal' ? '0px' : metrics.spacing;
      this.widths.clear();
    }
    if (metrics || update.state.field(listPrefixField) !== update.startState.field(listPrefixField) || this.quoted && update.selectionSet) this.decorations = this.build(update.view);
    if (update.geometryChanged) this.measure(update.view);
  }
  private build(view: EditorView) {
    const state = view.state; this.quoted = false;
    return Decoration.set(state.field(listPrefixField).map(prefix => {
      const active = state.selection.ranges.some(range => state.doc.lineAt(range.from).from <= prefix.from && state.doc.lineAt(range.to).to >= prefix.to);
      let text = state.sliceDoc(prefix.from, prefix.to);
      if (text.includes('>')) { this.quoted = true; if (!active) text = text.replace(/>[ \t]?/g, ''); }
      let column = 0;
      text = [...text].map(character => { const count = character === '\t' ? state.tabSize - column % state.tabSize : 1; column += count; return character === '\t' ? ' '.repeat(count) : character; }).join('');
      let width = this.widths.get(text);
      if (width === undefined) { width = this.context.measureText(text).width; this.widths.set(text, width); }
      return Decoration.line({ class: 'cm-list-line', attributes: { style: `--list-prefix-width: ${width}px` } }).range(prefix.from);
    }), true);
  }
  private measure(view: EditorView) {
    view.requestMeasure({ key: this,
      read: () => {
        const style = getComputedStyle(view.contentDOM);
        return { font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, spacing: style.letterSpacing, height: view.scrollDOM.clientHeight, lineHeight: view.defaultLineHeight };
      },
      write: metrics => {
        if (this.destroyed || JSON.stringify(metrics) === JSON.stringify(this.metrics)) return;
        // Dispatch after CodeMirror's measurement pass, never while it is updating.
        queueMicrotask(() => {
          if (this.destroyed) return;
          view.dom.style.setProperty('--editor-end-space', `${Math.max(0, metrics.height - metrics.lineHeight * 3)}px`);
          view.dispatch({ effects: measured.of(metrics) });
        });
      },
    });
  }
  destroy() { this.destroyed = true; }
}, { decorations: plugin => plugin.decorations });
