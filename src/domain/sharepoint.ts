export type OfficeType = 'excel' | 'word' | 'powerpoint';

/** Classification only. Keep the original sharing URL in Markdown and YAML. */
export function sharePointOfficeType(raw: string, hint?: string): OfficeType | null {
  let url: URL; try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.sharepoint.com') || url.username || url.password || url.port) return null;
  const path = url.pathname.toLowerCase(), code = path.split('/')[1];
  if (code === ':x:') return 'excel';
  if (code === ':w:') return 'word';
  if (code === ':p:') return 'powerpoint';
  if ([':b:', ':f:', ':v:', ':o:'].includes(code) || /\.(pdf|aspx|html?)$/.test(path) || path.startsWith('/_layouts/')) return null;
  if (/\.(xls[xmb]?|xlt[xm]?|csv)$/.test(path)) return 'excel';
  if (/\.(doc[xm]?|dot[xm]?)$/.test(path)) return 'word';
  if (/\.(ppt[xm]?|pot[xm]?|pps[xm]?)$/.test(path)) return 'powerpoint';
  return hint === 'excel' || hint === 'word' || hint === 'powerpoint' ? hint : null;
}
