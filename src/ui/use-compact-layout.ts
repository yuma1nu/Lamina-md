import { useSyncExternalStore } from 'react';

const query = '(max-width: 1100px)';
const subscribe = (change: () => void) => { const media = window.matchMedia(query); media.addEventListener('change', change); return () => media.removeEventListener('change', change); };
export const useCompactLayout = () => useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
