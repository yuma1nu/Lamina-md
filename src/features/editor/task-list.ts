import { EditorState, type StateCommand } from '@codemirror/state';
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { compose, type TextChange } from '../../domain/documents';
import { sourceFilesField } from './source-model';

/** Positions in the original Markdown; no synthetic characters enter the file. */
export function taskMarker(text: string, markerTo: number) {
  const lineEnd = text.indexOf('\n', markerTo);
  const match = /^([ \t]+)\[([ xX])\](?:[ \t]+|$)/.exec(text.slice(markerTo, lineEnd < 0 ? text.length : lineEnd));
  return match ? { checkFrom: markerTo + match[1].length + 1, bodyFrom: markerTo + match[0].length, checked: match[2] !== ' ' } : null;
}

// Work against each physical source, including selections across month labels.
export const markdownTaskToggle: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return true;
  const files = state.field(sourceFilesField), { segments } = compose(files);
  const lines: { from: number; task: ReturnType<typeof taskMarker>; insertion: number; prefix: string }[] = [];
  files.forEach((file, index) => {
    const segment = segments[index], local = EditorState.create({ doc: file.content });
    const selected = new Set<number>();
    for (const range of state.selection.ranges) {
      if (range.to < segment.from || range.from > segment.to || !range.empty && range.to === segment.from) continue;
      const first = local.doc.lineAt(Math.max(0, range.from - segment.from)).number;
      const end = Math.min(file.content.length, range.to - segment.from), lastLine = local.doc.lineAt(end);
      const last = lastLine.number - (!range.empty && end === lastLine.from && end > 0 ? 1 : 0);
      for (let n = first; n <= last; n++) selected.add(n);
    }
    if (!selected.size) return;
    const marks = new Map<number, number>(), excluded: { from: number; to: number }[] = [];
    const frontmatter = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(file.content)?.[0].length ?? 0;
    commonmarkLanguage.parser.parse(file.content).iterate({ enter(node) {
      if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'LinkReference', 'HorizontalRule'].includes(node.name) || /^(?:ATX|Setext)Heading/.test(node.name)) {
        excluded.push({ from: node.from, to: node.to }); return false;
      }
      if (node.name === 'ListMark') marks.set(local.doc.lineAt(node.from).number, node.to);
    } });
    for (const number of selected) {
      const line = local.doc.line(number);
      if (!line.text.trim() && state.selection.ranges.some(range => !range.empty)) continue;
      if (line.from < frontmatter || excluded.some(range => range.from <= line.to && range.to > line.from)) continue;
      const marker = marks.get(number), task = marker === undefined ? null : taskMarker(file.content, marker);
      const indentation = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line.text)![0].length;
      const insertion = marker === undefined ? line.from + indentation : marker + /^[ \t]*/.exec(file.content.slice(marker, line.to))![0].length;
      lines.push({ from: segment.from, task, insertion: segment.from + insertion, prefix: marker === undefined ? '- [ ] ' : '[ ] ' });
    }
  });
  if (!lines.length) return true;
  const allTasks = lines.every(line => line.task), checked = !lines.every(line => line.task?.checked);
  const changes: TextChange[] = lines.flatMap(line => line.task
    ? allTasks ? [{ from: line.from + line.task.checkFrom, to: line.from + line.task.checkFrom + 1, insert: checked ? 'x' : ' ' }] : []
    : [{ from: line.insertion, to: line.insertion, insert: line.prefix }]);
  if (changes.length) {
    const set = state.changes(changes.sort((a, b) => a.from - b.from));
    dispatch(state.update({ changes: set, selection: state.selection.map(set), scrollIntoView: true, userEvent: 'input.task' }));
  }
  return true;
};
