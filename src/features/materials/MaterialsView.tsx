import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpRight, Database, File, FileSpreadsheet, FileText, Folder, Globe, Info, Merge, Plus, Search } from 'lucide-react';
import { useWorkspace, workspace } from '../../app/workspace';
import { materialReferences, materialTypes, readMaterial, type Material, type MaterialProperties } from '../../domain/materials';
import type { OpenDocument } from '../../domain/documents';
import { editMaterial, mergeMaterials, requestMaterial } from './material-service';

const MarkdownEditor = lazy(() => import('../editor/MarkdownEditor').then(module => ({ default: module.MarkdownEditor })));
export function MaterialIcon({ type, size = 16 }: { type: string; size?: number }) {
  const Icon = type === 'excel' ? FileSpreadsheet : type === 'folder' ? Folder : type === 'web' ? Globe : ['pdf', 'word', 'powerpoint'].includes(type) ? FileText : File;
  return <Icon size={size} className={`material-type-icon type-${type}`} />;
}
export function MaterialBacklinks({ material, pane }: { material: Material; pane: 0 | 1 }) {
  useWorkspace(state => state.catalog); useWorkspace(state => state.documents);
  const refs = materialReferences(workspace.index(), material);
  return <div className="material-backlinks"><h3>参照元<span>{refs.length}</span></h3>{refs.length ? refs.map((hit, i) => <button className="backlink-card" key={`${hit.path}:${hit.from}:${i}`} title={`${hit.path}:${hit.line}`} onClick={event => void workspace.openHit(hit, event.ctrlKey && event.altKey ? 1 : pane, event.ctrlKey || event.metaKey)}><strong>{hit.source.name}</strong><span className="reference-meta">{hit.date ?? 'メモ'} · {hit.line}行</span><p>{hit.context}</p></button>) : <p className="empty-message">この資料への参照はまだありません。</p>}</div>;
}
function PropertyInput({ material, property, done }: { material: Material; property: 'title' | 'added' | 'memo' | 'themes' | 'path'; done?: () => void }) {
  const initial = property === 'themes' ? material.themes.join(', ') : material[property];
  const [value, setValue] = useState(initial), [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => setValue(initial), [initial]);
  async function commit() {
    if (cancelled.current) { cancelled.current = false; done?.(); return; }
    if (value === initial || saving) { done?.(); return; }
    setSaving(true);
    const next = property === 'themes' ? [...new Set(value.split(/[,、]/).map(theme => theme.trim()).filter(Boolean))] : value;
    const ok = await workspace.saveMaterial({ ...material, [property]: next }, material);
    setSaving(false);
    if (ok) done?.();
  }
  return <input className="material-cell-input" autoFocus={property === 'title'} aria-label={`${material.title}の${{ title: '資料名', added: '追加日', memo: 'メモ', themes: 'テーマ', path: 'パス' }[property]}`} title={value} type={property === 'added' ? 'date' : 'text'} value={value} onChange={event => setValue(event.target.value)} onBlur={() => void commit()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; setValue(initial); event.currentTarget.blur(); } }} disabled={saving} />;
}
function MaterialTitleCell({ material, select }: { material: Material; select: () => void }) {
  const [editing, setEditing] = useState(false);
  return <div className="material-title-cell">{editing ? <PropertyInput material={material} property="title" done={() => setEditing(false)} /> : <button className="material-row-title" aria-label={`${material.title}の詳細`} title="クリックで詳細・ダブルクリックで名前を編集" onClick={select} onDoubleClick={() => setEditing(true)} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); setEditing(true); } }}><MaterialIcon type={material.type} /><span>{material.title}</span></button>}<button className="icon-button material-row-action" aria-label={`${material.title}を開く`} title="資料本体を開く" onClick={() => void workspace.openResource(material.path)}><ArrowUpRight size={15} /></button><button className="icon-button material-row-action" aria-label={`${material.title}のプロパティ`} title="プロパティを編集" onClick={() => editMaterial(material)}><Info size={13} /></button></div>;
}
export function MaterialsView({ pane }: { pane: 0 | 1 }) {
  useWorkspace();
  const [query, setQuery] = useState(''), [type, setType] = useState(''), [theme, setTheme] = useState(''), [after, setAfter] = useState(''), [before, setBefore] = useState('');
  const [sort, setSort] = useState<keyof MaterialProperties>('added'), [descending, setDescending] = useState(true), [showPath, setShowPath] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [checked, setChecked] = useState<string[]>([]);
  const { materials, errors } = workspace.materials();
  const themeNames = [...new Set(materials.flatMap(item => item.themes))].sort((a, b) => a.localeCompare(b, 'ja'));
  const types = [...new Set([...Object.keys(materialTypes), ...materials.map(item => item.type)])];
  const visible = materials.filter(item => (!type || item.type === type) && (!theme || (theme === '@none' ? !item.themes.length : item.themes.includes(theme))) && (!after || item.added >= after) && (!before || item.added <= before) && [item.title, item.path, item.memo, ...item.themes].join('\n').toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => String(a[sort]).localeCompare(String(b[sort]), 'ja', { numeric: true }) * (descending ? -1 : 1) || a.file.path.localeCompare(b.file.path));
  const detail = materials.find(item => item.file.path === selected);
  const merged = checked.map(path => materials.find(item => item.file.path === path)).filter((item): item is Material => !!item);
  return <div className="materials-view"><div className="materials-heading"><div><span className="document-kicker">LIBRARY</span><h1><Database size={25} />資料一覧<span>{materials.length}</span></h1><p>記録につながる、仕事の資料。</p></div><button className="button primary" onClick={() => requestMaterial()}><Plus size={15} />資料を登録</button></div>
    <div className="material-filters"><label className="material-search"><Search size={15} /><input aria-label="資料を検索" placeholder="資料名・メモ・パスを検索" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="種類で絞り込み" value={type} onChange={event => setType(event.target.value)}><option value="">すべての種類</option>{types.map(type => <option key={type} value={type}>{materialTypes[type as keyof typeof materialTypes] ?? type}</option>)}</select><select aria-label="テーマで絞り込み" value={theme} onChange={event => setTheme(event.target.value)}><option value="">すべてのテーマ</option><option value="@none">テーマ未指定</option>{themeNames.map(theme => <option key={theme}>{theme}</option>)}</select><select aria-label="資料の並べ替え" value={sort} onChange={event => setSort(event.target.value as keyof MaterialProperties)}>{Object.entries({ added: '追加日', title: '資料名', type: '種類', memo: 'メモ', themes: 'テーマ', path: 'パス' }).map(([key, title]) => <option key={key} value={key}>{title}順</option>)}</select><button className="icon-button" aria-label={descending ? '昇順にする' : '降順にする'} title={descending ? '降順' : '昇順'} onClick={() => setDescending(!descending)}><ArrowDownWideNarrow size={16} style={{ transform: descending ? undefined : 'scaleY(-1)' }} /></button></div>
    <div className="material-filter-dates"><label>追加日<input type="date" aria-label="追加日の開始" value={after} onChange={event => setAfter(event.target.value)} /></label><span>〜</span><input type="date" aria-label="追加日の終了" value={before} onChange={event => setBefore(event.target.value)} /><button className="quiet-button" aria-pressed={showPath} onClick={() => setShowPath(!showPath)}>{showPath ? 'パスを隠す' : 'パスを表示'}</button>{merged.length > 0 && <button className="button" disabled={merged.length !== 2} onClick={() => mergeMaterials(merged[0], merged[1])}><Merge size={14} />{merged.length === 2 ? '選択した2件を統合' : '統合する資料を2件選択'}</button>}<span className="material-result-count">{visible.length}件</span></div>
    {errors.length > 0 && <div className="material-read-errors" role="alert"><strong>読み込めない資料ページがあります</strong>{errors.map(error => <button key={error.path} onClick={() => void workspace.openNote(error.path, pane, true)}>{error.path} — {error.message}</button>)}</div>}
    <div className={`materials-content ${detail ? 'has-detail' : ''}`}><div className="material-table-scroll"><table className="material-table"><thead><tr><th aria-label="選択" /><th>資料名</th><th>種類</th><th>追加日</th><th>メモ</th><th>テーマ</th>{showPath && <th>パス・URL</th>}</tr></thead><tbody>{visible.map(item => <tr key={item.file.path} className={selected === item.file.path ? 'selected' : ''}><td><input type="checkbox" aria-label={`${item.title}を選択`} checked={checked.includes(item.file.path)} onChange={event => setChecked(values => event.target.checked ? [...values, item.file.path] : values.filter(path => path !== item.file.path))} /></td><td><MaterialTitleCell material={item} select={() => setSelected(item.file.path)} /></td><td><select aria-label={`${item.title}の種類`} value={item.type} onChange={event => void workspace.saveMaterial({ ...item, type: event.target.value }, item)}>{types.map(type => <option key={type} value={type}>{materialTypes[type as keyof typeof materialTypes] ?? type}</option>)}</select></td><td><PropertyInput material={item} property="added" /></td><td><PropertyInput material={item} property="memo" /></td><td><PropertyInput material={item} property="themes" /></td>{showPath && <td><PropertyInput material={item} property="path" /></td>}</tr>)}</tbody></table>{!visible.length && <div className="material-empty"><Database size={32} strokeWidth={1} /><h2>{materials.length ? '条件に一致する資料がありません' : '資料を記録につなぐ'}</h2><p>{materials.length ? '検索やフィルタの条件を変えてみてください。' : '本文にパスやURLを貼り付けると、ここに資料が集まります。'}</p></div>}</div>
    {detail && <MaterialDetail material={detail} pane={pane} close={() => setSelected(null)} />}</div>
  </div>;
}

export function MaterialDetail({ material: detail, pane, close, className = '' }: { material: Material; pane: 0 | 1; close: () => void; className?: string }) {
  return <aside className={`material-detail ${className}`} aria-label="資料の詳細"><div className="material-detail-heading"><MaterialIcon type={detail.type} size={20} /><h2>{detail.title}</h2><button className="quiet-button" aria-label="資料の詳細を閉じる" onClick={close}>閉じる</button></div><p className="material-detail-path">{detail.path}</p><div className="material-detail-actions"><button className="button primary" onClick={() => void workspace.openResource(detail.path)}><ArrowUpRight size={14} />資料を開く</button><button className="button" onClick={() => editMaterial(detail)}>プロパティ</button></div><dl><dt>種類</dt><dd>{materialTypes[detail.type as keyof typeof materialTypes] ?? detail.type}</dd><dt>追加日</dt><dd>{detail.added}</dd><dt>テーマ</dt><dd>{detail.themes.join(' / ') || '未指定'}</dd></dl><h3>メモ</h3><p className="material-detail-memo">{detail.memo || 'メモはありません。'}</p><button className="quiet-button" onClick={() => void workspace.openNote(detail.file.path, pane, true)}>資料ページ・詳しい説明を開く ↗</button><MaterialBacklinks material={detail} pane={pane} /></aside>;
}

export function MaterialPage({ document, pane, jump }: { document: OpenDocument; pane: 0 | 1; jump: { anchor: number; sequence: number } | null }) {
  let material: Material | null = null, error = '';
  try { material = readMaterial(document.files[0]); } catch (caught) { error = String(caught instanceof Error ? caught.message : caught); }
  const body = material ? { ...document, files: document.files.map(file => ({ ...file, content: material!.body, savedContent: file.savedContent.slice(material!.bodyFrom) })) } : document;
  return <div className="document-container material-page"><div className="document-heading"><span className="document-kicker">資料ページ</span><h1>{material?.title ?? document.label}</h1>{material && <><div className="material-page-actions"><MaterialIcon type={material.type} /><span>{materialTypes[material.type as keyof typeof materialTypes] ?? material.type}</span><span>{material.added}</span><button className="button" onClick={() => void workspace.openResource(material!.path)}><ArrowUpRight size={14} />資料を開く</button><button className="quiet-button" onClick={() => editMaterial(material!)}>プロパティを編集</button></div><p className="material-page-path">{material.path}</p>{material.memo && <p className="material-page-memo">{material.memo}</p>}</>}{error && <p className="material-form-error" role="alert">{error}<br />以下のMarkdownを修正すると、資料一覧に反映されます。</p>}</div><Suspense fallback={<p className="editor-loading">資料ページを開いています…</p>}><MarkdownEditor document={body} pane={pane} bodyOnly={!!material} jump={jump && material ? { ...jump, anchor: Math.max(0, jump.anchor - material.bodyFrom) } : jump} /></Suspense></div>;
}
