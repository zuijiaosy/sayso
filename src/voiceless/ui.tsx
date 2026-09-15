import React from "react";

export const Page: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => (
  <div className="w-full max-w-[680px] mx-auto px-8 pt-8 pb-12">
    <h1 className="text-[28px] leading-9 font-bold tracking-tight">{title}</h1>
    {description && (
      <p className="text-sm text-mid-gray mt-1.5 leading-relaxed">
        {description}
      </p>
    )}
    <div className="mt-6 flex flex-col gap-8">{children}</div>
  </div>
);

export const Section: React.FC<{
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, description, actions, children }) => (
  <section>
    <div className="flex items-center gap-2.5 pb-3 border-b border-mid-gray/20">
      {icon && <span className="text-mid-gray shrink-0">{icon}</span>}
      <div className="flex-1 min-w-0">
        <h2 className="text-base font-semibold text-text/80">{title}</h2>
        {description && (
          <p className="text-xs text-mid-gray mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions}
    </div>
    <div className="divide-y divide-mid-gray/15">{children}</div>
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
        : "py-4 flex items-start justify-between gap-6"
    }
  >
    <div className="min-w-0 flex-1">
      <div className="text-[15px] font-semibold">{title}</div>
      {description && (
        <div className="text-[13px] text-mid-gray mt-0.5 leading-relaxed">
          {description}
        </div>
      )}
    </div>
    {children !== undefined && (
      <div className={stacked ? "w-full" : "shrink-0 flex items-center"}>
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
    className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
      checked ? "bg-background-ui" : "bg-mid-gray/30"
    }`}
  >
    <span
      className={`absolute top-0.5 start-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
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
    <div className="inline-flex p-0.5 rounded-lg bg-mid-gray/15 border border-mid-gray/20">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1 text-[13px] rounded-md transition-colors cursor-pointer disabled:cursor-not-allowed ${
            option.value === value
              ? "bg-background shadow-sm font-semibold"
              : "text-mid-gray hover:text-text"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const TextInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className = "", ...props }, ref) => (
  <input
    ref={ref}
    className={`h-9 px-3 text-sm rounded-lg border border-mid-gray/30 bg-background focus:outline-none focus:border-background-ui focus:ring-2 focus:ring-background-ui/20 disabled:opacity-60 ${className}`}
    {...props}
  />
));
TextInput.displayName = "TextInput";

export const SelectInput: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement>
> = ({ className = "", children, ...props }) => (
  <select
    className={`h-9 px-3 pe-8 text-sm rounded-lg border border-mid-gray/30 bg-background focus:outline-none focus:border-background-ui cursor-pointer disabled:opacity-60 ${className}`}
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
    className={`inline-flex items-center h-9 px-3 rounded-lg border text-[15px] font-medium font-sans shadow-[0_1px_0_rgba(0,0,0,0.08)] ${
      active
        ? "border-background-ui bg-background-ui/10"
        : "border-mid-gray/30 bg-background"
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
    className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${
      tone === "warning"
        ? "border-warning/40 bg-warning/10"
        : "border-mid-gray/25 bg-mid-gray/8"
    }`}
  >
    <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
      {title && <div className="font-semibold mb-0.5">{title}</div>}
      {children}
    </div>
    {action}
  </div>
);

export const StatusPill: React.FC<{
  ok: boolean;
  children: React.ReactNode;
}> = ({ ok, children }) => (
  <span
    className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${
      ok ? "text-green-600 dark:text-green-400" : "text-mid-gray"
    }`}
  >
    <span
      className={`w-2 h-2 rounded-full ${ok ? "bg-green-500" : "bg-mid-gray/50"}`}
    />
    {children}
  </span>
);
