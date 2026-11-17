export interface FileEntry { path: string; name: string }
export interface ThemeEntry { path: string; name: string; files: FileEntry[] }
export interface VaultSnapshot { root: string; name: string; themes: ThemeEntry[]; notes: FileEntry[]; noteFolders?: string[]; materials?: FileEntry[] }
export interface DiskFile { path: string; content: string; revision: string }
export interface SourceFile {
  path: string;
  content: string;
  savedContent: string;
  revision: string | null;
  ending: '\n' | '\r\n' | '\r';
  bom: boolean;
}
export interface OpenDocument {
  id: string;
  label: string;
  kind: 'theme' | 'note' | 'material' | 'materials';
  files: SourceFile[];
}
export interface Segment { index: number; from: number; to: number; path: string; label: string }
export interface TextChange { from: number; to: number; insert: string }
export interface FileChange extends TextChange { index: number }

const compositions = new WeakMap<SourceFile[], { text: string; segments: Segment[] }>();
export function compose(files: SourceFile[]): { text: string; segments: Segment[] } {
  const cached = compositions.get(files); if (cached) return cached;
  let text = '';
  const segments: Segment[] = [];
  files.forEach((file, index) => {
    if (index) text += '\n\n';
    const from = text.length;
    text += file.content;
    segments.push({ index, from, to: text.length, path: file.path, label: file.path.split('/').at(-1)!.replace(/\.md$/i, '') });
  });
  const result = { text, segments }; compositions.set(files, result); return result;
}

// Project edits onto physical files; virtual month separators never become file content.
// A replacement spanning months deletes only selected file content and inserts at
// the start of the selection. The remaining month boundaries are preserved.
export function projectChanges(files: SourceFile[], changes: TextChange[]): FileChange[] {
  const { segments, text } = compose(files);
  if (!segments.length) return [];
  const result: FileChange[] = [];
  for (const change of changes) {
    if (change.from < 0 || change.to < change.from || change.to > text.length) throw new Error('編集位置が文書の範囲外です。');
    const owner = segments.find(s => change.from >= s.from && change.from <= s.to)
      ?? segments.find(s => s.from > change.from) ?? segments.at(-1)!;
    const insertion = Math.max(owner.from, Math.min(change.from, owner.to));
    let inserted = false;
    for (const s of segments) {
      const from = Math.max(change.from, s.from);
      const to = Math.min(change.to, s.to);
      if (to > from) {
        const insert = s.index === owner.index ? change.insert : '';
        result.push({ from, to, insert, index: s.index });
        if (s.index === owner.index) inserted = true;
      }
    }
    if (!inserted && change.insert) result.push({ from: insertion, to: insertion, insert: change.insert, index: owner.index });
  }
  return result.sort((a, b) => a.from - b.from || a.to - b.to);
}

export function applyChanges(files: SourceFile[], changes: TextChange[]): SourceFile[] {
  const projected = projectChanges(files, changes);
  const { segments } = compose(files);
  return files.map((file, index) => {
    const relevant = projected.filter(change => change.index === index);
    if (!relevant.length) return file;
    let content = file.content;
    for (const change of [...relevant].reverse()) {
      const base = segments[index].from;
      content = content.slice(0, change.from - base) + change.insert + content.slice(change.to - base);
    }
    return { ...file, content };
  });
}

export function fromDisk(file: DiskFile): SourceFile {
  const bom = file.content.startsWith('\uFEFF');
  const raw = bom ? file.content.slice(1) : file.content;
  const ending = /\r\n|\r|\n/.exec(raw)?.[0] as SourceFile['ending'] | undefined;
  const content = raw.replace(/\r\n|\r/g, '\n');
  return { path: file.path, revision: file.revision, content, savedContent: content, ending: ending ?? '\n', bom };
}
export function serializeFile(file: SourceFile): string { return (file.bom ? '\uFEFF' : '') + file.content.replace(/\n/g, file.ending); }
export function isDirty(file: SourceFile): boolean { return file.revision === null || file.content !== file.savedContent; }
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Only top-level ATX date headings outside fenced code count as daily records.
export function dateHeadings(content: string): { date: string; from: number; line: number }[] {
  const results: { date: string; from: number; line: number }[] = [];
  let fence: { char: string; size: number } | null = null;
  let offset = 0;
  content.split('\n').forEach((raw, line) => {
    const text = raw.replace(/\r$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = null;
    } else if (marker) {
      fence = { char: marker[1][0], size: marker[1].length };
    } else {
      const match = /^ {0,3}#\s+(\d{4}-\d{2}-\d{2})(?:\s+#+)?\s*$/.exec(text);
      if (match) results.push({ date: match[1], from: offset, line: line + 1 });
    }
    offset += raw.length + 1;
  });
  return results;
}

export function ensureToday(document: OpenDocument, date = localDate()): { document: OpenDocument; anchor: number } {
  if (document.kind !== 'theme') throw new Error('今日へ移動できるのはテーマのノートです。');
  const month = date.slice(0, 7);
  const path = `${document.id}/${month}.md`;
  let files = [...document.files];
  let index = files.findIndex(file => file.path === path);
  if (index < 0) {
    files.push({ path, content: '', savedContent: '', revision: null, ending: '\n', bom: false });
    files.sort((a, b) => a.path.localeCompare(b.path));
    index = files.findIndex(file => file.path === path);
  }
  let file = files[index];
  const headings = dateHeadings(file.content);
  const existing = headings.find(h => h.date === date);
  let anchor: number;
  if (existing) {
    const end = file.content.indexOf('\n', existing.from);
    if (end < 0) {
      file = { ...file, content: file.content + '\n\n' };
      anchor = file.content.length;
    } else anchor = end + 1;
  } else {
    const next = headings.find(h => h.date > date);
    const position = next?.from ?? file.content.length;
    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    const before = file.content.slice(0, position);
    const prefix = before && !before.endsWith(eol + eol) ? (before.endsWith(eol) ? eol : eol + eol) : '';
    const addition = `${prefix}# ${date}${eol}${eol}`;
    file = { ...file, content: before + addition + file.content.slice(position) };
    anchor = position + addition.length;
  }
  files[index] = file;
  const segment = compose(files).segments[index];
  return { document: { ...document, files }, anchor: segment.from + anchor };
}
