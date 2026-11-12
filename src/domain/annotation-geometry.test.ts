import { describe, expect, it } from 'vitest';
import type { AnnotationShape } from './images';
import { lineEndpoints, moveLineEndpoint } from './annotation-geometry';

const line = (patch: Partial<AnnotationShape> = {}): AnnotationShape => ({ id: 'line', kind: 'arrow', x: 20, y: 30, width: 100, height: -40, rotation: 0, color: '#ef5350', lineWidth: 3, fontSize: 32, text: '', ...patch });
describe('矢印と直線の端点編集', () => {
  it('始点を動かしても終点を固定し、見た目と線の属性を維持する', () => {
    const original = line(), moved = moveLineEndpoint(original, 'start', { x: 0, y: 80 })!;
    expect(lineEndpoints(moved)).toEqual([{ x: 0, y: 80 }, { x: 120, y: -10 }]);
    expect(moved.color).toBe(original.color); expect(moved.lineWidth).toBe(original.lineWidth); expect(original.x).toBe(20);
  });
  it('以前の回転付きの線でも、終点だけを画像上の座標で動かせる', () => {
    const original = line({ kind: 'line', width: 100, height: 0, rotation: 90 });
    const before = lineEndpoints(original); expect(before[1].x).toBeCloseTo(20); expect(before[1].y).toBeCloseTo(130);
    const moved = moveLineEndpoint(original, 'end', { x: 150, y: 70 })!;
    expect(lineEndpoints(moved)).toEqual([{ x: 20, y: 30 }, { x: 150, y: 70 }]); expect(moved.rotation).toBe(0);
  });
  it('端点が交差する向き・水平・垂直も正しく表せる', () => {
    for (const endpoint of [{ x: -50, y: -20 }, { x: 20, y: 150 }, { x: 150, y: 30 }]) {
      const moved = moveLineEndpoint(line(), 'end', endpoint)!; expect(lineEndpoints(moved)[1]).toEqual(endpoint);
    }
  });
  it('長さがなくなる変更と線以外の変更を適用しない', () => {
    expect(moveLineEndpoint(line(), 'end', { x: 20, y: 30 })).toBeNull();
    expect(moveLineEndpoint(line({ kind: 'rect' }), 'end', { x: 100, y: 100 })).toBeNull();
  });
});
