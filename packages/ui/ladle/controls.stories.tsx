import { useState } from "react";
import {
  Button,
  Checkbox,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  Tooltip,
} from "../src/index";
import { Themes } from "./Themes";

const plus = (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    aria-hidden="true"
  >
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const Buttons = () => (
  <Themes>
    <Button variant="primary" icon={plus}>
      New
    </Button>
    <Button>Share</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="danger">Delete</Button>
    <Button size="sm">Small</Button>
    <Button loading>Saving</Button>
    <IconButton label="Add" icon={plus} />
    <Tooltip content="Hint">
      <Button>Hover me</Button>
    </Tooltip>
  </Themes>
);

export const Fields = () => {
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [view, setView] = useState<"grid" | "list">("grid");
  return (
    <Themes>
      <Input aria-label="Title" placeholder="Search artifacts" />
      <Textarea aria-label="Notes" placeholder="Notes" />
      <Select
        aria-label="Role"
        value={role}
        onChange={setRole}
        options={[
          { value: "viewer", label: "Viewer" },
          { value: "editor", label: "Editor" },
        ]}
      />
      <SegmentedControl
        aria-label="View"
        value={view}
        onChange={setView}
        options={[
          { value: "grid", label: "Grid" },
          { value: "list", label: "List" },
        ]}
      />
      <Switch label="Notify" defaultChecked />
      <Checkbox label="Agree" defaultChecked />
    </Themes>
  );
};
