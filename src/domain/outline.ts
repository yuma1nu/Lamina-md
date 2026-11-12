import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { markdownDestination } from './markdown';
import { compose, type SourceFile } from './documents';

export interface OutlineHeading { title: string; level: number; from: number; path: string }
const headingCache = new WeakMap<SourceFile, OutlineHeading[]>();
export function outlineHeadings(files: SourceFile[]): OutlineHeading[] {
  const { segments } = compose(files);
  return files.flatMap((file, index) => {
    const cached = headingCache.get(file);
    if (cached) return cached.map(heading => ({ ...heading, from: segments[index].from + heading.from }));
    const results: OutlineHeading[] = [], text = file.content;
    const frontmatter = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text)?.[0].length ?? 0;
    commonmarkLanguage.parser.parse(text).iterate({ enter(node) {
      if (node.name !== 'Document' && node.from < frontmatter || ['FencedCode', 'CodeBlock', 'HTMLBlock', 'Blockquote', 'ListItem'].includes(node.name)) return false;
      const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name); if (!match) return;
      const omitted: { from: number; to: number }[] = [];
      node.node.toTree().iterate({ enter(child) {
        if (['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel'].includes(child.name)) { omitted.push({ from: node.from + child.from, to: node.from + child.to }); return false; }
        if (child.name === 'Escape') omitted.push({ from: node.from + child.from, to: node.from + child.from + 1 });
      } });
      let title = text.slice(node.from, node.to);
      for (const part of omitted.sort((a, b) => b.from - a.from)) title = title.slice(0, part.from - node.from) + title.slice(part.to - node.from);
      title = markdownDestination(title).trim().replace(/\s+/g, ' ');
      if (title) results.push({ title, level: Number(match[1]), from: node.from, path: file.path });
      return false;
    } });
    headingCache.set(file, results);
    return results.map(heading => ({ ...heading, from: segments[index].from + heading.from }));
  });
}
