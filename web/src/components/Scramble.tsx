import { useEffect, useState, type CSSProperties } from 'react';

const GLYPHS = '@#*&%<>?!/\\=+0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * "Decoding" text effect: characters start as random glyphs and resolve left to right.
 * Screen readers get the final text immediately; the animation is skipped for reduced motion.
 */
export function Scramble({ text, duration = 900, delay = 0 }: { text: string; duration?: number; delay?: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? text : scramble(text, 0)));

  useEffect(() => {
    if (reducedMotion()) {
      setShown(text);
      return;
    }
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      setShown(progress >= 1 ? text : scramble(text, progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, duration, delay]);

  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only" style={srOnly}>
        {text}
      </span>
    </>
  );
}

function scramble(text: string, progress: number): string {
  const resolved = Math.floor(text.length * progress);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += i < resolved || ch === ' ' || ch === '\n' ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
  }
  return out;
}

const srOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};
