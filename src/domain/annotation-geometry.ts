import type { AnnotationShape } from './images';

export interface Point { x: number; y: number }
export type LineEnd = 'start' | 'end';
export const isLineShape = (shape: AnnotationShape) => shape.kind === 'arrow' || shape.kind === 'line';

export function lineEndpoints(shape: AnnotationShape): [Point, Point] {
  const radians = shape.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  return [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width * cosine - shape.height * sine, y: shape.y + shape.width * sine + shape.height * cosine }];
}

export function moveLineEndpoint(shape: AnnotationShape, end: LineEnd, point: Point): AnnotationShape | null {
  if (!isLineShape(shape) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const [start, finish] = lineEndpoints(shape);
  const first = end === 'start' ? point : start, last = end === 'end' ? point : finish;
  if (Math.hypot(last.x - first.x, last.y - first.y) < 2) return null;
  // Store the new world-space vector, including legacy rotated annotations.
  // The opposite endpoint stays fixed and PNG export needs no special case.
  return { ...shape, x: first.x, y: first.y, width: last.x - first.x, height: last.y - first.y, rotation: 0 };
}
