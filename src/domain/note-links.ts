import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { dateHeadings, fromDisk, serializeFile, type DiskFile, type OpenDocument, type SourceFile, type VaultSnapshot } from './documents';
import { markdownDestination } from './markdown';
import { imageMarkup, imagePath, imageReferences } from './images';

export interface PathMove { from: string; to: string }
export interface Catalog { snapshot: VaultSnapshot; files: DiskFile[]; moves: PathMove[]; previous: { path: string; kind: string }[]; warnings: string[] }
export interface FileWrite { path: string; content: string; expectedRevision: string | null }
export interface Operation { relocation?: PathMove; writes: FileWrite[]; guards: { path: string; revision: string }[]; folders?: string[]; deletes?: { path: string; revision: string }[]; acceptMoves?: boolean }
export interface NoteTarget { id: string; name: string; kind: 'theme' | 'note' | 'material'; files: string[] }
export interface NoteReference { from: number; to: number; targetFrom: number; targetTo: number; target: string; syntax: 'wiki' | 'markdown'; alias?: string; labelFrom: number; labelTo: number; reference?: string; shortcut?: boolean }
export interface NoteIndex { targets: NoteTarget[]; files: Map<string, SourceFile> }
export interface ResolvedLink { target?: NoteTarget; fragment: string; path?: string; offset: number; ambiguous: boolean; missingHeading: boolean }
export interface ReferenceHit { source: NoteTarget; path: string; from: number; line: number; date?: string; context: string; fragment: string }

export function mapPath(path: string, moves: PathMove[]): string {
  const movement = moves.filter(move => path === move.from || path.startsWith(move.from + '/')).sort((a, b) => b.from.length - a.from.length)[0];
  return movement ? movement.to + path.slice(movement.from.length) : path;
}
export const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
export const encodePath = (path: string) => path.replace(/[%\s#?()[\]<>"\\]/g, character => encodeURIComponent(character).replace(/[()]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase()));
export const encodeWiki = (value: string) => value.replace(/[%#|\[\]]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
const basename = (path: string) => path.split('/').at(-1)!.replace(/\.md$/i, '');
function normalize(path: string): string | null {
  const result: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!result.length) return null; result.pop(); } else result.push(part); }
  return result.join('/');
}
function relative(from: string, to: string): string {
  const left = from.split('/').slice(0, -1), right = to.split('/');
  while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift(); }
  return [...left.map(() => '..'), ...right].join('/');
}
export function makeIndex(vault: VaultSnapshot, disk: DiskFile[], documents: Record<string, OpenDocument> = {}): NoteIndex {
  const files = new Map(disk.map(file => [file.path, fromDisk(file)]));
  for (const document of Object.values(documents)) for (const file of document.files) files.set(file.path, file);
  return { files, targets: [
    ...vault.themes.map(theme => ({ id: theme.path, name: theme.name, kind: 'theme' as const, files: [...files.keys()].filter(path => path.split('/').slice(0, -1).join('/') === theme.path).sort() })),
    ...vault.notes.map(note => ({ id: note.path, name: basename(note.path), kind: 'note' as const, files: [note.path] })),
    ...(vault.materials ?? []).map(note => ({ id: note.path, name: basename(note.path), kind: 'material' as const, files: [note.path] })),
  ] };
}
export function oldIndex(catalog: Catalog): NoteIndex {
  const inverse = catalog.moves.map(move => ({ from: move.to, to: move.from }));
  const current = makeIndex(catalog.snapshot, catalog.files);
  return { files: new Map([...current.files].map(([path, file]) => { const old = mapPath(path, inverse); return [old, { ...file, path: old }]; })), targets: catalog.previous.filter(entry => entry.kind === 'theme' || entry.kind === 'note' || entry.kind === 'material').map(entry => ({ id: entry.path, name: basename(entry.path), kind: entry.kind as NoteTarget['kind'], files: entry.kind !== 'theme' ? [entry.path] : catalog.previous.filter(file => file.kind === 'month' && file.path.split('/').slice(0, -1).join('/') === entry.path).map(file => file.path).sort() })) };
}
const cache = new Map<string, { content: string; tree: ReturnType<typeof commonmarkLanguage.parser.parse> }>();
function tree(path: string, content: string) {
  if (cache.get(path)?.content === content) return cache.get(path)!.tree;
  const value = commonmarkLanguage.parser.parse(content); cache.set(path, { content, tree: value }); return value;
}
const destination = markdownDestination;
const labelKey = (value: string) => value.slice(1, -1).replace(/\s+/g, ' ').trim().toLowerCase();
export function noteReferences(path: string, content: string, includeExternal = false): NoteReference[] {
  const syntax = tree(path, content), blocked: { from: number; to: number }[] = [], definitions = new Map<string, { from: number; to: number; target: string }>();
  const yaml = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(content);
  if (yaml) blocked.push({ from: 0, to: yaml[0].length });
  syntax.iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'ProcessingInstructionBlock', 'Image', 'LinkReference'].includes(node.name)) { blocked.push({ from: node.from, to: node.to }); if (node.name !== 'LinkReference') return false; }
    if (node.name === 'LinkReference') {
      const label = node.node.getChild('LinkLabel'), url = node.node.getChild('URL');
      if (label && url && !definitions.has(labelKey(content.slice(label.from, label.to)))) definitions.set(labelKey(content.slice(label.from, label.to)), { from: url.from, to: url.to, target: destination(content.slice(url.from, url.to)) });
      return false;
    }
  } });
  const references: NoteReference[] = [];
  syntax.iterate({ enter(node) {
    if (blocked.some(range => node.from >= range.from && node.to <= range.to)) return false;
    if (includeExternal && node.name === 'Autolink') {
      const url = node.node.getChild('URL');
      if (url) references.push({ from: node.from, to: node.to, targetFrom: url.from, targetTo: url.to, target: destination(content.slice(url.from, url.to)), syntax: 'markdown', labelFrom: url.from, labelTo: url.to });
      return false;
    }
    if (node.name !== 'Link') return;
    blocked.push({ from: node.from, to: node.to });
    const marks = node.node.getChildren('LinkMark'), url = node.node.getChild('URL'), label = node.node.getChild('LinkLabel');
    if (marks.length < 2) return false;
    const key = labelKey(label ? content.slice(label.from, label.to) : content.slice(node.from, node.to));
    const target = url ? { from: url.from, to: url.to, target: destination(content.slice(url.from, url.to)) } : definitions.get(key);
    if (target && (includeExternal || !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target.target))) references.push({ from: node.from, to: node.to, targetFrom: target.from, targetTo: target.to, target: target.target, syntax: 'markdown', labelFrom: marks[0].to, labelTo: marks[1].from, ...(url ? {} : { reference: key, shortcut: !label || content.slice(label.from, label.to) === '[]' }) });
    return false;
  } });
  const expression = /\[\[([^\]\n]+)\]\]/g;
  for (const match of content.matchAll(expression)) {
    const from = match.index, to = from + match[0].length;
    if (content[from - 1] === '!' || blocked.some(range => from >= range.from && from < range.to)) continue;
    let escapes = 0; for (let i = from - 1; i >= 0 && content[i] === '\\'; i--) escapes++; if (escapes % 2) continue;
    const pipe = match[1].indexOf('|'), target = (pipe < 0 ? match[1] : match[1].slice(0, pipe)).trim();
    if (!target) continue;
    references.push({ from, to, targetFrom: from + 2, targetTo: from + 2 + (pipe < 0 ? match[1].length : pipe), target, syntax: 'wiki', ...(pipe < 0 ? {} : { alias: match[1].slice(pipe + 1) }), labelFrom: pipe < 0 ? from + 2 : from + 3 + pipe, labelTo: to - 2 });
  }
  return references.sort((a, b) => a.from - b.from);
}
export function isMarkupPosition(path: string, content: string, position: number): boolean {
  let blocked = false;
  tree(path, content).iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'ProcessingInstructionBlock', 'Image'].includes(node.name) && node.from <= position && (position < node.to || ['FencedCode', 'CodeBlock'].includes(node.name) && position === node.to)) { blocked = true; return false; }
  } });
  return blocked;
}
export function headings(path: string, content: string): { title: string; from: number }[] {
  const result: { title: string; from: number }[] = [];
  tree(path, content).iterate({ enter(node) {
    if (['Blockquote', 'FencedCode', 'CodeBlock', 'ListItem'].includes(node.name)) return false;
    if (/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) result.push({ title: content.slice(node.from, node.to).split('\n')[0].replace(/^#+\s+/, '').replace(/\s+#+\s*$/, '').trim(), from: node.from });
  } }); return result;
}
export function resolveNote(index: NoteIndex, raw: string, sourcePath: string, syntax: 'wiki' | 'markdown' = 'wiki'): ResolvedLink {
  const [part, ...rest] = raw.split('#'), name = decode(part.trim()), fragment = decode(rest.join('#'));
  let candidates: NoteTarget[] = [];
  const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!name) candidates = index.targets.filter(target => target.files.includes(sourcePath));
  else {
    const exact = normalize(name.replace(/^\//, ''));
    const local = normalize(sourcePath.split('/').slice(0, -1).join('/') + '/' + name);
    const matches = (path: string | null) => index.targets.filter(target => path !== null && (equal(target.id, path) || target.kind !== 'theme' && equal(target.id.replace(/\.md$/i, ''), path) || target.files.some(file => equal(file, path))));
    candidates = syntax === 'markdown' || name.startsWith('.') ? matches(local) : matches(exact);
    if (!candidates.length) candidates = matches(exact);
    if (!candidates.length && !name.includes('/') && syntax === 'wiki') candidates = index.targets.filter(target => equal(target.name, name.replace(/\.md$/i, '')));
  }
  if (candidates.length !== 1) return { fragment, offset: 0, ambiguous: candidates.length > 1, missingHeading: false };
  const target = candidates[0];
  if (!fragment) return { target, path: target.kind !== 'theme' ? target.id : target.files[0], fragment, offset: 0, ambiguous: false, missingHeading: false };
  for (const path of target.files) {
    const content = index.files.get(path)?.content;
    const heading = content !== undefined ? headings(path, content).find(heading => equal(heading.title, fragment) || heading.title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') === fragment.toLowerCase()) : null;
    if (heading) return { target, path, fragment, offset: heading.from, ambiguous: false, missingHeading: false };
  }
  return { target, fragment, offset: 0, ambiguous: false, missingHeading: true };
}
export function canonicalTarget(index: NoteIndex, target: NoteTarget): string {
  return encodeWiki(index.targets.filter(other => other.name.toLowerCase() === target.name.toLowerCase()).length === 1 ? target.name : target.id.replace(/\.md$/i, ''));
}
export function wikiLink(index: NoteIndex, target: NoteTarget, fragment = ''): string { return `[[${canonicalTarget(index, target)}${fragment ? '#' + encodeWiki(fragment) : ''}]]`; }
export function newNotePath(raw: string, sourcePath = 'メモ/index.md'): string {
  const value = decode(raw.split('#')[0]).trim().replace(/\\/g, '/');
  const path = value.startsWith('.') ? normalize(sourcePath.split('/').slice(0, -1).join('/') + '/' + value) : value.startsWith('メモ/') ? normalize(value) : !value.includes('/') ? 'メモ/' + value : null;
  if (!path || !path.startsWith('メモ/') || !value || path.endsWith('/')) throw new Error('メモ名、または「メモ/フォルダー/メモ名」を指定してください。');
  return /\.md$/i.test(path) ? path : path + '.md';
}
export function movedSnapshot(snapshot: VaultSnapshot, moves: PathMove[]): VaultSnapshot {
  const entries = (items: VaultSnapshot['notes']) => items.map(note => { const path = mapPath(note.path, moves); return { path, name: path.split('/').at(-1)! }; });
  return { ...snapshot, themes: snapshot.themes.map(theme => { const path = mapPath(theme.path, moves); return { ...theme, path, name: path.split('/').at(-1)!, files: theme.files.map(file => ({ ...file, path: mapPath(file.path, moves), name: mapPath(file.path, moves).split('/').at(-1)! })) }; }), notes: entries(snapshot.notes), materials: entries(snapshot.materials ?? []) };
}
export function referenceHits(index: NoteIndex, targetId: string): ReferenceHit[] {
  const results: ReferenceHit[] = [];
  for (const [path, file] of index.files) {
    const source = index.targets.find(target => target.files.includes(path)); if (!source) continue;
    const dates = dateHeadings(file.content);
    for (const ref of noteReferences(path, file.content)) {
      const resolved = resolveNote(index, ref.target, path, ref.syntax);
      if (resolved.target?.id !== targetId || resolved.missingHeading) continue;
      const before = file.content.slice(0, ref.from), line = before.split('\n').length;
      results.push({ source, path, from: ref.from, line, date: dates.filter(date => date.from <= ref.from).at(-1)?.date, context: file.content.split('\n').slice(Math.max(0, line - 2), line + 1).join('\n').trim(), fragment: resolved.fragment });
    }
  }
  return results;
}
export function searchNotes(index: NoteIndex, query: string): ReferenceHit[] {
  const needle = query.trim().toLowerCase(); if (!needle) return [];
  const results: ReferenceHit[] = [];
  for (const [path, file] of index.files) {
    const source = index.targets.find(target => target.files.includes(path)); if (!source) continue;
    const dates = dateHeadings(file.content); let offset = 0;
    file.content.split('\n').forEach((text, line) => {
      const position = text.toLowerCase().indexOf(needle);
      if (position >= 0) results.push({ source, path, from: offset + position, line: line + 1, date: dates.filter(date => date.from <= offset).at(-1)?.date, context: text.trim(), fragment: '' });
      offset += text.length + 1;
    });
  }
  return results;
}
export function rewriteLinks(before: NoteIndex, after: NoteIndex, moves: PathMove[], files: Map<string, SourceFile>, alreadyMoved = false): FileWrite[] {
  const inverse = moves.map(move => ({ from: move.to, to: move.from }));
  const writes: FileWrite[] = [];
  for (const file of files.values()) {
    const oldPath = alreadyMoved ? mapPath(file.path, inverse) : file.path, newPath = mapPath(oldPath, moves);
    const edits = new Map<string, { from: number; to: number; insert: string }>();
    const add = (from: number, to: number, insert: string) => { if (file.content.slice(from, to) !== insert) edits.set(`${from}:${to}`, { from, to, insert }); };
    for (const ref of noteReferences(oldPath, file.content)) {
      const resolved = resolveNote(before, ref.target, oldPath, ref.syntax); if (!resolved.target) continue;
      const target = after.targets.find(target => target.id === mapPath(resolved.target!.id, moves)); if (!target) continue;
      const current = resolveNote(after, ref.target, newPath, ref.syntax);
      const affected = target.id !== resolved.target.id || current.target?.id !== target.id || ref.syntax === 'markdown' && oldPath !== newPath;
      if (!affected) continue;
      if (ref.syntax === 'wiki') add(ref.targetFrom, ref.targetTo, canonicalTarget(after, target) + (resolved.fragment ? '#' + encodeWiki(resolved.fragment) : ''));
      else {
        const physical = resolved.path ? mapPath(resolved.path, moves) : target.id;
        const dest = encodePath(relative(newPath, physical)) + (resolved.fragment ? '#' + encodeURIComponent(resolved.fragment) : '');
        const original = file.content.slice(ref.targetFrom, ref.targetTo);
        add(ref.targetFrom, ref.targetTo, original.startsWith('<') ? `<${dest}>` : dest);
        const label = file.content.slice(ref.labelFrom, ref.labelTo);
        if (target.name !== resolved.target.name && (label === resolved.target.name || label === resolved.target.name + '.md')) {
          const replacement = target.name + (label.endsWith('.md') ? '.md' : '');
          if (ref.shortcut && ref.reference) add(ref.from, ref.to, `[${replacement}][${ref.reference}]`);
          else add(ref.labelFrom, ref.labelTo, replacement);
        }
      }
    }
    if (oldPath !== newPath) for (const image of imageReferences(file.content)) {
      const path = imagePath(oldPath, image.path);
      if (path) add(image.from, image.to, imageMarkup(newPath, mapPath(path, moves), image.alt, image.width));
    }
    if (!edits.size) continue;
    let content = file.content;
    for (const edit of [...edits.values()].sort((a, b) => b.from - a.from)) content = content.slice(0, edit.from) + edit.insert + content.slice(edit.to);
    writes.push({ path: file.path, content: serializeFile({ ...file, content }), expectedRevision: file.revision });
  }
  return writes;
}
