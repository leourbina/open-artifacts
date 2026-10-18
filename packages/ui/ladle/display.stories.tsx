import {
  Avatar,
  Badge,
  Card,
  FormatIcon,
  Kbd,
  Skeleton,
  Spinner,
  VisibilityBadge,
} from "../src/index";
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
    {(["html", "markdown", "code", "pdf"] as const).map((f) => (
      <FormatIcon key={f} format={f} />
    ))}
    <Kbd>⌘K</Kbd>
    <Spinner />
    <Skeleton width={120} />
    <Card style={{ padding: 16 }}>Card body</Card>
  </Themes>
);
