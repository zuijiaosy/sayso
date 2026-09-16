import React from "react";

export const Page: React.FC<{
  title: string;
  description?: string;
  /**
   * Fill the window rather than growing past it: the title stays put and the
   * children own the scrolling. For pages built around one long list (History,
   * Dictionary), where scrolling the whole page would drag the heading and the
   * search box off-screen. Everything else scrolls as a single unit.
   */
  fill?: boolean;
  children: React.ReactNode;
}> = ({ title, description, fill = false, children }) => (
  // The scroll container is full-width so the scrollbar sits at the window
  // edge, not against the 680px column.
  <div
    className={
      fill
        ? "flex-1 min-h-0 flex flex-col"
        : "flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
    }
  >
    <div
      className={`w-full max-w-[680px] mx-auto px-8 pt-6 ${
        fill ? "pb-6 flex-1 min-h-0 flex flex-col" : "pb-14"
      }`}
    >
      <h1 className="font-display text-[30px] leading-10 font-semibold">
        {title}
      </h1>
      {description && (
        <p className="text-sm text-muted mt-2 leading-relaxed">{description}</p>
      )}
      <div
        className={`mt-6 flex flex-col gap-6 ${fill ? "flex-1 min-h-0" : ""}`}
      >
        {children}
      </div>
    </div>
  </div>
);

/**
 * A titled group of rows, rendered as a card so a page reads as a few objects
 * rather than one long form. Sizes deliberately sit between the page title
 * (30px) and a row title (14px) so the three levels stay distinguishable.
 * Omitting `title` drops the header, for a page with a single unlabelled list.
 */
export const Section: React.FC<{
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  /** Pinned between the header and the rows — a search box and the like. */
  toolbar?: React.ReactNode;
  /** Fill the parent and scroll the rows, keeping header and toolbar in view. */
  fill?: boolean;
  children: React.ReactNode;
}> = ({
  icon,
  title,
  description,
  actions,
  toolbar,
  fill = false,
  children,
}) => (
  <section
    className={`bg-surface rounded-card shadow-card px-5 ${
      fill ? "flex-1 min-h-0 flex flex-col" : ""
    }`}
  >
    {title && (
      <div className="shrink-0 flex flex-wrap items-center gap-x-2.5 gap-y-2 pt-4 pb-3 border-b border-border">
        {icon && <span className="text-accent shrink-0">{icon}</span>}
        <div className="flex-1 min-w-0">
          <h2 className="text-[16px] leading-6 font-semibold tracking-tight">
            {title}
          </h2>
          {description && (
            <p className="text-xs text-muted mt-0.5 leading-relaxed">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="shrink-0 flex items-center gap-2">{actions}</div>
        )}
      </div>
    )}
    {toolbar && (
      <div className="shrink-0 divide-y divide-border border-b border-border">
        {toolbar}
      </div>
    )}
    <div
      className={`divide-y divide-border ${
        fill ? "flex-1 min-h-0 overflow-y-auto" : ""
      }`}
    >
      {children}
    </div>
  </section>
);

export const Row: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  stacked?: boolean;
}> = ({ title, description, children, stacked = false }) => (
  <div
    className={
      stacked
        ? "py-4 flex flex-col gap-3"
        : "py-4 flex items-start justify-between gap-4"
    }
  >
    <div className="min-w-0 flex-1">
      <div className="text-[14px] font-medium">{title}</div>
      {description && (
        <div className="text-[13px] text-muted mt-0.5 leading-relaxed">
          {description}
        </div>
      )}
    </div>
    {children !== undefined && (
      <div
        className={
          stacked
            ? "w-full min-w-0"
            : "shrink-0 min-w-0 max-w-[60%] flex items-center justify-end"
        }
      >
        {children}
      </div>
    )}
  </div>
);

export const Switch: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}> = ({ checked, onChange, disabled, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative w-11 h-6 rounded-pill transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
      checked ? "bg-accent" : "bg-muted/30"
    }`}
  >
    <span
      className={`absolute top-0.5 start-0.5 w-5 h-5 rounded-pill bg-white shadow-sm transition-transform ${
        checked ? "translate-x-5" : ""
      }`}
    />
  </button>
);

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex p-0.5 rounded-pill bg-surface-2 border border-border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`px-3.5 py-1 text-[13px] rounded-pill transition-colors cursor-pointer disabled:cursor-not-allowed ${
            option.value === value
              ? "bg-surface shadow-sm font-semibold"
              : "text-muted hover:text-text"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface TabDef<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Explains the active tab; shown under the switcher. */
  description?: string;
}

/**
 * One card whose body switches between several forms, for pages that would
 * otherwise stack a full-height card per topic. The caller renders the body
 * for `value`; this only draws the pinned switcher.
 */
export function TabbedSection<T extends string>({
  tabs,
  value,
  onChange,
  fill,
  children,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (value: T) => void;
  fill?: boolean;
  children: React.ReactNode;
}) {
  const active = tabs.find((tab) => tab.value === value);

  return (
    <Section
      fill={fill}
      toolbar={
        <div className="py-3 flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            {active?.icon && (
              <span className="text-accent shrink-0">{active.icon}</span>
            )}
            <Segmented<T>
              value={value}
              onChange={onChange}
              options={tabs.map(({ value, label }) => ({ value, label }))}
            />
          </div>
          {active?.description && (
            <p className="text-xs text-muted leading-relaxed">
              {active.description}
            </p>
          )}
        </div>
      }
    >
      {children}
    </Section>
  );
}

export const TextInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className = "", ...props }, ref) => (
  <input
    ref={ref}
    className={`h-9 min-w-0 px-3 text-sm rounded-control border border-border bg-surface focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60 ${className}`}
    {...props}
  />
));
TextInput.displayName = "TextInput";

export const SelectInput: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement>
> = ({ className = "", children, ...props }) => (
  <select
    className={`h-9 min-w-0 max-w-full px-3 pe-8 text-sm rounded-control border border-border bg-surface focus:outline-none focus:border-accent cursor-pointer disabled:opacity-60 ${className}`}
    {...props}
  >
    {children}
  </select>
);

export const KeyChip: React.FC<{ label: string; active?: boolean }> = ({
  label,
  active,
}) => (
  <kbd
    className={`inline-flex items-center h-9 px-3 rounded-[10px] border text-[15px] font-medium font-sans shadow-key ${
      active ? "border-accent bg-accent/10" : "border-border bg-surface"
    }`}
  >
    {label}
  </kbd>
);

export const Notice: React.FC<{
  tone?: "warning" | "info";
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}> = ({ tone = "info", title, children, action }) => (
  <div
    className={`rounded-card border px-4 py-3 flex items-start gap-3 ${
      tone === "warning"
        ? "border-warning/40 bg-warning/10"
        : "border-border bg-surface-2"
    }`}
  >
    <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
      {title && <div className="font-semibold mb-0.5">{title}</div>}
      {children}
    </div>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);

export const StatusPill: React.FC<{
  ok: boolean;
  children: React.ReactNode;
}> = ({ ok, children }) => (
  <span
    className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${
      ok ? "text-success" : "text-muted"
    }`}
  >
    <span
      className={`w-2 h-2 shrink-0 rounded-pill ${ok ? "bg-success" : "bg-muted/50"}`}
    />
    {children}
  </span>
);

/**
 * A small label chip. Replaces the inline accent-tinted spans that History and
 * Models had each grown their own copy of.
 */
export const Chip: React.FC<{
  children: React.ReactNode;
  tone?: "accent" | "neutral";
}> = ({ children, tone = "accent" }) => (
  <span
    className={`inline-flex items-center px-2 py-0.5 rounded-pill text-[11px] font-medium leading-normal ${
      tone === "accent" ? "bg-accent/12 text-accent" : "bg-muted/15 text-muted"
    }`}
  >
    {children}
  </span>
);
