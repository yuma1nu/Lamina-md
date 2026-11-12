function validPart(part: string): boolean {
  const stem = part.split('.')[0].toUpperCase();
  return !!part && part !== '.' && part !== '..' && part === part.trim() && !part.endsWith('.') && !/[<>:"/\\|?*\x00-\x1f]/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) && new TextEncoder().encode(part).length <= 180;
}
export function isNoteFolder(path: string): boolean { return path.split('/')[0] === 'メモ' && path.split('/').every(validPart); }
export function childNotePath(folder: string, title: string): string {
  const name = title.trim().replace(/\.md$/i, '');
  if (!isNoteFolder(folder) || !validPart(name + '.md') || !name || name === '.' || name === '..') throw new Error('メモの名前を確認してください。フォルダー区切りやWindowsで使用できない名前は使えません。');
  return `${folder}/${name}.md`;
}
export function childFolderPath(parent: string, name: string): string {
  const value = name.trim(), relative = parent === 'メモ' && value.startsWith('メモ/') ? value.slice('メモ/'.length) : value;
  if (!isNoteFolder(parent) || !relative.split('/').every(validPart)) throw new Error('フォルダー名を確認してください。相対指定やWindowsで使用できない名前は使えません。');
  return `${parent}/${relative}`;
}
export function noteMoveTarget(source: string, folder: string): string | null {
  if (!isNoteFolder(source) || source === 'メモ' || !isNoteFolder(folder)) return null;
  const destination = `${folder}/${source.split('/').at(-1)}`;
  const current = source.toLowerCase(), next = destination.toLowerCase(), parent = folder.toLowerCase();
  if (current === next || parent === current || parent.startsWith(current + '/')) return null;
  return destination;
}
