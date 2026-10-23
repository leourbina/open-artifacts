// Every shadcn component and variant, shared by the jsdom checks, the a11y
// Ladle story and the real-browser checks (test-browser/) that drive it.

import { XIcon } from "lucide-react";
import type { ReactElement } from "react";
import { toast } from "sonner";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Kbd,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover</Button>
        </TooltipTrigger>
        <TooltipContent>Hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
  Skeleton: <Skeleton className="h-4 w-24" />,
  Separator: <Separator />,
  Select: (
    <Select defaultValue="viewer">
      <SelectTrigger aria-label="Role">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="viewer">Viewer</SelectItem>
        <SelectItem value="editor">Editor</SelectItem>
      </SelectContent>
    </Select>
  ),
  Dialog: (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription>Invite people to this artifact.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  AlertDialog: (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Delete artifact</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete artifact?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes every version.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  DropdownMenu: (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Artifact</DropdownMenuLabel>
        <DropdownMenuItem>Rename</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>Starred</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  Tabs: (
    <Tabs defaultValue="versions">
      <TabsList>
        <TabsTrigger value="versions">Versions</TabsTrigger>
        <TabsTrigger value="share">Share</TabsTrigger>
      </TabsList>
      <TabsContent value="versions">7 versions</TabsContent>
      <TabsContent value="share">Shared with the team</TabsContent>
    </Tabs>
  ),
  ToggleGroup: (
    <ToggleGroup type="single" defaultValue="grid" aria-label="Layout">
      <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
      <ToggleGroupItem value="list">List</ToggleGroupItem>
    </ToggleGroup>
  ),
  ToggleGroupOutline: (
    <ToggleGroup
      type="single"
      variant="outline"
      defaultValue="grid"
      aria-label="Density"
    >
      <ToggleGroupItem value="grid">Cozy</ToggleGroupItem>
      <ToggleGroupItem value="list">Compact</ToggleGroupItem>
    </ToggleGroup>
  ),
  Table: (
    <Table>
      <TableCaption>Recent versions</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead>Agent</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow data-state="selected">
          <TableCell>v7</TableCell>
          <TableCell>Claude Code</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>v6</TableCell>
          <TableCell>Codex CLI</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
  ScrollArea: (
    <ScrollArea className="h-16 w-48 rounded-md border" aria-label="Notes">
      <p className="p-2">
        Marked billing cutover at risk; added ledger replay task and the review
        note. Rewrote the cutover procedure around the new script.
      </p>
    </ScrollArea>
  ),
  Textarea: <Textarea aria-label="Description" placeholder="What changed" />,
  Checkbox: (
    <div className="flex items-center gap-2">
      <Checkbox id="cb-notify" defaultChecked />
      <Label htmlFor="cb-notify">Notify people</Label>
    </div>
  ),
  CheckboxUnchecked: <Checkbox aria-label="Allow comments" />,
  CheckboxIndeterminate: (
    <Checkbox aria-label="Select all" checked="indeterminate" />
  ),
  Kbd: (
    <p>
      Type <Kbd>!</Kbd> and a space, or press <Kbd>⌘K</Kbd>.
    </p>
  ),
  AlertInfo: (
    <Alert variant="info">
      <AlertTitle>No usage recorded yet today.</AlertTitle>
      <AlertDescription>
        <p>Numbers appear after the first request.</p>
      </AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss">
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  ),
  AlertSuccess: (
    <Alert variant="success">
      <AlertTitle>Directory is healthy.</AlertTitle>
      <AlertDescription>
        <p>Last synced 2 minutes ago.</p>
      </AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss">
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  ),
  AlertWarning: (
    <Alert variant="warning">
      <AlertTitle>Some requests hit Cloudflare's CPU limit</AlertTitle>
      <AlertDescription>
        <p>Retrying usually works.</p>
      </AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss">
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  ),
  AlertDanger: (
    <Alert variant="danger">
      <AlertTitle>Sign-in didn't finish.</AlertTitle>
      <AlertDescription>
        <p>Try again, or ask your admin.</p>
      </AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss">
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  ),
  AlertStrip: (
    <Alert variant="info" size="sm">
      <AlertDescription>
        You can view this, but you can't change it.
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm">
          Request access
        </Button>
      </AlertAction>
    </Alert>
  ),
  // The <Toaster /> itself is mounted once, by the a11y story.
  ToastTrigger: (
    <Button variant="outline" onClick={() => toast("Link copied")}>
      Show toast
    </Button>
  ),
  ToastSuccess: (
    <Button variant="outline" onClick={() => toast.success("Published v8")}>
      Show success toast
    </Button>
  ),
  ToastError: (
    <Button variant="outline" onClick={() => toast.error("Upload failed")}>
      Show error toast
    </Button>
  ),
  ToastWarning: (
    <Button
      variant="outline"
      onClick={() => toast.warning("Daily free-plan limit almost reached")}
    >
      Show warning toast
    </Button>
  ),
};
