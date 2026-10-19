import "./shadcn.css";
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

// Side-by-side panels set tokens inline, so colors follow each panel; the
// `dark:` variant follows <html data-theme> only, as in the app.
export const Core = () => (
  <Themes>
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
  </Themes>
);
Core.storyName = "shadcn / core";
