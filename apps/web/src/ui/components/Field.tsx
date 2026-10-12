import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';

interface Labelled {
  /** The name of the field, in the pixel face above it. */
  label: ReactNode;
  /** A sentence of help under the label. */
  hint?: ReactNode;
  /** Why the value was refused. Its presence marks the control invalid and frames it in the hatch. */
  error?: ReactNode;
}

export interface FieldProps extends Labelled {
  /** The id of the control inside, so the label points at it. */
  htmlFor: string;
  className?: string;
  children: ReactNode;
}

const hintId = (id: string) => `${id}-hint`;
const errorId = (id: string) => `${id}-error`;

/** The ids a control inside a `Field` should name in `aria-describedby`. */
export function describedBy(id: string, field: { hint?: ReactNode; error?: ReactNode }): string | undefined {
  const ids = [field.hint === undefined ? null : hintId(id), field.error === undefined ? null : errorId(id)].filter((x) => x !== null);
  return ids.length === 0 ? undefined : ids.join(' ');
}

/**
 * Label, hint and error text around one control. `Input`, `Textarea` and
 * `Select` wrap themselves in this; use it directly for a control of your own
 * and give that control `id={htmlFor}` and `aria-describedby={describedBy(...)}`.
 */
export function Field({ label, hint, error, htmlFor, className, children }: FieldProps) {
  return (
    <div className={`hf-field${className === undefined ? '' : ` ${className}`}`}>
      <label className="hf-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {hint !== undefined && (
        <p className="hf-field__hint" id={hintId(htmlFor)}>
          {hint}
        </p>
      )}
      {children}
      {error !== undefined && (
        <p className="hf-field__error" id={errorId(htmlFor)} role="alert">
          <i className="hf-swatch" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export interface InputProps extends Labelled, Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Set amounts, addresses and hashes in the numeric face. */
  numeric?: boolean;
  className?: string;
}

/** A single-line text field with its label, hint and error. */
export function Input({ label, hint, error, numeric = false, className, id, ...rest }: InputProps) {
  const auto = useId();
  const controlId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={controlId} {...(className === undefined ? {} : { className })}>
      <input
        id={controlId}
        className={numeric ? 'hf-input hf-input--num' : 'hf-input'}
        aria-describedby={describedBy(controlId, { hint, error })}
        {...(error === undefined ? {} : { 'aria-invalid': true })}
        {...rest}
      />
    </Field>
  );
}

export interface TextareaProps extends Labelled, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  className?: string;
}

/** A multi-line text field with its label, hint and error. */
export function Textarea({ label, hint, error, className, id, ...rest }: TextareaProps) {
  const auto = useId();
  const controlId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={controlId} {...(className === undefined ? {} : { className })}>
      <textarea id={controlId} className="hf-textarea" aria-describedby={describedBy(controlId, { hint, error })} {...(error === undefined ? {} : { 'aria-invalid': true })} {...rest} />
    </Field>
  );
}

export interface SelectProps extends Labelled, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> {
  /** The choices, as value and visible text. */
  options: readonly { value: string; label: string; disabled?: boolean }[];
  className?: string;
}

/** A native select with its label, hint and error. */
export function Select({ label, hint, error, options, className, id, ...rest }: SelectProps) {
  const auto = useId();
  const controlId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={controlId} {...(className === undefined ? {} : { className })}>
      <span className="hf-select-wrap">
        <select id={controlId} className="hf-select" aria-describedby={describedBy(controlId, { hint, error })} {...(error === undefined ? {} : { 'aria-invalid': true })} {...rest}>
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled === true}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </Field>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  /** The statement being agreed to or switched on, in the serif. */
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
}

/** A checkbox with its sentence beside it. The box and the sentence are one target. */
export function Checkbox({ label, hint, className, ...rest }: CheckboxProps) {
  return (
    <label className={`hf-check${className === undefined ? '' : ` ${className}`}`}>
      <input type="checkbox" {...rest} />
      <span className="hf-check__text">
        {label}
        {hint !== undefined && <span className="hf-check__hint">{hint}</span>}
      </span>
    </label>
  );
}
