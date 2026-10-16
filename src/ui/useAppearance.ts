import { useEffect, useRef, useState } from 'react';
import type { ArchiveAPI } from '../desktop/bridge.js';
import type { Theme } from '../core/model.js';

export function useAppearance(api: ArchiveAPI, notify: (message: string) => void) {
  const [preference, setPreference] = useState<Theme>(api?.initialTheme ?? 'system');
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [saving, setSaving] = useState(false);
  const desired = useRef({ value: preference, sequence: 0 });
  const confirmed = useRef(preference);
  const writing = useRef(false);
  const mounted = useRef(true);
  const transition = useRef<ViewTransition | null>(null);
  const paletteSequence = useRef(0);
  const previousPreference = useRef(preference);

  useEffect(() => {
    mounted.current = true;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    media.addEventListener('change', changed);
    changed();
    return () => { mounted.current = false; media.removeEventListener('change', changed); transition.current?.skipTransition(); };
  }, []);

  useEffect(() => {
    const palette = preference === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : preference;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sequence = ++paletteSequence.current;
    const explicit = previousPreference.current !== preference;
    previousPreference.current = preference;
    transition.current?.skipTransition();
    const root = document.documentElement;
    delete root.dataset.themeChanging;
    const clear = () => { if (sequence === paletteSequence.current) delete root.dataset.themeChanging; };
    const apply = () => {
      if (sequence !== paletteSequence.current) return;
      root.dataset.themeChanging = '';
      root.dataset.theme = palette;
    };
    if (document.documentElement.dataset.theme !== palette) {
      // ponytail: OS changes and unsupported View Transitions apply atomically; never interpolate text colors.
      if (!media.matches && explicit && document.startViewTransition) {
        root.dataset.themeChanging = '';
        transition.current = document.startViewTransition(apply);
        void transition.current.ready.catch(() => {});
        void transition.current.finished.finally(clear).catch(() => {});
      } else { apply(); requestAnimationFrame(() => requestAnimationFrame(clear)); }
    }
    const reduced = () => { if (media.matches) { transition.current?.skipTransition(); apply(); requestAnimationFrame(clear); } };
    media.addEventListener('change', reduced);
    return () => media.removeEventListener('change', reduced);
  }, [preference, systemDark]);

  const native = (value: Theme) => void api.appearance(value).catch(error => { if (mounted.current) notify(error.message); });
  const choose = async (value: Theme) => {
    if (value === desired.current.value) return;
    notify('');
    desired.current = { value, sequence: desired.current.sequence + 1 };
    setPreference(value); native(value);
    if (writing.current) return;
    writing.current = true; setSaving(true);
    try {
      // Serialize writes and coalesce intermediate choices; status polling never owns appearance.
      while (mounted.current && desired.current.value !== confirmed.current) {
        const request = desired.current;
        try { await api.theme(request.value); confirmed.current = request.value; }
        catch {
          if (request.sequence === desired.current.sequence && mounted.current) {
            desired.current = { ...request, value: confirmed.current };
            setPreference(confirmed.current); native(confirmed.current);
            notify('Appearance could not be saved. Your previous choice was restored. Try again.');
          }
        }
      }
    } finally { writing.current = false; if (mounted.current) setSaving(false); }
  };
  return { preference, systemDark, saving, choose };
}
