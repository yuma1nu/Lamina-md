import { restoredHistory, retainHistory } from './editor-history';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChangeSet, Compartment, EditorState, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { foldEffect, foldedRanges, indentUnit, unfoldEffect } from '@codemirror/language';
import { compose, projectChanges, type OpenDocument, type Segment } from '../../domain/documents';
import { useWorkspace, workspace } from '../../app/workspace';
import { trackPendingFocus } from '../../app/refresh-focus';
import { documentPosition, filePosition } from '../../domain/session';
import { changesOf, sourceFilesEffect, sourceFilesField } from './source-model';
import { livePreview, noteIndexEffect, noteIndexField, previewLinkEvents } from './live-preview';
import { markdownBackspace, markdownDelete, markdownEnter, markdownListDedent, markdownListIndent, markdownListMoveUp, markdownListMoveDown, markdownSoftBreak } from './markdown-commands';
import { headingFoldField, headingFolding } from './heading-folding';
import { markdownTaskToggle } from './task-list';
import { markdownFormatting } from './formatting';
import { noteCompletion } from './note-completion';
import { imageExtensions, refreshImagePreview, type ImageEditRequest } from '../images/image-preview';

import { AnnotationEditor } from '../images/AnnotationEditor';
import { materialEditor } from '../materials/material-editor';
import { materialCommitted } from '../materials/material-service';
import { readMaterial } from '../../domain/materials';
import { listCaretGuard, listCursorLeft, listPrefixField } from './list-navigation';

class MonthWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(other: MonthWidget) { return other.label === this.label; }
  toDOM() {
    const element = document.createElement('div');
    element.className = 'month-divider';
    const label = document.createElement('div');
    label.className = 'month-divider-label';
    label.textContent = this.label.replace(/^(\d{4})-(\d{2})$/, (_, year: string, month: string) => `${year}年${Number(month)}月`);
    element.append(label);
    return element;
  }
  ignoreEvent() { return true; }
}
function boundaries(segments: Segment[]): DecorationSet {
  return Decoration.set(segments.map((segment, index) => index === 0
    ? Decoration.widget({ widget: new MonthWidget(segment.label), block: true, side: -1 }).range(segment.from)
    : Decoration.replace({ widget: new MonthWidget(segment.label), block: true, inclusive: false }).range(segments[index - 1].to, segment.from)), true);
}

export function MarkdownEditor({ document, pane, jump, bodyOnly = false }: { document: OpenDocument; pane: 0 | 1; jump: { anchor: number; sequence: number } | null; bodyOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null);
  const [imageRequest, setImageRequest] = useState<ImageEditRequest | null>(null);
  const latest = useRef(document);
  const locked = useWorkspace(state => state.busy || state.closing);
  const catalog = useWorkspace(state => state.catalog), documents = useWorkspace(state => state.documents);
  const split = useWorkspace(state => state.split), previousSplit = useRef(split);
  const editability = useRef(new Compartment()).current;
  latest.current = document;
  useLayoutEffect(() => {
    const current = latest.current;
    const historyKey = `${useWorkspace.getState().vault?.root}\0${pane}\0${current.id}\0${bodyOnly}`;
    const focusOwner = window.document.activeElement;
    const mayAutoFocus = !(focusOwner instanceof HTMLElement && focusOwner.matches('input, textarea, select'));
    const stillRequested = trackPendingFocus();
    const saved = useWorkspace.getState().views[pane][current.id];
    const startingSelection = saved ? { anchor: documentPosition(current.files, saved.anchor), head: documentPosition(current.files, saved.head) } : { anchor: 0 };
    let restoring = !!saved;
    function capture(view: EditorView) {
      if (restoring) return;
      const files = bodyOnly ? latest.current.files : useWorkspace.getState().documents[current.id]?.files ?? latest.current.files;
      const { anchor, head } = view.state.selection.main;
      const folds: NonNullable<import('../../domain/session').EditorPosition['folds']> = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { folds.push({ from: filePosition(files, from), to: filePosition(files, to) }); });
      workspace.captureView(pane, current.id, { anchor: filePosition(files, anchor), head: filePosition(files, head), scrollTop: view.scrollDOM.scrollTop, folds });
    }
    const monthly = StateField.define<DecorationSet>({
      create: () => current.kind === 'theme' ? boundaries(compose(current.files).segments) : Decoration.none,
      update(value, transaction) {
        return transaction.docChanged || transaction.effects.some(effect => effect.is(sourceFilesEffect))
          ? current.kind === 'theme' ? boundaries(compose(transaction.state.field(sourceFilesField)).segments) : Decoration.none : value;
      },
      provide: field => EditorView.decorations.from(field),
    });
    const materials = materialEditor(() => editor.current, current.id, pane, bodyOnly);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: compose(current.files).text,
        selection: startingSelection,
        extensions: [
          editability.of([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]),
          markdown({ addKeymap: false }), history(), restoredHistory(historyKey, compose(current.files).text), drawSelection(), noteIndexField.init(() => workspace.index()), noteCompletion((target, path) => void workspace.createLinkedNote(target, path, pane, true)), keymap.of([{ key: 'ArrowLeft', run: listCursorLeft }, { key: 'Enter', run: markdownEnter }, { key: 'Shift-Enter', run: markdownSoftBreak }, { key: 'Backspace', run: markdownBackspace }, { key: 'Delete', run: markdownDelete }, { key: 'Mod-l', run: markdownTaskToggle, preventDefault: true }, { key: 'Alt-ArrowUp', run: markdownListMoveUp, preventDefault: true }, { key: 'Alt-ArrowDown', run: markdownListMoveDown, preventDefault: true }, { key: 'Tab', run: markdownListIndent, shift: markdownListDedent }, { key: 'Mod-Shift-z', run: redo, preventDefault: true }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          markdownFormatting, indentUnit.of('    '), EditorState.tabSize.of(4),
          sourceFilesField.init(() => current.files),
          listPrefixField, listCaretGuard,
          materials.extensions,
          imageExtensions(useWorkspace.getState().vault!.root, setImageRequest),
          EditorView.lineWrapping, monthly, livePreview, headingFolding, previewLinkEvents(url => void workspace.openResource(url), (target, path, pane, newTab, syntax) => void workspace.openInternalLink(target, path, pane, newTab, syntax), pane),
          EditorView.contentAttributes.of({ 'aria-label': `${current.label}の本文`, spellcheck: 'false' }),
          EditorState.transactionExtender.of(transaction =>
            transaction.isUserEvent('input.indent') || transaction.isUserEvent('delete.dedent') || transaction.isUserEvent('input.image') || transaction.isUserEvent('input.material') || transaction.isUserEvent('input.task') || transaction.isUserEvent('input.format') || transaction.isUserEvent('move.list') || transaction.isUserEvent('delete.join')
              ? { annotations: isolateHistory.of('full') } : null),
          EditorState.transactionFilter.of(transaction => {
            if (!transaction.docChanged || transaction.annotation(Transaction.addToHistory) === false || transaction.annotation(materialCommitted)) return transaction;
            if (useWorkspace.getState().closing || useWorkspace.getState().busy) return [];
            const original = changesOf(transaction);
            const indenting = transaction.isUserEvent('input.indent') || transaction.isUserEvent('delete.dedent');
            const files = transaction.startState.field(sourceFilesField);
            const { segments } = compose(files);
            // Virtual month-divider lines must not indent the following month.
            const physical = indenting ? original.filter(change => segments.some(segment => change.from >= segment.from && change.from <= segment.to)) : original;
            const projected = projectChanges(files, physical).map(({ from, to, insert }) => ({ from, to, insert }));
            if (JSON.stringify(original) === JSON.stringify(projected)) return transaction;
            const changes = ChangeSet.of(projected, transaction.startState.doc.length);
            const first = projected[0];
            return { changes, selection: indenting ? transaction.startState.selection.map(changes) : { anchor: first ? changes.mapPos(first.from, -1) + first.insert.length : transaction.startState.selection.main.head }, scrollIntoView: transaction.scrollIntoView, annotations: Transaction.userEvent.of(transaction.annotation(Transaction.userEvent) ?? 'input') };
          }),
          EditorView.updateListener.of(update => {
            for (const transaction of update.transactions) if (transaction.docChanged && transaction.annotation(Transaction.addToHistory) !== false && !transaction.annotation(materialCommitted)) {
              const offset = bodyOnly ? readMaterial(useWorkspace.getState().documents[current.id].files[0]).bodyFrom : 0;
              workspace.edit(current.id, changesOf(transaction).map(change => ({ ...change, from: change.from + offset, to: change.to + offset })));
            }
            if (update.docChanged || update.selectionSet) { restoring = false; capture(update.view); }
            else if (!restoring && update.transactions.some(tr => tr.effects.some(effect => effect.is(foldEffect) || effect.is(unfoldEffect)))) capture(update.view);
          }),
          EditorView.domEventHandlers({
            scroll: (_event, view) => { capture(view); },
            compositionstart: (_event, view) => { workspace.setEditorComposing(view, true); },
            compositionend: (_event, view) => { workspace.setEditorComposing(view, false); },
          }),
          EditorView.theme({
            '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
            '.cm-scroller': { fontFamily: 'var(--font-body)', lineHeight: '1.8', overflow: 'auto' },
            '.cm-content': { padding: '16px 0 140px', maxWidth: '780px', margin: '0 auto', width: '100%', caretColor: '#e0e2de' },
            '.cm-line': { padding: '0 42px' },
            '.cm-cursor': { borderLeftColor: '#e0e2de' },
            '&.cm-focused': { outline: 'none' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: '#394441' },
            '.cm-gutters': { display: 'none' },
          }, { dark: true }),
        ],
      }).update({ selection: startingSelection }).state,
    });
    const restoredFolds = (saved?.folds ?? []).flatMap(fold => {
      const from = documentPosition(current.files, fold.from), to = documentPosition(current.files, fold.to);
      const valid = view.state.field(headingFoldField).find(range => range.from === from && range.to === to);
      return valid && !(view.state.selection.main.head > from && view.state.selection.main.head < to) ? [foldEffect.of(valid)] : [];
    });
    if (restoredFolds.length) view.dispatch({ effects: restoredFolds });
    editor.current = view;
    const stopDrops = materials.listenDrops();
    const imagesChanged = () => refreshImagePreview(view);
    window.addEventListener('lamina-images-changed', imagesChanged);
    view.requestMeasure({
      read: () => saved?.scrollTop ?? 0,
      write: top => {
        const mayFocus = stillRequested();
        if (editor.current !== view) return;
        if (saved && restoring) view.scrollDOM.scrollTop = top;
        restoring = false;
        const state = useWorkspace.getState();
        const owner = window.document.activeElement;
        if (mayAutoFocus && mayFocus && !state.busy && !state.closing && window.document.hasFocus() && state.activePane === pane && state.panes[pane].active === current.id && (owner === focusOwner || owner === window.document.body || owner === view.contentDOM)) view.focus();
      },
    });
    return () => { stillRequested(); workspace.setEditorComposing(view, false); stopDrops(); window.removeEventListener('lamina-images-changed', imagesChanged); capture(view); retainHistory(historyKey, view.state); editor.current = null; view.destroy(); };
  }, [document.id, pane, bodyOnly]);
  useEffect(() => {
    editor.current?.dispatch({ effects: editability.reconfigure([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]) });
  }, [locked, document.id, editability]);
  useEffect(() => {
    if (pane === 0 && previousSplit.current && !split) editor.current?.focus();
    previousSplit.current = split;
  }, [split, pane]);
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    const { text } = compose(document.files);
    const old = view.state.doc.toString();
    if (old !== text) {
      let prefix = 0;
      while (prefix < old.length && prefix < text.length && old[prefix] === text[prefix]) prefix++;
      let suffix = 0;
      while (suffix < old.length - prefix && suffix < text.length - prefix && old[old.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
      view.dispatch({ changes: { from: prefix, to: old.length - suffix, insert: text.slice(prefix, text.length - suffix) }, effects: sourceFilesEffect.of(document.files), annotations: Transaction.addToHistory.of(false) });
    } else view.dispatch({ effects: sourceFilesEffect.of(document.files) });
  }, [document.files, document.kind]);
  useEffect(() => { editor.current?.dispatch({ effects: noteIndexEffect.of(workspace.index()) }); }, [catalog, documents, document.id]);
  useEffect(() => {
    const view = editor.current;
    if (!view || !jump) return;
    const anchor = Math.min(jump.anchor, view.state.doc.length);
    view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    view.focus();
  }, [jump?.sequence]);
  return <><div className="editor-mount" ref={host} onFocusCapture={() => workspace.activate(pane)} />{imageRequest && <AnnotationEditor request={imageRequest} close={() => setImageRequest(null)} />}</>;
}
