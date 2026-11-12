import { EditorSelection, EditorState, StateField, type SelectionRange } from '@codemirror/state';
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import type { Command } from '@codemirror/view';
import { compose } from '../../domain/documents';
import { sourceFilesEffect, sourceFilesField } from './source-model';

export interface ListPrefix { from: number; to: number }
const prefixCache = new Map<string, { text: string; prefixes: ListPrefix[] }>();
export function listPrefixes(text: string): ListPrefix[] {
  const state = EditorState.create({ doc: text }), prefixes: ListPrefix[] = [];
  commonmarkLanguage.parser.parse(text).iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(node.name)) return false;
    if (node.name !== 'ListMark') return;
    const line = state.doc.lineAt(node.from);
    const whitespace = /^[ \t]*/.exec(line.text.slice(node.to - line.from))![0];
    prefixes.push({ from: line.from, to: node.to + whitespace.length });
  } });
  return prefixes;
}
export const listPrefixField = StateField.define<ListPrefix[]>({
  create: state => prefixesForState(state),
  update(value, transaction) { return transaction.docChanged || transaction.effects.some(effect => effect.is(sourceFilesEffect)) ? prefixesForState(transaction.state) : value; },
});
function prefixesForState(state: EditorState): ListPrefix[] {
  const files = state.field(sourceFilesField), { segments } = compose(files);
  return files.flatMap((file, index) => {
    let cached = prefixCache.get(file.path);
    if (!cached || cached.text !== file.content) { cached = { text: file.content, prefixes: listPrefixes(file.content) }; prefixCache.delete(file.path); prefixCache.set(file.path, cached); }
    if (prefixCache.size > 128) prefixCache.delete(prefixCache.keys().next().value!);
    return cached.prefixes.map(prefix => ({ from: segments[index].from + prefix.from, to: segments[index].from + prefix.to }));
  });
}
function clamp(range: SelectionRange, prefixes: ListPrefix[]): SelectionRange {
  // A range selection may include Markdown prefixes for copy/cut/select-all.
  if (!range.empty) return range;
  const prefix = prefixes.find(prefix => range.head >= prefix.from && range.head < prefix.to);
  return prefix ? EditorSelection.cursor(prefix.to, 1, range.bidiLevel ?? undefined, range.goalColumn) : range;
}
export const listCaretGuard = EditorState.transactionFilter.of(transaction => {
  const state = transaction.state, selection = state.selection;
  const ranges = selection.ranges.map(range => clamp(range, state.field(listPrefixField)));
  if (ranges.every((range, index) => range === selection.ranges[index])) return transaction;
  return [transaction, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }];
});
export const listCursorLeft: Command = view => {
  const { selection } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const prefix = view.state.field(listPrefixField).find(prefix => prefix.to === selection.main.head);
  if (!prefix || prefix.from === 0) return false;
  const { segments } = compose(view.state.field(sourceFilesField)), boundary = segments.findIndex(segment => segment.from === prefix.from);
  view.dispatch({ selection: { anchor: boundary > 0 ? segments[boundary - 1].to : prefix.from - 1 }, scrollIntoView: true, userEvent: 'select' });
  return true;
};
