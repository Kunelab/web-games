import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixSelect from '@radix-ui/react-select';
import * as RadixSwitch from '@radix-ui/react-switch';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react';

import { cx } from './cx';
import './ui.css';

/**
 * The primitive set.
 *
 * Behaviour and accessibility come from Radix; everything visual comes from the
 * tokens in styles/tokens.css, so the same components render as the atelier or as
 * the game stage depending only on the shell class above them.
 */

/* ------------------------------------------------------------------- button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  /** Shows a spinner and blocks further clicks. */
  busy?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, busy, icon, children, className, type = 'button', ...props },
  ref
) {
  const classes = cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', className);

  return (
    // Defaulting to type="button": these live inside forms, and without it every
    // click submitted the form, which is what the old icon buttons did.
    <button ref={ref} type={type} className={classes} disabled={busy || props.disabled} {...props}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  /** Required: an icon alone tells a screen reader nothing. */
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-icon ${className ?? ''}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {icon}
    </button>
  );
});

/* -------------------------------------------------------------------- field */

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/**
 * Wires a label, a hint and an error message to a control.
 *
 * Taking the control as a render function is what guarantees the ids line up:
 * there is no way to use this and forget `aria-describedby`, which is how hints
 * and errors usually end up invisible to assistive tech.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      {label && (
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
      )}
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={`input ${className ?? ''}`} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref
) {
  return <textarea ref={ref} className={`textarea ${className ?? ''}`} {...props} />;
});

/* ------------------------------------------------------------------- portals */

/**
 * The element that floating content is rendered into.
 *
 * The palette is declared on the shell, not on `:root`, so anything portalled to
 * `document.body` sits outside the scope of every colour variable and resolves them
 * all to nothing. That is why an open select had no background: not a missing rule,
 * but `var(--bg-raised)` with no value, along with its border, its shadow and its
 * text colour. Rendering inside the shell keeps the variables in scope, and it works
 * for whichever palette is mounted without this having to know which one that is.
 *
 * The shell hands its own element over rather than being looked up by class name.
 * Searching the document would work but ties this to a selector owned elsewhere, and
 * it cannot be done during render: on the first pass nothing is in the document yet,
 * so the answer would be null, and null is what Radix would still be holding when
 * the select was finally opened.
 */
const PortalContainerContext = createContext<HTMLElement | null>(null);

export function PortalContainerProvider({
  container,
  children
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>;
}

/** Null until the shell has mounted, which is Radix's own default of the body. */
function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}

/* ------------------------------------------------------------------- select */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  'aria-describedby'?: string;
}

export function Select({ value, onValueChange, options, placeholder, id, disabled, ...rest }: SelectProps) {
  const container = usePortalContainer();

  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger className="select-trigger" id={id} aria-describedby={rest['aria-describedby']}>
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="select-icon">
          <ChevronDown />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal container={container}>
        <RadixSelect.Content className="select-content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport className="select-viewport">
            {options.map((option) => (
              <RadixSelect.Item key={option.value} value={option.value} className="select-item">
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

/* ------------------------------------------------------------------- switch */

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function Switch({ checked, onCheckedChange, label, hint, disabled }: SwitchProps) {
  const id = useId();

  return (
    <div className="switch-row">
      <span className="switch-text">
        <label className="switch-title" htmlFor={id}>
          {label}
        </label>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <RadixSwitch.Root
        id={id}
        className="switch"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      >
        <RadixSwitch.Thumb className="switch-thumb" />
      </RadixSwitch.Root>
    </div>
  );
}

/* --------------------------------------------------------------------- chip */

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  /** Renders a colour dot, used to encode media kind. */
  dotColor?: string;
}

export function Chip({ active, dotColor, children, className, ...props }: ChipProps) {
  return (
    <button
      type="button"
      className={`chip ${className ?? ''}`}
      aria-pressed={active}
      style={dotColor ? ({ '--dot': dotColor } as React.CSSProperties) : undefined}
      {...props}
    >
      {dotColor && <span className="chip-dot" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Tag({ children, dotColor }: { children: ReactNode; dotColor?: string }) {
  return (
    <span className="chip chip-static" style={dotColor ? ({ '--dot': dotColor } as React.CSSProperties) : undefined}>
      {dotColor && <span className="chip-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Badge({ children, tone = 'quiet' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'quiet' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/* ------------------------------------------------------------------- dialog */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  actions?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, actions }: DialogProps) {
  const container = usePortalContainer();

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {/* Same reason as the select: a dialog on the body would lose the palette too,
          which is why its panel and its buttons were unstyled. */}
      <RadixDialog.Portal container={container}>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content className="dialog-content">
          <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
          {description && <RadixDialog.Description className="dialog-desc">{description}</RadixDialog.Description>}
          {children}
          {actions && <div className="dialog-actions">{actions}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/* -------------------------------------------------------------- empty, load */

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
      {action}
    </div>
  );
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="loading-row">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/* -------------------------------------------------------------------- icons */

export function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Two overlapping sheets: the duplicate action, in the library and on playlists. */
export function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
