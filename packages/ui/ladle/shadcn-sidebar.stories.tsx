import "../src/tokens/tokens.css";
import "./shadcn.css";
import { Clock, LayoutGrid, Search, Star, Trash2, Upload } from "lucide-react";
import { useEffect } from "react";
import {
  Button,
  Input,
  Sidebar,
  SidebarBrand,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "../src/shadcn";

const nav = [
  { label: "Library", icon: LayoutGrid, count: 214, active: true },
  { label: "Recent", icon: Clock },
  { label: "Starred", icon: Star, count: 9 },
  { label: "Trash", icon: Trash2 },
];
const collections = [
  ["Platform", 48],
  ["Legal & vendors", 17],
  ["Growth analytics", 31],
] as const;

// Studio layout: a flush chrome sidebar that collapses off-canvas (Cmd/Ctrl+B
// or the trigger) and becomes a sheet below md.
function Shell() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarBrand href="#home" />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((n) => (
                  <SidebarMenuItem key={n.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={n.active}
                      tooltip={n.label}
                    >
                      <a href={`#${n.label}`}>
                        <n.icon />
                        <span>{n.label}</span>
                      </a>
                    </SidebarMenuButton>
                    {n.count ? (
                      <SidebarMenuBadge>{n.count}</SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Collections</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {collections.map(([label, count]) => (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton asChild tooltip={label}>
                      <a href={`#${label}`}>
                        <span className="size-2 rounded-xs bg-border" />
                        <span>{label}</span>
                      </a>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>{count}</SidebarMenuBadge>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center gap-2 p-2 text-sm group-data-[collapsible=icon]:hidden">
            <span className="grid size-6 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
              MC
            </span>
            <div className="leading-tight">
              <div className="font-medium">Maya Chen</div>
              <div className="text-xs text-muted-foreground">
                maya@northwind.dev
              </div>
            </div>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <div className="relative max-w-md flex-1">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search"
              placeholder="Search titles, content, and agents"
              className="pl-8"
            />
          </div>
          <Button variant="outline" className="ml-auto">
            <Upload />
            Upload
          </Button>
        </header>
        <div className="p-6">
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">214 artifacts</p>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export const SidebarStory = () => <Shell />;
SidebarStory.storyName = "shadcn / sidebar";

// Sets <html data-theme="dark"> like the app, so `dark:` classes apply too.
export const SidebarDark = () => {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    root.setAttribute("data-theme", "dark");
    return () => {
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
    };
  }, []);
  return <Shell />;
};
SidebarDark.storyName = "shadcn / sidebar (dark root)";
