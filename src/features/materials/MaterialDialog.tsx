import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, FilePlus2, Merge, X } from 'lucide-react';
import { useWorkspace, workspace } from '../../app/workspace';
import { location, materialDraft, materialReferences, materialTypes, type MaterialProperties } from '../../domain/materials';
import { closeMaterialDialog, materialError, useMaterialDialog } from './material-service';

export function MaterialDialog() {
  const request = useMaterialDialog(state => state.request), vault = useWorkspace(state => state.vault);
  const ref = useRef<HTMLDialogElement>(null), titleInput = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<MaterialProperties | null>(null), [body, setBody] = useState(''), [working, setWorking] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!request) { ref.current?.close(); return; }
    setValue(request.value); setBody(request.body ?? ''); setError(''); setWorking(false);
    if (!ref.current?.open) ref.current?.showModal();
    titleInput.current?.focus();
    let disposed = false;
    void request.inspection?.then(info => { if (!disposed && info.folder) setValue(value => value && value.path === request.value.path && value.type === request.value.type ? { ...value, type: 'folder' } : value); });
    return () => { disposed = true; };
  }, [request]);
  function dismiss() { if (!working) closeMaterialDialog(); }
  function change<K extends keyof MaterialProperties>(key: K, next: MaterialProperties[K]) { setValue(value => value && ({ ...value, [key]: next })); }
  function defaults() {
    if (!value?.path || value.title) return;
    try { const draft = materialDraft(value.path); setValue({ ...value, title: draft.title, type: draft.type, path: draft.path }); } catch { /* Validate on save, while allowing the path to be typed. */ }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!request || !value) return;
    setWorking(true); setError('');
    try {
      const ok = await workspace.saveMaterial(value, request.original, request.insertion, request.merge, request.merge ? body : undefined);
      if (ok) closeMaterialDialog(); else setError(useWorkspace.getState().error ?? '資料を保存できませんでした。');
    } catch (error) { materialError(error); setError(String(error instanceof Error ? error.message : error)); }
    finally { setWorking(false); }
  }
  const themes = [...new Set([...(vault?.themes.map(theme => theme.name) ?? []), ...(value?.themes ?? [])])];
  let changed = false;
  try { changed = !!request?.original && !!value && location(request.original.path).key !== location(value.path).key; } catch { /* Incomplete path. */ }
  const hits = request?.original && (changed || request.merge) ? [...materialReferences(workspace.index(), request.original), ...(request.merge ? materialReferences(workspace.index(), request.merge) : [])] : [];
  return <dialog className="material-dialog" ref={ref} aria-label={request?.merge ? '資料を統合' : request?.original ? '資料のプロパティ' : '資料を登録'} onCancel={event => { if (working) event.preventDefault(); else dismiss(); }} onClose={dismiss}>
    {request && value && <form onSubmit={event => void save(event)}><div className="dialog-heading"><div className="material-dialog-title">{request.merge ? <Merge size={20} /> : <FilePlus2 size={20} />}<h2>{request.merge ? '資料を統合' : request.original ? '資料のプロパティ' : '資料を登録'}</h2>{request.original && !request.merge && <span className="registered-badge"><Check size={12} />登録済み</span>}</div><button className="icon-button" aria-label="資料の編集を閉じる" type="button" onClick={dismiss} disabled={working}><X size={18} /></button></div>
      {request.insertion && <p className="material-dialog-caption">{request.original ? '登録済みの資料を本文に挿入します。' : '自動入力された内容のまま、登録して挿入できます。'}</p>}
      {request.merge && <div className="merge-sources"><p><strong>{request.original!.title}</strong> と <strong>{request.merge.title}</strong> を1件にまとめます。</p><label>残すパス<select aria-label="残すパス" value={value.path} onChange={event => change('path', event.target.value)}>{[request.original!.path, request.merge.path].map(path => <option key={path} value={path}>{path}</option>)}</select></label></div>}
      <div className="material-fields"><label className="wide-field">資料名<input ref={titleInput} aria-label="資料名" value={value.title} onChange={event => change('title', event.target.value)} maxLength={500} disabled={working} /></label><label>種類<select aria-label="資料の種類" value={value.type} onChange={event => change('type', event.target.value)} disabled={working}>{Object.entries(materialTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}{!(value.type in materialTypes) && <option value={value.type}>{value.type}</option>}</select></label><label>追加日<input aria-label="資料の追加日" type="date" value={value.added} onChange={event => change('added', event.target.value)} disabled={working} /></label><label className="wide-field">パス・URL<textarea aria-label="資料のパス・URL" value={value.path} onChange={event => change('path', event.target.value)} onBlur={defaults} rows={2} disabled={working} spellCheck={false} /></label><label className="wide-field">メモ<textarea aria-label="資料のメモ" value={value.memo} onChange={event => change('memo', event.target.value)} rows={3} placeholder="短い説明や、資料を使うときの注意など" disabled={working} /></label><fieldset className="material-themes wide-field"><legend>テーマ<span>複数選択・未指定可</span></legend>{themes.length ? <div>{themes.map(theme => <label key={theme}><input type="checkbox" checked={value.themes.includes(theme)} disabled={working} onChange={event => change('themes', event.target.checked ? [...value.themes, theme] : value.themes.filter(item => item !== theme))} />{theme}</label>)}</div> : <p>テーマは未指定で登録できます。</p>}</fieldset></div>
      {request.merge && <label className="merge-body">統合後の詳しい説明<textarea aria-label="統合後の詳しい説明" value={body} onChange={event => setBody(event.target.value)} rows={8} disabled={working} /></label>}
      {(changed || request.merge) && <div className="material-change-preview"><strong>参照リンクをまとめて更新</strong><p>{hits.length}か所・{new Set(hits.map(hit => hit.path)).size}ファイル。リンクの表示名とコード内の文字列は保持します。</p>{hits.slice(0, 4).map((hit, i) => <div key={i}><span>{hit.source.name} · {hit.date ?? `${hit.line}行`}</span><p>{hit.context}</p></div>)}{request.merge && <p>統合元の資料ページは、統合内容とリンクを保存した後に1件へまとめます。</p>}</div>}
      {error && <p className="material-form-error" role="alert">{error}</p>}
      <footer><button className="button" type="button" onClick={dismiss} disabled={working}>キャンセル</button><button className="button primary" disabled={working || !value.path.trim() || !value.title.trim()}>{request.merge ? '統合して保存' : request.insertion ? '登録して挿入' : request.original ? '変更を保存' : '登録'}</button></footer>
    </form>}
  </dialog>;
}
