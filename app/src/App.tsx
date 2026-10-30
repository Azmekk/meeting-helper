import { CircleDot, Library, Search, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import logo from './assets/logo.svg';
import { FfmpegDialog } from './components/FfmpegDialog';
import { SidebarUpdateNotice, UpdateDialog } from './components/UpdateNotice';
import { Callout, Spinner, Toaster, clsx, errorMessage } from './components/ui';
import { initDb } from './lib/db';
import { initRecorder, useRecorder } from './lib/obs';
import { useJobs } from './lib/pipeline';
import { useSettings } from './lib/settings';
import { initUpdateCheck } from './lib/updates';
import MeetingScreen from './screens/MeetingScreen';
import MeetingsScreen from './screens/MeetingsScreen';
import RecordScreen from './screens/RecordScreen';
import SearchScreen from './screens/SearchScreen';
import SettingsScreen from './screens/SettingsScreen';

export default function App() {
  const [boot, setBoot] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    (async () => {
      try {
        await useSettings.getState().load();
        await initDb();
        initRecorder();
        initUpdateCheck();
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
        <Routes>
          <Route path="/" element={<Navigate to="/meetings" replace />} />
          <Route path="/record" element={<RecordScreen />} />
          <Route path="/meetings" element={<MeetingsScreen />} />
          <Route path="/meetings/:id" element={<MeetingScreen />} />
          <Route path="/search" element={<SearchScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/meetings" replace />} />
        </Routes>
      </main>
      <FfmpegDialog />
      <UpdateDialog />
      <Toaster />
    </div>
  );
}

function Sidebar() {
  const recording = useRecorder((s) => s.recording);
  const activeJobs = useJobs((s) => Object.values(s.jobs).filter((j) => j.stage !== 'done' && j.stage !== 'error').length);

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-line bg-sunken/60 px-3 py-4">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        <img src={logo} alt="" className="h-8 w-8" />
        <div className="leading-tight">
          <div className="font-display text-[15px] font-semibold">Meeting Helper</div>
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
          'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
          isActive ? 'bg-panel font-medium text-text shadow-sm' : 'text-muted hover:bg-hover hover:text-text',
        )
      }
    >
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      {children}
    </NavLink>
  );
}
