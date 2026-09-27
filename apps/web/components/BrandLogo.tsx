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
 * the component renders a styled SOLROLL wordmark so nothing breaks.
 */

import { useState } from "react";

const LOCKUP_SRC = "/logo/solroll.png";
const MARK_SRC = "/logo/solroll-mark.png";

export const BRAND_NAME = "SolRoll";

/** Full logo + wordmark lockup (hero / landing). */
export function BrandLogo({ className = "" }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <BrandWordmark className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={LOCKUP_SRC}
      alt="SolRoll"
      className={`w-auto ${className}`}
      onError={() => setFailed(true)}
    />
  );
}

/** Emblem-only mark (navbar / footer / compact spots). */
export function BrandMark({ className = "" }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <BrandWordmark className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={MARK_SRC}
      alt="SolRoll"
      className={`w-auto ${className}`}
      onError={() => setFailed(true)}
    />
  );
}

/** Styled gold wordmark fallback (also used when asset files are absent). */
export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-display font-bold uppercase tracking-[0.18em] text-gold-400 ${className}`}
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
