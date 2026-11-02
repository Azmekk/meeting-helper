import { CircleDot, Folder, Library, Search, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import logo from './assets/logo.svg';
import { FfmpegDialog } from './components/FfmpegDialog';
import { SidebarUpdateNotice, UpdateDialog } from './components/UpdateNotice';
import { Callout, Spinner, Toaster, clsx, errorMessage } from './components/ui';
import { RecordingSavedDialog } from './components/live/RecordingSavedDialog';
import { ExternalRecordingDialog } from './components/record/ExternalRecordingDialog';
import { initDb } from './lib/db';
import { initLive } from './lib/live';
import { initRemote } from './lib/remote';
import { initRecorder, useRecorder } from './lib/obs';
import { failInterruptedJobs, initJobCloseGuard, useJobs } from './lib/pipeline';
import { useSettings } from './lib/settings';
import { initUpdateCheck } from './lib/updates';
import { initFolderAi } from './lib/ai/folder';
import { initSidecars } from './lib/bundle';
import { initBackup } from './lib/backup';
import { initAppearance } from './lib/appearance';
import FoldersScreen from './screens/FoldersScreen';
import MeetingScreen from './screens/MeetingScreen';
import MeetingsScreen from './screens/MeetingsScreen';
import RecordScreen from './screens/RecordScreen';
import SearchScreen from './screens/SearchScreen';
import SettingsScreen from './screens/SettingsScreen';

export default function App() {
  const [boot, setBoot] = useState<'loading' | 'ready' | { error: string }>('loading');
  const screen = useRef<HTMLDivElement>(null);
  useScreenFade(screen);

  useEffect(() => {
    (async () => {
      try {
        await useSettings.getState().load();
        initAppearance();
        await initDb();
        await failInterruptedJobs();
        initJobCloseGuard();
        initRecorder();
        initLive();
        initRemote();
        initUpdateCheck();
        initSidecars();
        initFolderAi();
        initBackup();
        setBoot('ready');
      } catch (err) {
        setBoot({ error: errorMessage(err) });
      }
    })();
  }, []);

  if (boot === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }
  if (boot !== 'ready') {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Callout tone="error" title="Meeting Helper couldn't start">
          {boot.error}
        </Callout>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {/* The fade runs on this wrapper, never on the scrolling <main>: animating
            the scroll container briefly changed its scrollbar and so its width. */}
        <div ref={screen}>
        <Routes>
          <Route path="/" element={<Navigate to="/meetings" replace />} />
          <Route path="/record" element={<RecordScreen />} />
          <Route path="/meetings" element={<MeetingsScreen />} />
          <Route path="/meetings/:id" element={<MeetingScreen />} />
          <Route path="/folders" element={<FoldersScreen />} />
          <Route path="/folders/:id" element={<FoldersScreen />} />
          <Route path="/search" element={<SearchScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/meetings" replace />} />
        </Routes>
        </div>
      </main>
      <FfmpegDialog />
      <UpdateDialog />
      <ExternalRecordingDialog />
      <RecordingSavedDialog />
      <Toaster />
    </div>
  );
}

// A soft fade-in of the main column when the screen changes. Animated in place
// (Web Animations) rather than by remounting, so screens keep their state; the
// key ignores ids within the same screen (/folders/1 → /folders/2).
function useScreenFade(ref: React.RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  const [section, id] = pathname.split('/').filter(Boolean);
  const screen = section === 'meetings' && id ? 'meeting' : section;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // An animating ancestor stops glass cards from blurring what's behind them,
    // so they'd flash lighter until the fade ends. No fade with glass on.
    if (document.documentElement.dataset.glass === 'on') return;
    el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
      duration: 260,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  }, [screen, ref]);
}

function Sidebar() {
  const recording = useRecorder((s) => s.recording);
  const activeJobs = useJobs((s) => Object.values(s.jobs).filter((j) => j.stage !== 'done' && j.stage !== 'error').length);

  return (
    <nav aria-label="Main" className="sidebar flex w-56 shrink-0 flex-col px-3 py-5">
      <div className="mb-5 flex items-center gap-2.5 px-3">
        <img src={logo} alt="" className="h-8 w-8 rounded-[9px]" />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold">Meeting Helper</div>
          <div className="text-[11px] text-muted">Record · Transcribe · Find</div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        <NavItem to="/record" icon={CircleDot} label="Record">
          {recording && <span className="h-2 w-2 animate-pulse rounded-full bg-rec" title="Recording" />}
        </NavItem>
        <NavItem to="/meetings" icon={Library} label="Meetings">
          {activeJobs > 0 && <Spinner size={13} />}
        </NavItem>
        <NavItem to="/folders" icon={Folder} label="Folders" />
        <NavItem to="/search" icon={Search} label="Search" />
      </div>

      <div className="mt-auto">
        <SidebarUpdateNotice />
        <NavItem to="/settings" icon={SettingsIcon} label="Settings" />
      </div>
    </nav>
  );
}

function NavItem({
  to,
  icon: Icon,
  label,
  children,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          'flex h-9 items-center gap-2.5 rounded-[10px] px-3 text-[14px] transition-colors',
          isActive ? 'bg-accent-soft font-semibold text-accent-ink' : 'text-text/80 hover:bg-hover hover:text-text',
        )
      }
    >
      <Icon size={17} />
      <span className="flex-1">{label}</span>
      {children}
    </NavLink>
  );
}
