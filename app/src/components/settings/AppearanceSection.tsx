// Settings → Appearance: theme, accent colour, liquid glass and (Windows 11)
// the window material. Applied live by lib/appearance.ts.
import { ACCENTS, reducedTransparency } from '../../lib/appearance';
import { IS_WINDOWS } from '../../lib/platform';
import { useSettings, type Settings } from '../../lib/settings';
import { Card, Segmented, Switch, clsx } from '../ui';
import { saveSettings } from './common';

const THEMES: { id: Settings['appearanceTheme']; label: string; tile: string; side: string; main: string }[] = [
  { id: 'light', label: 'Light', tile: 'bg-[#f2f2f7] ring-1 ring-[#e0e0e5]', side: 'bg-white', main: 'bg-white' },
  { id: 'dark', label: 'Dark', tile: 'bg-[#1c1c1e] ring-1 ring-white/10', side: 'bg-[#2c2c2e]', main: 'bg-[#2c2c2e]' },
  {
    id: 'system',
    label: 'System',
    tile: 'bg-[linear-gradient(90deg,#f2f2f7_50%,#1c1c1e_50%)] ring-1 ring-[#e0e0e5]',
    side: 'bg-white',
    main: 'bg-[#2c2c2e]',
  },
];

export function AppearanceSection() {
  const s = useSettings((st) => st.settings);
  const reduced = reducedTransparency();

  return (
    <>
      <Card title="Theme">
        <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-6 pt-1">
          {THEMES.map((t) => {
            const selected = s.appearanceTheme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => void saveSettings({ appearanceTheme: t.id })}
                className={clsx(
                  'flex flex-col items-center gap-2 rounded-2xl text-[13px] focus-visible:outline-offset-4',
                  selected ? 'font-semibold text-text' : 'text-text/80 hover:text-text',
                )}
              >
                <span
                  className={clsx(
                    'flex h-[78px] w-[120px] gap-1.5 rounded-[14px] p-2 transition-[outline-color]',
                    t.tile,
                    selected ? 'outline-[3px] outline-offset-2 outline-accent outline-solid' : 'outline-transparent',
                  )}
                >
                  <span className={clsx('w-7 rounded-md', t.side)} />
                  <span className={clsx('flex-1 rounded-md', t.main)} />
                </span>
                {t.label}
              </button>
            );
          })}
        </div>
      </Card>

      <Card padded={false}>
        <div className="divide-y divide-line">
          <Row title="Accent colour" description="Buttons, highlights and the selected item.">
            <div role="radiogroup" aria-label="Accent colour" className="flex gap-2.5">
              {ACCENTS.map((a) => {
                const selected = s.appearanceAccent === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={a.label}
                    title={a.label}
                    onClick={() => void saveSettings({ appearanceAccent: a.id })}
                    className="h-[30px] w-[30px] rounded-full outline-offset-[3px]"
                    style={{
                      background: a.color,
                      outline: selected ? `2px solid ${a.color}` : undefined,
                    }}
                  />
                );
              })}
            </div>
          </Row>
          <Row
            title="Liquid glass"
            description={
              reduced
                ? 'Off while your system asks for less transparency.'
                : 'Translucent sidebar and cards over a soft background. Turns off when the system asks for less transparency.'
            }
          >
            <Switch
              label="Liquid glass"
              checked={s.appearanceGlass}
              disabled={reduced}
              onChange={(v) => void saveSettings({ appearanceGlass: v })}
            />
          </Row>
          {IS_WINDOWS && (
            <Row title="Window material (Windows 11)" description="With glass on, let the desktop show through the window.">
              <Segmented
                label="Window material"
                value={s.appearanceMaterial}
                onChange={(v) => void saveSettings({ appearanceMaterial: v })}
                options={[
                  { value: 'none', label: 'None', disabled: !s.appearanceGlass },
                  { value: 'mica', label: 'Mica', disabled: !s.appearanceGlass },
                  { value: 'acrylic', label: 'Acrylic', disabled: !s.appearanceGlass },
                ]}
              />
            </Row>
          )}
          <Row
            title="Overlay background"
            description="See-through lets the screen behind the live overlay show faintly. Solid is easier to read."
          >
            <Segmented
              label="Overlay background"
              value={s.overlaySolid ? 'solid' : 'see-through'}
              onChange={(v) => void saveSettings({ overlaySolid: v === 'solid' })}
              options={[
                { value: 'see-through', label: 'See-through' },
                { value: 'solid', label: 'Solid' },
              ]}
            />
          </Row>
        </div>
      </Card>
    </>
  );
}

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{title}</div>
        <div className="text-[13px] text-muted">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
