import { Checkbox as C, Select as S, Switch as Sw } from "radix-ui";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useState,
} from "react";
import { cx } from "./cx";
import { useDevError } from "./dev";
import s from "./Field.module.css";

export type Option<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

export const Input = (props: ComponentProps<"input">) => (
  <input {...props} className={cx(s.control, props.className)} />
);

export const Textarea = (props: ComponentProps<"textarea">) => (
  <textarea {...props} className={cx(s.control, s.textarea, props.className)} />
);

const chevron = (
  <svg viewBox="0 0 16 16" className={s.glyph} aria-hidden="true">
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </svg>
);

// Radix reserves "" for "no value", so a real "" option travels as a sentinel.
const EMPTY = "\u0000empty";
const enc = (v: string) => (v === "" ? EMPTY : v);

export function Select<T extends string>({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled,
  id,
  name,
  ref,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: {
  options: Option<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  ref?: Ref<HTMLButtonElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <S.Root
      value={known && value !== undefined ? enc(value) : ""}
      onValueChange={(v) => onChange((v === EMPTY ? "" : v) as T)}
      disabled={disabled}
      name={name}
    >
      <S.Trigger
        ref={ref}
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        className={cx(s.control, s.select)}
      >
        <S.Value placeholder={placeholder} />
        <S.Icon>{chevron}</S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content className={s.menu} position="popper" sideOffset={4}>
          <S.Viewport>
            {options.map((o) => (
              <S.Item key={o.value} value={enc(o.value)} className={s.item}>
                {o.icon}
                <S.ItemText>{o.label}</S.ItemText>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

type Labelled = {
  label?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

function useLabelCheck(kind: string, p: Labelled) {
  useDevError(
    !p.label && !p["aria-label"] && !p["aria-labelledby"],
    `${kind} needs a \`label\`, \`aria-label\` or \`aria-labelledby\``,
  );
}

export function Switch({
  label,
  className,
  ...rest
}: Labelled & ComponentProps<typeof Sw.Root>) {
  useLabelCheck("Switch", { label, ...rest });
  const autoId = useId();
  const id = rest.id ?? autoId;
  return (
    <span className={s.labelled}>
      <Sw.Root id={id} {...rest} className={cx(s.switch, className)}>
        <Sw.Thumb className={s.thumb} />
      </Sw.Root>
      {label && <label htmlFor={id}>{label}</label>}
    </span>
  );
}

export function Checkbox({
  label,
  className,
  onCheckedChange,
  ...rest
}: Labelled & ComponentProps<typeof C.Root>) {
  useLabelCheck("Checkbox", { label, ...rest });
  const autoId = useId();
  const id = rest.id ?? autoId;
  const [inner, setInner] = useState(rest.defaultChecked ?? false);
  const state = rest.checked ?? inner;
  return (
    <span className={s.labelled}>
      <C.Root
        id={id}
        {...rest}
        onCheckedChange={(v) => {
          setInner(v);
          onCheckedChange?.(v);
        }}
        className={cx(s.checkbox, className)}
      >
        <C.Indicator>
          <svg viewBox="0 0 16 16" className={s.glyph} aria-hidden="true">
            <path
              d={state === "indeterminate" ? "M4 8h8" : "m3.5 8.5 3 3 6-7"}
            />
          </svg>
        </C.Indicator>
      </C.Root>
      {label && <label htmlFor={id}>{label}</label>}
    </span>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
}) {
  const selected = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const last = options.length - 1;
    const next = {
      ArrowRight: i === last ? 0 : i + 1,
      ArrowDown: i === last ? 0 : i + 1,
      ArrowLeft: i === 0 ? last : i - 1,
      ArrowUp: i === 0 ? last : i - 1,
      Home: 0,
      End: last,
    }[e.key];
    const option = next === undefined ? undefined : options[next];
    if (!option) return;
    e.preventDefault();
    onChange(option.value);
    const group = e.currentTarget.parentElement;
    (group?.children[next as number] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={s.seg}>
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: styled segmented radio
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={i === selected}
          tabIndex={i === Math.max(selected, 0) ? 0 : -1}
          className={s.segItem}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
