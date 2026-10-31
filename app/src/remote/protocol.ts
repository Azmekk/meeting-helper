// JSON messages between the main window and the phone page (inside the
// encrypted frames, see crypto.ts). Type-only imports, so no Tauri code ends
// up in the phone bundle.
import type { LiveAiTask, LiveSnapshot } from '../lib/live';

export type ToPhone = { type: 'state'; snap: LiveSnapshot; hidden: boolean; canHide: boolean };

export type FromPhone =
  | { type: 'hello' }
  | { type: 'help' }
  | { type: 'ask'; question: string }
  | { type: 'set-model'; task: LiveAiTask; model: string }
  | { type: 'set-hidden'; hidden: boolean };

// WebSocket close codes sent by remote.rs.
export const CLOSE_REPAIRED = 4001;
export const CLOSE_BAD_KEY = 4002;
