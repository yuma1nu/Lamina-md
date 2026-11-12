import { acceptCompletion, autocompletion, closeCompletion, completionKeymap, selectedCompletion, startCompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete';
import { EditorSelection } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { canonicalTarget, decode, encodeWiki, headings, isMarkupPosition, newNotePath, resolveNote, wikiLink, type NoteTarget } from '../../domain/note-links';
import { compose } from '../../domain/documents';
import { noteIndexField } from './live-preview';
import { sourceFilesField } from './source-model';

interface LinkOption extends Completion { target?: NoteTarget; fragment?: string }
export function noteCompletion(create: (target: string, sourcePath: string) => void) {
  const source: CompletionSource = context => {
    const match = context.matchBefore(/\[\[[^\]\n]*$/); if (!match) return null;
    const files = context.state.field(sourceFilesField), segment = compose(files).segments.find(segment => context.pos >= segment.from && context.pos <= segment.to);
    if (!segment || isMarkupPosition(segment.path, files[segment.index].content, context.pos - segment.from)) return null;
    const query = match.text.slice(2); if (query.includes('|')) return null;
    const index = context.state.field(noteIndexField), hash = query.indexOf('#');
    const options: LinkOption[] = [];
    function apply(view: EditorView, value: string, from: number, to: number) {
      const end = to + (view.state.doc.sliceString(to, to + 2) === ']]' ? 2 : 0);
      view.dispatch({ changes: { from: from - 2, to: end, insert: value }, selection: EditorSelection.cursor(from - 2 + value.length), userEvent: 'input.complete' });
      closeCompletion(view);
    }
    if (hash >= 0) {
      const target = resolveNote(index, query.slice(0, hash), segment.path).target;
      if (!target) return null;
      for (const path of target.files) for (const heading of headings(path, index.files.get(path)?.content ?? '')) {
        if (target.kind === 'theme' && !/^\d{4}-\d{2}-\d{2}$/.test(heading.title) || !heading.title.toLowerCase().includes(decode(query.slice(hash + 1)).toLowerCase())) continue;
        options.push({ label: heading.title, detail: target.name, target, fragment: heading.title, type: 'text', apply: (view, _option, from, to) => apply(view, wikiLink(index, target, heading.title), from, to) });
      }
    } else {
      const needle = decode(query).toLowerCase();
      for (const target of index.targets.filter(target => target.name.toLowerCase().includes(needle) || target.id.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id))) options.push({ label: target.name, detail: `${target.kind === 'theme' ? 'テーマ' : 'メモ'} · ${target.id}`, target, type: target.kind === 'theme' ? 'namespace' : 'text', apply: (view, _option, from, to) => apply(view, wikiLink(index, target), from, to) });
      if (query.trim() && !resolveNote(index, query, segment.path).target && !resolveNote(index, query, segment.path).ambiguous) {
        try {
          newNotePath(query, segment.path);
          options.push({ label: `新規メモを作成: ${decode(query)}`, detail: '作成してリンクを挿入', type: 'text', boost: -99, apply(view, _option, from, to) { apply(view, `[[${encodeWiki(decode(query))}]]`, from, to); create(query, segment.path); } });
        } catch { /* Invalid paths are not offered as a new note. */ }
      }
    }
    return options.length ? { from: match.from + 2, to: context.pos, options, filter: false } : null;
  };
  return [autocompletion({ override: [source], defaultKeymap: false, interactionDelay: 0, activateOnTypingDelay: 20, maxRenderedOptions: 30 }), keymap.of([
    ...completionKeymap,
    { key: 'Tab', run(view) {
      const chosen = selectedCompletion(view.state) as LinkOption | null;
      if (!chosen) return false;
      if (chosen.target?.kind === 'theme' && !chosen.fragment) {
        const match = /\[\[([^\]\n]*)$/.exec(view.state.doc.sliceString(view.state.doc.lineAt(view.state.selection.main.head).from, view.state.selection.main.head));
        if (!match) return false;
        const to = view.state.selection.main.head, from = to - match[1].length, value = canonicalTarget(view.state.field(noteIndexField), chosen.target);
        view.dispatch({ changes: { from, to, insert: value }, selection: { anchor: from + value.length }, userEvent: 'input.complete' });
        closeCompletion(view); startCompletion(view); return true;
      }
      return acceptCompletion(view);
    } },
  ])];
}
