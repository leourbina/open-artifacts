import "../src/tokens/tokens.css";
import "./shadcn.css";
import {
  Button,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../src/shadcn";

// The "Update available" chip's popover, driven by test-browser/ in both
// themes through <html data-theme>.
export const PopoverStory = () => (
  <div className="min-h-screen bg-background p-8 font-sans text-foreground">
    <main data-popover-ready>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            Update available
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <PopoverHeader>
            <PopoverTitle>Version 1.4.0 is ready</PopoverTitle>
            <PopoverDescription>
              Restart the server to pick up the new version.
            </PopoverDescription>
          </PopoverHeader>
          <div className="mt-4 flex justify-end gap-2">
            <PopoverClose asChild>
              <Button variant="ghost" size="sm">
                Later
              </Button>
            </PopoverClose>
            <Button size="sm">View release notes</Button>
          </div>
        </PopoverContent>
      </Popover>
    </main>
  </div>
);
PopoverStory.storyName = "shadcn / popover";
