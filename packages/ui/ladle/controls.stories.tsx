import { Button, IconButton, Tooltip } from "../src/index";
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
