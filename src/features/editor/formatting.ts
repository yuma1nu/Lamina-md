import { countColumn, EditorSelection, EditorState, Prec, type SelectionRange, type StateCommand } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { keymap } from '@codemirror/view';
import { compose, type TextChange } from '../../domain/documents';
import { sourceFilesField } from './source-model';
import { taskMarker } from './task-list';

type Node = ReturnType<typeof markdownLanguage.parser.parse>['topNode'];
interface Source { base: number; end: number; text: string; doc: EditorState['doc']; nodes: Node[]; yaml: number }
function sources(state: EditorState): Source[] {
  const files = state.field(sourceFilesField), { segments } = compose(files);
  return files.map((file, i) => {
    const nodes: Node[] = [];
    markdownLanguage.parser.parse(file.content).iterate({ enter(node) { nodes.push(node.node); } });
    return { base: segments[i].from, end: segments[i].to, text: file.content, doc: EditorState.create({ doc: file.content }).doc, nodes,
      yaml: /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(file.content)?.[0].length ?? 0 };
  });
}
function contains(node: Node, from: number, to = from) { return node.from <= from && node.to >= to; }
function blocked(source: Source, from: number, to: number, inline = true) {
  return from < source.yaml || source.nodes.some(node =>
    ['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'LinkReference', 'URL', ...(inline ? ['InlineCode'] : [])].includes(node.name)
    && (['InlineCode', 'URL'].includes(node.name) ? contains(node, from, to) : from === to ? contains(node, from) : node.from < to && node.to > from));
}
function selectedLines(source: Source, range: SelectionRange) {
  if (range.to < source.base || range.from > source.end || !range.empty && range.to === source.base) return [];
  const from = Math.max(0, range.from - source.base), to = Math.min(source.text.length, range.to - source.base);
  const first = source.doc.lineAt(from), last = source.doc.lineAt(to);
  const end = last.number - (!range.empty && to === last.from && to > 0 ? 1 : 0);
  return Array.from({ length: Math.max(0, end - first.number + 1) }, (_, i) => source.doc.line(first.number + i));
}
function bodyStart(source: Source, number: number) {
  const line = source.doc.line(number), marker = source.nodes.find(node => node.name === 'ListMark' && source.doc.lineAt(node.from).number === number);
  if (marker) return taskMarker(source.text, marker.to)?.bodyFrom ?? marker.to + /^[ \t]*/.exec(source.text.slice(marker.to, line.to))![0].length;
  return line.from + /^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+)?/.exec(line.text)![0].length;
}

type Style = 'bold' | 'italic' | 'strike' | 'code';
const styles = { bold: ['StrongEmphasis', 'EmphasisMark', '**'], italic: ['Emphasis', 'EmphasisMark', '*'], strike: ['Strikethrough', 'StrikethroughMark', '~~'], code: ['InlineCode', 'CodeMark', '`'] } as const;
export function toggleInline(style: Style): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return true;
    const [name, mark, delimiter] = styles[style], changes: TextChange[] = [], empty = new Map<number, number>(), handled = new Set<string>();
    for (const source of sources(state)) for (const range of state.selection.ranges) for (const line of selectedLines(source, range)) {
      let from = Math.max(range.from - source.base, bodyStart(source, line.number)), to = Math.min(range.to - source.base, line.to);
      if (from > to) continue;
      // Empty pairs are not syntax nodes (**** may even parse as a rule).
      if (range.empty && source.text.slice(from - delimiter.length, from) === delimiter && source.text.slice(from, from + delimiter.length) === delimiter) {
        changes.push({ from: source.base + from - delimiter.length, to: source.base + from + delimiter.length, insert: '' }); continue;
      }
      const node = source.nodes.filter(node => node.name === name && contains(node, from, to)).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
      if (blocked(source, from, to, !node || style !== 'code')) continue;
      if (node) {
        const key = `${source.base}:${node.from}`; if (handled.has(key)) continue; handled.add(key);
        const marks = node.getChildren(mark);
        if (marks.length !== 2) continue;
        let firstTo = marks[0].to, lastFrom = marks[1].from;
        const body = source.text.slice(firstTo, lastFrom);
        if (style === 'code' && body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) { firstTo++; lastFrom--; }
        changes.push({ from: source.base + marks[0].from, to: source.base + firstTo, insert: '' }, { from: source.base + lastFrom, to: source.base + marks[1].to, insert: '' });
      } else {
        if (!range.empty && style !== 'code') {
          from += /^\s*/.exec(source.text.slice(from, to))![0].length;
          to -= /\s*$/.exec(source.text.slice(from, to))![0].length;
        }
        if (!range.empty && from === to) continue;
        const text = source.text.slice(from, to);
        let open: string = delimiter, close: string = delimiter;
        if (style === 'code' && text) {
          open = close = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
          if (/^`|`$/.test(text) || text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) { open += ' '; close = ' ' + close; }
        }
        if (from === to) { changes.push({ from: source.base + from, to: source.base + to, insert: open + close }); empty.set(source.base + from, open.length); }
        else changes.push({ from: source.base + from, to: source.base + from, insert: open }, { from: source.base + to, to: source.base + to, insert: close });
      }
    }
    if (changes.length) {
      const set = state.changes(changes.sort((a, b) => a.from - b.from || a.to - b.to));
      dispatch(state.update({ changes: set, selection: EditorSelection.create(state.selection.ranges.map(range => range.empty && empty.has(range.head) ? EditorSelection.cursor(set.mapPos(range.head, -1) + empty.get(range.head)!) : range.map(set)), state.selection.mainIndex), scrollIntoView: true, userEvent: 'input.format' }));
    }
    return true;
  };
}

export const insertMarkdownLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly || state.selection.ranges.length !== 1) return true;
  const range = state.selection.main, source = sources(state).find(source => range.from >= source.base && range.to <= source.end);
  if (!source) return true;
  const from = range.from - source.base, to = range.to - source.base;
  const existing = source.nodes.find(node => node.name === 'Link' && contains(node, from, to));
  const url = existing?.getChild('URL');
  if (url) { dispatch(state.update({ selection: { anchor: source.base + url.from, head: source.base + url.to }, scrollIntoView: true })); return true; }
  if (blocked(source, from, to) || source.text.slice(from, to).includes('\n')) return true;
  const text = state.sliceDoc(range.from, range.to).replace(/([\\[\]])/g, '\\$1') || 'リンク名';
  const insert = `[${text}](https://)`, start = range.from + text.length + 3;
  dispatch(state.update({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: start, head: start + 8 }, scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

type BlockStyle = 'bullet' | 'ordered' | 'quote' | number;
export function formatLines(style: BlockStyle, mode: 'toggle' | 'set' = 'toggle'): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return true;
    const changes: TextChange[] = [], seen = new Set<number>(), selected: { source: Source; number: number }[] = [];
    for (const source of sources(state)) for (const range of state.selection.ranges) for (const line of selectedLines(source, range)) {
      const at = source.base + line.from;
      if (seen.has(at) || blocked(source, line.from, line.to, false)) continue; seen.add(at);
      if (mode === 'toggle' && !line.text.trim() && !range.empty) continue;
      if (source.nodes.some(node => /^SetextHeading/.test(node.name) && contains(node, line.from, line.to) && node.from !== line.from)) continue;
      selected.push({ source, number: line.number });
    }
    const markFor = (source: Source, number: number) => {
      const marker = source.nodes.find(node => node.name === 'ListMark' && source.doc.lineAt(node.from).number === number);
      if (marker || mode === 'toggle') return marker;
      const line = source.doc.line(number), raw = /^(?:[ \t]*>[ \t]?)*[ \t]*([-+*]|\d+[.)])(?=[ \t]|$)/.exec(line.text);
      return raw ? { from: line.from + raw[0].length - raw[1].length, to: line.from + raw[0].length, parent: null } : undefined;
    };
    const isTarget = (source: Source, number: number) => {
      if (style === 'quote') return /^[ \t]*>/.test(source.doc.line(number).text);
      const marker = markFor(source, number);
      return !!marker && (style === 'bullet' ? /^[-+*]$/.test(source.text.slice(marker.from, marker.to)) : /^\d+[.)]$/.test(source.text.slice(marker.from, marker.to)));
    };
    const remove = mode === 'toggle' && selected.length > 0 && selected.every(({ source, number }) => isTarget(source, number));
    const rewritten = new Map<number, { source: Source; number: number; text: string }>(), removed: { source: Source; item: Node }[] = [], numbers = new Map<string, number>();
    for (const { source, number } of selected) {
      const line = source.doc.line(number), at = source.base + line.from;
      const quote = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line.text)![0], heading = /^(#{1,6})[ \t]+/.exec(line.text.slice(quote.length));
      const list = markFor(source, number);
      if (style === 'quote') {
        const old = /^[ \t]*>[ \t]?/.exec(line.text);
        if (remove || !old) changes.push({ from: at, to: at + (remove ? old![0].length : 0), insert: remove ? '' : '> ' });
      } else if (typeof style === 'number') {
        if (list || source.nodes.some(node => node.name === 'ListItem' && contains(node, line.from, line.to))) continue;
        changes.push({ from: at + quote.length, to: at + quote.length + (heading?.[0].length ?? 0), insert: style ? '#'.repeat(style) + ' ' : '' });
        const setext = source.nodes.find(node => /^SetextHeading/.test(node.name) && node.from === line.from);
        if (setext) changes.push({ from: at + line.length, to: source.base + setext.to, insert: '' });
      } else if (!heading) {
        const end = list ? remove || mode === 'set' && style === 'bullet' ? taskMarker(source.text, list.to)?.bodyFrom ?? list.to + /^[ \t]*/.exec(source.text.slice(list.to, line.to))![0].length : list.to + /^[ \t]*/.exec(source.text.slice(list.to, line.to))![0].length : line.from + quote.length;
        const item = list?.parent;
        const group = `${source.base}:${item?.parent?.from ?? 'plain'}:${quote}`;
        const ordinal = (numbers.get(group) ?? 0) + 1; numbers.set(group, ordinal);
        const prefix = remove ? '' : style === 'bullet' ? '- ' : `${ordinal}. `;
        rewritten.set(at, { source, number, text: line.text.slice(0, (list?.from ?? line.from + quote.length) - line.from) + prefix + source.text.slice(end, line.to) });
        if (remove && item?.name === 'ListItem') removed.push({ source, item });
      }
    }
    // Removing a parent's bullet promotes its children, rather than turning
    // their indentation into a code block. Selected descendants lose their
    // own markers as well; each removed ancestor contributes one dedent.
    const quoteEnd = (text: string) => /^(?:[ \t]*>[ \t]?)*/.exec(text)![0].length;
    for (const { source, item } of removed) {
      const child = (item.getChild('BulletList') ?? item.getChild('OrderedList'))?.getChild('ListItem')?.getChild('ListMark');
      const parent = item.getChild('ListMark'); if (!child || !parent) continue;
      const childLine = source.doc.lineAt(child.from), parentLine = source.doc.lineAt(parent.from);
      const delta = countColumn(childLine.text.slice(quoteEnd(childLine.text), child.from - childLine.from), 4) - countColumn(parentLine.text.slice(quoteEnd(parentLine.text), parent.from - parentLine.from), 4);
      for (let number = parentLine.number + 1, last = source.doc.lineAt(item.to - 1).number; number <= last; number++) {
        const line = source.doc.line(number), at = source.base + line.from, text = rewritten.get(at)?.text ?? line.text;
        const prefix = quoteEnd(text), spaces = /^[ \t]*/.exec(text.slice(prefix))![0];
        rewritten.set(at, { source, number, text: text.slice(0, prefix) + ' '.repeat(Math.max(0, countColumn(spaces, 4) - delta)) + text.slice(prefix + spaces.length) });
      }
    }
    for (const [from, value] of rewritten) {
      const old = value.source.doc.line(value.number).text;
      let prefix = 0, suffix = 0;
      while (prefix < old.length && prefix < value.text.length && old[prefix] === value.text[prefix]) prefix++;
      while (suffix < old.length - prefix && suffix < value.text.length - prefix && old[old.length - 1 - suffix] === value.text[value.text.length - 1 - suffix]) suffix++;
      if (prefix < old.length || prefix < value.text.length) changes.push({ from: from + prefix, to: from + old.length - suffix, insert: value.text.slice(prefix, value.text.length - suffix) });
    }
    if (changes.length) {
      const set = state.changes(changes.sort((a, b) => a.from - b.from));
      dispatch(state.update({ changes: set, selection: state.selection.map(set), scrollIntoView: true, userEvent: 'input.format' }));
    }
    return true;
  };
}

export const toggleCodeBlock: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly || state.selection.ranges.length !== 1) return true;
  const range = state.selection.main, source = sources(state).find(source => range.from >= source.base && range.to <= source.end);
  if (!source) return true;
  const from = range.from - source.base, to = range.to - source.base;
  if (from < source.yaml || source.nodes.some(node => ['ListItem', 'Blockquote', 'HTMLBlock', 'CodeBlock'].includes(node.name) && contains(node, from, to))) return true;
  const existing = source.nodes.find(node => node.name === 'FencedCode' && contains(node, from, to));
  if (existing) {
    const marks = existing.getChildren('CodeMark');
    if (!marks.length) return true;
    const start = source.doc.lineAt(marks[0].from).from, bodyStart = Math.min(source.text.length, source.doc.lineAt(marks[0].from).to + 1);
    const end = marks.length > 1 ? source.doc.lineAt(marks.at(-1)!.from).to : existing.to;
    const bodyEnd = marks.length > 1 ? Math.max(bodyStart, source.doc.lineAt(marks.at(-1)!.from).from - 1) : end;
    const body = source.text.slice(bodyStart, bodyEnd);
    const map = (pos: number) => source.base + start + Math.max(0, Math.min(body.length, pos - source.base - bodyStart));
    dispatch(state.update({ changes: { from: source.base + start, to: source.base + end, insert: body }, selection: { anchor: map(range.anchor), head: map(range.head) }, scrollIntoView: true, userEvent: 'input.format' }));
  } else {
    const lines = selectedLines(source, range), first = lines[0], last = lines.at(-1); if (!first || !last) return true;
    const body = source.text.slice(first.from, last.to), fence = '`'.repeat(Math.max(2, ...[...body.matchAll(/`+/g)].map(match => match[0].length)) + 1);
    const insert = `${fence}\n${body}\n${fence}`, prefix = source.base + first.from + fence.length + 1;
    const map = (pos: number) => prefix + Math.max(0, Math.min(body.length, pos - source.base - first.from));
    dispatch(state.update({ changes: { from: source.base + first.from, to: source.base + last.to, insert }, selection: { anchor: map(range.anchor), head: map(range.head) }, scrollIntoView: true, userEvent: 'input.format' }));
  }
  return true;
};

export const markdownFormatting = Prec.high(keymap.of([
  { key: 'Mod-b', run: toggleInline('bold'), preventDefault: true },
  { key: 'Mod-i', run: toggleInline('italic'), preventDefault: true },
  { key: 'Mod-e', run: toggleInline('code'), preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleInline('strike'), preventDefault: true },
  { key: 'Mod-k', run: insertMarkdownLink, preventDefault: true },
  { key: 'Mod-Shift-c', run: toggleCodeBlock, preventDefault: true },
  { key: 'Mod-Shift-8', run: formatLines('bullet'), preventDefault: true },
  { key: 'Mod-Shift-7', run: formatLines('ordered'), preventDefault: true },
  { key: 'Mod-Shift-.', run: formatLines('quote'), preventDefault: true },
  ...Array.from({ length: 7 }, (_, level) => ({ key: `Mod-Alt-${level}`, run: formatLines(level), preventDefault: true })),
]));
