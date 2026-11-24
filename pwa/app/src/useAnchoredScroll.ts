import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Scroll behaviour of the message list: follow new content only while pinned to the bottom, mark
 * the thread viewed at the bottom, jump to one message on request, and keep the message at the top
 * in place across a phone ↔ wide reflow. A modal covers the conversation, so nothing is followed
 * or marked viewed while one is open.
 *
 * `pinned` is shared so a send can pin the list; `jumpCursor` is set before a thread switch to land
 * on that message. The layout effect runs after every render of the list, and only then.
 */
export function useAnchoredScroll({ scroller, thread, covered, wide, pinned, jumpCursor, atBottom }: {
  scroller: RefObject<HTMLDivElement | null>;
  thread: string;
  /** A sheet is open over the list. */
  covered: boolean;
  wide: boolean;
  pinned: RefObject<boolean>;
  jumpCursor: RefObject<number | undefined>;
  /** The newest content is in view. */
  atBottom: () => void;
}) {
  /** The message at the top of the list, so a layout switch can restore it. */
  const anchor = useRef<{ cursor: string; offset: number; width: number } | null>(null);
  const layoutWidth = useRef(0);
  const reflowedAt = useRef(0);

  function markAtBottom(el: HTMLDivElement) {
    if (!covered && !document.hidden && el.scrollHeight - el.scrollTop - el.clientHeight <= 2) atBottom();
  }

  /** The message under the top edge and how far it is pushed up out of view. */
  function rememberTop(el: HTMLDivElement) {
    // A reflowing column fires scroll events too. Keep the anchor taken before
    // the switch, or the restore would target the already-moved position.
    if (el.clientWidth !== layoutWidth.current) {
      layoutWidth.current = el.clientWidth;
      reflowedAt.current = performance.now();
      return;
    }
    if (performance.now() - reflowedAt.current < 250) return;
    const box = el.getBoundingClientRect();
    // Children are in flow order, so binary search the first one still visible.
    let lo = 0;
    let hi = el.children.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (el.children[mid].getBoundingClientRect().bottom > box.top + 1) {
        i = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    anchor.current = null;
    for (let n = i; n >= 0 && n < el.children.length && n < i + 4; n++) {
      const row = el.children[n];
      const node = row.matches("[data-message-cursor]") ? row : row.querySelector("[data-message-cursor]");
      if (node) {
        anchor.current = { cursor: (node as HTMLElement).dataset.messageCursor!, offset: node.getBoundingClientRect().top - box.top, width: el.clientWidth };
        return;
      }
    }
  }

  useLayoutEffect(() => { pinned.current = true; anchor.current = null; }, [thread, pinned]);

  // Follow new content only if already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || covered || document.hidden) return;
    if (jumpCursor.current !== undefined) {
      const target = el.querySelector<HTMLElement>(`[data-message-cursor="${jumpCursor.current}"]`);
      jumpCursor.current = undefined;
      if (target) {
        pinned.current = false;
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
        return;
      }
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
    markAtBottom(el);
  });
  const followBottom = useEffectEvent(() => {
    const el = scroller.current;
    if (!el || covered || document.hidden) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    markAtBottom(el);
  });
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a || pinned.current || a.width === el.clientWidth) return;
    const node = el.querySelector<HTMLElement>(`[data-message-cursor="${a.cursor}"]`);
    // Phone ↔ wide reflows the column; keep the message that was at the top
    // where it was. Browsers only anchor across a container resize sometimes.
    if (!node) return;
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
    a.width = el.clientWidth;
    layoutWidth.current = el.clientWidth;
    reflowedAt.current = performance.now();
  }, [wide, scroller, pinned]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const view = () => followBottom();
    const observer = new ResizeObserver(view);
    observer.observe(el);
    document.addEventListener("visibilitychange", view);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", view);
    };
  }, [scroller]);

  /** The list's own scroll handler. */
  return function onScroll(el: HTMLDivElement) {
    if (covered || document.hidden) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    if (pinned.current) markAtBottom(el);
    rememberTop(el);
  };
}
