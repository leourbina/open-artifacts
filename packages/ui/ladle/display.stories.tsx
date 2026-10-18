import { Avatar, Badge, Kbd, Spinner, VisibilityBadge } from "../src/index";
import { Themes } from "./Themes";

export const Badges = () => (
  <Themes>
    {(["neutral", "accent", "success", "warning", "danger"] as const).map(
      (t) => (
        <Badge key={t} tone={t}>
          {t}
        </Badge>
      ),
    )}
    {(["private", "team", "public"] as const).map((v) => (
      <VisibilityBadge key={v} visibility={v} />
    ))}
  </Themes>
);

export const Misc = () => (
  <Themes>
    <Avatar name="Ada Lovelace" email="ada@example.com" />
    <Avatar email="grace@example.com" size={32} />
    <Kbd>⌘K</Kbd>
    <Spinner />
  </Themes>
);
