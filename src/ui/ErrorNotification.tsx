import { AlertCircle, Globe, RotateCw, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspace } from '../app/workspace';

export function ErrorNotification() {
  const { error, recovery } = useWorkspace(useShallow(state => ({ error: state.error, recovery: state.errorRecovery })));
  if (!error) return null;
  const action = recovery?.message === error ? recovery : null;
  return <div className="error-message" role="alert"><AlertCircle size={20} /><div><strong>{action?.title ?? '操作を完了できませんでした'}</strong><p>{error}</p>{action?.note && <p>{action.note}</p>}{action && <div className="error-actions"><button className="button" onClick={() => void action.retry().catch(() => {})}><RotateCw size={16} />{action.label}</button>{action.browser && <button className="button" onClick={() => void action.browser!()}><Globe size={16} />ブラウザで開く</button>}</div>}</div><button className="icon-button" aria-label="通知を閉じる" onClick={() => useWorkspace.setState({ error: null, errorRecovery: null })}><X size={18} /></button></div>;
}
