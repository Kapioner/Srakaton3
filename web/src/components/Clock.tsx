import { useEffect, useState } from 'react';

/** Live UTC clock, HH:MM:SS (FIRMS acquisition times are UTC too). */
export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <time dateTime={now.toISOString()}>{now.toISOString().slice(11, 19)} UTC</time>;
}
