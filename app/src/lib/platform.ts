// What OS the app runs on, for wording and file names in the UI.
const ua = navigator.userAgent;

export const IS_WINDOWS = ua.includes('Windows');
export const IS_MAC = ua.includes('Mac');

// Where secrets.ts keeps API keys and passwords on this OS.
export const KEY_STORE = IS_WINDOWS ? 'Windows Credential Manager' : IS_MAC ? 'the macOS Keychain' : 'the system keyring';

export const FFMPEG_EXE = IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg';
export const FFPROBE_EXE = IS_WINDOWS ? 'ffprobe.exe' : 'ffprobe';

// Install commands to suggest when ffmpeg can't be found.
export const FFMPEG_INSTALL: string[] = IS_WINDOWS
  ? ['winget install Gyan.FFmpeg', 'scoop install ffmpeg', 'choco install ffmpeg']
  : IS_MAC
    ? ['brew install ffmpeg']
    : ['sudo apt install ffmpeg', 'sudo dnf install ffmpeg'];
