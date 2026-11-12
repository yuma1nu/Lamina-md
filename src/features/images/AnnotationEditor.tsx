import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer, Image as CanvasImage, Group, Rect, Ellipse, Line, Arrow, Text, Transformer, Circle as CanvasCircle } from 'react-konva';
import { MousePointer2, Circle, Square, MoveUpRight, Minus, Type, Undo2, Redo2, Trash2, ZoomIn, ZoomOut, Scan, X, Check } from 'lucide-react';
import type { Annotation, AnnotationShape, ImageFile, ShapeKind } from '../../domain/images';
import { imageMarkup, validateAnnotation } from '../../domain/images';
import { isLineShape, lineEndpoints, moveLineEndpoint, type LineEnd } from '../../domain/annotation-geometry';
import { imageApi, imageWork, imagesChanged, loadImage, normalizeImage } from './image-service';
import { useWorkspace } from '../../app/workspace';
import type { ImageEditRequest } from './image-preview';

const COLORS = ['#ef5350', '#ffb74d', '#ffee58', '#66bb6a', '#42a5f5', '#ab78eb', '#ffffff', '#202124'];
const tools = [ ['select', '選択・移動', MousePointer2], ['ellipse', '丸', Circle], ['rect', '四角', Square], ['arrow', '矢印', MoveUpRight], ['line', '直線', Minus], ['text', 'テキスト', Type] ] as const;
const common = (shape: AnnotationShape) => ({ stroke: shape.color, strokeWidth: shape.lineWidth, lineCap: 'round' as const, lineJoin: 'round' as const, hitStrokeWidth: Math.max(12, shape.lineWidth), strokeScaleEnabled: true });
const textProps = (shape: AnnotationShape) => ({ text: shape.text, width: Math.max(8, shape.width), fontSize: shape.fontSize, fill: shape.color, fontFamily: 'Segoe UI, Yu Gothic UI, Meiryo, sans-serif', lineHeight: 1.2 });
function Shape({ shape }: { shape: AnnotationShape }) {
  if (shape.kind === 'rect') return <Rect width={shape.width} height={shape.height} {...common(shape)} />;
  if (shape.kind === 'ellipse') return <Ellipse x={shape.width / 2} y={shape.height / 2} radiusX={shape.width / 2} radiusY={shape.height / 2} {...common(shape)} />;
  if (shape.kind === 'text') return <Text {...textProps(shape)} />;
  const props = { points: [0, 0, shape.width, shape.height], ...common(shape) };
  return shape.kind === 'arrow' ? <Arrow {...props} pointerLength={Math.max(12, shape.lineWidth * 4)} pointerWidth={Math.max(10, shape.lineWidth * 3)} fill={shape.color} /> : <Line {...props} />;
}
async function renderPng(image: HTMLImageElement, annotation: Annotation) {
  await document.fonts.ready;
  const stage = new Konva.Stage({ container: document.createElement('div'), width: annotation.width, height: annotation.height });
  try {
    const layer = new Konva.Layer(); stage.add(layer);
    layer.add(new Konva.Image({ image, width: annotation.width, height: annotation.height }));
    for (const shape of annotation.shapes) {
      const group = new Konva.Group({ x: shape.x, y: shape.y, rotation: shape.rotation });
      let node: Konva.Shape;
      if (shape.kind === 'rect') node = new Konva.Rect({ width: shape.width, height: shape.height, ...common(shape) });
      else if (shape.kind === 'ellipse') node = new Konva.Ellipse({ x: shape.width / 2, y: shape.height / 2, radiusX: shape.width / 2, radiusY: shape.height / 2, ...common(shape) });
      else if (shape.kind === 'text') node = new Konva.Text(textProps(shape));
      else {
        const props = { points: [0, 0, shape.width, shape.height], ...common(shape) };
        node = shape.kind === 'arrow' ? new Konva.Arrow({ ...props, pointerLength: Math.max(12, shape.lineWidth * 4), pointerWidth: Math.max(10, shape.lineWidth * 3), fill: shape.color }) : new Konva.Line(props);
      }
      group.add(node); layer.add(group);
    }
    layer.draw(); return stage.toDataURL({ pixelRatio: 1, mimeType: 'image/png' }).split(',')[1];
  } finally { stage.destroy(); }
}

export function AnnotationEditor({ request, close }: { request: ImageEditRequest; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), viewport = useRef<HTMLDivElement>(null), stage = useRef<Konva.Stage>(null), transformer = useRef<Konva.Transformer>(null), textInput = useRef<HTMLTextAreaElement>(null);
  const [loaded, setLoaded] = useState<{ file: ImageFile; image: HTMLImageElement; annotation: Annotation; original: string } | null>(null);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [tool, setTool] = useState<ShapeKind | 'select'>('select');
  const [color, setColor] = useState(COLORS[0]), [lineWidth, setLineWidth] = useState(3), [fontSize, setFontSize] = useState(32);
  const [shapes, setShapes] = useState<AnnotationShape[]>([]), [selected, setSelected] = useState<string | null>(null), [drawing, setDrawing] = useState<AnnotationShape | null>(null), [textDraft, setTextDraft] = useState<AnnotationShape | null>(null);
  const [area, setArea] = useState({ width: 800, height: 500 }), [zoom, setZoom] = useState(1);
  const [endpointDraft, setEndpointDraft] = useState<AnnotationShape | null>(null);
  const endpointDrag = useRef<{ shape: AnnotationShape; end: LineEnd } | null>(null);
  const history = useRef<AnnotationShape[][]>([[]]), historyAt = useRef(0), start = useRef<{ x: number; y: number } | null>(null);
  const fit = loaded ? Math.min(1, (area.width - 48) / loaded.annotation.width, (area.height - 48) / loaded.annotation.height) : 1;
  const scale = Math.max(.02, fit * zoom);
  const activeShape = textDraft ?? shapes.find(shape => shape.id === selected);
  const selectedLine = tool === 'select' && !textDraft && activeShape && isLineShape(activeShape) ? endpointDraft ?? activeShape : null;
  function commit(next: AnnotationShape[]) {
    if (JSON.stringify(next) === JSON.stringify(history.current[historyAt.current])) return;
    history.current = [...history.current.slice(0, historyAt.current + 1), structuredClone(next)]; historyAt.current++;
    setShapes(next);
  }
  function undo(direction: number) { if (endpointDrag.current) return; const next = historyAt.current + direction; if (next >= 0 && next < history.current.length) { historyAt.current = next; setShapes(structuredClone(history.current[next])); setDrawing(null); setTextDraft(null); setSelected(null); } }
  function changeShape(id: string, patch: Partial<AnnotationShape>) { commit(shapes.map(shape => shape.id === id ? { ...shape, ...patch } : shape)); }
  function style(patch: Partial<AnnotationShape>) { if (textDraft) setTextDraft({ ...textDraft, ...patch }); else if (selected) changeShape(selected, patch); }
  function finishText() {
    if (!textDraft) return shapes;
    const next = shapes.filter(shape => shape.id !== textDraft.id);
    if (textDraft.text.trim()) next.push(textDraft);
    commit(next); setTextDraft(null); setSelected(textDraft.id); return next;
  }
  function dismiss() { if (!saving) close(); }
  useEffect(() => {
    useWorkspace.setState({ annotationOpen: true }); dialog.current?.showModal();
    let disposed = false;
    void (async () => {
      const file = await imageApi.read(request.root, request.path, true);
      let original = file.original, annotation = file.annotation;
      if (!original || !annotation) {
        const response = await fetch(`data:${file.mime};base64,${file.data}`);
        const normalized = await normalizeImage(await response.blob()); original = normalized.data; annotation = normalized.annotation;
      }
      validateAnnotation(annotation);
      const image = await loadImage(`data:image/png;base64,${original}`);
      if (image.naturalWidth !== annotation.width || image.naturalHeight !== annotation.height) throw new Error('画像と注釈データの寸法が一致しません。');
      if (disposed) return;
      setLoaded({ file, image, original, annotation }); setShapes(annotation.shapes); history.current = [structuredClone(annotation.shapes)]; historyAt.current = 0;
    })().catch(error => { if (!disposed) setError(String(error instanceof Error ? error.message : error)); });
    return () => { disposed = true; useWorkspace.setState({ annotationOpen: false }); request.view.focus(); };
  }, [request]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(entries => setArea({ width: entries[0].contentRect.width, height: entries[0].contentRect.height })); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { const shape = shapes.find(shape => shape.id === selected); const node = shape && !isLineShape(shape) && !textDraft && tool === 'select' ? stage.current?.findOne('#' + selected) : null; transformer.current?.nodes(node ? [node] : []); transformer.current?.getLayer()?.batchDraw(); }, [selected, shapes, textDraft, tool]);
  useEffect(() => { if (textDraft) textInput.current?.focus(); }, [textDraft?.id]);
  const point = () => { const position = stage.current?.getPointerPosition(); return position && loaded ? { x: Math.max(0, Math.min(loaded.annotation.width, position.x / scale)), y: Math.max(0, Math.min(loaded.annotation.height, position.y / scale)) } : null; };
  function begin(event: Konva.KonvaEventObject<MouseEvent>) {
    if (event.evt.button !== 0 || !loaded || saving || textDraft) return;
    if (tool === 'select') { if (event.target === event.target.getStage() || event.target.name() === 'original-image') setSelected(null); return; }
    const p = point(); if (!p) return;
    const shape: AnnotationShape = { id: crypto.randomUUID(), kind: tool, ...p, width: tool === 'text' ? Math.min(320, loaded.annotation.width - p.x) : 0, height: tool === 'text' ? fontSize * 1.2 : 0, rotation: 0, color, lineWidth, fontSize, text: '' };
    if (tool === 'text') { setTextDraft(shape); setSelected(null); setTool('select'); }
    else { start.current = p; setDrawing(shape); setSelected(null); }
  }
  function move() {
    if (!drawing || !start.current) return;
    const end = point(); if (!end) return;
    const rect = drawing.kind === 'ellipse' || drawing.kind === 'rect';
    setDrawing({ ...drawing, x: rect ? Math.min(start.current.x, end.x) : start.current.x, y: rect ? Math.min(start.current.y, end.y) : start.current.y, width: rect ? Math.abs(end.x - start.current.x) : end.x - start.current.x, height: rect ? Math.abs(end.y - start.current.y) : end.y - start.current.y });
  }
  function finish() { if (!drawing) return; if (Math.hypot(drawing.width, drawing.height) > 3 && (!(drawing.kind === 'rect' || drawing.kind === 'ellipse') || Math.min(drawing.width, drawing.height) > 1)) { commit([...shapes, drawing]); setSelected(drawing.id); } setDrawing(null); start.current = null; setTool('select'); }
  function endpointPosition(node: Konva.Node) {
    const position = node.position();
    const point = { x: Math.max(0, Math.min(loaded!.annotation.width, position.x)), y: Math.max(0, Math.min(loaded!.annotation.height, position.y)) };
    node.position(point); return point;
  }
  function dragEndpoint(node: Konva.Node, finish: boolean) {
    const drag = endpointDrag.current; if (!drag) return;
    const next = moveLineEndpoint(drag.shape, drag.end, endpointPosition(node));
    if (!next) node.position(lineEndpoints(endpointDraft ?? drag.shape)[drag.end === 'start' ? 0 : 1]);
    if (!finish) { if (next) setEndpointDraft(next); return; }
    const result = next ?? endpointDraft ?? drag.shape;
    endpointDrag.current = null; setEndpointDraft(null);
    commit(shapes.map(shape => shape.id === result.id ? result : shape));
  }
  async function save() {
    if (!loaded || saving || endpointDrag.current) return;
    setSaving(true); setError('');
    try {
      const annotation = validateAnnotation({ ...loaded.annotation, shapes: finishText() });
      const rendered = await renderPng(loaded.image, annotation);
      const file = await imageWork(() => imageApi.write(request.root, { ...(loaded.file.annotation ? { path: request.path, expectedRevision: loaded.file.revision } : {}), original: loaded.original, rendered, annotation }));
      if (!loaded.file.annotation) {
        if (request.view.state.sliceDoc(request.ref.from, request.ref.to) !== request.raw) throw new Error('元の本文が変更されています。画像の挿入位置を確認してください。');
        request.view.dispatch({ changes: { from: request.ref.from, to: request.ref.to, insert: imageMarkup(request.source, file.path, request.ref.alt, request.ref.width) }, userEvent: 'input.image.annotation' });
      }
      imagesChanged(); close();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  return <dialog className="annotation-dialog" ref={dialog} aria-label="画像に注釈" onCancel={event => { event.preventDefault(); if (textDraft) setTextDraft(null); else dismiss(); }} onKeyDown={event => {
    event.stopPropagation(); if (event.nativeEvent.isComposing || saving) return;
    if (endpointDrag.current) {
      event.preventDefault();
      if (event.key === 'Escape') { endpointDrag.current = null; stage.current?.findOne('.line-start-handle')?.stopDrag(); stage.current?.findOne('.line-end-handle')?.stopDrag(); setEndpointDraft(null); }
      return;
    }
    const input = (event.target as HTMLElement).matches('input, textarea, select');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    else if (textDraft && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); finishText(); }
    else if (!input && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); undo(event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : -1); }
    else if (!input && ['Delete', 'Backspace'].includes(event.key) && selected) { event.preventDefault(); commit(shapes.filter(shape => shape.id !== selected)); setSelected(null); }
    else if (!input && selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const shape = shapes.find(shape => shape.id === selected)!; const step = event.shiftKey ? 10 : 1; changeShape(selected, { x: shape.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: shape.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }); }
  }}>
    <header className="annotation-heading"><div><strong>画像に注釈</strong><span>元画像を保持して、図形や文字を重ねます</span></div><button className="icon-button" aria-label="注釈を閉じる" onClick={dismiss} disabled={saving}><X size={18} /></button></header>
    <div className="annotation-toolbar"><div className="annotation-tool-group">{tools.map(([kind, label, Icon]) => <button key={kind} className={`icon-button ${tool === kind ? 'active' : ''}`} aria-label={label} aria-pressed={tool === kind} title={label} disabled={!loaded || saving || !!textDraft} onClick={() => { setTool(kind); setSelected(null); }}><Icon size={18} /></button>)}</div>
      <label>色<select aria-label="注釈の色" value={activeShape?.color ?? color} disabled={saving} onChange={event => { setColor(event.target.value); style({ color: event.target.value }); }}>{COLORS.map((value, index) => <option key={value} value={value}>{['赤', 'オレンジ', '黄', '緑', '青', '紫', '白', '黒'][index]}</option>)}</select></label>
      <label>線<select aria-label="線の太さ" value={activeShape?.lineWidth ?? lineWidth} disabled={saving} onChange={event => { setLineWidth(+event.target.value); style({ lineWidth: +event.target.value }); }}>{[1, 2, 3, 4, 6, 8, 12].map(value => <option key={value} value={value}>{value}px</option>)}</select></label>
      <label>文字<select aria-label="文字サイズ" value={activeShape?.fontSize ?? fontSize} disabled={saving} onChange={event => { setFontSize(+event.target.value); style({ fontSize: +event.target.value }); }}>{[12, 16, 20, 24, 28, 32, 40, 48, 64, 80].map(value => <option key={value} value={value}>{value}px</option>)}</select></label>
      <div className="annotation-tool-group"><button className="icon-button" aria-label="注釈を元に戻す" title="元に戻す（Ctrl+Z）" disabled={historyAt.current === 0 || saving || !!textDraft} onClick={() => undo(-1)}><Undo2 size={17} /></button><button className="icon-button" aria-label="注釈をやり直す" title="やり直す（Ctrl+Shift+Z）" disabled={historyAt.current === history.current.length - 1 || saving || !!textDraft} onClick={() => undo(1)}><Redo2 size={17} /></button><button className="icon-button" aria-label="選択した注釈を削除" title="削除" disabled={!selected || saving || !!textDraft} onClick={() => { commit(shapes.filter(shape => shape.id !== selected)); setSelected(null); }}><Trash2 size={17} /></button></div>
      <div className="annotation-zoom"><button className="icon-button" aria-label="注釈画面を縮小" onClick={() => setZoom(Math.max(.1, zoom / 1.25))}><ZoomOut size={16} /></button><span>{Math.round(scale * 100)}%</span><button className="icon-button" aria-label="注釈画面を拡大" onClick={() => setZoom(Math.min(8, zoom * 1.25))}><ZoomIn size={16} /></button><button className="icon-button" aria-label="画像全体を表示" onClick={() => setZoom(1)}><Scan size={16} /></button></div>
    </div>
    <div className="annotation-viewport" ref={viewport} aria-label="注釈キャンバス"><div className="annotation-canvas" style={loaded ? { width: loaded.annotation.width * scale, height: loaded.annotation.height * scale } : undefined}>
      {loaded ? <Stage ref={stage} width={loaded.annotation.width * scale} height={loaded.annotation.height * scale} scaleX={scale} scaleY={scale} onMouseDown={begin} onMouseMove={move} onMouseUp={finish} onMouseLeave={finish} style={{ cursor: tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair', pointerEvents: saving ? 'none' : undefined }}><Layer><CanvasImage name="original-image" image={loaded.image} width={loaded.annotation.width} height={loaded.annotation.height} />
        {[...shapes.filter(shape => shape.id !== textDraft?.id).map(shape => endpointDraft?.id === shape.id ? endpointDraft : shape), ...(drawing ? [drawing] : [])].map(shape => <Group key={shape.id} id={shape.id} x={shape.x} y={shape.y} rotation={shape.rotation} draggable={tool === 'select' && !textDraft && !saving && !endpointDrag.current} onClick={() => { if (tool === 'select') setSelected(shape.id); }} onDblClick={() => { if (shape.kind === 'text' && tool === 'select') { setTextDraft({ ...shape }); setSelected(null); } }} onDragStart={() => setSelected(shape.id)} onDragEnd={event => changeShape(shape.id, { x: event.target.x(), y: event.target.y() })} onTransformEnd={event => {
          const node = event.target; const scaleX = node.scaleX(), scaleY = node.scaleY(); node.scaleX(1); node.scaleY(1);
          changeShape(shape.id, { x: node.x(), y: node.y(), rotation: node.rotation(), width: shape.width * scaleX, height: shape.height * scaleY, ...(shape.kind === 'text' ? { fontSize: Math.max(8, Math.min(500, shape.fontSize * scaleY)) } : {}) });
        }}><Shape shape={shape} /></Group>)}
        <Transformer ref={transformer} rotateEnabled={true} flipEnabled={false} enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']} anchorSize={8} borderStroke="#759bc0" anchorStroke="#759bc0" anchorFill="#ffffff" boundBoxFunc={(oldBox, newBox) => Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox} />
        {selectedLine && lineEndpoints(selectedLine).map((position, index) => <CanvasCircle key={index} name={index ? 'line-end-handle' : 'line-start-handle'} x={position.x} y={position.y} radius={5 / scale} stroke="#759bc0" strokeWidth={1.5 / scale} fill="#ffffff" hitStrokeWidth={14 / scale} draggable={!saving}
          onMouseDown={event => { event.cancelBubble = true; }} onTouchStart={event => { event.cancelBubble = true; }}
          onMouseEnter={() => { if (stage.current) stage.current.container().style.cursor = 'crosshair'; }} onMouseLeave={() => { if (stage.current) stage.current.container().style.cursor = 'default'; }}
          onDragStart={event => { event.cancelBubble = true; const shape = shapes.find(shape => shape.id === selected)!; endpointDrag.current = { shape, end: index ? 'end' : 'start' }; setEndpointDraft(shape); }}
          onDragMove={event => { event.cancelBubble = true; dragEndpoint(event.target, false); }}
          onDragEnd={event => { event.cancelBubble = true; dragEndpoint(event.target, true); }} />)}
      </Layer></Stage> : <p className="annotation-loading">{error ? '画像を開けませんでした。' : '画像を開いています…'}</p>}
      {textDraft && <textarea ref={textInput} className="annotation-text-input" aria-label="注釈のテキスト" placeholder="テキストを入力" value={textDraft.text} onChange={event => setTextDraft({ ...textDraft, text: event.target.value })} style={{ left: textDraft.x * scale, top: textDraft.y * scale, width: Math.max(80, textDraft.width * scale), minHeight: Math.max(40, textDraft.fontSize * scale * 2.5), fontSize: textDraft.fontSize * scale, color: textDraft.color }} />}
    </div></div>
    {error && <p role="alert" className="annotation-error">{error}</p>}
    <footer className="annotation-footer"><span>{textDraft ? 'Ctrl+Enterで文字を確定' : selectedLine ? '両端のハンドルをドラッグして長さ・向きを変更' : loaded ? `${loaded.annotation.width} × ${loaded.annotation.height}px · ダブルクリックで文字を再編集` : ''}</span>{textDraft && <button className="button" onClick={finishText}><Check size={15} />文字を確定</button>}<button className="button" disabled={saving} onClick={dismiss}>キャンセル</button><button className="button primary" disabled={!loaded || saving} onClick={() => void save()}>完了</button></footer>
  </dialog>;
}
