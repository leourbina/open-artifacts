import "./shadcn.css";
import { useEffect } from "react";
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
import { Themes } from "./Themes";

const Sheet = () => (
  <TooltipProvider>
    <div className="flex w-full flex-col gap-4 font-sans text-sm text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Button>Share</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="link">Link</Button>
        <Button size="sm">Small</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Failed</Badge>
        <Avatar>
          <AvatarFallback>MC</AvatarFallback>
        </Avatar>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm">
              Hover
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy link</TooltipContent>
        </Tooltip>
      </div>
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" placeholder="Q4 data migration plan" />
      </div>
      <Separator />
      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Q4 data migration plan</CardTitle>
          <CardDescription>Markdown · Claude Code · 2h ago</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </CardContent>
      </Card>
    </div>
  </TooltipProvider>
);

// Side-by-side panels set tokens inline, so colors follow each panel; the
// `dark:` variant follows <html data-theme> only, so it shows in Dark root.
export const Core = () => (
  <Themes>
    <Sheet />
  </Themes>
);
Core.storyName = "shadcn / core";

// Sets <html data-theme="dark"> like the app, so `dark:` classes apply too.
export const CoreDarkRoot = () => {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    root.setAttribute("data-theme", "dark");
    return () => {
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
    };
  }, []);
  return (
    <div className="min-h-screen bg-background p-6">
      <Sheet />
    </div>
  );
};
CoreDarkRoot.storyName = "shadcn / core (dark root)";
