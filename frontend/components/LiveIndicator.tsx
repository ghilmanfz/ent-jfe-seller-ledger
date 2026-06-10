'use client';

import { useEffect, useState } from 'react';

/** Small "polling is alive" affordance with a relative last-update time. */
export function LiveIndicator({ updatedAt }: { updatedAt: Date | null }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => forceTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 1000)) : null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      Live{seconds !== null ? ` · updated ${seconds}s ago` : ''}
    </span>
  );
}
