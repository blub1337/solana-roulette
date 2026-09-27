"use client";

/**
 * SolRoll brand logo.
 *
 * Uses the provided brand asset (dark-teal circuit emblem + gold ring + gold
 * SOLROLL wordmark) exactly as shipped — only size/placement are adapted here.
 *
 * Asset placement: `apps/web/public/logo/solroll.png` (full lockup incl.
 * wordmark) and `apps/web/public/logo/solroll-mark.png` (emblem only, for
 * compact spots like the navbar/footer). Until those files are dropped in,
 * the component renders a styled SOLROLL wordmark with its own text sizing.
 *
 * Reliability note: a 404 on a server-rendered <img> can fire BEFORE React
 * attaches listeners, so relying on onError alone leaves a broken image in
 * the DOM. After mount we therefore also check `complete && naturalWidth === 0`
 * and swap to the wordmark fallback ourselves.
 */

import { useEffect, useRef, useState } from "react";

const LOCKUP_SRC = "/logo/solroll.png";
const MARK_SRC = "/logo/solroll-mark.png";

export const BRAND_NAME = "SolRoll";

interface BrandProps {
  /** Sizing for the real asset (img) once the file exists. */
  className?: string;
  /** Text sizing used while the asset file is missing. */
  fallbackClassName?: string;
}

/** Shared broken-image detection: error event + post-mount completeness probe. */
function useImageOk() {
  const ref = useRef<HTMLImageElement | null>(null);
  const [ok, setOk] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0) setOk(false);
  }, []);
  return { ref, ok, markBroken: () => setOk(false) };
}

/** Full logo + wordmark lockup (hero / landing). */
export function BrandLogo({ className = "", fallbackClassName = "text-2xl" }: BrandProps) {
  const { ref, ok, markBroken } = useImageOk();
  if (!ok) return <BrandWordmark className={fallbackClassName} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={LOCKUP_SRC}
      alt="SolRoll"
      className={`w-auto ${className}`}
      onError={markBroken}
    />
  );
}

/** Emblem-only mark (navbar / footer / compact spots). */
export function BrandMark({ className = "", fallbackClassName = "text-xl" }: BrandProps) {
  const { ref, ok, markBroken } = useImageOk();
  if (!ok) return <BrandWordmark className={fallbackClassName} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={MARK_SRC}
      alt="SolRoll"
      className={`w-auto ${className}`}
      onError={markBroken}
    />
  );
}

/** Styled gold wordmark fallback (used while asset files are absent). */
export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block font-display font-bold uppercase leading-none tracking-[0.14em] ${className}`}
      style={{
        background: "linear-gradient(120deg, #f7e08a 0%, #f2cf62 45%, #c79a26 100%)",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
      }}
    >
      SolRoll
    </span>
  );
}
