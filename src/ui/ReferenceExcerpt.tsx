import type { ReferenceHit } from '../domain/note-links';
import { excerptText } from '../domain/reference-excerpt';

export function ReferenceExcerpt({ hit, query = '' }: { hit: ReferenceHit; query?: string }) {
  const lines = hit.context.split('\n');
  return <span className="reference-excerpt">{lines.map((line, index) => {
    const text = excerptText(line), start = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
    return <span key={index} className={index === (hit.contextLine ?? 0) ? 'reference-current-line' : ''}>{start < 0 ? text || '\u00a0' : <>{text.slice(0, start)}<mark>{text.slice(start, start + query.length)}</mark>{text.slice(start + query.length)}</>}</span>;
  })}</span>;
}
