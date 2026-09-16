import React from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "primary"
    | "primary-soft"
    | "secondary"
    | "warning"
    | "danger"
    | "danger-ghost"
    | "ghost";
  size?: "sm" | "md" | "lg";
}

export const Button: React.FC<ButtonProps> = ({
  children,
  className = "",
  variant = "primary",
  size = "md",
  ...props
}) => {
  const baseClasses =
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium rounded-pill border focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

  const variantClasses = {
    primary:
      "text-white bg-accent border-accent hover:bg-accent-strong hover:border-accent-strong focus:ring-1 focus:ring-accent",
    "primary-soft":
      "text-accent bg-accent/12 border-transparent hover:bg-accent/20 focus:ring-1 focus:ring-accent/40",
    secondary:
      "bg-surface-2 border-border hover:bg-accent/10 hover:border-accent/40 focus:outline-none",
    // Secondary's neutral resting look, but hover/focus use the semantic
    // --color-warning token (theme.css) instead of the accent — for buttons
    // sitting on warning surfaces like SecureInputWarning
    warning:
      "text-text bg-surface-2 border-border hover:bg-warning/15 hover:border-warning focus:ring-1 focus:ring-warning",
    danger:
      "text-white bg-error border-error hover:bg-error/85 hover:border-error/85 focus:ring-1 focus:ring-error",
    "danger-ghost":
      "text-error border-transparent hover:bg-error/10 focus:bg-error/15",
    ghost:
      "text-current border-transparent hover:bg-muted/12 hover:border-border focus:bg-muted/20",
  };

  const sizeClasses = {
    sm: "h-7 px-2.5 text-xs",
    md: "h-9 px-4 text-sm",
    lg: "h-10 px-5 text-base",
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
