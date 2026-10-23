// A labelled single-choice select (shadcn/Radix), for value/label options.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";

export function OptionSelect({
  label,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value ?? ""} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        size="sm"
        className="w-full text-[length:var(--oa-text-sm)]"
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            className="text-[length:var(--oa-text-sm)]"
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
