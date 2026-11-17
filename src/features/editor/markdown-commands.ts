import { countColumn, EditorSelection, EditorState, Transaction, type StateCommand } from '@codemirror/state';
import { commonmarkLanguage, deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown } from '@codemirror/lang-markdown';
import { insertNewlineAndIndent, moveLineDown, moveLineUp } from '@codemirror/commands';
import { ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { compose, type TextChange } from '../../domain/documents';
import { sourceFilesField } from './source-model';
import { taskMarker } from './task-list';

// A theme is displayed continuously, but Markdown constructs and list commands
// belong to each physical file. An unclosed fence must not change next month.
function withinSource(command: StateCommand): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const files = state.field(sourceFilesField), { segments } = compose(files);
    const segment = segments.find(segment => state.selection.ranges.every(range => range.from >= segment.from && range.to <= segment.to));
    if (!segment) return false;
    let local = EditorState.create({
      doc: files[segment.index].content,
      selection: EditorSelection.create(state.selection.ranges.map(range => EditorSelection.range(range.anchor - segment.from, range.head - segment.from)), state.selection.mainIndex),
      extensions: [markdown({ addKeymap: false }), indentUnit.of('    '), EditorState.tabSize.of(4)],
    });
    // Fresh states initially parse only a prefix. There is no EditorView here to
    // finish parsing in the background, so commands at the end of long files
    // must explicitly finish the Markdown tree before reading their context.
    ensureSyntaxTree(local, local.doc.length, 1000);
    local = local.update({}).state;
    return command({ state: local, dispatch: transaction => {
      const changes: TextChange[] = [];
      transaction.changes.iterChanges((from, to, _newFrom, _newTo, text) => changes.push({ from: segment.from + from, to: segment.from + to, insert: text.toString() }));
      const selection = transaction.state.selection;
      dispatch(state.update({
        changes,
        selection: EditorSelection.create(selection.ranges.map(range => EditorSelection.range(range.anchor + segment.from, range.head + segment.from)), selection.mainIndex),
        annotations: Transaction.userEvent.of(transaction.annotation(Transaction.userEvent) ?? 'input'),
        scrollIntoView: transaction.scrollIntoView,
      }));
    } });
  };
}

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });
export const markdownEnter = withinSource(target => {
  const { state, dispatch } = target, item = currentListItem(state);
  const task = item && item.node.parent?.name === 'OrderedList' ? taskMarker(state.doc.toString(), item.node.getChild('ListMark')!.to) : null;
  if (!item || !task) return continueMarkup(target) || insertNewlineAndIndent(target);
  const empty = !item.line.text.slice(task.bodyFrom - item.line.from).trim();
  const parent = item.node.parent?.parent?.getChild('ListMark');
  const keepTask = !empty || !!(parent && taskMarker(state.doc.toString(), parent.to));
  // CodeMirror's numbered-list continuation handles renumbering but does not
  // include task markers. Let it do the structural work, then add the checkbox.
  // On an empty task, first expose the empty numeric marker so Enter can exit.
  const cleared = empty ? state.update({ changes: { from: task.checkFrom - 1, to: task.bodyFrom, insert: '' }, selection: { anchor: task.checkFrom - 1 } }) : null;
  const local = { state: cleared?.state ?? state, dispatch: (transaction: Transaction) => {
    let changes = cleared ? cleared.changes.compose(transaction.changes) : transaction.changes;
    let selection = transaction.state.selection;
    const line = transaction.state.doc.lineAt(selection.main.head), prefix = line.text.slice(0, selection.main.head - line.from);
    if (keepTask && /^(?:[ \t]*>[ \t]?)*[ \t]*\d+[.)][ \t]+$/.test(prefix)) {
      const checkbox = transaction.state.update({ changes: { from: selection.main.head, insert: '[ ] ' }, selection: { anchor: selection.main.head + 4 } });
      changes = changes.compose(checkbox.changes); selection = checkbox.state.selection;
    }
    dispatch(state.update({ changes, selection, scrollIntoView: true, userEvent: 'input' }));
  } };
  return continueMarkup(local) || insertNewlineAndIndent(local);
});
export const markdownBackspace = withinSource(target => {
  const item = currentListItem(target.state);
  if (item && item.node.parent?.parent?.name === 'ListItem' && target.state.selection.main.head === item.line.from + item.contentFrom) return listIndent(target, false);
  return deleteMarkupBackward(target);
});
export const markdownSoftBreak = withinSource(target => {
  const item = currentListItem(target.state), range = target.state.selection.main;
  if (!item || range.head < item.line.from + item.contentFrom) return insertNewlineAndIndent(target);
  const quote = quotePrefix(item.line.text);
  const insert = '\n' + item.line.text.slice(0, quote) + ' '.repeat(countColumn(item.line.text.slice(quote, item.contentFrom), 4));
  target.dispatch(target.state.update({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, scrollIntoView: true, userEvent: 'input' }));
  return true;
});

type SyntaxNode = ReturnType<typeof commonmarkLanguage.parser.parse>['topNode'];
interface ListItem { node: SyntaxNode; marker: SyntaxNode; first: number; last: number; depth: number }
function currentListItem(state: EditorState) {
  const range = state.selection.main; if (state.selection.ranges.length !== 1 || !range.empty) return null;
  let node: SyntaxNode | null = commonmarkLanguage.parser.parse(state.doc.toString()).resolveInner(Math.max(0, range.head - 1), 1);
  while (node && node.name !== 'ListItem') { if (['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(node.name)) return null; node = node.parent; }
  const marker = node?.getChild('ListMark'); if (!node || !marker) return null;
  const line = state.doc.lineAt(marker.from);
  const after = /^[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line.text.slice(marker.to - line.from))?.[0] ?? '';
  return { node, line, contentFrom: marker.to - line.from + after.length };
}
function quotePrefix(text: string): number { return /^(?:[ \t]*>[ \t]?)*/.exec(text)![0].length; }
function indentation(text: string): number {
  let column = 0;
  for (const character of text) { if (character === ' ') column++; else if (character === '\t') column += 4 - column % 4; else break; }
  return column;
}
function listIndent(target: Parameters<StateCommand>[0], deeper: boolean): boolean {
  const { state, dispatch } = target, tree = commonmarkLanguage.parser.parse(state.doc.toString()), items: ListItem[] = [];
  tree.iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(node.name)) return false;
    if (node.name !== 'ListItem') return;
    const marker = node.node.getChild('ListMark'); if (!marker) return;
    let depth = 0; for (let parent = node.node.parent; parent; parent = parent.parent) if (parent.name === 'ListItem') depth++;
    items.push({ node: node.node, marker, first: state.doc.lineAt(marker.from).number, last: state.doc.lineAt(Math.max(marker.to, node.to - 1)).number, depth });
  } });
  const selected = new Map<number, ListItem>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number, end = state.doc.lineAt(range.to);
    const last = end.number - (!range.empty && range.to === end.from ? 1 : 0);
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      if (!line.text.slice(quotePrefix(line.text)).trim() && !range.empty) continue;
      let token: SyntaxNode | null = tree.resolveInner(Math.min(line.to, Math.max(line.from, range.from)), 1);
      while (token && !['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(token.name)) token = token.parent;
      if (token && (range.empty || !items.some(item => item.node.from <= line.from && item.node.to >= line.to && range.from <= item.marker.from && range.to >= item.marker.to))) return false;
      const item = items.filter(item => item.first <= number && item.last >= number).sort((a, b) => b.depth - a.depth)[0];
      if (!item) return false;
      selected.set(item.node.from, item);
    }
  }
  if (!selected.size) return false;
  const roots = [...selected.values()].filter(item => ![...selected.values()].some(parent => parent !== item && parent.node.from <= item.node.from && parent.node.to >= item.node.to)).sort((a, b) => a.node.from - b.node.from);
  const deltas = new Map<number, number>();
  const groups = new Map<number, ListItem[]>();
  for (const root of roots) { const key = root.node.parent!.from; groups.set(key, [...(groups.get(key) ?? []), root]); }
  for (const group of groups.values()) {
    let delta = 4;
    if (deeper) {
      let sibling = group[0].node.prevSibling;
      while (sibling && sibling.name !== 'ListItem') sibling = sibling.prevSibling;
      // A selected block needs an unselected previous sibling as its parent.
      if (!sibling) continue;
    } else {
      const parent = group[0].node.parent?.parent;
      if (parent?.name !== 'ListItem') continue;
      const parentMarker = parent.getChild('ListMark')!;
      const line = state.doc.line(group[0].first), parentLine = state.doc.lineAt(parentMarker.from);
      const childColumn = indentation(line.text.slice(quotePrefix(line.text), group[0].marker.from - line.from));
      const parentColumn = indentation(parentLine.text.slice(quotePrefix(parentLine.text), parentMarker.from - parentLine.from));
      delta = -Math.max(1, childColumn - parentColumn);
    }
    for (const item of group) for (let number = item.first; number <= item.last; number++) deltas.set(number, delta);
  }
  const changes: TextChange[] = [];
  for (const [number, delta] of [...deltas].sort((a, b) => a[0] - b[0])) {
    const line = state.doc.line(number), prefix = quotePrefix(line.text), from = line.from + prefix;
    if (delta > 0) changes.push({ from, to: from, insert: ' '.repeat(delta) });
    else {
      const whitespace = /^[ \t]*/.exec(line.text.slice(prefix))![0];
      const spaces = Math.max(0, indentation(whitespace) + delta);
      changes.push({ from, to: from + whitespace.length, insert: ' '.repeat(spaces) });
    }
  }
  if (changes.length) {
    const set = state.changes(changes);
    dispatch(state.update({ changes: set, selection: state.selection.map(set), scrollIntoView: true, userEvent: deeper ? 'input.indent' : 'delete.dedent' }));
  }
  return true;
}
export const markdownListIndent = withinSource(target => listIndent(target, true));
export const markdownListDedent = withinSource(target => listIndent(target, false));

// Delete joins the next item's body, not its indentation, bullet or checkbox.
// Its children stay children of the merged item at the appropriate depth.
export const markdownDelete = withinSource(({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return false;
  if (range.head === state.doc.length) return true; // Never consume a month boundary.
  const line = state.doc.lineAt(range.head), item = currentListItem(state);
  if (!item || range.head !== line.to) return false;
  const nextLine = state.doc.line(line.number + 1);
  const nextState = state.update({ selection: { anchor: nextLine.to } }).state;
  const next = currentListItem(nextState);
  if (!next || next.line.number !== nextLine.number || line.text.slice(0, quotePrefix(line.text)) !== nextLine.text.slice(0, quotePrefix(nextLine.text))) return false;
  const changes: TextChange[] = [{ from: line.to, to: nextLine.from + next.contentFrom, insert: '' }];
  const delta = indentation(item.line.text.slice(quotePrefix(item.line.text))) - indentation(nextLine.text.slice(quotePrefix(nextLine.text)));
  if (delta) for (let n = nextLine.number + 1, end = state.doc.lineAt(Math.max(next.node.from, next.node.to - 1)).number; n <= end; n++) {
    const child = state.doc.line(n), prefix = quotePrefix(child.text), whitespace = /^[ \t]*/.exec(child.text.slice(prefix))![0];
    changes.push({ from: child.from + prefix, to: child.from + prefix + whitespace.length, insert: ' '.repeat(Math.max(0, indentation(whitespace) + delta)) });
  }
  dispatch(state.update({ changes, selection: { anchor: line.to }, scrollIntoView: true, userEvent: 'delete.join' }));
  return true;
});

function moveListItem(target: Parameters<StateCommand>[0], down: boolean): boolean {
  const { state, dispatch } = target;
  if (state.selection.ranges.length !== 1) return true;
  const range = state.selection.main, tree = commonmarkLanguage.parser.parse(state.doc.toString());
  const nodes: SyntaxNode[] = [];
  tree.iterate({ enter(node) { if (node.name === 'ListItem') nodes.push(node.node); } });
  const firstLine = state.doc.lineAt(range.from).number, end = state.doc.lineAt(range.to);
  const lastLine = end.number - (!range.empty && range.to === end.from ? 1 : 0);
  const selected: SyntaxNode[] = [];
  for (let n = firstLine; n <= lastLine; n++) {
    const item = nodes.filter(node => state.doc.lineAt(node.from).number <= n && state.doc.lineAt(Math.max(node.from, node.to - 1)).number >= n).at(-1);
    if (item && !selected.some(node => node.from === item.from)) selected.push(item);
  }
  if (!selected.length) return false;
  const roots = selected.filter(node => !selected.some(parent => parent !== node && parent.from <= node.from && parent.to >= node.to));
  if (roots.some(node => node.parent?.from !== roots[0].parent?.from)) return true;
  const first = roots[0], last = roots.at(-1)!, sibling = down ? last.nextSibling : first.prevSibling;
  if (!sibling || sibling.name !== 'ListItem') return true;
  const from = state.doc.lineAt(first.from).from, to = state.doc.lineAt(Math.max(last.from, last.to - 1)).to;
  if (range.from < from || range.to > to + 1) return true;
  const otherFrom = state.doc.lineAt(sibling.from).from, otherTo = state.doc.lineAt(Math.max(sibling.from, sibling.to - 1)).to;
  const body = state.doc.sliceString(from, to), other = state.doc.sliceString(otherFrom, otherTo);
  const gap = down ? state.doc.sliceString(to, otherFrom) : state.doc.sliceString(otherTo, from);
  const delta = down ? otherTo - to : otherFrom - from;
  const shift = (pos: number) => pos >= from && pos <= to ? pos + delta : pos === to + 1 && !range.empty ? Math.min(state.doc.length, to + delta + 1) : pos;
  dispatch(state.update({
    changes: { from: Math.min(from, otherFrom), to: Math.max(to, otherTo), insert: down ? other + gap + body : body + gap + other },
    selection: EditorSelection.single(shift(range.anchor), shift(range.head)),
    scrollIntoView: true, userEvent: 'move.list',
  }));
  return true;
}
export const markdownListMoveUp = withinSource(target => moveListItem(target, false) || moveLineUp(target));
export const markdownListMoveDown = withinSource(target => moveListItem(target, true) || moveLineDown(target));
