// Whether secret mode has hidden the main window (see remote.ts). No imports,
// so ui.tsx can check it without pulling in Tauri or live code.
let hidden = false;

export function isHidden(): boolean {
  return hidden;
}

export function setHiddenFlag(value: boolean): void {
  hidden = value;
}
