// The floating overlay window that shows the live session.
import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { errorMessage } from '../errors';
import { toast } from '../toast';
import { getSettings, useSettings } from '../settings';
import { useLive } from './store';

const set = useLive.setState;

export const OVERLAY_LABEL = 'overlay';
// Main → overlay: animate out, then close the window (see OverlayScreen).
export const OVERLAY_CLOSE_EVENT = 'overlay://close';
const OVERLAY_WIDTH = 480; // logical px, incl. the transparent margin around the pill

export async function toggleOverlay(show?: boolean): Promise<void> {
  try {
    const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL);
    if (existing) {
      if (show !== true) {
        // Ask the overlay to fade out and close itself; force-close it if it
        // doesn't (an old build, a hung page).
        set({ overlayOpen: false });
        await emit(OVERLAY_CLOSE_EVENT, {}).catch(() => {});
        setTimeout(() => {
          void WebviewWindow.getByLabel(OVERLAY_LABEL)
            .then((w) => w?.close())
            .catch(() => {});
        }, 400);
      }
      return;
    }
    if (show === false) return;
    const win = new WebviewWindow(OVERLAY_LABEL, {
      url: 'index.html#/overlay',
      title: 'Meeting Helper · Live',
      // A transparent, frameless window holding the floating pill; the page
      // resizes it to fit its content (OverlayScreen).
      width: OVERLAY_WIDTH,
      height: 84,
      alwaysOnTop: true,
      decorations: false,
      transparent: true,
      shadow: false,
      resizable: false,
      focus: false,
      contentProtected: getSettings().overlayContentProtected,
    });
    void win.once('tauri://error', (e) => {
      set({ overlayOpen: false });
      toast(`Couldn't open the overlay: ${errorMessage(e.payload)}`, 'error');
    });
    void win.once('tauri://destroyed', () => set({ overlayOpen: false }));
    set({ overlayOpen: true });
  } catch (err) {
    toast(`Couldn't open the overlay: ${errorMessage(err)}`, 'error');
  }
}

export async function setOverlayProtected(on: boolean): Promise<void> {
  await useSettings.getState().update({ overlayContentProtected: on });
  const win = await WebviewWindow.getByLabel(OVERLAY_LABEL);
  await win?.setContentProtected(on).catch(() => {});
}
