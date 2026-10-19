import "../src/tokens/tokens.css";
import "./shadcn.css";
import { Toaster, TooltipProvider } from "../src/shadcn";
import { cases } from "../test/shadcn-fixtures";

const copy = (
  <TooltipProvider>
    {Object.entries(cases).map(([name, el]) => (
      <div key={name} className="py-1">
        {el}
      </div>
    ))}
  </TooltipProvider>
);

// Every shadcn component on bg and on surface, driven by test-browser/
// (axe incl. color-contrast, focus outlines, open overlays) in both themes,
// which it switches through <html data-theme>.
export const A11y = () => (
  <div className="min-h-screen bg-background font-sans text-foreground">
    <main data-a11y-ready>
      <section className="p-4">{copy}</section>
      <section className="bg-card p-4">{copy}</section>
    </main>
    <Toaster />
  </div>
);
A11y.storyName = "shadcn / a11y fixture";
