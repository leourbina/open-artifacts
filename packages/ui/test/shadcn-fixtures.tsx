// Every shadcn core component and variant, shared by the jsdom and the
// real-browser (test-browser/) checks.
import type { ReactElement } from "react";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../src/shadcn";

export const cases: Record<string, ReactElement> = {
  Button: <Button>Save</Button>,
  ButtonDestructive: <Button variant="destructive">Delete</Button>,
  ButtonOutline: <Button variant="outline">Outline</Button>,
  ButtonSecondary: <Button variant="secondary">Secondary</Button>,
  ButtonGhost: <Button variant="ghost">Ghost</Button>,
  ButtonLink: <Button variant="link">Link</Button>,
  Input: <Input aria-label="Title" placeholder="Q4 data migration plan" />,
  Label: (
    <>
      <Label htmlFor="t">Title</Label>
      <Input id="t" />
    </>
  ),
  Card: (
    <Card>
      <CardHeader>
        <CardTitle>Q4 plan</CardTitle>
        <CardDescription>Markdown · 2h ago</CardDescription>
      </CardHeader>
      <CardContent>Body</CardContent>
    </Card>
  ),
  Badge: <Badge>Team</Badge>,
  BadgeDestructive: <Badge variant="destructive">Failed</Badge>,
  BadgeOutline: <Badge variant="outline">Outline</Badge>,
  // Badges are only focusable as links; these exercise their focus outline.
  BadgeLink: (
    <Badge asChild>
      <a href="#team">Team</a>
    </Badge>
  ),
  BadgeLinkDestructive: (
    <Badge asChild variant="destructive">
      <a href="#failed">Failed</a>
    </Badge>
  ),
  BadgeSecondary: <Badge variant="secondary">Secondary</Badge>,
  Avatar: (
    <Avatar>
      <AvatarFallback>MC</AvatarFallback>
    </Avatar>
  ),
  Tooltip: (
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover</Button>
        </TooltipTrigger>
        <TooltipContent>Hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
  Skeleton: <Skeleton className="h-4 w-24" />,
  Separator: <Separator />,
};
