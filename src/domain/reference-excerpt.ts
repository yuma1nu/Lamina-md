import { noteReferences, decode } from './note-links';
import { markdownDestination } from './markdown';

// Plain text only: neither HTML nor document links are executed in excerpts.
export function excerptText(raw: string): string {
  let text = raw;
  for (const ref of noteReferences('excerpt.md', raw, true).sort((a, b) => b.from - a.from)) {
    const label = ref.syntax === 'wiki' ? ref.alias ?? decode(ref.target).split('/').at(-1)!.replace(/\.md(?=#|$)/i, '') : markdownDestination(raw.slice(ref.labelFrom, ref.labelTo));
    text = text.slice(0, ref.from) + label + text.slice(ref.to);
  }
  return text.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/`([^`]+)`/g, '$1');
}
