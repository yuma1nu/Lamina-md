import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { markdownDestination } from './markdown';

export interface ImageReference { from: number; to: number; path: string; alt: string; width?: number }
export type ShapeKind = 'ellipse' | 'rect' | 'arrow' | 'line' | 'text';
export interface AnnotationShape { id: string; kind: ShapeKind; x: number; y: number; width: number; height: number; rotation: number; color: string; lineWidth: number; fontSize: number; text: string }
export interface Annotation { version: 1; width: number; height: number; shapes: AnnotationShape[] }
export interface ImageFile { path: string; data: string; mime: string; revision: string; annotation: Annotation | null; original: string | null }
export interface ImageWrite { path?: string; original: string; rendered: string; annotation: Annotation; expectedRevision?: string }

export function imagePath(source: string, destination: string): string | null {
  let value = markdownDestination(destination);
  try { value = decodeURIComponent(value); } catch { return null; }
  if (!value || /^(?:[a-z][\w+.-]*:|[/\\])/.test(value) || /[\x00-\x1f]/.test(value)) return null;
  const parts = source.split('/').slice(0, -1);
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
export function relativeImagePath(source: string, target: string): string {
  const from = source.split('/').slice(0, -1), to = target.split('/');
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to].join('/').replace(/[%\s#?()[\]<>"'&]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]/g, ' ');
export function imageMarkup(source: string, path: string, alt: string, width?: number): string {
  return `<img src="${relativeImagePath(source, path)}" alt="${escapeAttribute(alt)}"${width ? ` width="${Math.round(width)}"` : ''}>`;
}
export function imageReferences(content: string): ImageReference[] {
  const tree = commonmarkLanguage.parser.parse(content), result: ImageReference[] = [];
  const definitions = new Map<string, string>();
  const label = (text: string) => text.slice(1, -1).trim().replace(/\s+/g, ' ').toLowerCase();
  tree.iterate({ enter(node) {
    if (node.name === 'LinkReference') {
      const key = node.node.getChild('LinkLabel'), url = node.node.getChild('URL');
      if (key && url && !definitions.has(label(content.slice(key.from, key.to)))) definitions.set(label(content.slice(key.from, key.to)), content.slice(url.from, url.to));
      return false;
    }
  } });
  tree.iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'CommentBlock', 'ProcessingInstructionBlock'].includes(node.name)) return false;
    if (node.name === 'Image') {
      const url = node.node.getChild('URL'), key = node.node.getChild('LinkLabel'), marks = node.node.getChildren('LinkMark');
      const alt = marks.length >= 2 ? content.slice(marks[0].to, marks[1].from) : '';
      const path = url ? content.slice(url.from, url.to) : definitions.get(label(key ? content.slice(key.from, key.to) : `[${alt}]`));
      if (path) result.push({ from: node.from, to: node.to, path: markdownDestination(path), alt });
      return false;
    }
    if (node.name === 'HTMLTag' || node.name === 'HTMLBlock') {
      const raw = content.slice(node.from, node.to);
      // Render only one img tag, rebuilding its DOM from safe known properties.
      if (!/^<img\s+[^>\n]*\/?>(?:\s*)$/i.test(raw)) return false;
      const attributes = new Map<string, string>();
      for (const match of raw.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
      const path = attributes.get('src');
      const width = Number(attributes.get('width'));
      if (path) result.push({ from: node.from, to: node.from + raw.trimEnd().length, path: markdownDestination(path), alt: markdownDestination(attributes.get('alt') ?? ''), ...(Number.isFinite(width) && width >= 24 && width <= 20000 ? { width } : {}) });
      return false;
    }
  } });
  return result;
}
export function validateAnnotation(value: Annotation): Annotation {
  if (value.version !== 1 || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width * value.height > 40_000_000 || !Array.isArray(value.shapes) || value.shapes.length > 2000) throw new Error('注釈データの形式を読み込めません。');
  const ids = new Set<string>();
  for (const shape of value.shapes) {
    if (!['ellipse', 'rect', 'arrow', 'line', 'text'].includes(shape.kind) || typeof shape.id !== 'string' || ids.has(shape.id) || !/^#[\da-f]{6}$/i.test(shape.color) || typeof shape.text !== 'string' || shape.text.length > 20000 || ![shape.x, shape.y, shape.width, shape.height, shape.rotation, shape.lineWidth, shape.fontSize].every(n => Number.isFinite(n) && Math.abs(n) <= 100000) || shape.lineWidth < 1 || shape.lineWidth > 100 || shape.fontSize < 8 || shape.fontSize > 500) throw new Error('注釈の内容が不正です。元のデータは変更しません。');
    ids.add(shape.id);
  }
  return value;
}
