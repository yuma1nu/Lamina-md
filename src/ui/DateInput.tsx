import type { ComponentProps } from 'react';

// Keep the native calendar and keyboard behavior, with a consistent idle label.
export function DateInput(props: Omit<ComponentProps<'input'>, 'type'>) {
  return <span className="iso-date"><input {...props} type="date" /><span aria-hidden="true">{String(props.value || 'YYYY-MM-DD')}</span></span>;
}
