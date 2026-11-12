import { isMap, parseDocument, Scalar } from 'yaml';
import { dateHeadings, localDate, serializeFile, type SourceFile, type TextChange } from './documents';
import { noteReferences, type FileWrite, type NoteIndex, type ReferenceHit } from './note-links';
import { markdownDestination } from './markdown';

export const materialTypes = { excel: 'Excel', pdf: 'PDF', word: 'Word', powerpoint: 'PowerPoint', folder: 'フォルダー', web: 'Webページ', file: 'ファイル' } as const;
export interface MaterialProperties { title: string; type: string; path: string; added: string; memo: string; themes: string[] }
export interface Material extends MaterialProperties { file: SourceFile; body: string; bodyFrom: number }
export interface MaterialInsertion { documentId: string; pane: 0 | 1; sourcePath: string; from: number; to: number; expectedContent: string; apply: (change: TextChange) => void }
const unsafeExtensions = /\.(?:exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|scr|msi|msp|hta|lnk|url|reg)$/i;
const unquote = (raw: string) => { const text = raw.trim(); return /^(["'])([\s\S]*)\1$/.exec(text)?.[2] ?? text; };
export function location(raw: string): { path: string; key: string; href: string; web: boolean; name: string; type: string } {
  let path = unquote(raw);
  if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('資料のパスまたはURLを確認してください。');
  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path);
    if (!url.hostname || url.username || url.password) throw new Error('資料のURLを確認してください。');
    const href = url.href.replace(/[()]/g, char => char === '(' ? '%28' : '%29');
    const leaf = decode(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    const name = /\.[a-z\d]{1,8}$/i.test(leaf) ? leaf : url.hostname;
    return { path, key: 'web:' + href, href, web: true, name, type: inferType(leaf, 'web') };
  }
  if (/^file:/i.test(path)) {
    const url = new URL(path);
    if (url.search || url.hash || url.username || url.password) throw new Error('ファイルURLの記号はパーセントエンコードしてください。');
    path = url.hostname ? '\\\\' + url.hostname + decode(url.pathname).replace(/\//g, '\\') : decode(url.pathname).replace(/^\/(?=[a-z]:)/i, '').replace(/\//g, '\\');
  }
  path = path.replace(/\//g, '\\');
  if (!/^[a-z]:\\/i.test(path) && !/^\\\\[^\\?\.][^\\]*\\[^\\]+/.test(path)) throw new Error('ドライブ名付きのパス、共有パス、HTTP／HTTPSのURLを指定してください。');
  if (/[<>"|?*]/.test(path) || path.slice(2).includes(':')) throw new Error('資料のパスに使用できない文字があります。');
  const prefix = /^[a-z]:/i.test(path) ? path.slice(0, 3) : '\\\\';
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split('\\')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length <= (prefix === '\\\\' ? 2 : 0)) throw new Error('パスがルートの外を参照しています。'); parts.pop(); }
    else parts.push(part);
  }
  const normalized = prefix + parts.join('\\');
  const name = parts.at(-1) ?? prefix;
  const href = prefix === '\\\\' ? 'file://' + parts.map(encodeSegment).join('/') : 'file:///' + prefix.slice(0, 2) + '/' + parts.map(encodeSegment).join('/');
  return { path, key: 'file:' + normalized.toLocaleLowerCase('en-US'), href, web: false, name, type: inferType(name, 'file') };
}
function decode(value: string) { try { return decodeURIComponent(value); } catch { throw new Error('URLの文字コードを確認してください。'); } }
function encodeSegment(value: string) { return encodeURIComponent(value).replace(/[()']/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()); }
export function inferType(name: string, fallback = 'file'): string {
  return /\.(xlsx?|xlsm|xlsb|csv)$/i.test(name) ? 'excel' : /\.pdf$/i.test(name) ? 'pdf' : /\.docx?$/i.test(name) ? 'word' : /\.pptx?$/i.test(name) ? 'powerpoint' : fallback;
}
export function canOpenMaterial(path: string) { const target = location(path); if (!target.web && unsafeExtensions.test(target.name)) throw new Error('この形式は資料として開けません。'); return target; }
export function materialLink(title: string, path: string): string { return `[${title.replace(/[\\[\]]/g, char => '\\' + char)}](${location(path).href})`; }
export function materialDraft(path: string, theme?: string, filename?: string): MaterialProperties {
  const target = location(path), title = filename?.trim() || target.name;
  return { title, type: inferType(title, target.type), path: target.path, added: localDate(), memo: '', themes: theme ? [theme] : [] };
}
export function frontmatter(content: string) {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(content);
  if (!match) throw new Error('資料ページのYAMLフロントマターを読み込めません。元のMarkdownを確認してください。');
  const yaml = parseDocument(match[1], { uniqueKeys: true });
  if (yaml.errors.length || yaml.warnings.length || !isMap(yaml.contents)) throw new Error('資料ページのYAMLに不正な形式や未対応のタグがあります。元のMarkdownは保持しています。');
  return { yaml, bodyFrom: match[0].length, body: content.slice(match[0].length) };
}
export function validateMaterial(value: MaterialProperties) {
  for (const key of ['title', 'type', 'path', 'added', 'memo'] as const) if (typeof value[key] !== 'string') throw new Error(`資料の「${key}」は文字列で指定してください。`);
  if (!value.title.trim() || !value.type.trim()) throw new Error('資料名と種類を指定してください。');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value.added) ? new Date(value.added + 'T00:00:00Z') : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.added) throw new Error('追加日をYYYY-MM-DDの実在する日付で指定してください。');
  if (!Array.isArray(value.themes) || value.themes.some(theme => typeof theme !== 'string' || !theme.trim())) throw new Error('テーマは名前の配列で指定してください。');
  location(value.path);
}
export function readMaterial(file: SourceFile): Material {
  const { yaml, body, bodyFrom } = frontmatter(file.content);
  const data = yaml.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
  const value = Object.fromEntries(['title', 'type', 'path', 'added', 'memo', 'themes'].map(key => [key, data[key]])) as unknown as MaterialProperties;
  validateMaterial(value);
  return { ...value, file, body, bodyFrom };
}
type MaterialCatalog = { materials: Material[]; errors: { path: string; message: string }[] };
const materialIndexes = new WeakMap<NoteIndex, MaterialCatalog>();
const parsedMaterials = new Map<string, { content: string; material?: Material; error?: string }>();
export function materialCatalog(index: NoteIndex): MaterialCatalog {
  const cached = materialIndexes.get(index); if (cached) return cached;
  const materials: Material[] = [], errors: { path: string; message: string }[] = [];
  for (const file of index.files.values()) if (file.path.startsWith('資料/')) {
    let parsed = parsedMaterials.get(file.path);
    if (!parsed || parsed.content !== file.content) {
      try { parsed = { content: file.content, material: readMaterial(file) }; }
      catch (error) { parsed = { content: file.content, error: String(error instanceof Error ? error.message : error) }; }
      parsedMaterials.set(file.path, parsed);
    }
    if (parsed.material) materials.push({ ...parsed.material, file });
    else errors.push({ path: file.path, message: parsed.error! });
  }
  for (const path of parsedMaterials.keys()) if (!index.files.has(path)) parsedMaterials.delete(path);
  const result = { materials, errors }; materialIndexes.set(index, result); return result;
}
export function writeMaterial(value: MaterialProperties, original?: Material, body?: string): string {
  validateMaterial(value);
  const yaml = original ? frontmatter(original.file.content).yaml : parseDocument('{}');
  if (!original && isMap(yaml.contents)) yaml.contents.flow = false;
  for (const key of ['title', 'type', 'path', 'added', 'memo', 'themes'] as const) {
    const next = key === 'themes' ? [...new Set(value.themes)] : value[key];
    if (original && JSON.stringify(original[key]) === JSON.stringify(next)) continue;
    if (key === 'added') { const scalar = new Scalar(value.added); scalar.type = 'QUOTE_SINGLE'; yaml.set(key, scalar); }
    else yaml.set(key, next);
  }
  const content = body ?? original?.body ?? `\n${materialLink('元の資料を開く', value.path)}\n`;
  return '---\n' + yaml.toString({ lineWidth: 0 }) + '---\n' + content;
}
export function newMaterialPath(title: string, existing: Iterable<string>): string {
  let name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || '資料';
  while (new TextEncoder().encode(name).length > 130) name = name.slice(0, -1);
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  const paths = new Set([...existing].map(path => path.toLowerCase()));
  for (let n = 1; ; n++) { const path = `資料/${name}${n === 1 ? '' : ` (${n})`}.md`; if (!paths.has(path.toLowerCase())) return path; }
}
export function materialReferences(index: NoteIndex, material: Material): ReferenceHit[] {
  const key = location(material.path).key, hits: ReferenceHit[] = [];
  for (const file of index.files.values()) {
    if (file.path === material.file.path) continue;
    const source = index.targets.find(target => target.files.includes(file.path)); if (!source) continue;
    const dates = dateHeadings(file.content);
    for (const ref of noteReferences(file.path, file.content, true)) {
      if (ref.syntax !== 'markdown') continue;
      try { if (location(ref.target).key !== key) continue; } catch { continue; }
      const line = file.content.slice(0, ref.from).split('\n').length;
      const rawContext = file.content.split('\n').slice(Math.max(0, line - 2), line + 1).join('\n').trim();
      let context = rawContext;
      for (const link of noteReferences('context.md', rawContext, true).filter(link => link.syntax === 'markdown').sort((a, b) => b.from - a.from)) context = context.slice(0, link.from) + markdownDestination(rawContext.slice(link.labelFrom, link.labelTo)) + context.slice(link.to);
      hits.push({ source, path: file.path, from: ref.from, line, context, date: dates.filter(date => date.from <= ref.from).at(-1)?.date, fragment: '' });
    }
  }
  return hits;
}
export function rewriteMaterialLinks(index: NoteIndex, paths: string[], destination: string): FileWrite[] {
  const keys = new Set(paths.map(path => location(path).key)), href = location(destination).href, writes: FileWrite[] = [];
  for (const file of index.files.values()) {
    const edits = new Map<string, TextChange>();
    for (const ref of noteReferences(file.path, file.content, true)) {
      if (ref.syntax !== 'markdown') continue;
      try { if (!keys.has(location(ref.target).key)) continue; } catch { continue; }
      const insert = file.content[ref.targetFrom] === '<' ? `<${href}>` : href;
      if (file.content.slice(ref.targetFrom, ref.targetTo) !== insert) edits.set(`${ref.targetFrom}:${ref.targetTo}`, { from: ref.targetFrom, to: ref.targetTo, insert });
    }
    if (!edits.size) continue;
    let content = file.content;
    for (const edit of [...edits.values()].sort((a, b) => b.from - a.from)) content = content.slice(0, edit.from) + edit.insert + content.slice(edit.to);
    writes.push({ path: file.path, content: serializeFile({ ...file, content }), expectedRevision: file.revision });
  }
  return writes;
}
