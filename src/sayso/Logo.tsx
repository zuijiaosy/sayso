import React from "react";
import markUrl from "@/assets/sayso-mark.svg";

/**
 * The app mark. Same SVG the tray glyphs and the bundled app icon derive from
 * (see `scripts/gen-app-icon.ts`), so the in-app logo can never drift from the
 * one in the Dock.
 */
export const Logo: React.FC<{ size?: number; className?: string }> = ({
  size = 22,
  className = "",
}) => (
  <img
    src={markUrl}
    width={size}
    height={size}
    alt=""
    draggable={false}
    className={`shrink-0 ${className}`}
  />
);
