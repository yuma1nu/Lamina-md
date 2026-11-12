import { invoke } from '@tauri-apps/api/core';
import { useWorkspace } from '../../app/workspace';
import type { Annotation, ImageFile, ImageWrite } from '../../domain/images';

export const imageApi = {
  read: (root: string, path: string, editing = false) => invoke<ImageFile>('read_image', { root, path, editing }),
  write: (root: string, write: ImageWrite) => invoke<ImageFile>('write_image', { root, write }),
};
const cache = new Map<string, Promise<ImageFile>>();
export function imagePreview(root: string, path: string) {
  const key = `${root}\n${path}`;
  if (!cache.has(key)) {
    const promise = imageApi.read(root, path).catch(error => { cache.delete(key); throw error; });
    cache.set(key, promise);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
  }
  return cache.get(key)!;
}
export function imagesChanged() { cache.clear(); window.dispatchEvent(new Event('lamina-images-changed')); }
export function imageError(error: unknown) { useWorkspace.setState({ error: `画像を処理できませんでした。\n${error instanceof Error ? error.message : String(error)}` }); }
export async function imageWork<T>(work: () => Promise<T>): Promise<T> {
  if (useWorkspace.getState().busy || useWorkspace.getState().closing) throw new Error('前の操作が完了するまでお待ちください。');
  useWorkspace.setState({ busy: true });
  try { return await work(); } finally { useWorkspace.setState({ busy: false }); }
}
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('画像を読み込めませんでした。')); image.src = url; });
}
export async function normalizeImage(file: Blob): Promise<{ data: string; annotation: Annotation }> {
  if (file.size > 32 * 1024 * 1024) throw new Error('画像は32MB以下にしてください。');
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('画像は4,000万画素以下にしてください。');
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    const data = canvas.toDataURL('image/png').split(',')[1];
    if (data.length > 45_000_000) throw new Error('PNGに変換した画像が大きすぎます。');
    return { data, annotation: { version: 1, width: canvas.width, height: canvas.height, shapes: [] } };
  } finally { URL.revokeObjectURL(url); }
}
