import { type Format, FormatSchema } from "@oa/shared";
import { Button, SegmentedControl } from "@oa/ui";

const LABEL: Record<Format, string> = {
  html: "HTML",
  markdown: "Markdown",
  code: "Code",
  pdf: "PDF",
};
const FORMATS = [
  { value: "", label: "All formats" },
  ...FormatSchema.options.map((value) => ({ value, label: LABEL[value] })),
];

export type FilterProps = {
  format: Format | undefined;
  agent: string | undefined;
  agents: string[];
  view: "grid" | "list";
  onFormat: (f: Format | undefined) => void;
  onAgent: (a: string | undefined) => void;
  onClear: () => void;
  onView: (v: "grid" | "list") => void;
};

export function Filters(p: FilterProps) {
  const agents =
    p.agent && !p.agents.includes(p.agent) ? [...p.agents, p.agent] : p.agents;
  return (
    <div className="lib-bar">
      <SegmentedControl
        aria-label="Format"
        options={FORMATS}
        value={p.format ?? ""}
        onChange={(v) => p.onFormat(v ? (v as Format) : undefined)}
      />
      <select
        aria-label="Agent"
        className="lib-select"
        value={p.agent ?? ""}
        onChange={(e) => p.onAgent(e.target.value || undefined)}
      >
        <option value="">All agents</option>
        {agents.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      {(p.format || p.agent) && (
        <Button variant="ghost" onClick={p.onClear}>
          Clear filters
        </Button>
      )}
      <span className="lib-spacer" />
      <SegmentedControl
        aria-label="Layout"
        options={[
          { value: "grid", label: "Grid" },
          { value: "list", label: "List" },
        ]}
        value={p.view}
        onChange={p.onView}
      />
    </div>
  );
}
