import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Theme } from '../core/model.js';

const choices = ['system', 'light', 'dark'] as const;
const label = (theme: Theme) => theme[0]!.toUpperCase() + theme.slice(1);
export function AppearanceIcon({ name }: { name: Theme | 'check' | 'chevron' }) {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'system' ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></> : name === 'light' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></> : name === 'dark' ? <path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z" /> : name === 'check' ? <path d="m5 12 4 4L19 6" /> : <path d="m6 9 6 6 6-6" />}
  </svg>;
}

export function AppearanceMenu({ preference, systemDark, saving, dismiss, onChoose }: {
  preference: Theme; systemDark: boolean; saving: boolean; dismiss: boolean; onChoose: (value: Theme) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const popup = menu.current!;
    const position = () => {
      if (!popup.matches(':popover-open')) return;
      const anchor = trigger.current!.getBoundingClientRect();
      if (anchor.bottom < 0 || anchor.top > innerHeight) { popup.hidePopover(); return; }
      popup.style.width = `${Math.min(216, innerWidth - 16)}px`;
      popup.style.left = `${Math.max(8, Math.min(anchor.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`;
      popup.style.top = `${Math.max(8, anchor.bottom + 8 + popup.offsetHeight <= innerHeight - 8 ? anchor.bottom + 8 : anchor.top - popup.offsetHeight - 8)}px`;
    };
    const toggle = (event: Event) => {
      const opening = (event as ToggleEvent).newState === 'open';
      popup.inert = !opening; setOpen(opening);
      if (opening) requestAnimationFrame(position);
    };
    popup.addEventListener('beforetoggle', toggle);
    const observer = new ResizeObserver(position); observer.observe(trigger.current!);
    observer.observe(trigger.current!.closest('.header-actions')!);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { popup.removeEventListener('beforetoggle', toggle); observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, []);
  useEffect(() => { if (dismiss && menu.current?.matches(':popover-open')) menu.current.hidePopover(); }, [dismiss]);
  const close = (focus = false) => { menu.current?.hidePopover(); if (focus) trigger.current?.focus(); };
  const show = () => {
    menu.current!.showPopover();
    menu.current!.querySelector<HTMLButtonElement>(`[data-choice=${preference}]`)?.focus();
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      rows[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowDown' ? 1 : 2)) % 3]?.focus();
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
  };
  return <div className="theme-control"><span className="appearance-label" aria-hidden="true">Appearance</span>
    <button ref={trigger} className="appearance-trigger" aria-label={`Appearance: ${label(preference)}`} title={`Appearance: ${label(preference)}`} aria-haspopup="menu" aria-controls="appearance-menu" aria-expanded={open} onClick={() => open ? close(true) : show()} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
    }}><AppearanceIcon name={preference} /><span>{label(preference)}</span><span className="appearance-chevron"><AppearanceIcon name="chevron" /></span></button>
    <div ref={menu} id="appearance-menu" className="appearance-menu" popover="auto" role="menu" aria-label="Appearance" onKeyDown={keyboard} onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close();
    }}><span className="eyebrow menu-caption">Appearance</span>{choices.map(choice => <button key={choice} role="menuitemradio" aria-checked={choice === preference} tabIndex={-1} data-choice={choice} onClick={() => { onChoose(choice); close(true); }}>
      <AppearanceIcon name={choice} /><span>{label(choice)}{choice === 'system' && <small>Currently {systemDark ? 'dark' : 'light'}</small>}</span><span className="appearance-check">{choice === preference && <AppearanceIcon name="check" />}</span>
    </button>)}</div><span className="sr-only" role="status">{saving ? 'Saving appearance.' : `Appearance: ${label(preference)}.`}</span>
  </div>;
}
