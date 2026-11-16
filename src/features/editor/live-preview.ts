import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { compose } from '../../domain/documents';
import { sourceFilesEffect, sourceFilesField } from './source-model';
import { decode, noteReferences, resolveNote, type NoteIndex } from '../../domain/note-links';
import { markdownDestination } from '../../domain/markdown';
import { location, materialCatalog } from '../../domain/materials';
import { taskMarker } from './task-list';
export { markdownDestination } from '../../domain/markdown';

export const noteIndexEffect = StateEffect.define<NoteIndex>();
export const noteIndexField = StateField.define<NoteIndex>({ create: () => ({ targets: [], files: new Map() }), update(value, transaction) { for (const effect of transaction.effects) if (effect.is(noteIndexEffect)) return effect.value; return value; } });
class WikiLabel extends WidgetType {
  constructor(readonly target: string, readonly source: string, readonly label: string, readonly broken: boolean) { super(); }
  eq(other: WikiLabel) { return other.target === this.target && other.source === this.source && other.label === this.label && other.broken === this.broken; }
  toDOM() {
    const element = document.createElement('a'); element.href = '#'; element.tabIndex = -1;
    element.className = 'cm-note-link' + (this.broken ? ' cm-note-link-missing' : '');
    element.textContent = this.label; element.title = this.broken ? `リンク先が見つかりません: ${this.target}` : this.target;
    element.dataset.noteLink = this.target; element.dataset.noteSource = this.source; element.dataset.noteSyntax = 'wiki'; element.dataset.sourceEditing = 'false'; return element;
  }
  ignoreEvent() { return false; }
}
class ResourceLabel extends WidgetType {
  constructor(readonly path: string, readonly label: string, readonly type: string, readonly page: string) { super(); }
  eq(other: ResourceLabel) { return other.path === this.path && other.label === this.label && other.type === this.type && other.page === this.page; }
  toDOM() {
    const group = document.createElement('span'); group.className = 'cm-material';
    const link = document.createElement('a'); link.href = location(this.path).href; link.dataset.previewLink = this.path; link.dataset.sourceEditing = 'false'; link.className = 'cm-resource-link'; link.title = this.path; link.rel = 'noreferrer noopener'; link.tabIndex = -1;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '15'); svg.setAttribute('height', '15'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('material-type-icon', 'type-' + this.type.replace(/[^\w-]/g, '-'));
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', this.type === 'folder' ? 'M3 7V4h6l3 3h9v13H3Z' : this.type === 'excel' ? 'M4 3h16v18H4ZM4 9h16M4 15h16M10 3v18' : this.type === 'web' ? 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18' : 'M5 3h9l5 5v13H5ZM14 3v6h5M8 14h8M8 17h6');
    svg.append(path); const text = document.createElement('span'); text.textContent = this.label.replace(/\\([\\[\]])/g, '$1'); link.append(svg, text);
    const info = document.createElement('button'); info.type = 'button'; info.className = 'cm-resource-info'; info.dataset.materialInfo = this.page; info.setAttribute('aria-label', `${this.label}の資料詳細`); info.title = '資料の詳細'; info.textContent = 'ⓘ';
    group.append(link, info); return group;
  }
  ignoreEvent() { return false; }
}

type MarkdownTree = ReturnType<typeof markdownLanguage.parser.parse>;
interface ParsedSource { path: string; text: string; from: number; tree: MarkdownTree }
interface Preview { sources: ParsedSource[]; decorations: DecorationSet; hidden: DecorationSet }

class CodeLanguage extends WidgetType {
  constructor(readonly language: string) { super(); }
  eq(other: CodeLanguage) { return other.language === this.language; }
  toDOM() {
    const element = document.createElement('span');
    element.className = 'cm-code-language';
    element.textContent = this.language || 'code';
    return element;
  }
  ignoreEvent() { return false; }
}

class TaskCheckbox extends WidgetType {
  constructor(readonly checkFrom: number, readonly checked: boolean, readonly label: string, readonly disabled: boolean) { super(); }
  eq(other: TaskCheckbox) { return this.checkFrom === other.checkFrom && this.checked === other.checked && this.label === other.label && this.disabled === other.disabled; }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span'); wrap.className = 'cm-task-control';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked; input.disabled = this.disabled;
    input.setAttribute('aria-label', this.label || '空のタスク'); input.title = '完了／未完了を切り替え（Ctrl+L）';
    input.addEventListener('mousedown', event => event.preventDefault());
    input.addEventListener('click', event => {
      event.stopPropagation();
      if (view.state.readOnly) { input.checked = this.checked; return; }
      view.dispatch({ changes: { from: this.checkFrom, to: this.checkFrom + 1, insert: input.checked ? 'x' : ' ' }, userEvent: 'input.task' });
      view.focus();
    });
    wrap.append(input); return wrap;
  }
  ignoreEvent() { return true; }
}

function preview(state: EditorState, previous?: Preview): Preview {
  const files = state.field(sourceFilesField);
  const index = state.field(noteIndexField, false) ?? { targets: [], files: new Map() };
  const resources = new Map(materialCatalog(index).materials.map(item => [location(item.path).key, item]));
  const { segments } = compose(files);
  const sources = files.map((file, index) => ({ path: file.path, text: file.content, from: segments[index].from,
    tree: previous?.sources.find(source => source.path === file.path && source.text === file.content)?.tree ?? markdownLanguage.parser.parse(file.content) }));
  const ranges: Range<Decoration>[] = [], hidden: Range<Decoration>[] = [];
  const edited = (from: number, to: number) => state.selection.ranges.some(range => {
    const start = state.doc.lineAt(range.from).from, end = state.doc.lineAt(range.to).to;
    return from <= end && to >= start;
  });
  function hide(from: number, to: number, widget?: WidgetType) {
    if (to <= from || state.doc.sliceString(from, to).includes('\n')) return;
    const range = Decoration.replace(widget ? { widget } : {}).range(from, to);
    ranges.push(range); hidden.push(range);
  }
  function mark(from: number, to: number, className: string, attributes?: Record<string, string>) {
    if (to > from) ranges.push(Decoration.mark({ class: className, ...(attributes ? { tagName: 'a', attributes } : {}) }).range(from, to));
  }
  function line(at: number, className: string) { ranges.push(Decoration.line({ class: className }).range(state.doc.lineAt(at).from)); }

  for (const source of sources) {
    const base = source.from;
    const frontmatter = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(source.text)?.[0].length ?? 0;
    const refs = noteReferences(source.path, source.text);
    for (const ref of refs.filter(ref => ref.syntax === 'wiki')) {
      const resolved = resolveNote(index, ref.target, source.path);
      const broken = !resolved.target || resolved.missingHeading;
      const label = ref.alias ?? (resolved.target?.name ?? decode(ref.target.split('#')[0]).split('/').at(-1)!.replace(/\.md$/i, '')) + (resolved.fragment ? ` › ${resolved.fragment}` : '');
      if (!edited(base + ref.from, base + ref.to)) {
        const range = Decoration.replace({ widget: new WikiLabel(ref.target, source.path, label, broken) }).range(base + ref.from, base + ref.to);
        ranges.push(range); hidden.push(range);
      } else mark(base + ref.labelFrom, base + ref.labelTo, 'cm-note-link' + (broken ? ' cm-note-link-missing' : ''), { href: '#', 'data-note-link': ref.target, 'data-note-source': source.path, 'data-note-syntax': 'wiki', 'data-source-editing': 'true', title: ref.target, tabindex: '-1' });
    }
    // References are scoped to their physical Markdown file, like code fences.
    const references = new Map<string, string>();
    const referenceName = (label: string) => label.slice(1, -1).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    source.tree.iterate({ enter(node) {
      if (node.name !== 'LinkReference') return;
      const label = node.node.getChild('LinkLabel'), url = node.node.getChild('URL');
      if (label && url) {
        const key = referenceName(source.text.slice(label.from, label.to));
        if (!references.has(key)) references.set(key, markdownDestination(source.text.slice(url.from, url.to)));
      }
    } });
    source.tree.iterate({ enter(node) {
      const from = base + node.from, to = base + node.to;
      const active = edited(from, to);
      const heading = /^(ATX|Setext)Heading([1-6])$/.exec(node.name);
      if (heading) line(from, `cm-heading cm-heading-${heading[2]}`);
      if (node.name === 'HeaderMark' && !active) {
        let end = to;
        if (state.doc.sliceString(to, to + 1) === ' ') end++;
        hide(from, end);
      }
      if (node.name === 'StrongEmphasis' || node.name === 'Emphasis') {
        mark(from, to, node.name === 'StrongEmphasis' ? 'cm-preview-strong' : 'cm-preview-emphasis');
        if (!active) for (const child of node.node.getChildren('EmphasisMark')) hide(base + child.from, base + child.to);
      }
      if (node.name === 'Strikethrough') {
        mark(from, to, 'cm-preview-strike');
        if (!active) for (const child of node.node.getChildren('StrikethroughMark')) hide(base + child.from, base + child.to);
      }
      if (node.name === 'HorizontalRule' && !active && node.from >= frontmatter) line(from, 'cm-preview-rule');
      if (node.name === 'InlineCode') {
        mark(from, to, 'cm-preview-inline-code');
        if (!active) {
          const delimiters = node.node.getChildren('CodeMark');
          for (const child of delimiters) hide(base + child.from, base + child.to);
          if (delimiters.length === 2) {
            const text = source.text.slice(delimiters[0].to, delimiters[1].from);
            if (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) {
              hide(base + delimiters[0].to, base + delimiters[0].to + 1);
              hide(base + delimiters[1].from - 1, base + delimiters[1].from);
            }
          }
        }
        return false;
      }
      if (node.name === 'Escape' && !active) hide(from, from + 1);
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const first = state.doc.lineAt(from).number, last = state.doc.lineAt(Math.max(from, to - 1)).number;
        for (let number = first; number <= last; number++) line(state.doc.line(number).from, `cm-code-block${number === first ? ' cm-code-first' : ''}${number === last ? ' cm-code-last' : ''}`);
        if (node.name === 'FencedCode' && !active) {
          const fences = node.node.getChildren('CodeMark');
          const info = node.node.getChild('CodeInfo');
          const opening = fences[0];
          if (opening) {
            hide(base + opening.from, state.doc.line(first).to, new CodeLanguage(info ? source.text.slice(info.from, info.to) : ''));
            line(from, 'cm-code-header');
          }
          if (fences.length > 1) {
            hide(base + fences[1].from, base + fences[1].to);
            line(base + fences[1].from, 'cm-code-footer');
          }
        }
        return false;
      }
      if (node.name === 'Blockquote') {
        const first = state.doc.lineAt(from).number, last = state.doc.lineAt(Math.max(from, to - 1)).number;
        for (let number = first; number <= last; number++) line(state.doc.line(number).from, 'cm-preview-quote');
      }
      if (node.name === 'QuoteMark' && !active) hide(from, to + (state.doc.sliceString(to, to + 1) === ' ' ? 1 : 0));
      // Preserve the original glyph's width and text positions. Replacing the
      // marker with an atomic widget shifts vertical navigation on every line.
      if (node.name === 'ListMark') {
        const task = node.from < frontmatter ? null : taskMarker(source.text, node.to);
        if (task) {
          const bodyFrom = base + task.bodyFrom, label = state.doc.sliceString(bodyFrom, state.doc.lineAt(bodyFrom).to);
          ranges.push(Decoration.mark({ class: 'cm-task-prefix', attributes: { 'aria-hidden': 'true' } }).range(from, bodyFrom));
          ranges.push(Decoration.widget({ widget: new TaskCheckbox(base + task.checkFrom, task.checked, label, state.readOnly), side: -1 }).range(from));
        } else if (/^[-+*]$/.test(source.text.slice(node.from, node.to))) ranges.push(Decoration.mark({ class: 'cm-list-bullet', attributes: { 'aria-hidden': 'true' } }).range(from, to));
      }
      if (node.name === 'Link' || node.name === 'Autolink') {
        if (refs.some(ref => ref.syntax === 'wiki' && ref.from <= node.from && ref.to >= node.to)) return false;
        const url = node.node.getChild('URL');
        const marks = node.node.getChildren('LinkMark');
        const label = node.node.getChild('LinkLabel');
        const destination = url ? markdownDestination(source.text.slice(url.from, url.to))
          : references.get(referenceName(label ? source.text.slice(label.from, label.to) : source.text.slice(node.from, node.to)));
        if (!destination || !marks.length || source.text.slice(node.from, node.to).includes('\n')) return false;
        const labelFrom = node.name === 'Autolink' ? url!.from : marks[0].to;
        const labelTo = node.name === 'Autolink' ? url!.to : marks[1]?.from;
        if (labelTo === undefined) return false;
        let resource;
        try { resource = resources.get(location(destination).key); } catch { /* Internal or unsupported link. */ }
        if (resource && !active) { hide(from, to, new ResourceLabel(resource.path, source.text.slice(labelFrom, labelTo), resource.type, resource.file.path)); return false; }
        const web = /^https?:\/\//i.test(destination);
        const external = web || /^file:\/\//i.test(destination);
        const internal = !web && !/^[a-z][a-z\d+.-]*:/i.test(destination) && (resolveNote(index, destination, source.path, 'markdown').target || /\.md(?:#|$)|^#/.test(destination));
        mark(base + labelFrom, base + labelTo, internal ? 'cm-note-link' + (!resolveNote(index, destination, source.path, 'markdown').target || resolveNote(index, destination, source.path, 'markdown').missingHeading ? ' cm-note-link-missing' : '') : 'cm-preview-link', external ? {
          href: destination, title: destination, 'data-preview-link': destination, 'data-source-editing': String(active), rel: 'noreferrer noopener', tabindex: '-1',
        } : internal ? { href: '#', title: destination, 'data-note-link': destination, 'data-note-source': source.path, 'data-note-syntax': 'markdown', 'data-source-editing': String(active), tabindex: '-1' } : undefined);
        if (!active) { hide(from, base + labelFrom); hide(base + labelTo, to); }
      }
      // Images and HTML remain literal until their dedicated rendering is added.
      if (node.name === 'Image' || node.name === 'LinkReference') return false;
    } });
  }
  return { sources, decorations: Decoration.set(ranges, true), hidden: Decoration.set(hidden, true) };
}

export const livePreview = StateField.define<Preview>({
  create: state => preview(state),
  update(value, transaction) {
    return transaction.docChanged || transaction.selection || transaction.reconfigured || transaction.effects.some(effect => effect.is(sourceFilesEffect) || effect.is(noteIndexEffect)) ? preview(transaction.state, value) : value;
  },
  provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).hidden)],
});

export function previewLinkEvents(open: (url: string) => void, openNote: (target: string, path: string, pane: 0 | 1, newTab: boolean, syntax: 'wiki' | 'markdown') => void = () => {}, pane: 0 | 1 = 0) {
  function link(event: MouseEvent): HTMLAnchorElement | null { return event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-preview-link], a[data-note-link]') : null; }
  function follow(target: HTMLAnchorElement, event: MouseEvent) {
    if (target.dataset.noteLink !== undefined) openNote(target.dataset.noteLink, target.dataset.noteSource!, event.ctrlKey && event.altKey ? 1 : pane, event.ctrlKey || event.metaKey || event.button === 1, target.dataset.noteSyntax === 'markdown' ? 'markdown' : 'wiki');
    else open(target.dataset.previewLink!);
  }
  function opens(event: MouseEvent, target: HTMLAnchorElement) {
    return event.button === 1 || event.ctrlKey || event.metaKey || target.dataset.sourceEditing !== 'true' && !event.altKey;
  }
  return EditorView.domEventHandlers({
    mousedown(event) { const target = link(event); if (target && opens(event, target)) { event.preventDefault(); return true; } return false; },
    click(event) {
      const target = link(event);
      if (!target) return false;
      event.preventDefault();
      if (opens(event, target)) follow(target, event);
      return true;
    },
    auxclick(event) {
      const target = link(event);
      if (!target || event.button !== 1) return false;
      event.preventDefault(); follow(target, event); return true;
    },
  });
}
