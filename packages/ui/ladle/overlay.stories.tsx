import { useState } from "react";
import { Button, Dialog, Menu, Tabs, Toaster, toast } from "../src/index";
import { Themes } from "./Themes";

const tabs = [
  { id: "versions", label: "Versions", content: "Version history" },
  { id: "share", label: "Share", content: "Sharing settings" },
  { id: "details", label: "Details", content: "Artifact details" },
];

export const Overlays = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Toaster />
      <Themes>
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Delete artifact?"
          description="This removes every version."
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger">Delete</Button>
            </>
          }
        />
        <Menu
          trigger={<Button>Actions</Button>}
          items={[
            { label: "Rename", onSelect: () => {} },
            { label: "Duplicate", onSelect: () => {} },
            "separator",
            { label: "Delete", onSelect: () => {}, danger: true },
          ]}
        />
        <Button
          onClick={() => toast({ title: "Link copied", tone: "success" })}
        >
          Toast
        </Button>
        <div style={{ width: "100%" }}>
          <Tabs tabs={tabs} />
        </div>
      </Themes>
    </>
  );
};
