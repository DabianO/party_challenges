import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Never shrink content below this, however much there is. */
const MIN_SCALE = 0.25;

/**
 * Shows its content as large as it is laid out, shrunk (never grown) until it fits the box
 * without scrolling: for big-screen slides, where everything has to be on one screen. Shrunk
 * content is laid out wider by the same factor, so it still fills the width.
 */
export function FitToBox({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    let timer = 0;
    let applied = '';
    const fit = () => {
      const width = box.clientWidth;
      const height = box.clientHeight;
      if (width === 0 || height === 0) return;
      const fits = (scale: number) => {
        content.style.width = `${width / scale}px`;
        return content.scrollHeight * scale <= height + 1 && content.scrollWidth <= width / scale + 1;
      };
      let scale = 1;
      if (!fits(1)) {
        // The largest scale that fits: content gets shorter as it gets wider, so search.
        let lo = MIN_SCALE;
        let hi = 1;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
        scale = lo;
      }
      const style = `${width / scale}|${scale}`;
      content.style.width = `${width / scale}px`;
      if (style === applied) return;
      applied = style;
      content.style.transform = scale < 1 ? `scale(${scale})` : '';
    };
    // A timer, not an animation frame: a big screen left in a background tab gets no frames.
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, 0);
    };
    fit();
    // Pictures that load and fonts change the content's size after the first layout.
    const ro = new ResizeObserver(later);
    ro.observe(box);
    for (const child of Array.from(content.children)) ro.observe(child);
    content.addEventListener('load', later, true);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      content.removeEventListener('load', later, true);
    };
  }, []);

  return (
    <div ref={outer} className={`fit-box${className ? ` ${className}` : ''}`}>
      <div ref={inner} className="fit-box-content">
        {children}
      </div>
    </div>
  );
}
