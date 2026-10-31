// Theme, accent and liquid glass: mirrors the appearance settings onto <html>
// attributes (index.css does the rest) and, on Windows, applies the Mica or
// Acrylic window material when glass is on.
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window';
import { IS_WINDOWS } from './platform';
import { useSettings, type AccentId, type Settings } from './settings';

// Swatch colours for the settings picker (the light value of each preset; the
// full light/dark/soft sets live in index.css).
export const ACCENTS: { id: AccentId; label: string; color: string }[] = [
  { id: 'teal', label: 'Teal', color: '#0f766e' },
  { id: 'blue', label: 'Blue', color: '#0a66d6' },
  { id: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { id: 'purple', label: 'Purple', color: '#7a3fd1' },
  { id: 'orange', label: 'Orange', color: '#c2410c' },
  { id: 'graphite', label: 'Graphite', color: '#48484a' },
];

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const reducedTransparencyQuery = window.matchMedia('(prefers-reduced-transparency: reduce)');

export function reducedTransparency(): boolean {
  return reducedTransparencyQuery.matches;
}

let lastEffectKey = '';

function apply(s: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = s.appearanceTheme;
  root.dataset.accent = s.appearanceAccent;

  const glass = s.appearanceGlass && !reducedTransparency();
  const material = glass && IS_WINDOWS && s.appearanceMaterial !== 'none';
  if (glass) root.dataset.glass = 'on';
  else delete root.dataset.glass;
  if (material) root.dataset.material = 'on';
  else delete root.dataset.material;

  const dark = s.appearanceTheme === 'dark' || (s.appearanceTheme === 'system' && darkQuery.matches);
  void applyWindow(material ? s.appearanceMaterial : 'none', s.appearanceTheme, dark);
}

async function applyWindow(material: Settings['appearanceMaterial'], theme: Settings['appearanceTheme'], dark: boolean) {
  const key = `${material}|${theme}|${dark}`;
  if (key === lastEffectKey) return;
  lastEffectKey = key;
  const win = getCurrentWindow();
  try {
    // Title bar (and Mica tint) follow the app theme; null = follow the OS.
    await win.setTheme(theme === 'system' ? null : theme);
  } catch {
    // Not supported on this platform.
  }
  if (!IS_WINDOWS) return;
  try {
    if (material === 'none') {
      await win.clearEffects();
    } else {
      await win.setEffects({
        effects: [material === 'acrylic' ? Effect.Acrylic : Effect.Mica],
        state: EffectState.Active,
      });
    }
  } catch (err) {
    console.warn('Window material not applied:', err);
  }
}

// Call once after settings have loaded (main window only).
export function initAppearance(): void {
  apply(useSettings.getState().settings);
  useSettings.subscribe((state, prev) => {
    const a = state.settings;
    const b = prev.settings;
    if (
      a.appearanceTheme !== b.appearanceTheme ||
      a.appearanceAccent !== b.appearanceAccent ||
      a.appearanceGlass !== b.appearanceGlass ||
      a.appearanceMaterial !== b.appearanceMaterial
    ) {
      apply(a);
    }
  });
  const reapply = () => apply(useSettings.getState().settings);
  darkQuery.addEventListener('change', reapply);
  reducedTransparencyQuery.addEventListener('change', reapply);
}
