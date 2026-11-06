/** Imperative handles to live terminals, so the header and the command palette can act on one without lifting xterm into React state. */
export interface TermHandle {
  clear(): void;
  focus(): void;
  copyOutput(): Promise<boolean>;
  selectAll(): void;
  /** Search the buffer. Returns the match count and selects the first. */
  find(query: string, caseSensitive?: boolean): { index: number; count: number };
  findStep(dir: 1 | -1): { index: number; count: number };
  clearFind(): void;
}

const handles = new Map<string, TermHandle>();

export const termHandles = {
  set: (id: string, h: TermHandle) => handles.set(id, h),
  remove: (id: string) => handles.delete(id),
  get: (id: string | null | undefined) => (id ? handles.get(id) : undefined),
};
