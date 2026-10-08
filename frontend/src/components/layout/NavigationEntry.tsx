import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import type { ScreenDefinition } from '../../routes/catalog';

type NavigationAction = Readonly<{ id: 'favorite' | 'up' | 'down' | 'hide'; label: string; disabled?: boolean; run: () => void }>;

export function NavigationEntry({ screen, end, favorite, actions, open, onOpenChange, onNavigate, ready }: Readonly<{
  screen: ScreenDefinition;
  end: boolean;
  favorite: boolean;
  actions: readonly NavigationAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: () => void;
  ready: boolean;
}>) {
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const menu = popup.current, entry = row.current;
    const scroll = entry?.closest('nav');
    if (!menu || !entry || !scroll) return;
    // 포털 없이 모달/inert 경계 안에서 배치하고 스크롤 하단에서는 위로 연다.
    const bounds = scroll.getBoundingClientRect(), anchor = entry.getBoundingClientRect();
    const below = bounds.bottom - anchor.bottom - 8, above = anchor.top - bounds.top - 8;
    const upward = below < menu.scrollHeight && above > below;
    menu.style.top = upward ? 'auto' : 'calc(100% + 4px)';
    menu.style.bottom = upward ? 'calc(100% + 4px)' : 'auto';
    menu.style.maxHeight = `${Math.max(44, upward ? above : below)}px`;
    menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) {
        trigger.current?.focus({ preventScroll: true });
        onOpenChange(false);
      }
    };
    document.addEventListener('click', outside);
    return () => document.removeEventListener('click', outside);
  }, [open, onOpenChange]);

  function close(): void {
    trigger.current?.focus({ preventScroll: true });
    onOpenChange(false);
  }

  return <div ref={row} className="nav-entry" data-popup-open={open} onBlur={event => {
    // 빈 영역 클릭은 브라우저가 sidebar(tabIndex=-1)에 먼저 포커스를 준다.
    // 이 경우 click 해제에서 트리거로 돌리고, 다른 컨트롤로 이동한 포커스는 유지한다.
    if (open && event.relatedTarget && event.relatedTarget !== event.currentTarget.closest('.sidebar')
      && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
  }}>
    <NavLink to={screen.path} end={end} data-screen-id={screen.id} onClick={onNavigate} className={({ isActive }) => isActive ? 'active' : ''}>
      <span className="nav-mark" aria-hidden="true">{screen.label.slice(0, 1)}</span><span className="nav-label">{screen.label}</span>{screen.ai && <span className="nav-ai">AI</span>}
    </NavLink>
    <button ref={trigger} type="button" data-favorite-screen-id={screen.id} data-favorite={favorite} className="nav-pref-control nav-pin"
      disabled={!ready} aria-label={`${screen.label} 메뉴 동작`} title={`${screen.label} 메뉴 동작`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? popupId : undefined}
      onClick={event => { event.stopPropagation(); if (open) close(); else onOpenChange(true); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); onOpenChange(true); }
      }}><span aria-hidden="true">…</span></button>
    {open && <div ref={popup} id={popupId} className="nav-action-popup" role="menu" aria-label={`${screen.label} 메뉴 동작`} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { close(); return; }
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
      const index = items.findIndex(item => item === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null;
      if (next !== null) { event.preventDefault(); items[next]?.focus(); }
    }}>
      {actions.map(action => <button key={action.id} type="button" role="menuitem" tabIndex={-1} className="nav-pref-control nav-action" data-nav-action={action.id}
        disabled={action.disabled || !ready} title={action.id === 'hide' ? '내 메뉴에서만 숨깁니다' : undefined}
        onClick={() => { close(); action.run(); }}>
        <span>{action.label}</span>{action.id === 'hide' && <small>내 메뉴에서만 숨깁니다</small>}
      </button>)}
    </div>}
  </div>;
}
