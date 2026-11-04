'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Re-reads the records while the page is visible so a run landing mid-demo shows up.
export function LiveRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
